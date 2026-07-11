import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { redactError } from "../redact.ts";

const perplexityModuleUrl = new URL("../perplexity.ts", import.meta.url).href;
const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;
const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;

const FAKE_OPENAI_KEY = `sk-proxy-${"A".repeat(32)}`;
const FAKE_GOOGLE_KEY = `AIza${"B".repeat(32)}`;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"WEB_SEARCH_PROXY_URL",
		"WEB_SEARCH_PROXY_KEY",
		"PERPLEXITY_API_KEY",
		"PERPLEXITY_BASE_URL",
		"EXA_API_KEY",
		"EXA_BASE_URL",
		"BRAVE_API_KEY",
		"BRAVE_BASE_URL",
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

async function agentDir(prefix) {
	return mkdtemp(join(tmpdir(), prefix));
}

test("redactError removes supported secret forms", () => {
	const input = [
		FAKE_OPENAI_KEY,
		FAKE_GOOGLE_KEY,
		"Bearer bearer-token-value",
		"https://example.test/path?key=query-secret&other=kept",
		"password=password-secret",
		"api_key: api-secret",
	].join(" ");

	const output = redactError(input, 1_000);
	assert.equal(output.includes(FAKE_OPENAI_KEY), false);
	assert.equal(output.includes(FAKE_GOOGLE_KEY), false);
	assert.equal(output.includes("bearer-token-value"), false);
	assert.equal(output.includes("query-secret"), false);
	assert.equal(output.includes("password-secret"), false);
	assert.equal(output.includes("api-secret"), false);
	assert.ok(output.match(/\[REDACTED\]/g)?.length >= 6);
});

test("redactError removes JSON-quoted password/api_key forms (HIGH 1)", () => {
	const jsonBody = '{"error":{"password":"topsecretvalue","api_key":"anothersecret","token":"quoted-token"}}';
	const output = redactError(jsonBody, 1_000);
	assert.equal(output.includes("topsecretvalue"), false);
	assert.equal(output.includes("anothersecret"), false);
	assert.equal(output.includes("quoted-token"), false);
	assert.ok(output.match(/\[REDACTED\]/g)?.length >= 3);

	// spaced-and-quoted variant
	const spaced = redactError('{ "password" : "spaced-secret" }', 1_000);
	assert.equal(spaced.includes("spaced-secret"), false);
	assert.match(spaced, /\[REDACTED\]/);
});

test("redactError key= param respects a query/form boundary (MEDIUM 4)", () => {
	// real query params are still redacted
	const redacted = redactError("https://x.test/?key=realsecret&monkey=fine", 1_000);
	assert.equal(redacted.includes("realsecret"), false);
	assert.match(redacted, /\[REDACTED\]/);
	// `monkey=` must NOT be treated as a `key=` param
	assert.equal(redactError("monkey=value", 1_000), "monkey=value");
	assert.match(redactError("a=1&key=zzz", 1_000), /\[REDACTED\]/);
});

test("redactError truncates before redaction and appends an ellipsis", () => {
	assert.equal(redactError("0123456789", 5), "01234…");
	assert.equal(redactError("short", 5), "short");
});

test("redactError redacts a secret partial left by truncation (MEDIUM 5)", () => {
	// max cuts through the key, leaving `sk-proxy-AAAAA` (< 16 chars after sk-)
	const text = `${"x".repeat(20)} sk-proxy-${"A".repeat(40)}`;
	const output = redactError(text, 35);
	assert.equal(output.includes("sk-proxy"), false);
	assert.match(output, /\[REDACTED\]/);
	assert.ok(output.endsWith("…"));
});

test("Perplexity upstream error message is redacted and bounded", async () => {
	const dir = await agentDir("pi-web-access-error-redaction-");
	const upstreamBody = `request echoed ${FAKE_OPENAI_KEY} and Bearer bearer-secret ${"x".repeat(600)}`;
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(upstreamBody)}, { status: 502 });
		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
		try {
			await searchWithPerplexity("redaction check");
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir, PERPLEXITY_API_KEY: "perplexity-test-key" }));
	assert.match(output.message, /^Perplexity API error 502: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
	assert.equal(output.message.includes("bearer-secret"), false);
	assert.ok(output.message.endsWith("…"));
	assert.ok(output.message.length <= "Perplexity API error 502: ".length + 301);
});

