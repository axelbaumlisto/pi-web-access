import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../session-digest.ts", import.meta.url).href;

// A "session line" as pi writes it. toolResult lines carry the bulk (file dumps);
// they are never searchable and must not reach the digest.
const turn = (role, text, ts = new Date().toISOString()) =>
	JSON.stringify({ type: "message", timestamp: ts, message: { role, content: [{ type: "text", text }] } });

function corpus(home) {
	const root = join(home, ".pi", "agent", "sessions");
	const a = join(root, "--Users-me-work-alpha--");
	const b = join(root, "--Users-me-work-beta--");
	mkdirSync(a, { recursive: true });
	mkdirSync(b, { recursive: true });
	writeFileSync(join(a, "2026-09-01T00-00-00-000Z_a1.jsonl"), [
		turn("user", "how do we bind proxy keys"),
		turn("assistant", "destination-first: proxied → proxy key only"),
		turn("toolResult", "x".repeat(200_000)),
		JSON.stringify({ type: "custom", data: "ignored" }),
	].join("\n") + "\n");
	writeFileSync(join(b, "2026-09-02T00-00-00-000Z_b1.jsonl"), [
		turn("assistant", "the zebra answer"),
	].join("\n") + "\n");
	return { root, a, b };
}

function run(home, body) {
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: `const m = await import(${JSON.stringify(moduleUrl)}); ${body}`,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

const refresh = (home, opts = "{}") =>
	run(home, `const r = await m.refreshSessionDigest(${opts}); console.log(JSON.stringify({ ...r, dir: m.sessionDigestDir() }));`);

test("first refresh digests every session file into text-only lines and drops toolResult dumps", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-digest-first-"));
	corpus(home);
	const r = refresh(home);
	assert.equal(r.complete, true);
	assert.equal(r.digested, 2);
	assert.ok(existsSync(r.dir));
	const files = readdirSync(r.dir).filter((f) => f.endsWith(".jsonl"));
	assert.equal(files.length, 2);
	const total = files.reduce((n, f) => n + statSync(join(r.dir, f)).size, 0);
	assert.ok(total < 2_000, `digest must be tiny (got ${total} bytes) — the 200 KB toolResult must be gone`);
	const all = files.map((f) => readFileSync(join(r.dir, f), "utf8")).join("");
	assert.match(all, /destination-first/);
	assert.doesNotMatch(all, /xxxxxxxx/);
	assert.doesNotMatch(all, /ignored/);
	// Digest lines keep exactly what the search pipeline consumes.
	const line = JSON.parse(all.split("\n").find((l) => l.includes("zebra")));
	assert.deepEqual(Object.keys(line).sort(), ["role", "text", "ts"]);
	assert.equal(line.role, "assistant");
});

test("second refresh is a no-op when nothing changed", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-digest-noop-"));
	corpus(home);
	refresh(home);
	const r = refresh(home);
	assert.equal(r.digested, 0);
	assert.equal(r.complete, true);
});

test("a grown (live) session file is re-digested; a deleted one has its digest removed", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-digest-delta-"));
	const { a, b } = corpus(home);
	const r1 = refresh(home);
	// Append to the live session (size grows, mtime moves).
	const live = join(a, "2026-09-01T00-00-00-000Z_a1.jsonl");
	writeFileSync(live, readFileSync(live, "utf8") + turn("assistant", "appended giraffe fact") + "\n");
	// Delete the other session entirely.
	rmSync(join(b, "2026-09-02T00-00-00-000Z_b1.jsonl"));
	const r2 = refresh(home);
	assert.equal(r2.digested, 1);
	assert.equal(r2.removed, 1);
	const files = readdirSync(r1.dir).filter((f) => f.endsWith(".jsonl"));
	assert.equal(files.length, 1);
	const text = readFileSync(join(r1.dir, files[0]), "utf8");
	assert.match(text, /giraffe/);
	assert.doesNotMatch(text, /zebra/);
});

