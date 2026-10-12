import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

/**
 * ripgrep searches the files it is given in parallel and prints whichever
 * finishes first, so a single call plus a byte budget cuts an arbitrary set:
 * on a CI runner the newest session was dropped while old noise filled the
 * budget. The scan must therefore ask in batches, newest batch first.
 */
test("the second pass asks ripgrep in newest-first batches, never one giant call", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-scan-order-"));
	const agentDir = join(home, ".pi", "agent");
	const sessions = join(agentDir, "sessions", "--Users-me-work-proj--");
	mkdirSync(sessions, { recursive: true });

	// 20 sessions, one day apart; the name encodes the age so the log is readable.
	const day = 86_400_000;
	for (let i = 0; i < 20; i++) {
		const p = join(sessions, `age-${String(i).padStart(2, "0")}.jsonl`);
		writeFileSync(p, JSON.stringify({ type: "message", timestamp: new Date(Date.now() - i * day).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "zebra-token here" }] } }) + "\n");
		const t = (Date.now() - i * day) / 1000;
		utimesSync(p, t, t);
	}

	// A ripgrep that logs each call's file list and reports "no matches", so the
	// scan runs to the end and every batch is visible.
	const binDir = join(agentDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const log = join(home, "calls.txt");
	const rgPath = join(binDir, "rg");
	// Pass 1 (`-c`) must report a match in every file, or there is no pass 2 to
	// observe; pass 2 only has its file list recorded.
	writeFileSync(
		rgPath,
		[
			"#!/bin/sh",
			'for a in "$@"; do case "$a" in -c) counting=1;; esac; done',
			'if [ -n "$counting" ]; then',
			'  for a in "$@"; do case "$a" in /*) echo "$a:1";; esac; done',
			"  exit 0",
			"fi",
			`echo "$@" >> ${JSON.stringify(log)}`,
			"exit 1",
			"",
		].join("\n"),
	);
	chmodSync(rgPath, 0o755);

	const script = `
		const { searchMemory } = await import(${JSON.stringify(new URL("../memory-search.ts", import.meta.url).href)});
		await searchMemory("zebra-token", { scope: "all", sources: ["sessions"], limit: 10, cwd: "/tmp" });
	`;
	execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: script, encoding: "utf8",
		env: { ...process.env, HOME: home, PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PATH: join(agentDir, "empty") },
	});

	assert.ok(existsSync(log), "ripgrep was never called");
	// Pass 1 counts matches per token; pass 2 is what must be batched.
	const scanCalls = readFileSync(log, "utf8").trim().split("\n").filter((l) => l.includes("--no-heading"));
	assert.ok(scanCalls.length >= 2, `the scan must be batched, got ${scanCalls.length} call(s)`);

	const batches = scanCalls.map((line) => line.split(" ").filter((a) => a.includes("/memory-search-cache/")).length);
	assert.ok(batches.every((n) => n <= 8), `no batch may exceed 8 files, got ${batches.join(",")}`);
	assert.equal(batches.reduce((a, b) => a + b, 0), 20, "every session must still be scanned");
});
