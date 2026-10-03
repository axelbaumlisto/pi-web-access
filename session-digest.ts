/**
 * session-digest — a text-only cache of pi session transcripts for memory_search.
 *
 * Why: transcripts are ~15 GB on a busy machine, but 98.8 % of that is
 * toolResult dumps (file contents, fetched pages) that the search pipeline
 * never surfaces. The searchable part — user/assistant turns — measured at
 * 1.2 % of raw size. Any per-query scan of the raw tree is disk-bound at
 * 8–20 s regardless of rg flags; scanning the digest is sub-second.
 *
 * How: one digest file per session file, each line `{ts, role, text}` (exactly
 * the fields the search consumes). A manifest maps source path → {size, mtime};
 * a source is (re)digested only when either changes. Session files are
 * append-only, so this is exact: only the live session ever re-digests.
 *
 * Cold start on a large tree is bounded by `budgetMs`, newest-first, and
 * reported as `complete: false`; every later call advances the digest until it
 * is complete. No daemon, no schema, no dependencies.
 *
 * The live session grows while it is being searched, so a manifest entry also
 * records `offset`: how many bytes of the source are already digested, always
 * on a line boundary. A grown append-only file is then read from that offset
 * and its turns appended, instead of re-reading megabytes per query. Anything
 * that breaks the append-only assumption (shrunk source, missing digest, older
 * manifest) falls back to a full re-digest.
 */
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { createHash } from "node:crypto";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DIGEST_ROOT = join(homedir(), ".pi", "agent", "memory-search-cache", "sessions");
const MANIFEST_PATH = join(DIGEST_ROOT, "manifest.json");
/** Digest format version — bump to force a full rebuild when the line schema changes. */
const DIGEST_VERSION = 3;

interface ManifestEntry {
	size: number;
	mtimeMs: number;
	/** Bytes of the source already digested; always ends on a line boundary. */
	offset: number;
	/** Digest file name: `<sha1(relpath)[0:16]>-<basename>` — short, unique, safe for any depth. */
	digest: string;
}
interface Manifest {
	version: number;
	files: Record<string, ManifestEntry>;
}

export interface RefreshResult {
	/** Source files (re)digested in this call. */
	digested: number;
	/** Source files that could not be digested this call (unreadable); retried next call. */
	failed: number;
	/** Digests deleted because their source disappeared. */
	removed: number;
	/** False when the time budget stopped the sweep before every stale file was digested. */
	complete: boolean;
	/** Source files still awaiting digest (0 when complete). */
	pending: number;
}

export interface RefreshOptions {
	/** Wall-clock budget for digesting stale files. Default: no budget (finish). */
	budgetMs?: number;
	signal?: AbortSignal;
}

export function sessionDigestDir(): string {
	return DIGEST_ROOT;
}

/** Every digest file, newest source first. Empty until the first refresh. */
export function sessionDigestFiles(): string[] {
	const manifest = loadManifest();
	return Object.entries(manifest.files)
		.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
		.map(([, e]) => join(DIGEST_ROOT, e.digest));
}

/** Map a digest path back to its source session path (for hit locations). O(1). */
export function sessionSourceForDigest(digestPath: string): string | undefined {
	return reverseIndex().get(relative(DIGEST_ROOT, digestPath));
}

let manifestCache: Manifest | undefined;
let reverseCache: { manifest: Manifest; map: Map<string, string> } | undefined;
function reverseIndex(): Map<string, string> {
	const manifest = loadManifest();
	if (reverseCache?.manifest === manifest) return reverseCache.map;
	const map = new Map<string, string>();
	for (const [src, e] of Object.entries(manifest.files)) map.set(e.digest, src);
	reverseCache = { manifest, map };
	return map;
}
function loadManifest(): Manifest {
	if (manifestCache) return manifestCache;
	try {
		const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
		if (m.version === DIGEST_VERSION && m.files) return (manifestCache = m);
	} catch {
		/* missing or corrupt → rebuild */
	}
	return (manifestCache = { version: DIGEST_VERSION, files: {} });
}
function saveManifest(m: Manifest): void {
	mkdirSync(DIGEST_ROOT, { recursive: true });
	const tmp = `${MANIFEST_PATH}.tmp`;
	writeFileSync(tmp, JSON.stringify(m));
	renameSync(tmp, MANIFEST_PATH);
	manifestCache = m;
	reverseCache = undefined; // files were mutated in place — identity check is not enough
}

