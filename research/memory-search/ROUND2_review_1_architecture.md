# ROUND2 Review 1 — Architecture / SOLID / DRY / KISS / API design

Blind first-time read of `memory-search.ts`, `provider-endpoints.ts`, and the
`memory_search` registration + provider-endpoint usage in `index.ts`
(`/Users/shamash/work/pi-web-access`). Findings verified empirically where
possible (`node --experimental-strip-types` probes, sqlite3 schema inspection,
session-dir listing). No research/ or review files read; no git history read.

---

## Numbered findings

### 1. [HIGH] Fully synchronous exec pipeline blocks the host event loop — and the tool's AbortSignal is ignored
`memory-search.ts` (whole module; `EXEC_TIMEOUT_MS` ~line 96; `execFileSync`
×5) + `index.ts:2067` (`async execute(_callId, params, _signal, …)`).

Every source runs `execFileSync` (rg ×2, sqlite3, git ×N-repos ×2-passes
+ diff expansion per top hit) **sequentially and synchronously** inside an
`async execute`. Worst case is `sources=[all four]`, `scope="all"`:
`~/.pi/agent/sessions` is **8.0 GB** on this machine (verified `du -sh`), and
git window-mode expands diffs for up to 200 commits — each `git show` is
another blocking exec. With a 20s timeout per exec, a single tool call can
freeze the pi TUI event loop for tens of seconds (nothing else — rendering,
other tools, cancellation — can run). The `_signal` parameter is received and
never wired into anything; the user cannot abort a runaway search.
Architecturally the module should be async (`execFile` + `Promise.all` across
sources, signal-aware kill), which would also parallelize the 4 sources for
free. This is the single biggest design decision that will bite.

### 2. [HIGH] No tests for either module, and the exec seams are not injectable
Repo has an established `test/` convention (16 `.test.mjs` files), but
`grep -l "memory-search\|provider-endpoints" test/*.mjs` → nothing.
`memory-search.ts` calls `execFileSync("rg"|"sqlite3"|"git", …)` directly and
hardcodes `SESSIONS_ROOT`/`RECALL_DB`/`WORK_ROOT` at module scope (~lines
55-58), so the module cannot be tested without the real binaries and the real
home directory. There is no seam (no injectable runner, no root-path options).
The scoring/parsing core (`tokenize`, `keywordScore`, `recencyBoost`,
`parseTimestamp`, `makeSnippet`, `projectFromFolder`) is pure and *could* be
tested today, but nothing is. For a module with this many encoding/locale/CLI
edge cases, zero coverage is a maintenance time bomb. `provider-endpoints.ts`
is similarly untested despite carrying a documented security invariant
(key-leak gating).

### 3. [HIGH] Key/URL precedence trap: a personal `*_API_KEY` env var silently gets sent to the unified proxy
`provider-endpoints.ts:210-221` (`providerApiKey`). Verified empirically:

```
WEB_SEARCH_PROXY_URL=https://proxy.example
WEB_SEARCH_PROXY_KEY=sk-proxy-TEST
OPENAI_API_KEY=sk-real-openai-PERSONAL
→ providerUrl("openai")   = https://proxy.example/v1/responses
→ providerApiKey("openai") = sk-real-openai-PERSONAL
```

URL resolution and key resolution are two independent precedence ladders. When
the URL falls through to the proxy but a per-provider key exists (extremely
common: `OPENAI_API_KEY`/`PERPLEXITY_API_KEY` in the ambient env), the user's
**personal upstream secret is transmitted to the proxy gateway** as the bearer
key. The B3 gating (see finding 4) protects only the opposite direction
(shared key → custom host). Correct design: resolve endpoint *first*, then
pick the key that *belongs to* the resolved destination (per-provider key only
when the endpoint is the provider's own/default or a per-provider override;
proxy key only when the endpoint is the proxy). Right now the two decisions
can cross wires silently.

