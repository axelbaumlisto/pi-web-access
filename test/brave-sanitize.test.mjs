import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "BRAVE_API_KEY", "BRAVE_BASE_URL"]) {
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

test("Brave search strips HTML and decodes entities in titles and snippets", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-sanitize-"));
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({
			web: { results: [{
				title: "<strong>Brave</strong> &amp; Search &#65; &#x42;",
				url: "https://example.com/brave",
				description: "<strong>foo</strong> &#x27;bar&#x27; &amp; baz &lt;x&gt;",
			}] },
		}), { status: 200, headers: { "content-type": "application/json" } });

		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("sanitize brave result", { numResults: 1 });
		console.log(JSON.stringify(result));
	`, {
		HOME: home,
		USERPROFILE: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.results[0].title, "Brave & Search A B");
	assert.equal(result.results[0].snippet, "foo 'bar' & baz <x>");
	assert.match(result.answer, /^foo 'bar' & baz <x>\nSource: Brave & Search A B/);
});
