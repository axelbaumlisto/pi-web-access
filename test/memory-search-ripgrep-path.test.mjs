import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * Pi installs its own ripgrep into the agent bin directory and leaves that
 * directory off PATH. Calling a bare "rg" therefore works locally and fails on
 * a server that has no system ripgrep: two of three memory_search sources came
 * back as "tool missing/crashed" on exactly such a host.
 */
test("history search uses pi's own ripgrep when the system has none", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
	const binDir = join(agentDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const marker = join(agentDir, "called.txt");
	const rgPath = join(binDir, "rg");
	// ripgrep that only proves it ran: a real scan is not what is under test
	writeFileSync(rgPath, `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\nexit 1\n`);
	chmodSync(rgPath, 0o755);

	const previousAgentDir = process.env.PI_AGENT_DIR;
	const previousPath = process.env.PATH;
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PATH = join(agentDir, "empty");
	try {
		const { searchMemory } = await import(`../memory-search.ts?rgpath=${Date.now()}`);
		await searchMemory("anything", { scope: "all", sources: ["docs"], limit: 1, cwd: agentDir });

		const { existsSync } = await import("node:fs");
		assert.ok(existsSync(marker), "pi's own ripgrep was never called");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previousAgentDir;
		process.env.PATH = previousPath;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
