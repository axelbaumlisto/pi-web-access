#!/usr/bin/env node
/**
 * Does this build actually answer on the machines that run it?
 *
 * Two releases in a row shipped green: tests passed, audit was clean, the
 * version installed everywhere — and the feature was dead in the field.
 * Perplexity hit a gateway route that answers 405, and history search called a
 * ripgrep that is not on a server's PATH, so the tool replied "no matches in
 * your history". A confident empty answer is the failure mode that gets
 * through every other gate, so here an empty answer counts as a failure.
 *
 * Each capability is exercised through a real `pi -p` on each host, and the
 * answer must carry the marker the probe asked for.
 *
 *   node scripts/smoke-fleet.mjs                      # every host in HOSTS
 *   node scripts/smoke-fleet.mjs --hosts mac,airpx    # a subset
 *   node scripts/smoke-fleet.mjs --probes memory      # a subset of probes
 *   node scripts/smoke-fleet.mjs --timeout 180        # per probe, seconds
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const HOSTS = ["mac", "gene", "airpx", "grep_app", "spex", "pixel", "astra"];

/**
 * A probe asks for one verifiable fact. `expect` is what a working answer must
 * contain; `reject` catches the polite failures a model will otherwise narrate
 * as success.
 */
const PROBES = {
	memory: {
		title: "memory_search",
		prompt:
			"Call memory_search with the query \"claude-recall\" and reply with exactly one line: " +
			"OK <number of hits> if there is at least one hit, or EMPTY if there are none, " +
			"or FAILED <reason> if a source CRASHED or was MISSING. A truncated scan is not a failure. Nothing else.",
		expect: /\bOK\s+[1-9]/i,
		reject: /\bEMPTY\b|\bFAILED\b|no matches/i,
		// A truncated scan returns real hits, just not all of them.
		warn: /TRUNCATED|усеч/i,
	},
	websearch: {
		title: "web_search (configured provider)",
		prompt:
			"Call web_search with the query \"pi coding agent\" and reply with exactly one line: " +
			"OK <number of results> <first domain>, or FAILED <error text> if the provider failed. Nothing else.",
		expect: /\bOK\s+[1-9]/i,
		reject: /\bFAILED\b|\bEMPTY\b/i,
	},
	perplexity: {
		title: "web_search via perplexity",
		prompt:
			"Call web_search with provider \"perplexity\" and the query \"pi coding agent\" and reply with exactly " +
			"one line: OK <number of results>, or FAILED <error text>. Nothing else.",
		expect: /\bOK\s+[1-9]/i,
		reject: /\bFAILED\b|405|\bEMPTY\b/i,
	},
	fetch: {
		// A page with real prose: example.com is 230 characters and trips the
		// "content appears incomplete" heuristic, which fails the probe without
		// anything being wrong.
		title: "fetch_content",
		prompt:
			"Call fetch_content on https://nodejs.org/api/path.html and reply with exactly one line: " +
			"OK <number of characters fetched>, or FAILED <error text>. Nothing else.",
		expect: /\bOK\s+[1-9]/i,
		reject: /\bFAILED\b|\bEMPTY\b/i,
	},
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const hosts = flag("hosts", HOSTS.join(",")).split(",").filter(Boolean);
const probes = flag("probes", Object.keys(PROBES).join(",")).split(",").filter(Boolean);
const timeoutSec = Number(flag("timeout", 150));

/** Is the host reachable and does it have pi at all? An unreachable machine is
 * not a broken feature, and conflating the two makes the table useless. */
async function hostReady(host) {
	const command = "command -v pi >/dev/null && pi --version 2>/dev/null | head -1";
	try {
		const { stdout } = host === "mac"
			? await run("bash", ["-lc", command], { timeout: 30000 })
			: await run("ssh", ["-o", "ConnectTimeout=15", host, `bash -lic ${JSON.stringify(command)}`], { timeout: 45000 });
		const version = stdout.trim().split("\n").pop() ?? "";
		return version ? { ok: true, version } : { ok: false, reason: "pi не найден" };
	} catch (err) {
		return { ok: false, reason: String(err?.message ?? err).split("\n")[0].slice(0, 60) };
	}
}

/** One probe on one host. Never throws: a dead host is a result, not a crash. */
async function probeHost(host, key) {
	const probe = PROBES[key];
	// stdin must be closed: with an open pipe pi waits for input and the probe
	// times out with an empty answer, which looks exactly like a dead feature.
	const command = `timeout ${timeoutSec} pi -p ${JSON.stringify(probe.prompt)} < /dev/null 2>&1 | tail -4`;
	const started = Date.now();
	let output = "";
	try {
		const { stdout } = host === "mac"
			? await run("bash", ["-lc", command], { timeout: (timeoutSec + 30) * 1000, maxBuffer: 1 << 22 })
			: await run("ssh", ["-o", "ConnectTimeout=20", host, `bash -lic ${JSON.stringify(command)}`],
				{ timeout: (timeoutSec + 40) * 1000, maxBuffer: 1 << 22 });
		output = stdout.trim();
	} catch (err) {
		output = String(err?.stdout ?? err?.message ?? err).trim();
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(0);
	const line = output.split("\n").filter(Boolean).pop() ?? "";
	const timedOut = Number(seconds) >= timeoutSec;
	const verdict = probe.expect.test(output) && !probe.reject.test(output)
		? (probe.warn?.test(output) ? "частично" : "живо")
		: probe.reject.test(output) ? "ОТКАЗ"
		: timedOut ? "ТАЙМАУТ" : "ПУСТО";
	return { host, key, verdict, seconds, line: line.slice(0, 90) };
}

const results = [];
const unreachable = [];
for (const host of hosts) {
	const ready = await hostReady(host);
	if (!ready.ok) {
		unreachable.push({ host, reason: ready.reason });
		console.log(`  ${host.padEnd(9)} ${"— нет связи".padEnd(30)} ${ready.reason}`);
		continue;
	}
	for (const key of probes) {
		if (!PROBES[key]) {
			console.error(`неизвестная проба: ${key}`);
			process.exit(2);
		}
		const result = await probeHost(host, key);
		results.push(result);
		console.log(`  ${host.padEnd(9)} ${PROBES[key].title.padEnd(30)} ${result.verdict.padEnd(6)} ${result.seconds}с  ${result.line}`);
	}
}

const broken = results.filter((r) => r.verdict !== "живо" && r.verdict !== "частично");
const partial = results.filter((r) => r.verdict === "частично");
console.log();
console.log(
	`  проверок ${results.length}, живых ${results.length - broken.length - partial.length}` +
	`, частично ${partial.length}, не ответили ${broken.length}` +
	(unreachable.length ? `, без связи ${unreachable.length}` : ""),
);
for (const r of partial) console.log(`    ${r.host} / ${PROBES[r.key].title}: частично — ${r.line}`);
for (const r of broken) console.log(`    ${r.host} / ${PROBES[r.key].title}: ${r.verdict} — ${r.line}`);
for (const u of unreachable) console.log(`    ${u.host}: нет связи — ${u.reason}`);
// Машина без связи не делает сборку плохой: это про сеть, а не про выпуск.
process.exit(broken.length === 0 ? 0 : 1);