### 4. [MED] The B3 "don't leak the proxy key" guard uses a prefix check that is not host-boundary safe
`provider-endpoints.ts:218`:
`resolveProviderEndpoint(provider).url.startsWith(base)`.
Verified: `"https://airpx.cc.evil.com/v1/exa".startsWith("https://airpx.cc")`
→ `true`. If a per-provider override is set to a host that merely *extends*
the proxy origin string (`airpx.cc.evil.com`, or `https://airpx.cc2/...`), the
shared proxy key is sent there — exactly what the inline comment says the
gating exists to prevent. The values are user-controlled config, so practical
exploitability is low, but the guard is defective relative to its own stated
contract. Compare parsed origins (`new URL(url).origin === new URL(base).origin`)
or require a `/` boundary after the prefix.

### 5. [MED] Hidden runtime fields `_repo`/`_hash` are smuggled past the `MemoryHit` type
`memory-search.ts` searchGit, both push sites (`...({ _repo, _hash } as object)`,
~lines 470 and 520). Verified: returned objects actually carry
`_repo` (an **absolute local path**) and `_hash` beyond the declared interface:

```
first git hit keys: [... 'score', '_repo', '_hash']
```

The exported `searchMemory` return type lies about its shape. `index.ts`
happens to whitelist fields when building `details.hits` (good hygiene), but
any other consumer that serializes hits verbatim will leak local filesystem
paths and undocumented fields. This is a classic under-abstraction: the diff
expansion is an internal post-processing step, so either (a) expand diffs
inside `searchGit` before returning, or (b) use a private wrapper type
(`GitHitInternal extends MemoryHit`) that is stripped before return. The
`as object` spread-cast exists purely to defeat the type checker — a smell in
itself.

### 6. [MED] "Git window mode" is derived in four places — DRY violation with real drift risk
The predicate "no content tokens after stopword strip AND sinceMs set" is
computed independently in:
1. `searchGit` internal `windowMode` (~line 448),
2. orchestrator `gitWindowOnly` (~line 630, via `tokens.every(GIT_STOPWORDS.has)`),
3. orchestrator `gitWindow` (~line 645, via `tokens.filter(!has).length === 0`),
4. `index.ts:2080-2083` routing policy (`wantsGit(query) && parseRecency(query) !== undefined` → git-only sources).

Three syntactically different expressions of the same rule inside one module,
plus a fourth approximation at the tool layer. The final `slice` cap in the
orchestrator must re-derive `searchGit`'s internal decision to avoid clipping
its results — a leaky abstraction. If the stopword set or the rule changes,
these will drift. `searchGit` should own the decision and communicate it
(return `{ hits, windowMode }` or set a source-level flag).

### 7. [MED] Config loading is duplicated ~7× across the plugin; provider-endpoints adds an eighth cache with divergent error semantics
`provider-endpoints.ts:139-149` (`loadRawConfig`, silent `{}` on parse error)
vs `gemini-api.ts:18-33` (own `cachedConfig`, **throws** on parse error) vs
`exa.ts:64-78` (own `loadConfig`, throws) — and `grep -l readFileSync`
confirms `perplexity.ts`, `brave.ts`, `tavily.ts`, `parallel.ts`,
`openai-search.ts` each still read the same `web-search.json` themselves. The
module's header claims to keep endpoints "in ONE place instead of
copy-pasting", and it does centralize *URL/key resolution*, but the underlying
config read+cache is still copy-pasted per module with **inconsistent failure
behavior**: a malformed `web-search.json` is a hard error in gemini/exa paths
and silently `{}` in provider-endpoints (so a typo'd config silently downgrades
everyone to defaults — with finding 3, that can silently redirect traffic).
One shared `loadWebSearchConfig()` in `utils.ts` (with one documented
error policy and one cache/invalidations story) is the obvious refactor.
`normalizeBaseUrl` is likewise duplicated (`provider-endpoints.ts:127`,
`gemini-api.ts:46`).

### 8. [MED] Silent degradation with no diagnostics channel — "no matches" is indistinguishable from "source broken"
Error strategy across sources is inconsistent and everywhere terminal-silent:
- `searchRecall` (~line 268): *any* exec failure (sqlite3 not installed, DB
  locked, SQL error) → `return []`.
- `searchSessions`/`searchDocs`: salvage partial stdout (good) but a missing
  `rg` binary also degrades to `[]`.
- `gitOut`: returns partial stdout, no distinction.

