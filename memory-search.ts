/**
 * memory_search — search your own history instead of the web.
 *
 * Three sources, searched on the fly (no index yet — that comes later):
 *   1. pi sessions   — ~/.pi/agent/sessions/<project>/*.jsonl  (chat transcripts)
 *   2. claude-recall — ~/.claude-recall/claude-recall.db        (stored memories)
 *   3. markdown docs — *.md under the project (and ~/.pi/agent for scope=all)
 *
 * Scope:
 *   - "current" (default): the current project only. Sessions are the folder
 *     whose de-slugged path matches cwd; recall is project_id === basename(cwd)
 *     (plus universal memories); md docs are under cwd.
 *   - "all": every project on this machine. Sessions = all folders; recall =
 *     all rows; md docs = ~/work + ~/.pi/agent.
 *
 * Ranking is deliberately simple for now: keyword-overlap score × recency
 * boost. FTS5/BM25 is a later upgrade.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

export type MemoryScope = "current" | "all";
export type MemorySource = "sessions" | "memory" | "docs" | "git";

export interface MemoryHit {
	source: MemorySource;
	/** Short human label: session role / memory type / doc path. */
	label: string;
	/** The matched text snippet (already trimmed around the match). */
	snippet: string;
	/** Where it came from (session file, memory key, or doc path). */
	location: string;
	/** Project this belongs to (basename), or "universal". */
	project: string;
	/** Unix ms of the item (session event ts, memory ts, or file mtime). */
	timestamp: number;
	/** Final rank score (higher = better). */
	score: number;
}

export interface MemorySearchOptions {
	scope?: MemoryScope;
	sources?: MemorySource[];
	/** Only items newer than this many ms ago (e.g. "yesterday" → ~48h). */
	sinceMs?: number;
	/** Max hits to return. */
	limit?: number;
	/** cwd to resolve the current project from. */
	cwd?: string;
}

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const RECALL_DB = join(homedir(), ".claude-recall", "claude-recall.db");
const WORK_ROOT = join(homedir(), "work");
const PI_AGENT_ROOT = join(homedir(), ".pi", "agent");

// ── query + scoring ─────────────────────────────────────────────────────────

function tokenize(q: string): string[] {
	return q
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.filter((t) => t.length >= 2);
}

/**
 * Keyword-overlap score for `text` against query `tokens`. Counts occurrences
 * (capped per token) so a doc mentioning the query many times ranks higher,
 * but one spammy token can't dominate.
 */
function keywordScore(text: string, tokens: string[]): number {
	if (tokens.length === 0) return 0;
	const lower = text.toLowerCase();
	let score = 0;
	let matched = 0;
	for (const t of tokens) {
		let idx = lower.indexOf(t);
		if (idx === -1) continue;
		matched++;
		let count = 0;
		while (idx !== -1 && count < 5) {
			count++;
			idx = lower.indexOf(t, idx + t.length);
		}
		score += count;
	}
	if (matched === 0) return 0;
	// reward covering more distinct query tokens
	return score * (matched / tokens.length);
}

/** Recency multiplier: 1.0 now → ~0.5 at 30 days → asymptote 0.2. */
function recencyBoost(timestamp: number, now: number): number {
	const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
	return 0.2 + 0.8 / (1 + ageDays / 30);
}

/** Trim a snippet around the first matched token. */
function makeSnippet(text: string, tokens: string[], width = 240): string {
	const lower = text.toLowerCase();
	let pos = -1;
	for (const t of tokens) {
		const i = lower.indexOf(t);
		if (i !== -1 && (pos === -1 || i < pos)) pos = i;
	}
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (pos === -1) return collapsed.slice(0, width);
	// recompute pos on the collapsed string
	const cpos = collapsed.toLowerCase().indexOf(tokens.find((t) => lower.includes(t)) ?? "");
	const start = Math.max(0, (cpos === -1 ? 0 : cpos) - width / 3);
	const end = Math.min(collapsed.length, start + width);
	return (start > 0 ? "…" : "") + collapsed.slice(start, end) + (end < collapsed.length ? "…" : "");
}

// ── project resolution ──────────────────────────────────────────────────────

