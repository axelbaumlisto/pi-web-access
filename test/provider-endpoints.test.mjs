import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../provider-endpoints.ts", import.meta.url).href;

const SCRUB = [
	"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME",
	"WEB_SEARCH_PROXY_URL", "WEB_SEARCH_PROXY_KEY",
	"EXA_BASE_URL", "BRAVE_BASE_URL", "TAVILY_BASE_URL", "PERPLEXITY_BASE_URL", "PARALLEL_BASE_URL", "OPENAI_RESPONSES_URL",
	"EXA_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY", "PERPLEXITY_API_KEY", "PARALLEL_API_KEY", "OPENAI_API_KEY",
];

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of SCRUB) delete childEnv[key];
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
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-endpoints-"));
	await writeFile(join(dir, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return dir;
}

/** Resolve URLs + proxied flag for all providers; never prints key material. */
const inspectUrls = `
	const pe = await import(${JSON.stringify(moduleUrl)});
	const out = {};
	for (const p of ["exa", "brave", "perplexity", "tavily", "parallel", "openai"]) {
		let url = null, overridden = null, error = null;
		try { ({ url, overridden } = pe.resolveProviderEndpoint(p)); } catch (e) { error = e.message; }
		out[p] = { url, overridden, error, proxied: pe.isProxiedDestination(p) };
	}
	console.log(JSON.stringify(out));
`;

/**
 * Resolve the key for one provider with an injectable "!cmd" runner spy so we can
 * assert the personal-credential path was / was not consulted.
 */
function inspectKey(provider, { configuredValue, environmentValue } = {}) {
	return `
		const pe = await import(${JSON.stringify(moduleUrl)});
		let commandCalls = 0;
		const runCommand = async () => { commandCalls++; return { stdout: "personal-from-cmd\\n" }; };
		const opts = {
			configuredValue: ${JSON.stringify(configuredValue)},
			environmentValue: ${JSON.stringify(environmentValue)},
			runCommand,
		};
		let key = null, error = null;
		try { key = await pe.resolveProviderKey(${JSON.stringify(provider)}, opts); } catch (e) { error = e.message; }
		const has = pe.providerHasCredential(${JSON.stringify(provider)}, opts);
		console.log(JSON.stringify({ key, error, has, commandCalls, proxied: pe.isProxiedDestination(${JSON.stringify(provider)}) }));
	`;
}

// ---------------------------------------------------------------------------
// URL resolution: kind base|full, proxy paths, validation
// ---------------------------------------------------------------------------

test("no overrides: defaults are used, nothing is proxied", async () => {
	const dir = await makeConfig();
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir }));
	assert.equal(out.exa.url, "https://api.exa.ai");
	assert.equal(out.brave.url, "https://api.search.brave.com/res/v1/web/search");
	assert.equal(out.perplexity.url, "https://api.perplexity.ai/chat/completions");
	assert.equal(out.tavily.url, "https://api.tavily.com");
	assert.equal(out.parallel.url, "https://api.parallel.ai");
	assert.equal(out.openai.url, "https://api.openai.com/v1/responses");
	for (const p of Object.values(out)) {
		assert.equal(p.overridden, false);
		assert.equal(p.proxied, false);
		assert.equal(p.error, null);
	}
});

test("unified proxy: fronted providers resolve to proxy base + proxyPath (brave stays a FULL url)", async () => {
	const dir = await makeConfig({ proxyBaseUrl: "https://gateway.test", proxyApiKey: "proxy-K" });
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir }));
	assert.equal(out.exa.url, "https://gateway.test/v1/exa");
	assert.equal(out.brave.url, "https://gateway.test/v1/brave/search");
	assert.equal(out.perplexity.url, "https://gateway.test/v1/chat/completions");
	assert.equal(out.openai.url, "https://gateway.test/v1/responses");
	for (const p of ["exa", "brave", "perplexity", "openai"]) {
		assert.equal(out[p].overridden, true, p);
		assert.equal(out[p].proxied, true, p);
	}
	// not fronted by the gateway → defaults, not proxied
	assert.equal(out.tavily.url, "https://api.tavily.com");
	assert.equal(out.tavily.proxied, false);
	assert.equal(out.parallel.url, "https://api.parallel.ai");
	assert.equal(out.parallel.proxied, false);
});

test("per-provider override wins over proxy; brave override is a BASE and gets /web/search appended", async () => {
	const dir = await makeConfig({
		proxyBaseUrl: "https://gateway.test",
		proxyApiKey: "proxy-K",
		braveBaseUrl: "https://brave-gw.example/res/v1",
		exaBaseUrl: "https://exa-gw.example/",
	});
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir }));
	assert.equal(out.brave.url, "https://brave-gw.example/res/v1/web/search");
	assert.equal(out.brave.overridden, true);
	assert.equal(out.brave.proxied, false);
	assert.equal(out.exa.url, "https://exa-gw.example"); // trailing slash normalised
	assert.equal(out.exa.proxied, false);
	// perplexity still goes to the proxy
	assert.equal(out.perplexity.url, "https://gateway.test/v1/chat/completions");
	assert.equal(out.perplexity.proxied, true);
});

test("env override beats config override", async () => {
	const dir = await makeConfig({ exaBaseUrl: "https://from-config.example" });
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir, EXA_BASE_URL: "https://from-env.example" }));
	assert.equal(out.exa.url, "https://from-env.example");
});

test("explicit override equal to the default is NOT 'overridden' (exa MCP stays on mcp.exa.ai)", async () => {
	const dir = await makeConfig({ exaBaseUrl: "https://api.exa.ai" });
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir }));
	assert.equal(out.exa.url, "https://api.exa.ai");
	assert.equal(out.exa.overridden, false);
});

