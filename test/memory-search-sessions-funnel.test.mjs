import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../memory-search.ts", import.meta.url).href;

// Reproduces the production failure: a query whose tokens include a corpus-wide
// common word ("model" appears on >50 % of real session lines). The old scan
// OR-ed every token, so rg emitted the whole corpus (10.8 GB measured), Node
// killed it at maxBuffer, and the surviving 2 % of output was whatever came
// first on disk — never the newest session. The answer was unfindable.
function buildCorpus(root, { oldFiles, linesPerFile, lineBytes }) {
	const sessions = join(root, ".pi", "agent", "sessions", "--Users-me-work-proj--");
	mkdirSync(sessions, { recursive: true });
	const filler = "x".repeat(lineBytes);
	const oldTs = Date.now() - 40 * 86_400_000;
	for (let f = 0; f < oldFiles; f++) {
		const lines = [];
		for (let i = 0; i < linesPerFile; i++) {
			// Every old line matches the common token "model" but never the rare one.
			lines.push(JSON.stringify({ type: "message", timestamp: new Date(oldTs).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `model output ${filler} ${i}` }] } }));
		}
		const p = join(sessions, `2026-07-${String(10 + (f % 19)).padStart(2, "0")}T00-00-0${f % 10}-000Z_old-${f}.jsonl`);
		writeFileSync(p, lines.join("\n") + "\n");
		utimesSync(p, oldTs / 1000, oldTs / 1000);
	}
	const newest = join(sessions, `2026-09-04T12-00-00-000Z_new.jsonl`);
	writeFileSync(newest, [
		JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "unrelated chatter about the model" }] } }),
		JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "openai — failed (400: built-in web_search not supported for bridged model gpt-5.6-terra)" }] } }),
	].join("\n") + "\n");
	return sessions;
}

// Bring the digest cache fully up to date (models a warm cache; the per-call
// budget inside memory_search is for cold starts and is tested separately).
function warm(home) {
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: `
			const { refreshSessionDigest } = await import(${JSON.stringify(new URL("../session-digest.ts", import.meta.url).href)});
			for (;;) { const r = await refreshSessionDigest(); if (r.complete) break; }
			console.log("{}");
		`,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
	});
	assert.equal(child.status, 0, child.stderr);
}

function search(home, query, extra = "") {
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: `
			const { searchMemory } = await import(${JSON.stringify(moduleUrl)});
			const t0 = Date.now();
			const r = await searchMemory(${JSON.stringify(query)}, { scope: "all", sources: ["sessions"], limit: 10, cwd: "/tmp" ${extra} });
			console.log(JSON.stringify({ ms: Date.now() - t0, status: r.sourceStatus, hits: r.hits.map(h => ({ snippet: h.snippet, location: h.location, ts: h.timestamp })) }));
		`,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("sessions scan finds a rare-token answer in the newest file behind a common-token flood", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-funnel-"));
	// ~300 MB of old lines all matching "model": above the 256 MB child-output
	// buffer a whole-corpus OR scan has, so the old code is killed mid-stream.
	buildCorpus(home, { oldFiles: 300, linesPerFile: 200, lineBytes: 5_000 });
	warm(home);

	const out = search(home, "airpx web_search openai 400 error model");
	assert.equal(out.status.sessions, "ok", `scan must not be truncated: ${JSON.stringify(out.status)}`);
	assert.ok(out.hits.length > 0, "expected at least one hit");
	assert.match(out.hits[0].snippet, /bridged model gpt-5\.6-terra/);
	assert.match(out.hits[0].location, /_new\.jsonl$/);
});

test("sessions scan ranks the discriminating token, not the flood", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-rank-"));
	buildCorpus(home, { oldFiles: 5, linesPerFile: 50, lineBytes: 200 });
	const out = search(home, "web_search model");
	// Only ONE line in the corpus contains web_search; it must be first even
	// though 250 other lines contain "model".
	assert.match(out.hits[0].snippet, /web_search/);
});

test("cold cache: the first search is time-bounded, finds the newest session, and says it is partial", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-time-"));
	buildCorpus(home, { oldFiles: 300, linesPerFile: 200, lineBytes: 5_000 });
	// No warm(): the search itself must digest newest-first within its budget.
	const out = search(home, "web_search model");
	assert.ok(out.ms < 15_000, `took ${out.ms} ms`);
	assert.match(out.hits[0]?.snippet ?? "", /web_search/, "newest file must be digested first and found");
	// Whether it finished depends on machine speed; if not, it must say so.
	assert.ok(["ok", "partial"].includes(out.status.sessions));
});

test("warm cache: a search over a large corpus is fast", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-warm-"));
	buildCorpus(home, { oldFiles: 300, linesPerFile: 200, lineBytes: 5_000 });
	warm(home);
	const out = search(home, "web_search model");
	assert.equal(out.status.sessions, "ok");
	assert.ok(out.ms < 5_000, `warm search took ${out.ms} ms`);
});

