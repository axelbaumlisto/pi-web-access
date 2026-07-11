# BLIND Review 2 — Edge-case & Security Critic

**Scope reviewed:** `memory-search.ts` (new), `provider-endpoints.ts` (new) + the
`index.ts`, and the base-URL/key refactor across `brave/exa/openai/parallel/perplexity/tavily`.
**Lens:** command/argument injection, ReDoS, resource exhaustion, path/data leak, secrets, unicode, timestamp math.
**Method:** static read of the two diffs + full source of `memory-search.ts` and `provider-endpoints.ts`. Review-only; no source modified.

---

## Executive summary

The headline attack surface (shelling out to `rg`/`sqlite3`/`git` with a user query)
is **substantially safer than it looks**, for one structural reason:

> `tokenize()` (`memory-search.ts:62`) splits on `/[^\p{L}\p{N}_]+/u` and keeps only
> tokens of length ≥ 2. Every token is therefore **guaranteed** to contain *only*
> Unicode letters, digits, and underscore — **no leading `-`, no shell metachars,
> no regex metachars.**

That single invariant defuses the three scariest classes the task asked about:
argument injection (`-`-prefixed tokens), shell injection (moot with `execFileSync`),
and ReDoS via the un-escaped `git -G` pattern. So: **no active injection or RCE.**

The **real** problems are (1) an **unbounded `git log --all` + empty pickaxe scan**
when the query is all stop-words with no time window, (2) **no `timeout` on any
synchronous `execFileSync`** (blocks the event loop), and (3) **secret exposure**
from the recall DB and git diffs into tool output with no redaction.

Verdict: **CONDITIONAL GO** — fix findings #1 and #2 before shipping.

---

## 1. Security / edge bugs (file + line, with severity)

### 1.1 — HIGH — Unbounded `git log --all` + empty `-G` pickaxe on stop-word-only queries
`memory-search.ts` `searchGit` passes construction (~lines 445–452) + reach via `index.ts` auto-routing (~line 2075).

When the query reduces to **only stop-words** *and* there is **no recency phrase**:
- `contentTokens = []`
- `windowMode = false` (requires `sinceMs !== undefined`)
- `grepArgs = [].flatMap(...) = []` → pass 0 becomes `git log -i --all --regexp-ignore-case --format=…` **with no `--grep`** = enumerate **every commit on every ref**.
- pass 1 builds `` `-G${[].join("|")}` `` = the literal arg `"-G"` (empty pattern) → pickaxe with an empty regex = **diff-scan of the entire history of every ref**.

This is trivially reached: `wantsGit("commit")` / `wantsGit("git log")` → `sources=["git"]`,
`parseRecency` returns `undefined`, and `"commit"`/`"git"`/`"log"` are all in `GIT_STOPWORDS`.
The orchestrator guard at `searchMemory` (`if (tokens.length === 0 && !gitWindowOnly) return []`)
does **not** catch it because `tokens.length` is ≥ 1 (the stop-words are still tokens).