test("origin compare: a proxy-lookalike per-provider override is NOT proxied", async () => {
	const dir = await makeConfig({
		proxyBaseUrl: "https://gateway.test",
		proxyApiKey: "proxy-K",
		exaBaseUrl: "https://gateway.test.evil.example/v1/exa",
	});
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir }));
	assert.equal(out.exa.url, "https://gateway.test.evil.example/v1/exa");
	assert.equal(out.exa.proxied, false);
});

test("proxy base url is validated: http:// throws at URL resolution, availability paths do not throw", async () => {
	const dir = await makeConfig({ proxyApiKey: "proxy-K" });
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir, WEB_SEARCH_PROXY_URL: "http://gateway.test" }));
	assert.match(out.exa.error, /WEB_SEARCH_PROXY_URL must be an absolute HTTPS URL/);
	assert.equal(out.exa.url, null);
	assert.equal(out.exa.proxied, false); // isProxiedDestination never throws
	// a provider the proxy does not front is unaffected
	assert.equal(out.tavily.error, null);
	assert.equal(out.tavily.url, "https://api.tavily.com");
});

test("proxy base url is validated: embedded credentials are rejected", async () => {
	const dir = await makeConfig({ proxyBaseUrl: "https://user:pw@gateway.test", proxyApiKey: "proxy-K" });
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir }));
	assert.match(out.openai.error, /proxyBaseUrl .* must not include credentials/);
	assert.equal(out.openai.proxied, false);
});

test("per-provider override is validated: http:// and query strings throw", async () => {
	const dir = await makeConfig({ braveBaseUrl: "https://brave-gw.example/res/v1?x=1" });
	const out = parseChild(runChild(inspectUrls, { PI_CODING_AGENT_DIR: dir, TAVILY_BASE_URL: "http://insecure.example" }));
	assert.match(out.brave.error, /braveBaseUrl .* must not include query parameters/);
	assert.match(out.tavily.error, /TAVILY_BASE_URL must be an absolute HTTPS URL/);
});

// ---------------------------------------------------------------------------
// Key resolution: destination-first, never falls back to a personal key on the proxy
// ---------------------------------------------------------------------------

test("proxied destination → shared proxy key; the personal '!cmd' source is never run", async () => {
	const dir = await makeConfig({ proxyBaseUrl: "https://gateway.test", proxyApiKey: "proxy-K" });
	const out = parseChild(runChild(inspectKey("exa", { configuredValue: "!/bin/echo personal", environmentValue: "exa-personal-LEAK" }), {
		PI_CODING_AGENT_DIR: dir,
	}));
	assert.equal(out.proxied, true);
	assert.equal(out.key, "proxy-K");
	assert.equal(out.has, true);
	assert.equal(out.commandCalls, 0);
});

test("proxied destination WITHOUT a proxy key → null / unavailable; personal key is NOT used", async () => {
	// The dangerous case: proxy URL set (env), proxy key missing (e.g. malformed config json).
	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-endpoints-broken-"));
	await writeFile(join(dir, "web-search.json"), "{ this is not json", "utf8");
	const out = parseChild(runChild(inspectKey("openai", { configuredValue: undefined, environmentValue: "sk-personal-LEAK" }), {
		PI_CODING_AGENT_DIR: dir,
		WEB_SEARCH_PROXY_URL: "https://gateway.test",
	}));
	assert.equal(out.proxied, true);
	assert.equal(out.key, null);
	assert.equal(out.has, false);
	assert.equal(out.commandCalls, 0);
});

test("non-fronted provider under proxy → personal credential path ($ENV source honoured)", async () => {
	const dir = await makeConfig({ proxyBaseUrl: "https://gateway.test", proxyApiKey: "proxy-K" });
	const out = parseChild(runChild(inspectKey("tavily", { configuredValue: "$TAVILY_SCOPED", environmentValue: undefined }), {
		PI_CODING_AGENT_DIR: dir,
		TAVILY_SCOPED: "tvly-scoped",
	}));
	assert.equal(out.proxied, false);
	assert.equal(out.key, "tvly-scoped");
	assert.equal(out.has, true);
});

test("no proxy → personal credential path; '!cmd' source runs on resolve but not on availability check", async () => {
	const dir = await makeConfig();
	const out = parseChild(runChild(inspectKey("brave", { configuredValue: "!/bin/echo x", environmentValue: undefined }), {
		PI_CODING_AGENT_DIR: dir,
	}));
	assert.equal(out.proxied, false);
	assert.equal(out.key, "personal-from-cmd");
	assert.equal(out.has, true);
	assert.equal(out.commandCalls, 1);
});

test("invalid proxy url → treated as not proxied by the key path, personal env key is used", async () => {
	const dir = await makeConfig({ proxyApiKey: "proxy-K" });
	const out = parseChild(runChild(inspectKey("exa", { configuredValue: undefined, environmentValue: "exa-personal" }), {
		PI_CODING_AGENT_DIR: dir,
		WEB_SEARCH_PROXY_URL: "http://gateway.test",
	}));
	assert.equal(out.proxied, false);
	assert.equal(out.key, "exa-personal");
	assert.equal(out.has, true);
});

test("legacy sync resolvers are gone (single async key path)", async () => {
	const dir = await makeConfig();
	const out = parseChild(runChild(`
		const pe = await import(${JSON.stringify(moduleUrl)});
		console.log(JSON.stringify({
			providerApiKey: typeof pe.providerApiKey,
			providerProxyApiKey: typeof pe.providerProxyApiKey,
			normalizeBaseUrl: typeof pe.normalizeBaseUrl,
		}));
	`, { PI_CODING_AGENT_DIR: dir }));
	assert.deepEqual(out, { providerApiKey: "undefined", providerProxyApiKey: "undefined", normalizeBaseUrl: "undefined" });
});
