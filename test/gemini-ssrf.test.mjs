import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const geminiSearchUrl = new URL("../gemini-search.ts", import.meta.url).href;
const geminiApiUrl = new URL("../gemini-api.ts", import.meta.url).href;

function cleanEnv(overrides = {}) {
	const env = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
	]) {
		delete env[key];
	}
	return { ...env, ...overrides };
}

function runChild(script, env) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: cleanEnv(env),
		maxBuffer: 2 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

async function runGroundingChunk(uri, location) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-ssrf-"));
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ geminiApiKey: "gemini-test-key" }) + "\n",
		"utf8",
	);

	return runChild(`
		const calls = [];
		globalThis.fetch = async (url, init = {}) => {
			calls.push({ url: url.toString(), method: init.method || "GET" });
			if (init.method === "HEAD") {
				return new Response(null, {
					status: 302,
					headers: { location: ${JSON.stringify(location)} },
				});
			}
			return new Response(JSON.stringify({
				candidates: [{
					content: { parts: [{ text: "Grounded answer" }] },
					groundingMetadata: {
						groundingChunks: [{ web: { title: "Source", uri: ${JSON.stringify(uri)} } }],
					},
				}],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { search } = await import(${JSON.stringify(geminiSearchUrl)});
		const result = await search("safe grounding", { provider: "gemini" });
		console.log(JSON.stringify({ calls, results: result.results }));
	`, { PI_CODING_AGENT_DIR: agentDir });
}

async function inspectGateway(apiHost) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-gateway-"));
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ geminiApiKey: "configured-key", cloudflareApiKey: "cf-key" }) + "\n",
		"utf8",
	);

	return runChild(`
		const { buildKeyParam, buildAuthHeaders } = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({
			keyParam: buildKeyParam("configured-key"),
			headers: buildAuthHeaders(),
		}));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		GOOGLE_GEMINI_BASE_URL: apiHost,
		CLOUDFLARE_API_KEY: "cf-key",
	});
}

test("exact HTTPS Google grounding redirect is HEAD-probed and resolved", async () => {
	const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/source";
	const resolved = "https://93.184.216.34/article";
	const output = await runGroundingChunk(redirect, resolved);

	assert.deepEqual(output.calls.filter(call => call.method === "HEAD"), [
		{ url: redirect, method: "HEAD" },
	]);
	assert.deepEqual(output.results, [{ title: "Source", url: resolved, snippet: "" }]);
});

test("substring-spoofed loopback grounding redirect is skipped without HEAD", async () => {
	const spoofed = "http://127.0.0.1/?vertexaisearch.cloud.google.com/grounding-api-redirect";
	const output = await runGroundingChunk(spoofed, "https://93.184.216.34/article");

	assert.deepEqual(output.calls.filter(call => call.method === "HEAD"), []);
	assert.deepEqual(output.results, []);
});

test("grounding redirect resolving to loopback is rejected", async () => {
	const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/private";
	const output = await runGroundingChunk(redirect, "https://127.0.0.1/admin");

	assert.equal(output.calls.filter(call => call.method === "HEAD").length, 1);
	assert.deepEqual(output.results, []);
});

test("lookalike grounding redirect path suffix is skipped without HEAD", async () => {
	const lookalike = "https://vertexaisearch.cloud.google.com/grounding-api-redirect-evil/source";
	const output = await runGroundingChunk(lookalike, "https://93.184.216.34/article");

	assert.deepEqual(output.calls.filter(call => call.method === "HEAD"), []);
	assert.deepEqual(output.results, []);
});

test("Cloudflare gateway detection uses parsed hostname boundaries", async () => {
	const evil = await inspectGateway("https://gateway.ai.cloudflare.com.evil.com/v1/account/gateway");
	assert.equal(evil.keyParam, "?key=configured-key");
	assert.deepEqual(evil.headers, {});

	const real = await inspectGateway("https://x.gateway.ai.cloudflare.com/v1/account/gateway");
	assert.equal(real.keyParam, "");
	assert.deepEqual(real.headers, { "cf-aig-authorization": "Bearer cf-key" });

	const direct = await inspectGateway("https://generativelanguage.googleapis.com");
	assert.equal(direct.keyParam, "?key=configured-key");
	assert.deepEqual(direct.headers, {});
});