function walkSessionFiles(dir: string, out: Array<{ path: string; size: number; mtimeMs: number }>): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walkSessionFiles(p, out);
		else if (e.isFile() && e.name.endsWith(".jsonl")) {
			try {
				const st = statSync(p);
				out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
			} catch {
				/* vanished between readdir and stat */
			}
		}
	}
}

function digestNameFor(sourcePath: string): string {
	// Subagent runs nest 6+ levels deep; a flattened path exceeds the 255-byte
	// filename limit (ENAMETOOLONG on macOS/Linux). Hash the path instead and
	// keep the basename for human readability.
	const rel = relative(SESSIONS_ROOT, sourcePath);
	const hash = createHash("sha1").update(rel).digest("hex").slice(0, 16);
	return `${hash}-${basename(sourcePath).slice(-80)}`;
}

/** Same extraction rule as memory-search's live scan: user/assistant text only. */
function extractTurn(line: string): { ts: string | undefined; role: string; text: string } | null {
	let evt: unknown;
	try {
		evt = JSON.parse(line);
	} catch {
		return null; // half-written trailing line of a live session, or non-JSON noise
	}
	if (typeof evt !== "object" || evt === null) return null;
	const e = evt as Record<string, unknown>;
	if (e.type !== "message") return null;
	const m = e.message as Record<string, unknown> | undefined;
	if (!m) return null;
	const role = String(m.role ?? "?");
	if (role === "toolResult") return null;
	const content = m.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
				text += `${String((block as Record<string, unknown>).text ?? "")} `;
			}
		}
	}
	text = text.trim();
	if (!text) return null;
	return { ts: typeof e.timestamp === "string" ? e.timestamp : undefined, role, text };
}

/** True when the source's last byte is a newline, i.e. no partial trailing line. */
function endsWithNewline(sourcePath: string, size: number): boolean {
	if (size === 0) return true;
	const fd = openSync(sourcePath, "r");
	try {
		const buf = Buffer.alloc(1);
		readSync(fd, buf, 0, 1, size - 1);
		return buf[0] === 0x0a;
	} finally {
		closeSync(fd);
	}
}

/**
 * Digest `sourcePath` from byte `from` onward and return the new offset.
 *
 * Only complete (newline-terminated) lines are consumed: a live session's
 * half-written trailing line stays outside the offset so the next call sees it
 * again, whole. `from === 0` rewrites the digest atomically; a positive `from`
 * appends, which is what keeps a growing session cheap.
 */
async function digestOne(
	sourcePath: string,
	digestPath: string,
	signal?: AbortSignal,
	from = 0,
	size?: number,
): Promise<number> {
	const total = size ?? statSync(sourcePath).size;
	if (from >= total) return from;
	const complete = endsWithNewline(sourcePath, total);

	const out: string[] = [];
	let consumed = from;
	let pending: string | null = null;
	const rl = createInterface({ input: createReadStream(sourcePath, { encoding: "utf8", start: from }), crlfDelay: Infinity });
	for await (const line of rl) {
		if (signal?.aborted) throw new Error("aborted");
		// Hold one line back: readline cannot say whether the last one was
		// newline-terminated, and only the file's final line can be partial.
		if (pending !== null) {
			consumed += Buffer.byteLength(pending, "utf8") + 1;
			const t = extractTurn(pending);
			if (t) out.push(JSON.stringify(t));
		}
		pending = line;
	}
	if (pending !== null && complete) {
		consumed += Buffer.byteLength(pending, "utf8") + 1;
		const t = extractTurn(pending);
		if (t) out.push(JSON.stringify(t));
	}

	const text = out.length ? `${out.join("\n")}\n` : "";
	if (from === 0) {
		const tmp = `${digestPath}.tmp`;
		writeFileSync(tmp, text);
		renameSync(tmp, digestPath);
	} else if (text) {
		appendFileSync(digestPath, text);
	}
	return consumed;
}

