import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractModuleUrl = new URL("../github-extract.ts", import.meta.url).href;

test("githubClone.enabled false skips GitHub clone/API specialization", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-github-disabled-"));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "web-search.json"),
		JSON.stringify({ githubClone: { enabled: false } }),
		"utf8",
	);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHub } = await import(${JSON.stringify(extractModuleUrl)});
			const result = await extractGitHub("https://github.com/owner/repo");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
		},
	});

	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout), null);
});
