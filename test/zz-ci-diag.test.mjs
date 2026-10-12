import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

test("DIAG: what the digest sees on this runner", () => {
	const home = mkdtempSync(join(tmpdir(), "diag-"));
	const sessions = join(home, ".pi", "agent", "sessions", "--Users-me-work-proj--");
	mkdirSync(sessions, { recursive: true });
	const filler = "y".repeat(30_000);
	const oldTs = Date.now() - 40 * 86_400_000;
	for (let f = 0; f < 17; f++) {
		const lines = [];
		for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ type: "message", timestamp: new Date(oldTs).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `zebra-token old ${filler} ${i}` }] } }));
		const p = join(sessions, `2026-07-${String(10 + f).padStart(2, "0")}T00-00-00-000Z_old-${f}.jsonl`);
		writeFileSync(p, lines.join("\n") + "\n");
		utimesSync(p, oldTs / 1000, oldTs / 1000);
	}
	writeFileSync(join(sessions, "2026-09-04T12-00-00-000Z_new.jsonl"), JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "zebra-token NEWEST answer here" }] } }) + "\n");

	const url = new URL("../session-digest.ts", import.meta.url).href;
	const script = `
		const m = await import(${JSON.stringify(url)});
		const t0 = Date.now();
		const r = await m.refreshSessionDigest({ budgetMs: 6000 });
		const files = m.sessionDigestFiles();
		const names = files.map(m.sessionSourceForDigest).map(s => s && s.split("/").pop());
		console.log("DIAGOUT " + JSON.stringify({ ms: Date.now() - t0, refresh: r, count: files.length, first: names.slice(0,3), hasNewest: names.includes("2026-09-04T12-00-00-000Z_new.jsonl") }));

		// Сырой второй проход: сколько байт отдал rg, в каком порядке и что распарсилось.
		const ms = await import(${JSON.stringify(new URL("../memory-search.ts", import.meta.url).href)});
		const res = await ms.searchMemory("zebra-token", { scope: "all", sources: ["sessions"], limit: 10, cwd: "/tmp" });
		const { execFileSync } = await import("node:child_process");
		const rgPath = process.env.RG_PATH || "rg";
		let bytes = 0, firstFile = "", rows = 0;
		try {
			const raw = execFileSync(rgPath, ["-i","-F","--no-heading","--no-line-number","--with-filename","-e","zebra-token","--", ...files], { maxBuffer: 400*1024*1024, encoding: "utf8" });
			bytes = raw.length; rows = raw.split(String.fromCharCode(10)).length;
			const sep = raw.indexOf(".jsonl:");
			firstFile = (m.sessionSourceForDigest(raw.slice(0, sep + 6)) || "").split("/").pop();
		} catch (e) { firstFile = "ERR " + (e.message || "").slice(0, 60); }
		console.log("DIAGOUT2 " + JSON.stringify({ hits: res.hits.length, status: res.sourceStatus, rgBytes: bytes, rgRows: rows, rgFirstFile: firstFile }));
	`;
	const out = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module"], {
		input: script, encoding: "utf8",
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
	});
	console.log(out.trim());
});
