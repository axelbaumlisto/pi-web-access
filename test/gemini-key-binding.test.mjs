import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const geminiApiUrl = new URL("../gemini-api.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"GEMINI_API_KEY",
		"GOOGLE_GEMINI_BASE_URL",
		"CLOUDFLARE_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
}

async function makeConfig(config = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-gemini-key-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return agentDir;
}

const inspectGeminiKey = `
	const {
		getApiKey,
		getApiHost,
		buildKeyParam,
		buildAuthHeaders,
		isGeminiApiAvailable,
	} = await import(${JSON.stringify(geminiApiUrl)});
	const apiKey = getApiKey();
	console.log(JSON.stringify({
		apiHost: getApiHost(),
		apiKey,
		keyParam: buildKeyParam(apiKey),
		headers: buildAuthHeaders(),
		available: isGeminiApiAvailable(),
	}));
`;

function parseChild(child) {
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("direct Google host uses ambient GEMINI_API_KEY", async () => {
	const agentDir = await makeConfig();
	const output = parseChild(runChild(inspectGeminiKey, {
		PI_CODING_AGENT_DIR: agentDir,
		GEMINI_API_KEY: "personal-google-key",
	}));

	assert.deepEqual(output, {
		apiHost: "https://generativelanguage.googleapis.com",
		apiKey: "personal-google-key",
		keyParam: "?key=personal-google-key",
		headers: {},
		available: true,
	});
});

test("override host never receives ambient GEMINI_API_KEY", async () => {
	const agentDir = await makeConfig({ geminiBaseUrl: "https://airpx.cc" });
	const output = parseChild(runChild(inspectGeminiKey, {
		PI_CODING_AGENT_DIR: agentDir,
		GEMINI_API_KEY: "personal-google-key",
	}));

	assert.equal(output.apiHost, "https://airpx.cc");
	assert.equal(output.apiKey, null);
	assert.equal(output.keyParam, "");
	assert.equal(output.keyParam.includes("personal-google-key"), false);
	assert.equal(output.available, false);
});

test("override host uses explicitly configured Gemini key", async () => {
	const agentDir = await makeConfig({
		geminiBaseUrl: "https://airpx.cc",
		geminiApiKey: "explicit-proxy-key",
	});
	const output = parseChild(runChild(inspectGeminiKey, {
		PI_CODING_AGENT_DIR: agentDir,
		GEMINI_API_KEY: "personal-google-key",
	}));

	assert.equal(output.apiHost, "https://airpx.cc");
	assert.equal(output.apiKey, "explicit-proxy-key");
	assert.equal(output.keyParam, "?key=explicit-proxy-key");
	assert.equal(output.keyParam.includes("personal-google-key"), false);
	assert.equal(output.available, true);
});

test("Cloudflare gateway keeps key param empty and uses cf-aig auth", async () => {
	const agentDir = await makeConfig({ geminiApiKey: "explicit-google-key" });
	const output = parseChild(runChild(inspectGeminiKey, {
		PI_CODING_AGENT_DIR: agentDir,
		GOOGLE_GEMINI_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio",
		GEMINI_API_KEY: "personal-google-key",
		CLOUDFLARE_API_KEY: "cloudflare-gateway-key",
	}));

	assert.equal(output.keyParam, "");
	assert.deepEqual(output.headers, {
		"cf-aig-authorization": "Bearer cloudflare-gateway-key",
	});
	assert.equal(output.available, true);
});
