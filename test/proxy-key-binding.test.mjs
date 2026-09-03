/**
 * Hermetic leak check for the unified proxy mode (F1/F2).
 *
 * Every keyed provider is exercised with FAKE personal keys in the environment
 * and a fake gateway configured. For fronted providers the request must go to
 * the gateway origin with the shared proxy key and NEVER carry a personal key;
 * for non-fronted providers the request must go to the vendor origin with the
 * personal key and NEVER carry the proxy key. Plus the negative case: gateway
 * configured but no proxy key → provider unavailable, no request at all.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const GATEWAY = "https://gateway.test";
const PROXY_KEY = "proxy-shared-key";

const PERSONAL = {
	OPENAI_API_KEY: "sk-personal-LEAK",
	PERPLEXITY_API_KEY: "pplx-personal-LEAK",
	EXA_API_KEY: "exa-personal-LEAK",
	BRAVE_API_KEY: "BSA-personal-LEAK",
	TAVILY_API_KEY: "tvly-personal-LEAK",
	GEMINI_API_KEY: "AIza-personal-LEAK",
};

const SCRUB = [
	"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME",
	"WEB_SEARCH_PROXY_URL", "WEB_SEARCH_PROXY_KEY", "GOOGLE_GEMINI_BASE_URL", "CLOUDFLARE_API_KEY",
	"EXA_BASE_URL", "BRAVE_BASE_URL", "TAVILY_BASE_URL", "PERPLEXITY_BASE_URL", "OPENAI_RESPONSES_URL",
	...Object.keys(PERSONAL),
];

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of SCRUB) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 4 * 1024 * 1024,
	});
}

function parseChild(child) {
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

async function makeConfig(config) {
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-leak-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return dir;
}

const mod = (name) => JSON.stringify(new URL(`../${name}.ts`, import.meta.url).href);

/**
 * Child script: mock fetch to record { origin, credentialHeaders } per call and
 * return a benign 200 JSON body that every provider parser accepts; then call
 * each provider and report what was sent.
 */
const driver = `
	const calls = [];
	const CRED_HEADERS = ["authorization", "x-subscription-token", "x-api-key", "x-goog-api-key", "cf-aig-authorization", "chatgpt-account-id"];
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
		const h = new Headers(init.headers ?? (typeof input !== "string" && input.headers) ?? {});
		const creds = {};
		for (const name of CRED_HEADERS) { const v = h.get(name); if (v) creds[name] = v; }
		calls.push({ origin: url.origin, path: url.pathname, creds });
		return new Response(JSON.stringify({
			answer: "ok",
			results: [{ title: "t", url: "https://example.com/", snippet: "s" }],
			citations: ["https://example.com/"],
			choices: [{ message: { content: "ok" } }],
			web: { results: [{ title: "t", url: "https://example.com/", description: "d" }] },
			output: [
				{ type: "web_search_call", action: { sources: [{ title: "t", url: "https://example.com/" }] } },
				{ type: "message", content: [{ type: "output_text", text: "ok" }] },
			],
			candidates: [{ content: { parts: [{ text: "ok" }] } }],
		}), { status: 200, headers: { "content-type": "application/json" } });
	};

	const report = {};
	async function run(name, fn) {
		const before = calls.length;
		try { await fn(); report[name] = { ok: true, calls: calls.slice(before) }; }
		catch (e) { report[name] = { ok: false, error: e.message, calls: calls.slice(before) }; }
	}

	const brave = await import(${mod("brave")});
	const exa = await import(${mod("exa")});
	const tavily = await import(${mod("tavily")});
	const pplx = await import(${mod("perplexity")});
	const openai = await import(${mod("openai-search")});
	const gemini = await import(${mod("gemini-api")});

	report.available = {
		brave: brave.isBraveAvailable(),
		exa: exa.hasExaApiKey(),
		tavily: tavily.isTavilyAvailable(),
		perplexity: pplx.isPerplexityAvailable(),
		openai: await openai.isOpenAISearchAvailable(),
		gemini: gemini.isGeminiApiAvailable(),
	};

	await run("brave", () => brave.searchWithBrave("q"));
	await run("exa", () => exa.searchWithExa("q"));
	await run("tavily", () => tavily.searchWithTavily("q"));
	await run("perplexity", () => pplx.searchWithPerplexity("q"));
	await run("openai", () => openai.searchWithOpenAI("q"));
	await run("gemini", async () => {
		const key = await gemini.getApiKey();
		await gemini.fetchGeminiApi(gemini.getVersionedApiBase() + "/models/x:generateContent", { method: "POST", body: "{}" }, key);
	});
	console.log(JSON.stringify(report));
`;

function assertNoLeak(calls, label) {
	for (const c of calls) {
		for (const [h, v] of Object.entries(c.creds)) {
			assert.equal(v.includes("LEAK"), false, `${label}: personal key leaked in ${h} to ${c.origin}${c.path}`);
		}
	}
}