Impact: `scope:"all"` runs `git log --all` + empty pickaxe across **every repo under `~/work`**;
even `scope:"current"` runs it on a large repo (e.g. thousands of commits) with `--all`.
With no timeout (see #1.2) this can freeze the agent for a long time. Not a data-corruption
bug, but a clear self-inflicted DoS / latency cliff on ordinary phrasing.

**Fix:** if `contentTokens.length === 0 && !windowMode`, bail (return `[]`) — a git
search with no keywords and no window has no meaningful result anyway.

### 1.2 — MEDIUM — No `timeout` on any `execFileSync`; blocking call on the event loop
`searchSessions` rg (~line 175), `searchDocs` rg (~line 311), `searchRecall` sqlite3 (~line 268),
`gitOut` (~line 400).

None of the four `execFileSync` calls pass a `timeout`. `execFileSync` is **synchronous**
and runs inside the tool's `async execute`, so a slow/hung `rg` (8 GB of sessions),
`git` (`--all` pickaxe, #1.1), or a wedged `sqlite3` (DB lock) **blocks Node's single
thread** — the whole extension/agent stalls until it returns.

**Fix:** add `timeout: <ms>` (e.g. 10–20 s) + `killSignal` to each `execFileSync`, or
move to async `spawn`. Add a note that partial/killed output degrades to `[]`.

### 1.3 — MEDIUM — Secrets surfaced into tool output with no redaction
`searchRecall` (~lines 289–303), `searchGit` diff expansion (~lines 494–500), `searchDocs`.

The recall DB and git diffs are exactly where credentials live. This tool reads memory
`value` content and up-to-200 lines of `git show --patch`, then emits them as `snippet`
into `content[].text` (`formatHits`) and `details.hits` back to the model.

- Recall memories in this environment contain literal `sk-proxy-…` keys, DB passwords
  (`llmproxy2026`, `proxy_dev_pwd`), SSH hosts, Cloudflare keys, etc. A query matching
  such a memory returns the secret verbatim.
- `git show --patch` can surface any secret that was ever committed (even if later removed),
  or the contents of a `.env`/config that lives in history — within the first 200 lines.

This is inherent to a "search your own history" tool and arguably acceptable for a local
single-user agent, but there is **zero redaction**. At minimum flag it; ideally run a
cheap secret-pattern scrub (`sk-[A-Za-z0-9]{20,}`, `AIza…`, `-----BEGIN … KEY-----`,
common `password=`/`token=`) over emitted snippets.

Note: the provider-endpoints refactor itself does **not** leak the proxy key into
`memory_search` output — the two subsystems are unrelated. Good.

### 1.4 — LOW/MEDIUM — `scope:"all"` is a cross-project data-egress surface (by design)
`searchSessions`/`searchRecall`/`searchDocs`/`searchGit` all branch to "every project"
when `scope === "all"`.

The model can set `scope:"all"` and pull snippets (incl. secrets per #1.3) from **unrelated
projects'** transcripts, memories, `~/work` docs, and git diffs into the current context.
Documented and intentional, but worth an explicit risk note: unrelated-project confidential
content becomes reachable by a single tool arg the LLM controls.

### 1.5 — LOW — `wantsGit` / `wantsDocs` false positives (Cyrillic substrings + Latin `\b` bug)
`wantsGit` (~line 585), `wantsDocs` (~line 572).

- `/…|гит|…|диф|…/` matches as **substrings**: `"агитация"` contains `гит` → `wantsGit` true;
  `"дифференциал"`/`"дифтерия"` contain `диф` → true.
- `\bdiff` matches `"difficult"`, `"different"`, `"diffuse"` (word boundary + literal `diff`).

Consequence is not security but **wrong source routing**: `index.ts` does
`if (wantsGit(query)) sources = ["git"]` — a **full replacement** — so a query like
`"поищи агитацию в переписке"` searches **only git** and silently drops sessions+memory,
returning nothing useful (and, per #1.1, may kick off the full-history scan).
`wantsDocs` similarly over-triggers but only *augments*, so lower impact.

**Fix:** anchor the Cyrillic stems more (`\bгит`-equivalent via negative lookarounds, or
require `коммит`/`дифф` with the doubled-f), and don't let `wantsGit` fully replace
sessions+memory — merge instead.

### 1.6 — LOW/MEDIUM — Session `timestamp` unit/format assumed to be unix-ms; no detection
`searchSessions` (~line 233): `const ts = Number((evt).timestamp) || mtime;`

Unlike `searchRecall` (which detects s-vs-ms via `tsRaw > 1e12`) and `searchGit`
(which explicitly `* 1000`s `%at` seconds), sessions do **no unit handling**:
- If pi writes `timestamp` as an **ISO string** (session *files* are named with ISO
  timestamps, so this is plausible for events too), `Number("2026-07-…") = NaN` →
  falls back to whole-**file mtime**, so per-event recency and the `sinceMs` filter
  degrade to file granularity.
- If it's unix **seconds**, `Number()` yields ~1.7e9, interpreted as **ms** = year 1970 →
  `recencyBoost` bottoms out **and** the `sinceMs` filter (`ts < now - sinceMs`) drops
  every hit. So a "yesterday/last week" session search could return **nothing**.

**Fix:** apply the same `>1e12 ? ms : *1000` detection (and ISO-string parse) used in
`searchRecall`. Verify pi's actual event schema.

### 1.7 — LOW — `git -G` pattern is **not** regex-escaped (latent, currently safe)
`searchGit` (~line 450): `` `-G${contentTokens.join("|")}` ``.

The task flagged this correctly as *un-escaped* (sessions/docs escape via the char-class
`replace`, git `-G` does not). It is **currently harmless only because `tokenize()`
guarantees alphanumeric-only tokens** — an alternation of literal alphanumerics is a
linear, valid regex. This is a **coupling landmine**: if `tokenize` is ever loosened to
admit `.`, `*`, `(`, `\`, etc., `git -G` immediately becomes a regex-error / ReDoS vector,
and so do the `rg -e` patterns' correctness. Escape it defensively even though it's inert today.

### 1.8 — LOW — No `--` end-of-options guard before positional path args (defensive)
`rg` in `searchSessions` (~line 190, `…"-e", pattern, ...searchDirs`) and `searchDocs`
(~line 313, `…"-e", pattern, ...roots`).

Not exploitable via the query (paths are internally derived absolute paths starting with
`/`, and the query goes through `-e`), but there is no `--` separator before the path
operands. If a future caller ever passes a relative or `-`-leading root, rg would treat it
as a flag. Add `--` before `...searchDirs` / `...roots` as belt-and-suspenders.

### 1.9 — LOW — Fragile `path:content` line parsing (no NUL/JSON separator)
`searchSessions` (~lines 210–213): `row.indexOf(".jsonl:")`.

Parsing rg's default `path:linecontent` by string search on `.jsonl:` is heuristic. It
works for the current filename scheme but breaks if a path/line contains embedded newlines,
or if content legitimately contains `".jsonl:"` before the real one (mitigated because the
path precedes content). Prefer `rg --null` (`-0`) or `rg --json` for robust field splitting.

### 1.10 — Cosmetic — Project label mis-derivation
`searchSessions` (~line 240): `folder…split("-").pop()`.

`--Users-…-pi-web-access--` → `"access"` (last dash segment), not `pi-web-access`.
Only affects the human-facing `project` label; no functional/security impact.

---

## 2. Missing guards

- **`searchGit` empty-keyword bail** (see #1.1) — the single most important missing guard.
- **`timeout` on all four `execFileSync`** (see #1.2).
- **Secret scrub** on emitted snippets (see #1.3) — or at least an explicit doc warning.
- **Session timestamp unit detection** (see #1.6) — recall has it; sessions don't.
- **`--` before rg path operands** (see #1.8) and **regex-escape for `git -G`** (#1.7),
  both defensive against future tokenizer changes.
- **No cap on number of `~/work` repos scanned** in `scope:"all"` git mode — `readdirSync`
  enumerates every dir with `.git`; combined with `--all` pickaxe this multiplies #1.1.

---

## 3. Doubtful assumptions

- **`sessionFolderForCwd` slug scheme** (`cwd.replace(/\//g,"-")` wrapped in `--…--`) is a
  *guess* at pi's internal slugging. If pi collapses repeated slashes or encodes special
  chars differently, `scope:"current"` sessions silently search the **wrong / empty** folder
  (correctness, not security). Worth an integration test against a real session dir.
- **`parseRecency` windows are loose and slightly contradictory:** "last week" → **14 days**,
  "this week" → 7, "last month" → **60 days**, "past month/за месяц" → 31. Intentional fuzz,
  but "last month = 60 days" and "last week = 14 days" will surprise users and widen the
  git/session windows more than expected.
- **`Number(evt.timestamp) || mtime`** assumes a falsy/NaN ts should fall back to file mtime;
  fine, but see #1.6 — the assumption that a *valid* number is already ms is unverified.
- **recall `-json` output shape**: the code reads both `r["COALESCE(project_id,'')"]` and
  `r.project_id`. sqlite3 `-json` labels columns by their **expression text**, so the
  `COALESCE(...)` key is right; the `?? r.project_id` fallback is dead but harmless. Relies
  on a specific sqlite3 CLI version's JSON column-naming — brittle if the schema/CLI changes.
- **SQL string-escaping is *sufficient* here** — worth stating clearly: the LLM **query is
  never interpolated into SQL** (recall pulls all active rows then filters in JS). The only
  interpolated value is `proj = basename(cwd)`, which is environment-trusted (the LLM cannot
  set `cwd` via tool params) and is correctly escaped for SQLite via `'` → `''` (SQLite does
  **not** honor backslash escapes in string literals, so `''`-doubling cannot be bypassed).
  **No SQL injection.**

---

## 4. Provider-endpoints refactor (secondary)

- Key-routing is **correct and safe**: `providerApiKey` only falls back to the shared proxy
  key for providers that both declare `proxyPath` **and** have a proxy base configured —
  so `tavily`/`parallel` never receive the proxy key. This matches intent and prevents
  leaking `sk-proxy-…` to a real third-party API.
- Per-provider env/config override still wins over the unified proxy (priority 1–2 in
  `resolveProviderEndpoint`). Consistent with the documented precedence.
- **Footgun (not security):** for `brave`/`perplexity` the "base" is actually the **full**
  endpoint URL; a user who sets `braveBaseUrl` to just a host (without `/…/web/search`)
  silently produces a wrong URL. Documented in comments, so acceptable.
- `normalizeBaseUrl` trims trailing slashes and rejects non-strings/empties — fine.
- No secret is logged or emitted by this module.

---

## 5. What is NOT a problem (checked, to avoid inventing risk)

- **No shell injection** — `execFileSync` never spawns a shell.
- **No argument injection from the query** — tokens are alphanumeric/underscore only
  (`tokenize`), so they cannot begin with `-`; `rg` uses `-e <pattern>` and `git --grep`
  consumes its value; `git -G<stuck>` cannot be split. Holds regardless of rg/git arg-parsing.
- **No ReDoS from the query** — `rg`/`git` patterns are literal alphanumerics (+ `|` we add);
  the `wantsX`/`parseRecency` regexes use only bounded `\S*`, no nested quantifiers.
- **No unhandled crash to the user** — every `execFileSync` is wrapped, and `searchMemory`
  is wrapped in `index.ts`'s `try/catch`; maxBuffer overflow degrades to partial/`[]`.
- **No SQL injection** (see §3).

---

## 6. VERDICT

**CONDITIONAL GO — maturity 6.5 / 10.**

Injection/RCE/ReDoS are effectively closed by the tokenizer invariant, and the SQL path is
safe. The blockers are operational/robustness, not exploitation:

**Must-fix before ship:**
1. `searchGit`: bail when `contentTokens.length === 0 && !windowMode` (kills the
   `git log --all` + empty-pickaxe full-history scan) — **#1.1 HIGH**.
2. Add `timeout` (and cap `~/work` repo count) to all `execFileSync` — **#1.2 MEDIUM**.

**Should-fix:**
3. Redact secrets (or explicitly document the exposure) in emitted snippets — **#1.3**.
4. Fix session timestamp unit handling to match `searchRecall` — **#1.6**.
5. Tighten `wantsGit` so it doesn't false-positive (агитация/дифференциал/difficult) and
   doesn't fully replace sessions+memory — **#1.5**.

**Nice-to-have (defensive/latent):** regex-escape `git -G` (#1.7), add `--` before rg paths
(#1.8), use `rg -0/--json` (#1.9), fix project label (#1.10), verify the pi slug scheme (§3).

---

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Delivered a review-only findings doc at the mandated output path; no source files modified. Covered every requested angle (a)-(g): injection/arg-injection, ReDoS, resource exhaustion, path/cross-project leak, secrets, unicode/\\b, timestamp math."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each finding cites file + approximate line + severity, with concrete reproduction reasoning (e.g. stop-word-only query -> empty contentTokens -> `git log --all` + `-G` empty; tokenizer invariant that neutralizes injection). Explicit NOT-a-problem section prevents invented risk. Verdict + maturity given."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read search.diff, index_tool.diff, memory-search.ts, provider-endpoints.ts",
      "result": "passed",
      "summary": "Full static read of both diffs and both new source files"
    }
  ],
  "validationOutput": [
    "Static analysis only (review task). Key derived invariant: tokenize() restricts tokens to \\p{L}\\p{N}_ (>=2 chars), so no query token can start with '-' or contain regex/shell metachars -> argument-injection and ReDoS via git -G are structurally prevented.",
    "Confirmed reachable HIGH finding: wantsGit('commit')/parseRecency=undefined -> contentTokens=[] , windowMode=false -> pass0 `git log --all` (no --grep) + pass1 `-G` empty = full-history scan; no timeout.",
    "Confirmed no SQL injection: LLM query never enters SQL; only basename(cwd) interpolated and correctly ''-escaped for SQLite (no backslash-escape bypass)."
  ],
  "residualRisks": [
    "HIGH: unbounded `git log --all` + empty pickaxe on stop-word-only queries (memory-search.ts searchGit) — DoS/latency.",
    "MEDIUM: no timeout on synchronous execFileSync blocks the event loop.",
    "MEDIUM: recall-DB values and git diffs (secrets) emitted into tool output with no redaction.",
    "LOW/MEDIUM: scope=all cross-project data egress by design; session timestamp unit assumption; wantsGit/wantsDocs false positives.",
    "LOW: git -G un-escaped (latent, safe only due to tokenizer); missing `--` rg guard; fragile path:content parsing."
  ],
  "noStagedFiles": true,
  "diffSummary": "No code changes. Wrote BLIND_review_2_edgecase.md with 10 findings (1 HIGH, 3 MEDIUM, rest LOW/cosmetic), missing-guards, doubtful-assumptions, provider-endpoints notes, and CONDITIONAL GO / 6.5-10 verdict.",
  "reviewFindings": [
    "HIGH: memory-search.ts searchGit (~L445-452) - stop-word-only query with no time window runs `git log --all` + empty `-G` pickaxe over full history of every repo; no timeout.",
    "MEDIUM: memory-search.ts (rg ~L175/L311, sqlite3 ~L268, git ~L400) - no timeout on synchronous execFileSync; blocks event loop.",
    "MEDIUM: memory-search.ts searchRecall/searchGit diff-expansion - secrets from recall DB and git diffs emitted with no redaction.",
    "LOW/MEDIUM: memory-search.ts searchSessions (~L233) - session timestamp assumed unix-ms; ISO/seconds break recency + sinceMs filter.",
    "LOW: memory-search.ts wantsGit (~L585)/wantsDocs (~L572) - Cyrillic substring + Latin \\b false positives misroute sources.",
    "LOW: memory-search.ts searchGit (~L450) - `git -G` pattern un-escaped (safe only because tokenizer strips metachars).",
    "no blockers on provider-endpoints.ts: key-routing to proxy is correctly gated to proxyPath providers; no secret leak."
  ],
  "manualNotes": "No web_search needed: the tokenizer invariant (alphanumeric/underscore-only tokens) makes rg/git argument-injection and git -G ReDoS moot regardless of rg/git arg-parsing details, and the query never reaches SQL. Priorities for the author: (1) bail searchGit on empty contentTokens+no window, (2) add execFileSync timeouts, then (3) secret redaction and session-timestamp unit handling."
}
```