test("refresh honours a time budget, digests newest-first, and reports incompleteness", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-digest-budget-"));
	const root = join(home, ".pi", "agent", "sessions", "--Users-me-work-big--");
	mkdirSync(root, { recursive: true });
	const old = Date.now() - 30 * 86_400_000;
	for (let i = 0; i < 40; i++) {
		const p = join(root, `2026-08-${String(1 + (i % 28)).padStart(2, "0")}T00-00-${String(i).padStart(2, "0")}-000Z_old${i}.jsonl`);
		writeFileSync(p, Array.from({ length: 300 }, (_, k) => turn("assistant", `old ${i} line ${k} ` + "p".repeat(2000))).join("\n") + "\n");
		utimesSync(p, old / 1000, old / 1000);
	}
	writeFileSync(join(root, "2026-09-04T00-00-00-000Z_newest.jsonl"), turn("assistant", "the newest session") + "\n");
	// A budget too small to finish 41 files (each ~600 KB of JSON to parse).
	const r = refresh(home, "{ budgetMs: 1 }");
	assert.equal(r.complete, false, "must report that not everything was digested");
	assert.ok(r.digested >= 1 && r.digested < 41, `digested ${r.digested}`);
	const files = readdirSync(r.dir).filter((f) => f.endsWith(".jsonl"));
	assert.ok(files.some((f) => f.includes("newest")), "newest file must be digested first");
	// A follow-up call with no budget finishes the job.
	const r2 = refresh(home);
	assert.equal(r2.complete, true);
	assert.equal(r2.digested + r.digested, 41);
});

test("digest survives a half-written trailing line and never records it as done", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-digest-partial-line-"));
	const { a } = corpus(home);
	const live = join(a, "2026-09-01T00-00-00-000Z_a1.jsonl");
	writeFileSync(live, readFileSync(live, "utf8") + '{"type":"message","timestamp":"2026-09-01T00:00:00Z","message":{"role":"assistant","content":[{"type":"text","text":"half wri');
	const r1 = refresh(home);
	assert.equal(r1.complete, true);
	// Complete the line; refresh must pick the file up again (size changed).
	writeFileSync(live, readFileSync(live, "utf8") + 'tten koala"}]}}\n');
	const r2 = refresh(home);
	assert.equal(r2.digested, 1);
	const files = readdirSync(r1.dir).filter((f) => f.endsWith(".jsonl"));
	const text = files.map((f) => readFileSync(join(r1.dir, f), "utf8")).join("");
	assert.match(text, /half written koala/);
});

test("deeply nested subagent sessions digest fine and one unreadable file does not block the sweep", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-digest-deep-"));
	const root = join(home, ".pi", "agent", "sessions", "--Users-me-work-proj--");
	// 8 levels of 60-char segments: a flattened name would be ~500 bytes (> 255 limit).
	let deep = root;
	for (let i = 0; i < 8; i++) deep = join(deep, `2026-04-10T08-59-23-943Z_${String(i).repeat(36)}`);
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, "2026-04-10T12-57-20-081Z_deepest.jsonl"), turn("assistant", "the octopus at the bottom") + "\n");
	// An unreadable sibling.
	const bad = join(root, "2026-09-03T00-00-00-000Z_bad.jsonl");
	writeFileSync(bad, turn("assistant", "unreadable"), { mode: 0o000 });
	writeFileSync(join(root, "2026-09-04T00-00-00-000Z_good.jsonl"), turn("assistant", "the good one") + "\n");
	const r = refresh(home);
	assert.equal(r.digested, 2, JSON.stringify(r));
	assert.equal(r.failed, 1);
	assert.equal(r.complete, true, "a broken file must not make the sweep incomplete forever");
	const text = readdirSync(r.dir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(r.dir, f), "utf8")).join("");
	assert.match(text, /octopus/);
	assert.match(text, /good one/);
	// Retried on the next call (still unreadable → failed again, still complete).
	const r2 = refresh(home);
	assert.equal(r2.failed, 1);
	assert.equal(r2.complete, true);
});
