import assert from "node:assert/strict";
import test from "node:test";

/**
 * The unified gateway routes /v1/chat/completions and nothing else — measured
 * against the real proxy, /v1/search answers 405. Upstream moved Perplexity
 * onto the Search API, so without this split a proxied install loses the
 * provider entirely.
 */
test("a proxied Perplexity search goes through chat completions, not the Search API", async () => {
	process.env.WEB_SEARCH_PROXY_URL = "https://gateway.example.com";
	process.env.WEB_SEARCH_PROXY_KEY = "proxy-key";
	const endpoints = await import("../provider-endpoints.ts");
	endpoints.resetEndpointCache();

	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		return new Response(JSON.stringify({
			choices: [{ message: { content: "proxied answer [1]" } }],
			citations: ["https://example.com/a", "https://example.com/b"],
		}), { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		const { searchWithPerplexity } = await import("../perplexity.ts");
		const response = await searchWithPerplexity("test query", { numResults: 2 });

		assert.deepEqual(calls, ["https://gateway.example.com/v1/chat/completions"]);
		assert.equal(response.answer, "proxied answer [1]");
		assert.deepEqual(response.results.map((r) => r.url), ["https://example.com/a", "https://example.com/b"]);
	} finally {
		globalThis.fetch = originalFetch;
		delete process.env.WEB_SEARCH_PROXY_URL;
		delete process.env.WEB_SEARCH_PROXY_KEY;
		endpoints.resetEndpointCache();
	}
});
