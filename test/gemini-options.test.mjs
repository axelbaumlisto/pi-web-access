import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function runGeminiSearch(query, options, chunks) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-options-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ geminiApiKey: "gemini-test-key" }) + "\n", "utf8");

	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	for (const key of [
		"XDG_CONFIG_HOME",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
	]) {
		delete env[key];
	}

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			let capturedBody = null;
			globalThis.fetch = async (_url, init) => {
				capturedBody = JSON.parse(init.body);
				return new Response(JSON.stringify({
					candidates: [{
						content: { parts: [{ text: "Grounded answer" }] },
						groundingMetadata: { groundingChunks: ${JSON.stringify(chunks)} },
					}],
				}), { status: 200, headers: { "content-type": "application/json" } });
			};

			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const result = await search(${JSON.stringify(query)}, {
				provider: "gemini",
				...${JSON.stringify(options)},
			});
			console.log(JSON.stringify({ capturedBody, result }));
		`,
		encoding: "utf8",
		env,
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

function groundingChunks(count, duplicateAt = -1) {
	return Array.from({ length: count }, (_, index) => ({
		web: {
			title: `Source ${index + 1}`,
			uri: `https://example.com/${index === duplicateAt ? 0 : index}`,
		},
	}));
}

test("Gemini grounded request includes recency and domain constraints", async () => {
	const output = await runGeminiSearch("latest SDK news", {
		recencyFilter: "month",
		domainFilter: ["docs.example.com", "-spam.example.com"],
	}, groundingChunks(1));

	const prompt = output.capturedBody.contents[0].parts[0].text;
	assert.match(prompt, /^latest SDK news/);
	assert.match(prompt, /Only include results from the past month\./);
	assert.match(prompt, /Only cite sources from: docs\.example\.com/);
	assert.match(prompt, /Do not cite sources from: spam\.example\.com/);
});

test("Gemini grounding results are URL-deduped and capped to numResults", async () => {
	const output = await runGeminiSearch("dedupe sources", { numResults: 5 }, groundingChunks(10, 3));
	const urls = output.result.results.map((result) => result.url);

	assert.equal(urls.length, 5);
	assert.equal(new Set(urls).size, urls.length);
	assert.deepEqual(urls, [
		"https://example.com/0",
		"https://example.com/1",
		"https://example.com/2",
		"https://example.com/4",
		"https://example.com/5",
	]);
});

test("Gemini treats an invalid numResults as absent and returns all unique chunks", async () => {
	for (const numResults of [-3, 0, NaN]) {
		const output = await runGeminiSearch("invalid count", { numResults }, groundingChunks(7));
		const urls = output.result.results.map((result) => result.url);
		assert.equal(urls.length, 7, `numResults=${numResults} should not cap`);
		assert.equal(new Set(urls).size, urls.length);
	}
});

test("Gemini clamps an oversized numResults to the public max of 20", async () => {
	const output = await runGeminiSearch("oversized count", { numResults: 100 }, groundingChunks(25));
	assert.equal(output.result.results.length, 20);
});

test("Gemini floors a fractional numResults before capping", async () => {
	const output = await runGeminiSearch("fractional count", { numResults: 3.9 }, groundingChunks(7));
	assert.equal(output.result.results.length, 3);
});

test("Gemini plain query is sent bare and returns all unique chunks when numResults is omitted", async () => {
	const output = await runGeminiSearch("plain grounded query", {}, groundingChunks(7));

	assert.equal(output.capturedBody.contents[0].parts[0].text, "plain grounded query");
	assert.equal(output.result.answer, "Grounded answer");
	const urls = output.result.results.map((result) => result.url);
	assert.equal(urls.length, 7);
	assert.equal(new Set(urls).size, urls.length);
});