`searchMemory` returns only `MemoryHit[]`; there is no way to report "source X
failed / was skipped / timed out / truncated" to the model or the user.
`formatHits` will happily say `No matches in your history` when the actual
cause is `rg: command not found`. For a memory tool whose whole value is
trust in negative results, the return type needs a diagnostics side-channel
(`{ hits, sourceStatus: Record<MemorySource, "ok"|"partial"|"failed"> }`).

### 9. [MED] Machine-specific roots hardcoded; ignores the repo's own config-dir convention
`memory-search.ts:55-58`: `SESSIONS_ROOT = ~/.pi/agent/sessions`,
`WORK_ROOT = ~/work`, plus `full.split("/work/")[1]` in `searchDocs`
(~line 330) and `gitRepos` scanning only direct children of `~/work`.
Meanwhile `utils.ts:getWebSearchConfigDir()` honors `PI_CODING_AGENT_DIR` /
`XDG_CONFIG_HOME` — memory-search does not, so under a relocated agent dir the
tool silently searches the wrong (empty) tree. `~/work` as the universe of
"all projects" is this machine's layout, not a general contract for a
published plugin; scope="all" git/docs simply miss projects elsewhere, again
silently (see finding 8). These should at minimum be module constants
overridable via options/env, which would also fix testability (finding 2).

### 10. [MED] `scope="current"` session matching breaks on symlinked cwds and is structurally fragile
`sessionFolderForCwd` (~line 155) string-replaces `/`→`-` without resolving
symlinks. On macOS `/tmp` → `/private/tmp`; the session store (verified `ls`)
contains `--private-tmp--`, so a tool call with `cwd=/tmp/x` builds
`--tmp-x--` and finds nothing. Also verified live: the slug scheme is
lossy/ambiguous by pi's own design (`projectFromFolder` has to guess with a
`-work-` heuristic), and folder names can contain spaces
(`--Users-shamash-work-maenam-menu sync--`). Any change in pi's slugging
breaks this quietly. A more robust design: enumerate session dirs once and
match by *de-slugged candidates* against `realpathSync(cwd)`, or read the cwd
recorded inside session files.

### 11. [MED] `providerUrl` semantics differ per provider ("base" vs "full endpoint") with nothing in the type system to prevent misuse
`provider-endpoints.ts:72-76` docblock admits it: exa/parallel are *bases*
(callers append `/search` etc. — `exa.ts:11-12`, `parallel.ts:10-11`), while
brave/perplexity/tavily/openai are *full URLs* used verbatim. The
`ProviderEndpoint` record has no `kind` discriminator and `providerUrl`
returns a bare string, so adding provider #7 (or refactoring a caller) can
silently double-append or miss a path. A `kind: "base" | "endpoint"` field —
or splitting the accessors (`providerBase()` vs `providerEndpoint()`) — would
make the registry self-describing.

### 12. [LOW] Dead code / dead parameters
- `searchGit(query, …)` (~line 430): `query` is accepted and never used
  (verified — only the signature and a comment mention it).
- `parseRecency` (~line 700): in the second branch,
  the alternation `за прошл\S* недел` is unreachable — the *first* branch's
  `прошл\S* недел` already matches every such string (verified empirically:
  "за прошлую неделю" → 14d via branch 1). Dead alternation that suggests an
  intent ("за прошлую неделю" = 7d?) which never fires.
- `exa.ts` still keeps `CONFIG_PATH`/`loadConfig`/`WebSearchConfig` machinery
  whose URL/key role moved to provider-endpoints (partially dead weight, ties
  into finding 7).

### 13. [LOW] Shotgun surgery to add a 5th source
Adding a source touches: `MemorySource` union, a new `searchX` function, the
orchestrator's if-chain (+ its per-source `tokens.length > 0` guards), the
`tagOf` map in `formatHits`, the `StringEnum` in `index.ts:2062`, the
tool-description prose, and possibly the wants*/routing logic in
`index.ts:2075-2090`. The `searchX` functions already share an implicit
signature `(tokens, scope, cwd, sinceMs, now, perSourceCap)` — one interface
+ a registry array would collapse the orchestrator's special-casing (except
git's extra query/window quirks, which finding 6 wants explicit anyway). Not
urgent at N=4, but the seams are visible.