test("when the byte budget is hit, the NEWEST session survives and the scan is labelled partial", () => {
	// Flood where every line ALSO contains the discriminator, so the second pass
	// cannot filter and must be cut by the budget. The newest file must still win.
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-budget-"));
	const sessions = join(home, ".pi", "agent", "sessions", "--Users-me-work-proj--");
	mkdirSync(sessions, { recursive: true });
	const filler = "y".repeat(30_000); // under the 40 KB line cap → not elided
	const oldTs = Date.now() - 40 * 86_400_000;
	// ~250 MB of qualifying lines: 8500 × 30 KB. Above the 192 MB budget.
	for (let f = 0; f < 17; f++) {
		const lines = [];
		for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ type: "message", timestamp: new Date(oldTs).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `zebra-token old ${filler} ${i}` }] } }));
		const p = join(sessions, `2026-07-${String(10 + f).padStart(2, "0")}T00-00-00-000Z_old-${f}.jsonl`);
		writeFileSync(p, lines.join("\n") + "\n");
		utimesSync(p, oldTs / 1000, oldTs / 1000);
	}
	const newest = join(sessions, `2026-09-04T12-00-00-000Z_new.jsonl`);
	writeFileSync(newest, JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "zebra-token NEWEST answer here" }] } }) + "\n");

	const out = search(home, "zebra-token");
	assert.equal(out.status.sessions, "partial", "budget cut must be reported");
	assert.ok(out.hits.length > 0);
	assert.match(out.hits[0].snippet, /NEWEST answer here/, "newest hit must survive the budget cut");
});

function tinyCorpus(home, lines) {
	const sessions = join(home, ".pi", "agent", "sessions", "--Users-me-work-proj--");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, `2026-09-01T00-00-00-000Z_a.jsonl`), lines.map((text) =>
		JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } }),
	).join("\n") + "\n");
}

test("a Russian question word in the query never becomes the line filter", () => {
	// Only ONE line has the answer ("merge upstream"); a decoy line contains the
	// rare-in-corpus filler "какой" but not the answer. If "какой" were chosen as
	// discriminator (rarest token), the answer line would be unreachable.
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-stop-"));
	tinyCorpus(home, [
		"e8f93cd Merge upstream nicobailon/pi-web-access v0.27.0",
		"какой вариант выбрать — решай сам",
		"unrelated line about nothing",
	]);
	const out = search(home, "какой коммит merge upstream v0.27.0");
	assert.ok(out.hits.length > 0);
	assert.match(out.hits[0].snippet, /e8f93cd Merge upstream/);
});

test("a bare number in the query is not preferred as the line filter", () => {
	// "27" appears in ONE line, "flaky" in three. Pure rarity would pick "27" as
	// the line filter and only that line would ever be a candidate. The word must
	// win the tie-break so all "flaky" lines are candidates; the line covering
	// both tokens still ranks first on score.
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-memsearch-num-"));
	tinyCorpus(home, [
		"flaky test one",
		"flaky test two",
		"flaky test three with the number 27 inside",
	]);
	const out = search(home, "flaky 27");
	assert.equal(out.hits.length, 3, JSON.stringify(out.hits.map((h) => h.snippet)));
	assert.match(out.hits[0].snippet, /number 27 inside/);
});

// --- workflow parity with web_search ----------------------------------------

test("history hits adapt to the shared summary shape without inventing anything", async () => {
	const { hitsToQueryResults } = await import("../memory-search.ts");
	const hits = [
		{
			source: "sessions",
			label: "assistant",
			snippet: "destination-first: proxied → proxy key only",
			location: "/home/me/.pi/agent/sessions/--proj--/2026-09-01T00-00-00-000Z_a1.jsonl",
			project: "pi-web-access",
			timestamp: Date.UTC(2026, 8, 1),
			score: 3.5,
		},
		{
			source: "memory",
			label: "preference",
			snippet: "npm publish требует OTP",
			location: "recall:preference",
			project: "universal",
			timestamp: Date.UTC(2026, 9, 2),
			score: 1.25,
		},
	];

	const results = hitsToQueryResults("key binding", hits);

	assert.equal(results.length, 1, "one query block, like a single-query web search");
	assert.equal(results[0].query, "key binding");
	assert.equal(results[0].provider, "memory_search");
	assert.equal(results[0].answer, "", "history has no provider answer to quote");
	assert.equal(results[0].error, null);
	assert.deepEqual(
		results[0].results.map((r) => r.url),
		hits.map((h) => h.location),
		"the stable reference is carried verbatim — no fabricated URLs",
	);
	assert.match(results[0].results[0].title, /^sessions · 2026-09-01 · pi-web-access · assistant$/);
	assert.match(results[0].results[1].title, /^memory · 2026-10-02 · universal · preference$/);
	assert.equal(results[0].results[0].snippet, hits[0].snippet);
});

