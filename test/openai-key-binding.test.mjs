import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"OPENAI_RESPONSES_URL",
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

function inspectOpenAIAuth(registryResult) {
	return `
		let registryCalls = 0;
		const ctx = {
			modelRegistry: {
				// upstream 0.27: resolvePiAuth lists models via getAll() and picks the
				// newest non-pro/ultra id ("terra" tier preferred).
				getAll: () => [{ provider: "openai-codex", id: "gpt-5.6-terra" }, { provider: "openai", id: "gpt-5.6-terra" }],
				getApiKeyAndHeaders: async () => {
					registryCalls += 1;
					return ${JSON.stringify(registryResult)};
				},
			},
		};
		const { isOpenAISearchAvailable, resolveOpenAIAuth } = await import(${JSON.stringify(openaiModuleUrl)});
		const auth = await resolveOpenAIAuth(ctx);
		const available = await isOpenAISearchAvailable(ctx);
		console.log(JSON.stringify({
			auth,
			available,
			registryCalls,
			destinationOrigin: auth ? new URL(auth.responsesUrl).origin : null,
		}));
	`;
}

async function makeAgentDir(prefix) {
	return mkdtemp(join(tmpdir(), prefix));
}

test("direct OpenAI destination uses the personal model-registry key", async () => {
	const agentDir = await makeAgentDir("pi-web-access-openai-direct-");
	const output = parseChild(runChild(inspectOpenAIAuth({
		ok: true,
		apiKey: "personal-openai-key",
		headers: { "x-personal-header": "present" },
	}), {
		PI_CODING_AGENT_DIR: agentDir,
	}));

	assert.equal(output.auth.provider, "openai-codex");
	assert.equal(output.auth.apiKey, "personal-openai-key");
	assert.equal(output.auth.responsesUrl, "https://api.openai.com/v1/responses");
	assert.equal(output.destinationOrigin, "https://api.openai.com");
	assert.deepEqual(output.auth.headers, { "x-personal-header": "present" });
	assert.equal(output.available, true);
	assert.ok(output.registryCalls > 0);
});

test("proxy destination skips and never returns the personal model-registry key", async () => {
	const agentDir = await makeAgentDir("pi-web-access-openai-proxy-personal-");
	const output = parseChild(runChild(inspectOpenAIAuth({
		ok: true,
		apiKey: "personal-openai-key",
		headers: { "x-personal-header": "must-not-leak" },
	}), {
		PI_CODING_AGENT_DIR: agentDir,
		WEB_SEARCH_PROXY_URL: "https://airpx.cc",
		WEB_SEARCH_PROXY_KEY: "shared-proxy-key",
	}));

	assert.equal(output.auth.apiKey, "shared-proxy-key");
	assert.equal(output.auth.responsesUrl, "https://airpx.cc/v1/responses");
	assert.equal(output.destinationOrigin, "https://airpx.cc");
	assert.deepEqual(output.auth.headers, {});
	assert.equal(output.auth.apiKey.includes("personal-openai-key"), false);
	assert.equal(output.registryCalls, 0);
	assert.equal(output.available, true);
});

test("proxy destination uses its shared key when no personal key exists", async () => {
	const agentDir = await makeAgentDir("pi-web-access-openai-proxy-only-");
	const output = parseChild(runChild(inspectOpenAIAuth({ ok: false }), {
		PI_CODING_AGENT_DIR: agentDir,
		WEB_SEARCH_PROXY_URL: "https://airpx.cc",
		WEB_SEARCH_PROXY_KEY: "shared-proxy-key",
	}));

	assert.equal(output.auth.apiKey, "shared-proxy-key");
	assert.equal(output.auth.responsesUrl, "https://airpx.cc/v1/responses");
	assert.equal(output.destinationOrigin, "https://airpx.cc");
	assert.equal(output.registryCalls, 0);
	assert.equal(output.available, true);
});

// Fork invariant (regression guard for the v0.35.0 merge): the chatgpt.com hop is
// decided from isCodexJwt(apiKey), so a JWT-SHAPED key issued by a gateway must not
// drag the request — and that gateway's key — to OpenAI's Codex backend. Before the
// merge this was enforced at the request site; it now rides on the auth object as
// useCodexEndpoint:false for every non-OpenAI destination.
const JWT_SHAPED_PROXY_KEY = [
	Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
	Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-gateway" } })).toString("base64url"),
	"signature",
].join(".");

function inspectRequestDestination() {
	return `
		const requests = [];
		globalThis.fetch = async (url, init) => {
			requests.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
			return new Response(JSON.stringify({ output: [
				{ type: "web_search_call", action: { sources: [] } },
				{ type: "message", content: [{ type: "output_text", text: "ok" }] },
			] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		await searchWithOpenAI("q", {});
		console.log(JSON.stringify({ requests }));
	`;
}

test("a JWT-shaped gateway key stays on the gateway instead of hopping to chatgpt.com", async () => {
	const agentDir = await makeAgentDir("pi-web-access-openai-proxy-jwt-");
	const env = {
		PI_CODING_AGENT_DIR: agentDir,
		WEB_SEARCH_PROXY_URL: "https://airpx.cc",
		WEB_SEARCH_PROXY_KEY: JWT_SHAPED_PROXY_KEY,
	};

	const auth = parseChild(runChild(inspectOpenAIAuth({ ok: false }), env));
	assert.equal(auth.auth.apiKey, JWT_SHAPED_PROXY_KEY);
	assert.equal(auth.destinationOrigin, "https://airpx.cc");
	// Pinned at credential-resolution time so no later heuristic can re-enable the hop.
	assert.equal(auth.auth.useCodexEndpoint, false);

	const { requests } = parseChild(runChild(inspectRequestDestination(), env));
	assert.equal(requests.length, 1);
	assert.equal(new URL(requests[0].url).origin, "https://airpx.cc");
	assert.equal(requests[0].authorization, `Bearer ${JWT_SHAPED_PROXY_KEY}`);
});

test("a JWT-shaped standalone key with no gateway still reaches only OpenAI", async () => {
	const agentDir = await makeAgentDir("pi-web-access-openai-direct-jwt-");
	const { requests } = parseChild(runChild(inspectRequestDestination(), {
		PI_CODING_AGENT_DIR: agentDir,
		OPENAI_API_KEY: JWT_SHAPED_PROXY_KEY,
	}));

	assert.equal(requests.length, 1);
	assert.equal(new URL(requests[0].url).origin, "https://chatgpt.com");
});
