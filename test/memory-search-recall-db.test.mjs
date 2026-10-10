import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The memory source used to shell out to the sqlite3 CLI, which nobody
 * installs: on a phone without it the source reported "crashed" and the tool
 * answered that there were no matches at all. Node reads the database itself.
 */
test("recall memories are read without the sqlite3 CLI", async (t) => {
	let DatabaseSync;
	try {
		({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
	} catch {
		t.skip("this runtime has no built-in SQLite");
		return;
	}

	const home = mkdtempSync(join(tmpdir(), "recall-home-"));
	const dbDir = join(home, ".claude-recall");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(dbDir, { recursive: true });
	const db = new DatabaseSync(join(dbDir, "claude-recall.db"));
	db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, type TEXT, project_id TEXT, scope TEXT,
		timestamp INTEGER, value TEXT, is_active INTEGER)`);
	db.prepare(`INSERT INTO memories (type, project_id, scope, timestamp, value, is_active)
		VALUES ('preference', 'proj', 'universal', ?, ?, 1)`)
		.run(Date.now(), JSON.stringify({ content: "ripgrep lives in the agent bin directory" }));
	db.close();

	const previousHome = process.env.HOME;
	process.env.HOME = home;
	// PATH without sqlite3: the point is that the CLI is not needed at all.
	const previousPath = process.env.PATH;
	process.env.PATH = join(home, "empty");
	try {
		const { searchMemory } = await import(`../memory-search.ts?recalldb=${Date.now()}`);
		const hits = await searchMemory("ripgrep", { scope: "all", sources: ["memory"], limit: 5, cwd: home });

		assert.ok(hits.hits.length >= 1, "the memory source returned nothing without sqlite3");
		assert.notEqual(hits.status?.memory, "failed");
	} finally {
		process.env.HOME = previousHome;
		process.env.PATH = previousPath;
		rmSync(home, { recursive: true, force: true });
	}
});