/** Slugified session-folder name for a given absolute path (pi's scheme). */
function sessionFolderForCwd(cwd: string): string {
	// pi slugs the absolute path: leading/every "/" → "-", wrapped in "--…--".
	const slug = cwd.replace(/\//g, "-");
	return `--${slug.replace(/^-+/, "").replace(/-+$/, "")}--`;
}

function currentProject(cwd: string): string {
	return basename(cwd) || "unknown";
}

// ── source: sessions ─────────────────────────────────────────────────────────

function extractMessageText(evt: unknown): { role: string; text: string } | null {
	if (typeof evt !== "object" || evt === null) return null;
	const e = evt as Record<string, unknown>;
	if (e.type !== "message") return null;
	const m = e.message as Record<string, unknown> | undefined;
	if (!m) return null;
	const role = String(m.role ?? "?");
	const content = m.content;
	let text = "";
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
				text += `${String((block as Record<string, unknown>).text ?? "")} `;
			}
		}
	}
	text = text.trim();
	// Skip empty / tool-only turns and giant tool dumps we don't want to surface.
	if (!text || role === "toolResult") return null;
	return { role, text };
}

function searchSessions(
	tokens: string[],
	scope: MemoryScope,
	cwd: string,
	sinceMs: number | undefined,
	now: number,
	perSourceCap: number,
): MemoryHit[] {
	if (!existsSync(SESSIONS_ROOT)) return [];
	const searchDirs =
		scope === "current"
			? [join(SESSIONS_ROOT, sessionFolderForCwd(cwd))].filter((d) => existsSync(d))
			: [SESSIONS_ROOT];
	if (searchDirs.length === 0) return [];

	// Use ripgrep to find matching LINES fast (scans 8GB in ~1.5s vs ~40s in JS).
	// We OR the tokens as a fixed-string alternation, case-insensitive, and get
	// back `file:linetext`. Then JSON.parse only the matched lines.
	const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	let out = "";
	try {
		out = execFileSync(
			"rg",
			[
				"-i",
				"--no-heading",
				"--no-line-number",
				"--with-filename",
				"--glob",
				"*.jsonl",
				"--max-columns",
				"1000000",
				"-e",
				pattern,
				...searchDirs,
			],
			{ encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
		);
	} catch (e) {
		// rg exits 1 when no matches — that's not an error.
		const status = (e as { status?: number }).status;
		if (status === 1) return [];
		if (status !== 0 && status !== undefined && status !== 1) {
			// rg missing or crashed → fall back to empty (docs/memory still work).
			return [];
		}
		out = String((e as { stdout?: Buffer | string }).stdout ?? "");
	}

	const mtimeCache = new Map<string, number>();
	const hits: MemoryHit[] = [];
	for (const row of out.split("\n")) {
		if (!row) continue;
		// rg output is `path:linecontent`; the path ends at the first `.jsonl:`.
		const sep = row.indexOf(".jsonl:");
		if (sep === -1) continue;
		const full = row.slice(0, sep + 6);
		const line = row.slice(sep + 7);
		if (!line) continue;

		let mtime = mtimeCache.get(full);
		if (mtime === undefined) {
			try {
				mtime = statSync(full).mtimeMs;
			} catch {
				mtime = 0;
			}
			mtimeCache.set(full, mtime);
		}

		let evt: unknown;
		try {
			evt = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = extractMessageText(evt);
		if (!msg) continue;
		const s = keywordScore(msg.text, tokens);
		if (s <= 0) continue;
		const ts = Number((evt as Record<string, unknown>).timestamp) || mtime;
		if (sinceMs !== undefined && ts < now - sinceMs) continue;

		const rel = full.startsWith(SESSIONS_ROOT) ? full.slice(SESSIONS_ROOT.length + 1) : full;
		const folder = rel.split("/")[0] ?? "";
		const project = folder.replace(/^--/, "").replace(/--$/, "").split("-").pop() || folder;
		hits.push({
			source: "sessions",
			label: msg.role,
			snippet: makeSnippet(msg.text, tokens),
			location: rel,
			project,
			timestamp: ts,
			score: s * recencyBoost(ts, now),
		});
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, perSourceCap);
}

// ── source: claude-recall memories ───────────────────────────────────────────

function searchRecall(
	tokens: string[],
	scope: MemoryScope,
	cwd: string,
	sinceMs: number | undefined,
	now: number,
	perSourceCap: number,
): MemoryHit[] {
	if (!existsSync(RECALL_DB)) return [];
	const proj = currentProject(cwd);
	// Pull active memories (optionally scoped) as TSV; parse value JSON for text.
	const where =
		scope === "current"
			? `is_active=1 AND (project_id='${proj.replace(/'/g, "''")}' OR scope='universal')`
			: `is_active=1`;
	const sql = `SELECT type, COALESCE(project_id,''), scope, timestamp, value FROM memories WHERE ${where};`;
	let out = "";
	try {
		out = execFileSync("sqlite3", ["-json", RECALL_DB, sql], {
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return [];
	}
	let rows: Array<Record<string, unknown>>;
	try {
		rows = JSON.parse(out || "[]");
	} catch {
		return [];
	}
	const hits: MemoryHit[] = [];
	for (const r of rows) {
		const type = String(r.type ?? "memory");
		const project = String(r["COALESCE(project_id,'')"] ?? r.project_id ?? "") || "universal";
		const scopeVal = String(r.scope ?? "");
		const tsRaw = Number(r.timestamp) || 0;
		// recall timestamps are unix ms already
		const ts = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
		if (sinceMs !== undefined && ts < now - sinceMs) continue;
		let text = String(r.value ?? "");
		try {
			const v = JSON.parse(text);
			if (v && typeof v === "object" && typeof v.content === "string") text = v.content;
		} catch {
			// value wasn't JSON — use raw
		}
		const s = keywordScore(text, tokens);
		if (s <= 0) continue;
		hits.push({
			source: "memory",
			label: type,
			snippet: makeSnippet(text, tokens),
			location: `recall:${type}`,
			project: scopeVal === "universal" ? "universal" : project,
			timestamp: ts,
			score: s * recencyBoost(ts, now) * 1.15, // slight boost: memories are curated
		});
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, perSourceCap);
}

// ── source: markdown docs ─────────────────────────────────────────────────────

function searchDocs(
	tokens: string[],
	scope: MemoryScope,
	cwd: string,
	sinceMs: number | undefined,
	now: number,
	perSourceCap: number,
): MemoryHit[] {
	const roots = (scope === "current" ? [cwd] : [WORK_ROOT, PI_AGENT_ROOT]).filter((r) => existsSync(r));
	if (roots.length === 0) return [];

	// ripgrep finds the matching .md FILES fast (respects .gitignore, skips
	// node_modules/.git by default). We then read+score only those files.
	const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	let out = "";
	try {
		out = execFileSync(
			"rg",
			["-l", "-i", "--glob", "*.md", "-e", pattern, ...roots],
			{ encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
		);
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (status === 1) return [];
		out = String((e as { stdout?: Buffer | string }).stdout ?? "");
		if (!out) return [];
	}

	const hits: MemoryHit[] = [];
	for (const full of out.split("\n")) {
		if (!full) continue;
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		const ts = st.mtimeMs;
		if (sinceMs !== undefined && ts < now - sinceMs) continue;
		let raw: string;
		try {
			raw = readFileSync(full, "utf-8");
		} catch {
			continue;
		}
		const s = keywordScore(raw, tokens);
		if (s <= 0) continue;
		hits.push({
			source: "docs",
			label: "md",
			snippet: makeSnippet(raw, tokens),
			location: full.replace(homedir(), "~"),
			project:
				scope === "current" ? basename(cwd) : (full.split("/work/")[1]?.split("/")[0] ?? "doc"),
			timestamp: ts,
			score: s * recencyBoost(ts, now),
		});
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, perSourceCap);
}

// ── source: git commit history ────────────────────────────────────────────────

const US = "\x1f"; // unit separator for --format parsing
// Filler / recency / meta words that carry no search signal for git — if only
// these remain, we switch to time-window mode (list all commits in the window).
const GIT_STOPWORDS = new Set<string>([
	// ru
	"поищи", "найди", "поиск", "история", "истории", "гит", "гите", "коммит", "коммитов",
	"коммиты", "дифф", "дифы", "диффы", "за", "последний", "последнюю", "последние",
	"месяц", "месяца", "неделя", "неделю", "неделе", "день", "вчера", "сегодня", "все", "всех",
	"прошлый", "прошлом", "прошлой", "этот", "этотм", "этой", "этом",
	// en
	"search", "find", "git", "history", "commit", "commits", "diff", "diffs",
	"last", "past", "this", "month", "week", "day", "yesterday", "today", "all", "the", "in", "for",
]);
const GIT_LOG_FMT = `%H${US}%at${US}%an${US}%s${US}%b`;
// How many top commit hits get their FULL diff expanded (capped per commit).
const GIT_EXPAND_TOP = 3;
const GIT_DIFF_MAX_LINES = 200;

function gitOut(repo: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", repo, ...args], {
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (e) {
		return String((e as { stdout?: Buffer | string }).stdout ?? "");
	}
}

/** Repos to search: the cwd's repo (current) or every git repo under ~/work (all). */
function gitRepos(scope: MemoryScope, cwd: string): string[] {
	if (scope === "current") {
		const top = gitOut(cwd, ["rev-parse", "--show-toplevel"]).trim();
		return top ? [top] : [];
	}
	if (!existsSync(WORK_ROOT)) return [];
	const repos: string[] = [];
	try {
		for (const name of readdirSync(WORK_ROOT)) {
			const dir = join(WORK_ROOT, name);
			if (existsSync(join(dir, ".git"))) repos.push(dir);
		}
	} catch {
		// ignore
	}
	return repos;
}

function searchGit(
	query: string,
	tokens: string[],
	scope: MemoryScope,
	cwd: string,
	sinceMs: number | undefined,
	now: number,
	perSourceCap: number,
): MemoryHit[] {
	const repos = gitRepos(scope, cwd);
	if (repos.length === 0) return [];
	const since = sinceMs !== undefined ? [`--since=${new Date(now - sinceMs).toISOString()}`] : [];

	// TIME-WINDOW mode: when the query has no real keywords left after stripping
	// the recency phrase (e.g. "поищи в гит истории за последний месяц"), just list
	// ALL commits in the window (newest first) and expand their diffs — no
	// keyword filtering.
	const contentTokens = tokens.filter((t) => !GIT_STOPWORDS.has(t));
	const windowMode = contentTokens.length === 0 && sinceMs !== undefined;

	const hits: MemoryHit[] = [];
	for (const repo of repos) {
		const project = basename(repo);
		const seen = new Set<string>();

		if (windowMode) {
			const raw = gitOut(repo, ["log", ...since, `--format=${GIT_LOG_FMT}${US}%x00`]);
			for (const rec of raw.split("\x00")) {
				const r = rec.trim();
				if (!r) continue;
				const [hash, at, , subject] = r.split(US);
				if (!hash || seen.has(hash)) continue;
				seen.add(hash);
				const ts = (Number(at) || 0) * 1000;
				hits.push({
					source: "git",
					label: "commit",
					snippet: subject.slice(0, 240),
					location: `${project}@${hash.slice(0, 9)}`,
					project,
					timestamp: ts || now,
					// rank purely by recency in window mode
					score: recencyBoost(ts || now, now),
					...({ _repo: repo, _hash: hash } as object),
				});
			}
			continue;
		}

		// Two passes: commit MESSAGES (--grep, all tokens OR'd, case-insensitive)
		// and diff CONTENT (pickaxe -G on the joined phrase). Merge, dedupe.
		const grepArgs = contentTokens.flatMap((t) => ["--grep", t]);
		const passes: string[][] = [
			["log", "-i", "--all", "--regexp-ignore-case", ...grepArgs, ...since,
				`--format=${GIT_LOG_FMT}${US}%x00`],
			["log", "-i", "--all", `-G${contentTokens.join("|")}`, ...since,
				`--format=${GIT_LOG_FMT}${US}%x00`],
		];
		for (let pass = 0; pass < passes.length; pass++) {
			const raw = gitOut(repo, passes[pass]);
			for (const rec of raw.split("\x00")) {
				const r = rec.trim();
				if (!r) continue;
				const [hash, at, , subject, body = ""] = r.split(US);
				if (!hash || seen.has(hash)) continue;
				seen.add(hash);
				const ts = (Number(at) || 0) * 1000;
				const msg = `${subject}\n${body}`.trim();
				// pass 0 scores on the message; pass 1 (diff match) gets a base score
				// since the hit is in code, not the message.
				const msgScore = keywordScore(msg, contentTokens);
				const s = pass === 0 ? Math.max(msgScore, 1) : Math.max(msgScore, 2);
				hits.push({
					source: "git",
					label: pass === 0 ? "commit" : "commit·diff",
					snippet: subject.slice(0, 240),
					location: `${project}@${hash.slice(0, 9)}`,
					project,
					timestamp: ts || now,
					score: s * recencyBoost(ts || now, now) * 1.05,
					// stash repo+hash for on-demand diff expansion
					...( { _repo: repo, _hash: hash } as object),
				});
			}
		}
	}
	hits.sort((a, b) => b.score - a.score);
	const top = hits.slice(0, perSourceCap);
	// Expand full diffs: a few for keyword search, more for a time-window sweep
	// ("all diffs this month").
	const expandCount = windowMode ? Math.min(top.length, perSourceCap) : GIT_EXPAND_TOP;
	for (let i = 0; i < expandCount && i < top.length; i++) {
		const h = top[i] as MemoryHit & { _repo?: string; _hash?: string };
		if (!h._repo || !h._hash) continue;
		const diff = gitOut(h._repo, ["show", "--stat", "--patch", "--format=%s%n%b", h._hash]);
		const lines = diff.split("\n");
		h.snippet =
			lines.slice(0, GIT_DIFF_MAX_LINES).join("\n") +
			(lines.length > GIT_DIFF_MAX_LINES ? `\n… (+${lines.length - GIT_DIFF_MAX_LINES} more lines)` : "");
	}
	return top;
}

// ── orchestrator ──────────────────────────────────────────────────────────────

export function searchMemory(query: string, opts: MemorySearchOptions = {}): MemoryHit[] {
	const tokens = tokenize(query);
	const scope = opts.scope ?? "current";
	// Default = "memory" in the user's sense: chat transcripts + recall memories.
	// Markdown docs and git history are opt-in (only when the caller asks).
	const sources = opts.sources ?? ["sessions", "memory"];
	const cwd = opts.cwd ?? process.cwd();
	const limit = opts.limit ?? 15;
	const now = Date.now();
	const perSourceCap = Math.max(limit, 10);

	// git in time-window mode works with zero content tokens ("all diffs this
	// month"); every other source needs at least one keyword.
	const gitWindowOnly =
		sources.includes("git") && opts.sinceMs !== undefined &&
		tokens.every((t) => GIT_STOPWORDS.has(t));
	if (tokens.length === 0 && !gitWindowOnly) return [];

	let hits: MemoryHit[] = [];
	if (sources.includes("sessions") && tokens.length > 0)
		hits = hits.concat(searchSessions(tokens, scope, cwd, opts.sinceMs, now, perSourceCap));
	if (sources.includes("memory") && tokens.length > 0)
		hits = hits.concat(searchRecall(tokens, scope, cwd, opts.sinceMs, now, perSourceCap));
	if (sources.includes("docs") && tokens.length > 0)
		hits = hits.concat(searchDocs(tokens, scope, cwd, opts.sinceMs, now, perSourceCap));
	if (sources.includes("git"))
		hits = hits.concat(searchGit(query, tokens, scope, cwd, opts.sinceMs, now, perSourceCap));

	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}

/**
 * Detect whether the query explicitly asks to include markdown documentation.
 * By default memory_search covers only chat + recall memories; docs are opt-in.
 */
export function wantsDocs(query: string): boolean {
	const q = query.toLowerCase();
	return /(документац|в доках|доках|\bdocs?\b|documentation|\bmarkdown\b|\b\.md\b|md-файл|md файл)/.test(q);
}

/**
 * Detect whether the query asks to search git commit history / diffs.
 * Opt-in like docs. Matches 'гит/git', 'коммит(ы)', 'дифф(ы)/diff', 'история
 * коммитов', 'commit history'.
 */
export function wantsGit(query: string): boolean {
	// \b doesn't work around Cyrillic; match гит/диф as substrings but keep the
	// Latin "git" bounded so words like "digit"/"legit" don't trigger.
	const q = query.toLowerCase();
	return /(\bgit\b|гит|коммит|commit|диф|\bdiff|commit history|git log)/.test(q);
}

/** Parse a natural-language recency hint into a lookback window (ms). */
export function parseRecency(query: string): number | undefined {
	// Note: \b word boundaries don't work with Cyrillic, so match on substrings.
	const q = query.toLowerCase();
	if (/(прошл\S* недел|last week|past week)/.test(q)) return 14 * 86_400_000;
	if (/(эт\S* недел|this week)/.test(q)) return 7 * 86_400_000;
	if (/(прошл\S* месяц|last month)/.test(q)) return 60 * 86_400_000;
	if (/(последн\S* месяц|за месяц|past month)/.test(q)) return 31 * 86_400_000;
	if (/(вчера|yesterday)/.test(q)) return 48 * 3600_000;
	if (/(сегодня|today)/.test(q)) return 24 * 3600_000;
	return undefined;
}

/** Render hits as a compact text block for the tool result. */
export function formatHits(hits: MemoryHit[], query: string): string {
	if (hits.length === 0) return `No matches in your history for "${query}".`;
	const lines: string[] = [`Found ${hits.length} match(es) for "${query}":`, ""];
	const tagOf = (s: MemorySource): string =>
		s === "sessions" ? "chat" : s === "memory" ? "memory" : s === "docs" ? "doc" : "git";
	for (const h of hits) {
		const d = new Date(h.timestamp);
		const date = Number.isFinite(h.timestamp) && h.timestamp > 0 ? d.toISOString().slice(0, 10) : "?";
		lines.push(`[${tagOf(h.source)} ${date}] ${h.label} · ${h.project}`);
		if (h.source === "git" && h.snippet.includes("\n")) {
			// expanded diff — render inside a fenced block, not indented
			lines.push(`  ↳ ${h.location}`);
			lines.push("```diff");
			lines.push(h.snippet);
			lines.push("```");
		} else {
			lines.push(`  ${h.snippet}`);
			lines.push(`  ↳ ${h.location}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}