test("gateway configured: fronted providers go to the gateway with ONLY the proxy key; non-fronted keep personal keys", async () => {
	const dir = await makeConfig({
		proxyBaseUrl: GATEWAY,
		proxyApiKey: PROXY_KEY,
		geminiBaseUrl: GATEWAY,
		geminiApiKey: PROXY_KEY,
	});
	const r = parseChild(runChild(driver, { PI_CODING_AGENT_DIR: dir, ...PERSONAL }));

	// fronted → gateway origin, proxy key, no LEAK
	for (const [name, header] of [["brave", "x-subscription-token"], ["exa", "x-api-key"], ["perplexity", "authorization"], ["openai", "authorization"], ["gemini", "x-goog-api-key"]]) {
		assert.equal(r[name].ok, true, `${name}: ${r[name].error}`);
		assert.ok(r[name].calls.length > 0, `${name}: no request recorded`);
		for (const c of r[name].calls) {
			assert.equal(c.origin, GATEWAY, `${name} went to ${c.origin}${c.path}`);
			const v = c.creds[header];
			assert.ok(v, `${name}: missing ${header}`);
			assert.equal(v.replace(/^Bearer\s+/i, ""), PROXY_KEY, `${name}: wrong credential on gateway`);
		}
		assertNoLeak(r[name].calls, name);
	}

	// not fronted → vendor origin, personal key, proxy key never sent
	assert.equal(r.tavily.ok, true, r.tavily.error);
	for (const c of r.tavily.calls) {
		assert.equal(c.origin, "https://api.tavily.com");
		assert.equal(c.creds.authorization, `Bearer ${PERSONAL.TAVILY_API_KEY}`);
		assert.equal(JSON.stringify(c.creds).includes(PROXY_KEY), false, "tavily: proxy key sent to vendor");
	}

	assert.deepEqual(r.available, { brave: true, exa: true, tavily: true, perplexity: true, openai: true, gemini: true });
});

test("gateway configured WITHOUT proxy key: fronted providers are unavailable and send nothing; personal keys never used", async () => {
	// The dangerous configuration: proxy URL via env, no proxy key anywhere
	// (e.g. the key was rotated out of the config). Before the destination-first
	// resolver this fell through to the personal key and sent it to the gateway.
	// (A *malformed* config file is a separate, louder failure: upstream
	// providers' loadConfig() throws "Failed to parse" before any request.)
	const dir = await makeConfig({});
	const r = parseChild(runChild(driver, { PI_CODING_AGENT_DIR: dir, WEB_SEARCH_PROXY_URL: GATEWAY, ...PERSONAL }));

	for (const name of ["brave", "exa", "perplexity", "openai"]) {
		assert.equal(r.available[name], false, `${name} should be unavailable (no destination-bound key)`);
	}
	for (const name of ["brave", "perplexity", "openai"]) {
		assert.equal(r[name].ok, false, `${name} should have thrown`);
		assert.equal(r[name].calls.length, 0, `${name} must not send a request without a destination-bound key`);
	}
	// Exa has a KEYLESS path (MCP) by design in both trees: with no key it falls
	// back to MCP under the proxy base. That request must carry NO credential at all.
	for (const c of r.exa.calls) {
		assert.equal(c.origin, GATEWAY);
		assert.match(c.path, /\/mcp$/);
		assert.deepEqual(c.creds, {}, "exa keyless MCP call must not carry any credential header");
	}
	// tavily is not fronted → still works with its personal key
	assert.equal(r.available.tavily, true);
	assert.equal(r.tavily.ok, true, r.tavily.error);
	assertNoLeak([...r.brave.calls, ...r.exa.calls, ...r.perplexity.calls, ...r.openai.calls], "no-proxy-key");
});

test("no gateway: every provider goes to its vendor origin with its personal key", async () => {
	const dir = await makeConfig({});
	const r = parseChild(runChild(driver, { PI_CODING_AGENT_DIR: dir, ...PERSONAL }));
	const expect = {
		brave: ["https://api.search.brave.com", "x-subscription-token", PERSONAL.BRAVE_API_KEY],
		exa: ["https://api.exa.ai", "x-api-key", PERSONAL.EXA_API_KEY],
		tavily: ["https://api.tavily.com", "authorization", `Bearer ${PERSONAL.TAVILY_API_KEY}`],
		perplexity: ["https://api.perplexity.ai", "authorization", `Bearer ${PERSONAL.PERPLEXITY_API_KEY}`],
		openai: ["https://api.openai.com", "authorization", `Bearer ${PERSONAL.OPENAI_API_KEY}`],
		gemini: ["https://generativelanguage.googleapis.com", "x-goog-api-key", PERSONAL.GEMINI_API_KEY],
	};
	for (const [name, [origin, header, value]] of Object.entries(expect)) {
		assert.equal(r[name].ok, true, `${name}: ${r[name].error}`);
		assert.ok(r[name].calls.length > 0, `${name}: no request`);
		for (const c of r[name].calls) {
			assert.equal(c.origin, origin, `${name} → ${c.origin}`);
			assert.equal(c.creds[header], value, `${name}: wrong credential`);
			assert.equal(JSON.stringify(c.creds).includes(PROXY_KEY), false);
		}
	}
});
