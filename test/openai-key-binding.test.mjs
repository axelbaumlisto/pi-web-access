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
