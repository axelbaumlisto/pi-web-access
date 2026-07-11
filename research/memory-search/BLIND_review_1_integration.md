# BLIND Review 1 — Integration Critic: memory-search + provider-endpoints

Reviewer role: senior TypeScript/Node integration critic (first look).
Scope reviewed: `search.diff`, `index_tool.diff`, and current `memory-search.ts` /
`provider-endpoints.ts`. Claims verified empirically against the local machine
(`rg 15.1.0`, `git 2.46.0`, `sqlite3 3.51.0`, the real recall DB, and a real pi
session file). No source files were modified.

---

## 1. Concrete bugs / errors

### B1 — [HIGH] Session event `timestamp` is an ISO string → `Number()` = NaN → silently uses file mtime
`memory-search.ts` searchSessions:
```ts
const ts = Number((evt as Record<string, unknown>).timestamp) || mtime;
```
Verified against a real pi session (`~/.pi/agent/sessions/--Users-shamash-work-maenam--/*.jsonl`):
the per-event field is `"timestamp": "2026-07-10T16:40:23.774Z"` — an **ISO string**.
`Number("2026-07-10T16:40:23.774Z")` is `NaN`, so `NaN || mtime` always falls back
to the **file mtime**. Consequences:
- The `sinceMs`/recency window for chat hits is applied to the whole-file mtime,
  not the message time. A months-old message in a session file touched today
  passes a "yesterday" filter (and vice-versa: a fresh message in an old,
  untouched file is wrongly filtered out).
- The date shown in `formatHits` for `chat` hits is the file's last-write time,
  not the turn's time. The header comment's claim "session event ts" is dead —
  that code path never yields the event ts. Fix: `Date.parse(...)` the string (or
  read `evt.timestamp` as string) before falling back to mtime.

### B2 — [MEDIUM] `rg` exit code 2 (partial/permission error) discards matches that rg *did* print (sessions only)
searchSessions catch:
```ts
if (status !== 0 && status !== undefined && status !== 1) {
    return [];   // rg missing or crashed → empty
}
```
Verified: `rg` returns **exit 2** when it hits an unreadable subdirectory but
**still prints the matches it found** on stdout. Under `scope:"all"` a single
permission-denied folder anywhere beneath `~/.pi/agent/sessions` makes exit code
2 → the whole sessions source returns `[]`, throwing away all the good matches rg
already emitted. Note the inconsistency: **searchDocs** handles the same case
correctly (`out = String(e.stdout ?? "")` on any non-1 status, so it keeps the
partial output). The two rg call-sites disagree on exit-2 semantics; sessions is
the buggy one.

### B3 — [MEDIUM] Shared proxy key can be sent to a NON-proxy host (focus (g))
`provider-endpoints.ts` decouples URL resolution from key resolution:
```ts
// providerApiKey():
if (ep.proxyPath && proxyBaseUrl() !== null) return proxyApiKey();
```
`providerApiKey` only checks "provider has a proxyPath AND a proxy base is merely
configured" — it does **not** check whether the URL actually resolved to the
proxy. Scenario: user sets `EXA_BASE_URL` (or `exaBaseUrl`) to a custom
third-party Exa-compatible host **and** also has `proxyBaseUrl` set (e.g. mid-
migration, or because other providers use the proxy). Then:
- `providerUrl("exa")` → the per-provider override host (case 1, wins), NOT the
  proxy.
- `providerApiKey("exa")` (no per-provider key set) → `ep.proxyPath` is truthy
  and `proxyBaseUrl()` is non-null → returns the **shared `sk-proxy-...` key**,
  which is then sent to the user's custom host.

