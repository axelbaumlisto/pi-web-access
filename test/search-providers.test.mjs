import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;
const openaiModuleUrl = new URL("../openai-search.ts", import.meta.url).href;

function runChild(script, env) {
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: { ...process.env, ...env },
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("Brave search applies domain filters in the query and returned results", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({
				web: { results: [
					{ title: "GitHub", url: "https://github.com/nicobailon/pi-web-access", description: "repo" },
					{ title: "Gist", url: "https://gist.github.com/nicobailon/abc", description: "gist" },
					{ title: "Example", url: "https://example.com/nope", description: "example" },
				] },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("sdk docs", {
			domainFilter: ["github.com", "-gist.github.com"],
			numResults: 2,
		});
		const parsedUrl = new URL(capturedUrl);
		console.log(JSON.stringify({
			q: parsedUrl.searchParams.get("q"),
			count: parsedUrl.searchParams.get("count"),
			token: capturedHeaders["X-Subscription-Token"],
			results: result.results,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.match(output.q, /site:github\.com/);
	assert.match(output.q, /NOT site:gist\.github\.com/);
	assert.equal(output.count, "20");
	assert.equal(output.token, "brave-test-key");
	assert.deepEqual(output.results.map((result) => result.url), ["https://github.com/nicobailon/pi-web-access"]);
});

test("OpenAI search requires web_search and maps domain filters", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-openai-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init.headers;
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				output: [
					{
						type: "web_search_call",
						action: { sources: [{ title: "OpenAI Blog", url: "https://openai.com/blog?utm_source=openai" }] },
					},
					{
						type: "message",
						content: [{
							type: "output_text",
							text: "Answer from the web",
							annotations: [{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://openai.com/docs?utm_source=openai",
								title: "OpenAI Docs",
							}],
						}],
					},
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOpenAI } = await import(${JSON.stringify(openaiModuleUrl)});
		const result = await searchWithOpenAI("latest docs", {
			domainFilter: ["https://openai.com/docs", "-reddit.com"],
			numResults: 3,
		});
		console.log(JSON.stringify({
			url: capturedUrl,
			authorization: capturedHeaders.Authorization,
			body: capturedBody,
			results: result.results,
			answer: result.answer,
		}));
	`, {
		HOME: home,
		USERPROFILE: home,
		OPENAI_API_KEY: "sk-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.url, "https://api.openai.com/v1/responses");
	assert.equal(output.authorization, "Bearer sk-test-key");
	assert.equal(output.body.tool_choice, "required");
	assert.deepEqual(output.body.include, ["web_search_call.action.sources"]);
	assert.deepEqual(output.body.tools[0].filters, {
		allowed_domains: ["openai.com"],
		blocked_domains: ["reddit.com"],
	});
	assert.equal(output.answer, "Answer from the web");
	assert.deepEqual(output.results.map((result) => result.url), [
		"https://openai.com/docs",
		"https://openai.com/blog",
	]);
});