### 14. [LOW] `MemorySearchOptions.sinceMs` is a duration named like a timestamp
`memory-search.ts:47`. "Only items newer than this many ms ago" — every call
site must know it's a *lookback window*, not an epoch. `lookbackMs` or
`maxAgeMs` would remove a guaranteed future misreading (the git code then
converts it to `--since=<ISO>` — i.e. the natural representation really is a
point in time).

### 15. [LOW] `formatHits` fenced diff block can be broken by the diff content itself
`formatHits` (~line 745): expanded git diffs are wrapped in ` ```diff … ``` `
but a diff touching markdown files can legitimately contain ``` lines,
prematurely closing the fence and garbling the rest of the tool output. Needs
fence-escaping or a longer fence (` ```` `).

### 16. [LOW] keyword scoring uses raw substring matching
`keywordScore` (~line 104) uses `indexOf` per token, so `log` matches
`catalog`, `кот` matches `который`. Combined with the ≥2-char tokenizer this
inflates noise for short tokens. Acceptable for a v1 "deliberately simple"
ranker (the header says so), but worth a word-boundary pass before FTS5
arrives, since it also feeds the git stopword/window decision indirectly.

### 17. [LOW] Recall SQL is string-built; scale ceiling on full-table pull
`searchRecall` (~line 240): WHERE clause interpolates `proj` with only
single-quote doubling — safe for the values `basename(cwd)` can take today,
but it is still hand-rolled SQL escaping at a CLI boundary; and the query
pulls **every** active row (1261 today — fine; verified) then scores in JS.
No `LIMIT`, no FTS. Documented as a later upgrade; flagging the escape
pattern as the part that shouldn't survive that upgrade.

---

## What is genuinely well done

- **rg-as-index strategy is the right call.** Delegating the 8 GB JSONL scan
  to ripgrep and JSON-parsing only matched lines is a sound
  performance/simplicity trade; the docstring even records the measured win.
- **Partial-output salvage on non-zero exit** (sessions/docs/gitOut): treating
  rg exit 1 as "no matches", and keeping printed matches on exit 2, matches
  the actual CLI contracts instead of naively try/catch-discarding. Most
  first implementations get this wrong.
- **Secret redaction before snippets reach the model** — placed at the right
  choke points (`makeSnippet` + git diff expansion), pattern set is sensible.
- **`parseTimestamp` fallback chain** (numeric s/ms heuristic → `Date.parse`
  → mtime) shows real defensive thinking about heterogeneous event data.
- **Cyrillic-aware boundaries** in `wantsGit`/`tokenize`
  (`(?<![\p{L}\p{N}])гит(?!…)`, `\p{L}\p{N}` tokenizer) — verified: no false
  triggers on "агитация"/"digital difference". Bilingual intent detection is
  handled with actual care, not ASCII `\b` cargo cult.
- **Layering of provider-endpoints itself**: the four-tier precedence
  (per-provider env > per-provider config > unified proxy > default) is the
  correct order, is documented at the top, and the per-provider modules are
  now genuinely thin (`providerUrl("x")` one-liners; verified across 6
  modules). The declarative `ProviderEndpoint` record makes adding a provider
  a data change.
- **Deliberate exclusions documented** (gemini keeps its own resolver because
  of CF-gateway detection; codex OAuth endpoint stays hardcoded) — scoping
  the abstraction instead of forcing everything through it is good KISS
  judgment.
- **`index.ts` detail payload whitelists fields** instead of dumping raw hits
  — which incidentally contains the blast radius of finding 5.
- **Additive opt-in source routing** (docs/git detected from query never
  *replace* base sources except the explicit git+time-window case) is a
  thoughtful UX policy with the reasoning written down at the decision site.

---

## Verdict

Solid pragmatic v1 with several genuinely mature touches (CLI-contract-aware
error salvage, redaction, precedence layering), but it ships with a blocking
synchronous exec pipeline in an interactive agent host, zero tests around
brittle CLI/locale seams, one real cross-wired-secrets trap and one defective
security guard in the endpoint registry, and a 4×-duplicated mode predicate
that will drift. All are fixable without redesign; none should be ignored.

VERDICT: CONDITIONAL GO — maturity 6.5/10

Conditions (in order): #3 + #4 (key routing correctness), #1 (async + signal),
#8 (diagnostics channel), #5 (hidden fields), #2 (tests for the pure core at
minimum), #6 (single window-mode owner).
