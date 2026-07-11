import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const geminiModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME",
		"OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY",
		"TAVILY_API_KEY", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
		"WEB_SEARCH_PROXY_URL", "WEB_SEARCH_PROXY_KEY",
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

// AUTO mode: brave (earlier in the chain) returns an empty 200; the chain must
// keep falling through and return perplexity's non-empty result.
test("auto search falls through an empty provider to the next non-empty one", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-fallback-empty-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u.includes("brave.com")) {
				return new Response(JSON.stringify({ web: { results: [] } }),
					{ status: 200, headers: { "content-type": "application/json" } });
			}
			if (u.includes("perplexity.ai")) {
				return new Response(JSON.stringify({
					choices: [{ message: { content: "PPLX answer" } }],
					citations: ["https://example.com/a", "https://example.com/b"],
				}), { status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("unexpected fetch: " + u);
		};
		const { search } = await import(${JSON.stringify(geminiModuleUrl)});
		const r = await search("some query", { provider: "auto" });
		console.log(JSON.stringify({ provider: r.provider, answer: r.answer, n: r.results.length }));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
		PERPLEXITY_API_KEY: "pplx-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const r = JSON.parse(child.stdout.trim());
	assert.equal(r.provider, "perplexity", "should fall through empty brave to perplexity");
	assert.equal(r.answer, "PPLX answer");
	assert.ok(r.n >= 2);
});

// AUTO mode: every available provider empty → return the last empty response
// (from a real provider) rather than throwing.
test("auto search returns the last empty response when all providers are empty", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-fallback-allempty-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u.includes("brave.com")) {
				return new Response(JSON.stringify({ web: { results: [] } }),
					{ status: 200, headers: { "content-type": "application/json" } });
			}
			throw new Error("unexpected fetch: " + u);
		};
		const { search } = await import(${JSON.stringify(geminiModuleUrl)});
		const r = await search("some query", { provider: "auto" });
		console.log(JSON.stringify({ provider: r.provider, n: r.results.length }));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const r = JSON.parse(child.stdout.trim());
	assert.equal(r.provider, "brave", "last empty provider is returned, not thrown");
	assert.equal(r.n, 0);
});

// EXPLICIT mode stays strict: an empty brave result is returned as-is, no fallthrough.
test("explicit provider returns its empty result without fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-fallback-explicit-"));
	const child = runChild(`
		let perplexityCalled = false;
		globalThis.fetch = async (url) => {
			const u = String(url);
			if (u.includes("brave.com")) {
				return new Response(JSON.stringify({ web: { results: [] } }),
					{ status: 200, headers: { "content-type": "application/json" } });
			}
			if (u.includes("perplexity.ai")) { perplexityCalled = true; }
			throw new Error("unexpected fetch: " + u);
		};
		const { search } = await import(${JSON.stringify(geminiModuleUrl)});
		const r = await search("some query", { provider: "brave" });
		console.log(JSON.stringify({ provider: r.provider, n: r.results.length, perplexityCalled }));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
		PERPLEXITY_API_KEY: "pplx-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const r = JSON.parse(child.stdout.trim());
	assert.equal(r.provider, "brave");
	assert.equal(r.n, 0);
	assert.equal(r.perplexityCalled, false, "explicit mode must not fall back");
});
