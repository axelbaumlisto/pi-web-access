import assert from "node:assert/strict";
import test from "node:test";

// The search URL has to follow the configured chat URL: otherwise an override
// or the unified proxy moves half of Perplexity and leaves the rest public.
test("the Perplexity search URL follows the configured chat URL", async () => {
	const mod = await import("../provider-endpoints.ts");
	assert.equal(mod.perplexitySearchUrl(), "https://api.perplexity.ai/search");

	process.env.PERPLEXITY_BASE_URL = "https://gateway.example.com/v1/chat/completions";
	mod.resetEndpointCache();
	assert.equal(mod.perplexitySearchUrl(), "https://gateway.example.com/v1/search");

	// An endpoint without the known suffix is used verbatim rather than guessed at.
	process.env.PERPLEXITY_BASE_URL = "https://gateway.example.com/pplx";
	mod.resetEndpointCache();
	assert.equal(mod.perplexitySearchUrl(), "https://gateway.example.com/pplx");

	delete process.env.PERPLEXITY_BASE_URL;
	mod.resetEndpointCache();
});