test("Perplexity invalid-JSON on a 200 is redacted (HIGH 3)", async () => {
	const dir = await agentDir("pi-web-access-perplexity-badjson-");
	// Secret at the body start: Node's JSON SyntaxError echoes the leading window.
	const body = `${FAKE_OPENAI_KEY} not-json`;
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "application/json" } });
		const { searchWithPerplexity } = await import(${JSON.stringify(perplexityModuleUrl)});
		try {
			await searchWithPerplexity("bad json");
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir, PERPLEXITY_API_KEY: "perplexity-test-key" }));
	assert.match(output.message, /^Perplexity API returned invalid JSON: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes("sk-proxy"), false);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
});

test("Exa direct API non-ok error body is redacted (integration)", async () => {
	const dir = await agentDir("pi-web-access-exa-nonok-");
	const body = `boom ${FAKE_OPENAI_KEY} ${"z".repeat(600)}`;
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 500 });
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		try {
			await searchWithExa("boom");
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir, EXA_API_KEY: "exa-test-key" }));
	assert.match(output.message, /^Exa API error 500: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
	assert.ok(output.message.endsWith("…"));
});

test("Exa direct API invalid-JSON on a 200 is redacted (HIGH 3)", async () => {
	const dir = await agentDir("pi-web-access-exa-badjson-");
	const body = `${FAKE_OPENAI_KEY} garbage`;
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "application/json" } });
		const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
		try {
			// includeContent forces the /search path (second json() site)
			await searchWithExa("garbage", { includeContent: true });
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir, EXA_API_KEY: "exa-test-key" }));
	assert.match(output.message, /^Exa API returned invalid JSON: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes("sk-proxy"), false);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
});

test("Exa MCP JSON-RPC error message is redacted on a 200 (HIGH 2)", async () => {
	const dir = await agentDir("pi-web-access-exa-mcp-error-");
	const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `failed with ${FAKE_OPENAI_KEY}` } });
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(rpc)}, { status: 200, headers: { "content-type": "application/json" } });
		const { callExaMcp } = await import(${JSON.stringify(exaModuleUrl)});
		try {
			await callExaMcp("web_search_exa", { query: "x" });
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir }));
	assert.match(output.message, /^Exa MCP error -32000: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
});

test("Exa MCP isError content is redacted on a 200 (HIGH 2)", async () => {
	const dir = await agentDir("pi-web-access-exa-mcp-iserror-");
	const rpc = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: { isError: true, content: [{ type: "text", text: `tool failed ${FAKE_OPENAI_KEY}` }] },
	});
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(rpc)}, { status: 200, headers: { "content-type": "application/json" } });
		const { callExaMcp } = await import(${JSON.stringify(exaModuleUrl)});
		try {
			await callExaMcp("web_search_exa", { query: "x" });
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir }));
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
});

test("Brave non-ok error body is redacted (integration)", async () => {
	const dir = await agentDir("pi-web-access-brave-nonok-");
	const body = `denied ${FAKE_GOOGLE_KEY} ${"q".repeat(600)}`;
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 403 });
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		try {
			await searchWithBrave("denied");
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir, BRAVE_API_KEY: "brave-test-key" }));
	assert.match(output.message, /^Brave Search API error 403: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes(FAKE_GOOGLE_KEY), false);
	assert.ok(output.message.endsWith("…"));
});

test("Brave invalid-JSON on a 200 is redacted (HIGH 3)", async () => {
	const dir = await agentDir("pi-web-access-brave-badjson-");
	const body = `${FAKE_OPENAI_KEY} not-json`;
	const script = `
		globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "application/json" } });
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		try {
			await searchWithBrave("bad json");
		} catch (error) {
			console.log(JSON.stringify({ message: error.message }));
		}
	`;
	const output = parseChild(runChild(script, { PI_CODING_AGENT_DIR: dir, BRAVE_API_KEY: "brave-test-key" }));
	assert.match(output.message, /^Brave Search API returned invalid JSON: /);
	assert.match(output.message, /\[REDACTED\]/);
	assert.equal(output.message.includes("sk-proxy"), false);
	assert.equal(output.message.includes(FAKE_OPENAI_KEY), false);
});