The stated invariant ("prevents sending the proxy key to a provider the gateway
does not front") holds for tavily/parallel (no proxyPath) but breaks for the
proxied providers when their URL is overridden away from the proxy. Fix: gate the
shared-key fallback on the *resolved endpoint actually being the proxy*
(`resolveProviderEndpoint(...).url.startsWith(proxyBaseUrl())`), not merely on
proxyPath+base being present.

### B4 — [LOW] `searchGit` with git source but no keywords and no time window dumps the entire history
In `searchMemory`, `windowMode` requires `sinceMs !== undefined`. For a query like
"search git history" (all tokens are stopwords, **no** recency phrase),
`contentTokens = []` and `windowMode = false`, so the two-pass branch runs with
empty args:
- Pass 0: `grepArgs = [].flatMap(...) = []` → `git log -i --all --regexp-ignore-case --format=...`
  with **no `--grep`** → verified: this lists **every commit** in the repo.
- Pass 1: `-G${[].join("|")}` = `-G` (empty pattern) → verified: `git log -G` with
  empty pattern also matches all commits.

No crash (dedup + `perSourceCap` slice contain it), but the result is "every
commit ranked by recency" for a keyword-less git query without a window —
probably not intended, and on a large monorepo the two full `git log --all`
sweeps are expensive. Consider requiring either content tokens or a window before
running git.

### B5 — [LOW] Project label wrong for hyphenated project names
searchSessions:
```ts
const project = folder.replace(/^--/, "").replace(/--$/, "").split("-").pop() || folder;
```
`sessionFolderForCwd` slugs both `/` **and** pre-existing `-` in the path to `-`,
so the slug is ambiguous. For a project at `/Users/x/work/pi-web-access` the
folder is `--Users-x-work-pi-web-access--` and `split("-").pop()` yields
`"access"`, not `"pi-web-access"`. The `project` label (used in output and
`details.hits[].project`) is truncated to the last hyphen segment for any
hyphenated repo name.

---

## 2. Missing handling / dead code / duplication

### M1 — maxBuffer truncation is silent and inconsistent (focus (f))
Limits: sessions rg 256 MB, git 64 MB, sqlite 64 MB, docs rg 32 MB. On overflow
`execFileSync` throws `ENOBUFS` (with `err.status === undefined`, partial output
in `err.stdout`):
- searchSessions: `status===undefined` short-circuits the crash check → falls to
  `out = String(e.stdout ?? "")` → parses a **truncated** buffer; the last line is
  likely a partial JSON that `JSON.parse` rejects and skips. Graceful but silently
  lossy.
- searchRecall: bare `catch { return []; }` → on >64 MB TSV the **entire recall
  source is dropped** with no signal.
- gitOut: returns partial stdout on any throw, including ENOBUFS → truncated diff/
  log, no marker that truncation happened.

None of these surface a "results truncated" note to the caller. For a tool that
advertises "scans 8 GB", 32–256 MB ceilings + silent truncation is a real gap.

### M2 — `...({_repo,_hash} as object)` internal fields ride along on returned hits (focus (e))
The stash hack works at runtime and, importantly, does **not** leak into the tool
output: `index.ts` `details.hits` maps only the six known fields, and `formatHits`
reads only known fields — so `_repo`/`_hash` never reach the model. **However**,
the exported `searchMemory()` returns `MemoryHit[]` objects that still carry
untyped `_repo`/`_hash` at runtime (only git hits). Any other consumer of the
public API gets hidden, undeclared properties. Cleaner: extend the internal type
(`interface GitHit extends MemoryHit { _repo?; _hash? }`) or strip these before
return. Minor type-safety / API-hygiene issue, not a leak on the tool path.

### M3 — Duplicated config loading + duplicated regex-escape
- `provider-endpoints.ts` keeps its own `cachedConfig`/`loadRawConfig`, while
  brave/exa/perplexity/tavily each still keep their own `loadConfig` +
  `CONFIG_PATH` + `WebSearchConfig` (grep confirms all four still define these).
  After the refactor those per-module `loadConfig`/`normalizeApiKey` are largely
  dead for key/URL resolution (only used for the "how to configure" error
  strings). Not wrong, but the DRY goal is only half-achieved — the config is now
  read and cached in *two* places per provider.
- The rg pattern escape `t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` is copy-pasted
  verbatim in searchSessions and searchDocs. Extract a `escapeRe` helper.

### M4 — Both provider `cachedConfig` and endpoint `cachedConfig` never invalidate
Module-level `cachedConfig` in `provider-endpoints.ts` is cached for the process
lifetime; editing `web-search.json` at runtime won't be picked up. Acceptable for
a CLI, worth a comment.

---

## 3. Doubtful assumptions

### D1 — `indexOf('.jsonl:')` path splitting (focus (c))
`row.indexOf(".jsonl:")` assumes the first literal `.jsonl:` is the path/content
boundary. rg with `--with-filename` and no `--field-match-separator` uses `:`.
Failure modes: (a) a **directory** named `something.jsonl:` in the path (unusual
but legal on macOS/Linux — `:` is a valid filename char) would mis-split; (b) a
`.jsonl` file whose *content line* begins before another `.jsonl:` substring is
fine because it takes the **first** occurrence, which is correct as long as no
path segment contains `.jsonl:`. In practice pi-generated session paths are
`<ISO>_<uuid>.jsonl`, so this holds — but it is an assumption about external path
shape, and there is no fallback if it breaks (line silently dropped via
`sep===-1 → continue`). A `--null`/`-0` + `--with-filename` (NUL separator) or
`--json` output would be robust; worth noting even if deferred.

### D2 — `--format` delimiters `\x1f` / `\x00` in commit bodies (focus (d))
Records are split on `\x00` and fields on `\x1f`. Commit *messages* are text and
practically never contain NUL or US bytes, so this is safe in the normal case.
Two caveats: (a) `git log --format` does not sanitize the body — a maliciously
crafted commit body containing `\x1f`/`\x00` would corrupt field/record splitting
(low risk, local repos only); (b) the field array is destructured
`const [hash, at, , subject, body = ""] = r.split(US)` — if a body legitimately
spans an embedded US it lands in a 6th element and is dropped, not corrupting
other records. Acceptable, but the "can bodies contain those bytes" answer is
"yes, in theory" — no guard exists.

### D3 — Exa MCP under the proxy path
`EXA_MCP_URL()` returns `${url}/mcp` whenever `resolveProviderEndpoint("exa")`
reports `overridden` — which is `true` merely because a proxy base is configured
(exa has `proxyPath`). This assumes the airpx proxy fronts Exa **MCP** at
`${proxyBase}/v1/exa/mcp`. Per the unified-proxy design the proxy fronts exa at
`/v1/exa` (search/answer); whether it also proxies the MCP JSON-RPC endpoint is an
unverified assumption. If it doesn't, `callExaMcp` will POST to a 404 whenever a
proxy base is set but no explicit `EXA_BASE_URL` override exists.

### D4 — `sqlite3 -json` column key for the COALESCE expression
searchRecall reads `r["COALESCE(project_id,'')"]`. Verified on `sqlite3 3.51.0`:
the JSON key is exactly `"COALESCE(project_id,'')"`, so this works **today**. But
it is brittle — it depends on sqlite's expression-to-column-name formatting
(whitespace/quoting could differ across versions). An explicit
`COALESCE(project_id,'') AS project_id` alias would make the key stable and also
let the existing `?? r.project_id` fallback actually fire. (Recall timestamps
confirmed unix-ms, so the `tsRaw > 1e12` branch is correct.)

### D5 — SQL quote-escaping for recall (focus (b))
`project_id='${proj.replace(/'/g, "''")}'` — `proj` is `basename(cwd)`, which
cannot contain `/`. Single-quote doubling is the correct escape for a sqlite
string literal, and no other metacharacter is significant inside a `'...'`
literal, so injection is not practically reachable here. This is acceptable, but
note it is hand-rolled; if the `where` clause ever incorporates untrusted
free-form input this pattern is fragile. Low risk as written.

### D6 — Tooling assumed present on PATH (focus (a))
`rg`, `sqlite3`, `git` are all `execFileSync`'d with no existence probe. Failure
handling is mostly graceful (missing binary → `ENOENT`, `err.status===undefined`
→ falls through to empty output for sessions/docs/git; searchRecall's bare catch
returns `[]`). Net effect: if `rg` is absent, sessions **and** docs silently
return nothing while recall still works — the tool "succeeds" with a partial,
misleading empty-ish result and no diagnostic. A one-time capability check with a
surfaced warning ("ripgrep not found; chat/doc search disabled") would prevent
silent degradation. Note also `searchGit`'s `gitOut` swallows *all* git errors
into `""`, so a non-repo cwd or git failure is indistinguishable from "no
commits".

---

## 4. Verdict

**CONDITIONAL GO** — maturity **6.5 / 10**.

The provider-endpoints refactor is clean and the layered priority is correct for
the common cases; the memory_search tool is well-structured, the rg/sqlite/git
seams mostly fail soft, and the `_repo/_hash` stash does **not** leak into tool
output. Nothing here is a crash or a data-corruption blocker.

Blocking-for-fix before merge:
- **B3** (proxy key can go to a non-proxy host when a per-provider URL override
  coexists with a proxy base) — security-relevant, fix key-fallback to gate on the
  *resolved* URL being the proxy.
- **B1** (session timestamps are ISO strings → recency/date silently use file
  mtime) — the recency feature is a headline capability and is effectively broken
  for chat hits.

Should-fix:
- **B2** (rg exit-2 discards good matches in sessions; align with docs handling).
- **M1** (silent maxBuffer truncation — at minimum surface a truncation note).

Everything else (B4, B5, M2–M4, D1–D6) is polish / robustness and can follow.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Report lists concrete findings with file+line/function refs and severities: B1 searchSessions ISO-timestamp NaN→mtime (HIGH), B2 rg exit-2 discards matches (MEDIUM), B3 provider-endpoints.ts providerApiKey proxy-key-to-non-proxy-host (HIGH/focus g), B4 empty git log full-history dump, B5 project label truncation, plus M1-M4 and D1-D6. Claims verified empirically (rg 15.1.0 exit-2 behavior, real pi session ISO timestamp, sqlite3 -json COALESCE key, empty --grep/-G list-all)."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "sqlite3 -json ~/.claude-recall/claude-recall.db 'SELECT ...'",
      "result": "passed",
      "summary": "Confirmed COALESCE(project_id,'') is the -json key and recall timestamps are unix-ms"
    },
    {
      "command": "rg -i --with-filename over a dir with an unreadable subdir",
      "result": "passed",
      "summary": "rg prints matches AND exits 2 on permission error → confirms B2"
    },
    {
      "command": "grep type:message pi session jsonl + python json",
      "result": "passed",
      "summary": "session event timestamp is ISO string '2026-07-10T16:40:23.774Z' → confirms B1"
    },
    {
      "command": "git log -i --all --regexp-ignore-case --format / git log -G '' ",
      "result": "passed",
      "summary": "empty --grep and empty -G both list ALL commits → confirms B4"
    }
  ],
  "validationOutput": [
    "rg 15.1.0, git 2.46.0, sqlite3 3.51.0 all present on PATH",
    "recall memories table schema confirmed (project_id nullable, scope CHECK, timestamp INTEGER ms)",
    "Number('2026-07-10T16:40:23.774Z') === NaN verified conceptually and by ISO-string presence"
  ],
  "residualRisks": [
    "B3 proxy key leak requires the uncommon config combo (per-provider URL override + proxyBaseUrl set) — plausible during migration, not default",
    "D3 Exa MCP-under-proxy (/v1/exa/mcp) is an unverified assumption about the airpx gateway; could 404 when proxy base set without explicit EXA_BASE_URL",
    "maxBuffer truncation (M1) is data-dependent and silent; unlikely on typical repos but real on very large session/git corpora"
  ],
  "noStagedFiles": true,
  "diffSummary": "Adds provider-endpoints.ts (central URL/key resolver with env>config>unified-proxy>default priority; shared key gated on proxyPath) and rewires exa/brave/perplexity/tavily/parallel/openai to it; adds memory-search.ts (new memory_search tool over pi sessions via rg, claude-recall via sqlite3, md docs via rg, and git via git log --grep/-G) plus index.ts tool registration.",
  "reviewFindings": [
    "high: memory-search.ts searchSessions - session event timestamp is an ISO string, Number() yields NaN and silently falls back to file mtime, breaking recency filter/date for chat hits (B1)",
    "high: provider-endpoints.ts providerApiKey - shared proxy key returned whenever ep.proxyPath && proxyBaseUrl() is set, even when the URL resolved to a per-provider override host that is NOT the proxy (B3, focus g)",
    "medium: memory-search.ts searchSessions - rg exit code 2 (permission/partial) discards matches rg already printed; searchDocs handles the same case correctly, so behavior is inconsistent (B2)",
    "medium: silent maxBuffer truncation across sessions(256MB)/git(64MB)/sqlite(64MB)/docs(32MB) with no truncation signal (M1)",
    "low: searchGit with git source but no keywords and no time window runs two full 'git log --all' sweeps (empty --grep / empty -G both match all commits) (B4)",
    "low: project label uses split('-').pop() on an ambiguous slug → wrong label for hyphenated repo names (B5)",
    "low: _repo/_hash stash via '...({} as object)' does NOT leak to tool output (details maps known fields only) but rides on the exported MemoryHit[] as untyped runtime props (M2)"
  ],
  "manualNotes": "Verified on the actual machine (rg 15.1.0, git 2.46.0, sqlite3 3.51.0, real recall DB + real pi session). Positive confirmations for the author: recall timestamps ARE unix-ms so the >1e12 branch is correct; the sqlite3 -json COALESCE column key matches exactly today; the SQL quote-escaping is adequate for basename-derived project_id; and the _repo/_hash internal fields are correctly filtered out of the model-facing tool result. Priorities: fix B3 and B1 before merge; B2/M1 soon after."
}
```