/**
 * Bring the digest up to date with the sessions tree. Cheap when nothing
 * changed (one stat sweep, ~200 ms for 6 000 files). Stale files are digested
 * newest-first within `budgetMs`.
 */
export async function refreshSessionDigest(options: RefreshOptions = {}): Promise<RefreshResult> {
	let manifest = loadManifest();
	if (!existsSync(SESSIONS_ROOT)) return { digested: 0, failed: 0, removed: 0, complete: true, pending: 0 };
	// One check for the whole cache dir instead of one existsSync per digest
	// file (halves the syscalls of the no-op sweep). If someone wiped the cache,
	// the manifest is void: rebuild everything.
	if (!existsSync(DIGEST_ROOT)) {
		manifest = { version: DIGEST_VERSION, files: {} };
		manifestCache = manifest;
		reverseCache = undefined;
	}
	mkdirSync(DIGEST_ROOT, { recursive: true });

	const sources: Array<{ path: string; size: number; mtimeMs: number }> = [];
	walkSessionFiles(SESSIONS_ROOT, sources);
	const seen = new Set(sources.map((s) => s.path));

	// Remove digests whose source is gone.
	let removed = 0;
	for (const src of Object.keys(manifest.files)) {
		if (seen.has(src)) continue;
		try {
			rmSync(join(DIGEST_ROOT, manifest.files[src].digest), { force: true });
		} catch {
			/* already gone */
		}
		delete manifest.files[src];
		removed++;
	}

	// Stale = new, grown, or touched. Newest first so a budget cut drops old data.
	const stale = sources
		.filter((s) => {
			const e = manifest.files[s.path];
			return !e || e.size !== s.size || e.mtimeMs !== s.mtimeMs;
		})
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
	let digested = 0;
	let failed = 0;
	let i = 0;
	for (; i < stale.length; i++) {
		if (Date.now() >= deadline || options.signal?.aborted) break;
		const s = stale[i];
		const digest = digestNameFor(s.path);
		const digestPath = join(DIGEST_ROOT, digest);
		// Append-only tail read when the previous offset is still trustworthy:
		// the file only grew and its digest is where we left it. Anything else
		// (shrunk/rewritten source, digest wiped by hand) rebuilds from zero.
		const previous = manifest.files[s.path];
		const canAppend =
			previous !== undefined &&
			typeof previous.offset === "number" &&
			previous.offset > 0 &&
			s.size >= previous.offset &&
			previous.digest === digest &&
			existsSync(digestPath);
		const from = canAppend ? (previous as ManifestEntry).offset : 0;
		let offset: number;
		try {
			offset = await digestOne(s.path, digestPath, options.signal, from, s.size);
		} catch {
			if (options.signal?.aborted) break;
			failed++; // unreadable this time — one bad file must not block the rest
			continue;
		}
		// Record the size/mtime we READ, so a file that grew mid-digest re-digests next call.
		manifest.files[s.path] = { size: s.size, mtimeMs: s.mtimeMs, offset, digest };
		digested++;
	}
	if (digested > 0 || removed > 0) saveManifest(manifest);
	const pending = stale.length - i;
	// Failed files stay stale and are retried next call; they do not make the
	// sweep "incomplete" (that would spin forever on a permanently broken file).
	return { digested, failed, removed, complete: pending === 0, pending };
}