test("the history summary prompt keeps every web guardrail but drops the URL wording", async () => {
	const { buildSummaryPrompt } = await import("../summary-review.ts");
	const { hitsToQueryResults } = await import("../memory-search.ts");
	const results = hitsToQueryResults("key binding", [
		{
			source: "sessions",
			label: "assistant",
			snippet: "proxied → proxy key only",
			location: "/sessions/a1.jsonl",
			project: "pi-web-access",
			timestamp: Date.UTC(2026, 8, 1),
			score: 1,
		},
	]);

	const web = buildSummaryPrompt(results, undefined, undefined, "web");
	const history = buildSummaryPrompt(results, undefined, undefined, "history");

	for (const guardrail of ["Do not invent sources or claims.", "If evidence is weak or conflicting, say so explicitly."]) {
		assert.ok(web.includes(guardrail), `web prompt keeps: ${guardrail}`);
		assert.ok(history.includes(guardrail), `history prompt keeps: ${guardrail}`);
	}
	assert.match(web, /final web search summary/);
	assert.match(history, /the user's OWN history/);
	assert.match(web, /listing the most relevant URLs/);
	assert.match(history, /source · date · project`, never as URLs/);
	assert.match(history, /<history_matches>/);
	assert.doesNotMatch(history, /<search_results>/);

	// Custom requirements stay additive in both modes.
	const withInstructions = buildSummaryPrompt(results, undefined, "- Keep dates verbatim.", "history");
	assert.match(withInstructions, /- Keep dates verbatim\./);
	assert.match(withInstructions, /Do not invent sources or claims\./);
});

test("the deterministic fallback speaks history, not web", async () => {
	const { buildDeterministicSummary } = await import("../summary-review.ts");
	const { hitsToQueryResults } = await import("../memory-search.ts");
	const results = hitsToQueryResults("key binding", [
		{
			source: "sessions",
			label: "assistant",
			snippet: "proxied → proxy key only",
			location: "/sessions/a1.jsonl",
			project: "pi-web-access",
			timestamp: Date.UTC(2026, 8, 1),
			score: 1,
		},
	]);

	const web = buildDeterministicSummary(results).summary;
	const history = buildDeterministicSummary(results, "history").summary;
	assert.match(web, /currently selected search results/);
	assert.match(history, /matching history entries/);
	assert.doesNotMatch(history, /search results/);

	// Empty input keeps the same contract in both modes: a summary, never a throw.
	assert.match(buildDeterministicSummary([], "history").summary, /No history matches/);
	assert.match(buildDeterministicSummary([]).summary, /No completed search results/);
});

// --- default sources: hand-written markdown, not just chats and commits ------

/** Run searchMemory in a sandboxed HOME with whatever sources the caller wants. */
function searchDefaults(home, query, cwd, opts = "") {
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: `
			const { searchMemory } = await import(${JSON.stringify(moduleUrl)});
			const r = await searchMemory(${JSON.stringify(query)}, { cwd: ${JSON.stringify(cwd)}, limit: 20 ${opts} });
			console.log(JSON.stringify({
				status: r.sourceStatus,
				hits: r.hits.map(h => ({ source: h.source, location: h.location, snippet: h.snippet })),
			}));
		`,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("markdown is searched by default: project docs, CLAUDE.md, and the claude memory tree", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-memory-docs-default-"));
	const project = join(home, "work", "proj");
	mkdirSync(project, { recursive: true });
	mkdirSync(join(home, ".claude", "memory", "entities", "decisions"), { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });

	writeFileSync(join(project, "README.md"), "# proj\n\nThe quokka protocol handshake is documented here.\n");
	writeFileSync(join(project, "CLAUDE.md"), "Project rule: never deploy the quokka protocol on Friday.\n");
	writeFileSync(join(home, ".claude", "memory", "entities", "decisions", "quokka.md"), "Decision: quokka protocol replaces the legacy ping.\n");
	writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "Global instruction: quokka protocol needs a changelog entry.\n");

	const out = searchDefaults(home, "quokka protocol", project);
	assert.equal(out.status.docs, "ok", "docs ran without being asked for");
	const locations = out.hits.filter((h) => h.source === "docs").map((h) => h.location);
	for (const expected of ["README.md", "CLAUDE.md", "quokka.md", "AGENTS.md"]) {
		assert.ok(
			locations.some((l) => l.endsWith(expected)),
			`${expected} is reachable by default — got ${JSON.stringify(locations)}`,
		);
	}
});

test("git stays opt-in while docs do not", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-memory-git-optin-"));
	const project = join(home, "work", "proj");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "notes.md"), "the wombat migration is finished\n");

	const plain = searchDefaults(home, "wombat migration", project);
	assert.equal(plain.status.docs, "ok");
	assert.equal(plain.status.git, undefined, "git must not run for a question that never mentions it");

	const explicit = searchDefaults(home, "wombat migration", project, `, sources: ["docs"]`);
	assert.equal(explicit.status.docs, "ok");
	assert.equal(explicit.status.sessions, undefined, "an explicit list still narrows the search");
	assert.equal(explicit.status.memory, undefined);
});
