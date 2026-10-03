import assert from "node:assert/strict";
import { test } from "node:test";

test("the summary prompt carries the evidence, not just titles and URLs", async () => {
	const { buildSummaryPrompt } = await import("../summary-review.ts");
	const results = [
		{
			query: "why peer",
			answer: "",
			provider: "memory_search",
			error: null,
			results: [
				{ title: "sessions · 2026-10-02 · fork", url: "/s/a1.jsonl", snippet: "typebox moved to peerDependencies so the host supplies it" },
				{ title: "docs · 2026-10-03 · fork", url: "/d/README.md", snippet: "a bundled copy bypasses pi's module mapping" },
			],
		},
	];

	const prompt = buildSummaryPrompt(results, undefined, undefined, "history");
	assert.match(prompt, /typebox moved to peerDependencies so the host supplies it/);
	assert.match(prompt, /a bundled copy bypasses pi's module mapping/);
	assert.match(prompt, /1\. sessions · 2026-10-02 · fork — \/s\/a1\.jsonl/);
});

test("snippets are bounded per source and per query so one huge match cannot flood the prompt", async () => {
	const { buildSummaryPrompt } = await import("../summary-review.ts");
	const huge = (n, ch) => ({ title: `t${n}`, url: `u${n}`, snippet: ch.repeat(50_000) });
	const results = [
		{
			query: "flood",
			answer: "",
			provider: "memory_search",
			error: null,
			results: Array.from({ length: 40 }, (_, i) => huge(i, String.fromCharCode(97 + (i % 26)))),
		},
	];

	const prompt = buildSummaryPrompt(results);
	// Per-source cap: no single snippet survives whole.
	assert.ok(!/a{601}/.test(prompt), "a 50 000-char snippet is truncated");
	assert.match(prompt, /…/, "truncation is visible to the model");
	// Per-query cap: the whole block stays far below the raw 2 000 000 chars.
	assert.ok(prompt.length < 20_000, `prompt stayed bounded, got ${prompt.length}`);
	// Every source is still listed, even when its snippet was dropped by budget.
	assert.match(prompt, /40\. t39 — u39/);
});

test("snippet budget shrinks when the provider already returned an answer", async () => {
	const { buildSummaryPrompt } = await import("../summary-review.ts");
	const sources = Array.from({ length: 30 }, (_, i) => ({
		title: `t${i}`,
		url: `https://e.example/${i}`,
		snippet: "z".repeat(5_000),
	}));

	const evidence = buildSummaryPrompt([{ query: "q", answer: "", provider: "p", error: null, results: sources }]);
	const corroboration = buildSummaryPrompt([
		{ query: "q", answer: "A full provider answer that already carries the substance.", provider: "p", error: null, results: sources },
	]);

	assert.ok(/z{600}/.test(evidence) && !/z{601}/.test(evidence), "no answer → 600-char snippets");
	assert.ok(/z{200}/.test(corroboration) && !/z{201}/.test(corroboration), "answer present → 200-char snippets");
	assert.ok(
		corroboration.length < evidence.length / 2,
		`corroboration prompt is far smaller: ${corroboration.length} vs ${evidence.length}`,
	);
});
