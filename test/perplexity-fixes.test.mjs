import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"PERPLEXITY_API_KEY",
		"PERPLEXITY_BASE_URL",
		"WEB_SEARCH_PROXY_URL",
		"WEB_SEARCH_PROXY_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

function parseChild(child) {
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

async function makeConfig(config = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-perplexity-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return agentDir;
}

test("Perplexity is available with only unified proxy config", async () => {
	const agentDir = await makeConfig({
		proxyBaseUrl: "https://proxy.example",
		proxyApiKey: "shared-proxy-key",
	});
	const child = runChild(`
		const { isPerplexityAvailable } = await import(${JSON.stringify(perplexityModuleUrl)});
		console.log(JSON.stringify({ available: isPerplexityAvailable() }));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
	});

	assert.deepEqual(parseChild(child), { available: true });
});

test("Perplexity preserves every citation even when numResults is lower", async () => {
	const agentDir = await makeConfig();
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			choices: [{ message: { content: "The supporting evidence is in source [8]." } }],
			citations: Array.from({ length: 9 }, (_, index) => index % 2 === 0
				? "https://example.com/source-" + (index + 1)
				: { title: "Named source " + (index + 1), url: "https://example.com/source-" + (index + 1) }),
		}), { status: 200, headers: { "content-type": "application/json" } });

		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
		const result = await searchWithPerplexity("cited answer", { numResults: 5 });
		console.log(JSON.stringify({ answer: result.answer, results: result.results }));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		PERPLEXITY_API_KEY: "perplexity-test-key",
	});

	const output = parseChild(child);
	assert.match(output.answer, /\[8\]/);
	assert.equal(output.results.length, 9);
	assert.deepEqual(
		output.results.map((result) => result.url),
		Array.from({ length: 9 }, (_, index) => `https://example.com/source-${index + 1}`),
	);
	assert.equal(output.results[7].title, "Named source 8");
});

test("Perplexity fetch has its own 30-second AbortSignal", async () => {
	const agentDir = await makeConfig();
	const child = runChild(`
		let timeoutMs = null;
		const timeoutController = new AbortController();
		timeoutController.abort(new DOMException("mock timeout", "TimeoutError"));
		AbortSignal.timeout = (ms) => {
			timeoutMs = ms;
			return timeoutController.signal;
		};

		let signalPassed = false;
		let signalAborted = false;
		globalThis.fetch = async (_url, init) => {
			signalPassed = init.signal instanceof AbortSignal;
			signalAborted = init.signal.aborted;
			return new Response(JSON.stringify({
				choices: [{ message: { content: "answer" } }],
				citations: [],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
		await searchWithPerplexity("timeout check");
		console.log(JSON.stringify({ timeoutMs, signalPassed, signalAborted }));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		PERPLEXITY_API_KEY: "perplexity-test-key",
	});

	assert.deepEqual(parseChild(child), {
		timeoutMs: 30000,
		signalPassed: true,
		signalAborted: true,
	});
});
