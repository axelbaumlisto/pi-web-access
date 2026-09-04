# BLIND review 3 — merge-conformance & test-strategy critique of `/tmp/merge-plan-clean.md`

Scope: every factual claim in the plan checked against `main` (fork) and `upstream/main` (v0.27.0),
merge-base `58ce1566`. Evidence given as `file:line` (fork working tree) or `upstream/main:file:line`.
No project files were modified; `git log` was not used (only `merge-tree`, `diff`, `show`, `ls-tree`, `grep`).

Baseline sanity: the 8 fork-only test files currently pass on `main` (38 tests, 0 fail).

---

## 1) Errors (claims that are WRONG, with correction)

### E1. "Conflicts in the same **10** files" — WRONG (11), and 3 both-sides files auto-merge silently
`git merge-tree --write-tree main upstream/main` → 11 conflicting paths:
`CHANGELOG.md README.md brave.ts exa.ts gemini-api.ts gemini-search.ts index.ts openai-search.ts package.json perplexity.ts tavily.ts`.
The plan's own list has 11 names; only the number "10" is wrong. More important: three files were changed on BOTH sides and auto-merge without conflict — `parallel.ts`, `test/search-providers.test.mjs`, `test/tool-registration-config.test.mjs`. The plan never mentions `parallel.ts` as a fork-touched file (it uses `providerUrl("parallel")`, `parallel.ts:7-12`). I checked the merge-tree result: `parallel.ts` merges sanely (upstream only renamed `resolveApiKey → resolveParallelApiKey`). But auto-merged test files carry fork assertions that will silently coexist with upstream's new ones (see E6).

### E2. F9 "Brave HTML-sanitized snippets (already upstreamed in 0.14 — verify still there)" — WRONG
`stripHtml` exists **only** in the fork (`brave.ts:61-88`, added in our diff vs merge-base). `upstream/main:brave.ts` has no `stripHtml`, no entity decoding; it does `snippet: item.description || ""` (`upstream/main:brave.ts:204`). It was never in 0.14 either (it appears as `+` in `git diff 58ce1566 main -- brave.ts`).
Consequence: Task 1.3's "each file = upstream + exactly three fork touches" would drop `stripHtml` → `test/brave-sanitize.test.mjs` fails. Must be listed as a 4th re-apply.

### E3. "Each file = upstream + exactly three fork touches" (Task 1.3) — WRONG for brave.ts and exa.ts
Fork touches beyond `getApiKey` / `isXAvailable` / `!response.ok` redaction:
- `brave.ts`: `stripHtml` (E2) **and** invalid-JSON guard around `response.json()` (`brave.ts:223-231`). Upstream brave has no invalid-JSON handling. Guarded by `error-redaction.test.mjs:247` "Brave invalid-JSON on a 200 is redacted (HIGH 3)".
- `exa.ts`: invalid-JSON guards for both `/answer` and `/search` (`exa.ts:414-420`, `458-464`); `redactError` on three MCP paths (`exa.ts:202`, `239`, `246`); MCP URL under override (`exa.ts:15-18`). Upstream exa has none of these (`upstream/main:exa.ts:232-287`). Guarded by `error-redaction.test.mjs:169,189,207`.
- `tavily.ts`: upstream already has an invalid-JSON path (`upstream/main:tavily.ts:213`) — three touches is right there.
- `perplexity.ts`: fork also wraps the invalid-JSON message in `redactError` (`perplexity.ts:188`); upstream does not (`upstream/main:perplexity.ts` "returned invalid JSON: ${message}"). Guarded by `error-redaction.test.mjs:130`.

### E4. "Upstream `feature-config.ts` gates (per-tool enable) — hook `memorySearch.enabled` into the same mechanism" — WRONG
`upstream/main:feature-config.ts` is 30 lines and gates exactly one thing: `image.enabled` (`isImageEnabled()`, `canAttachImages()`). It has no per-tool machinery.
The real per-tool gate lives in **index.ts**: `isToolEnabled(config, key)` (`upstream/main:index.ts:259-263`) reading `config.tools?.[key]?.enabled` with `webSearch.enabled` as legacy fallback, keyed by `ToolNames` / `DEFAULT_TOOL_NAMES` (`upstream/main:index.ts:222-227`), plus `resolveToolNames()` which validates and de-duplicates names of *enabled* tools only (`:270-300`).
Correction for Task 2.5: add `memorySearch: "memory_search"` to `ToolNames`/`DEFAULT_TOOL_NAMES`; gate is `tools.memorySearch.enabled` (not a top-level `memorySearch.enabled`); register with `name: toolNames.memorySearch` so it participates in rename + duplicate detection (today it is hard-coded `"memory_search"`, `index.ts:2301`, and is invisible to the duplicate check). Don't touch `feature-config.ts`.

### E5. Task 2.3 omits a fork hardening that a named test asserts
Fork `isCloudflareGateway()` uses parsed hostname (`gemini-api.ts:54-59`); upstream uses `getApiHost().includes("gateway.ai.cloudflare.com")` (`upstream/main:gemini-api.ts:61-63`). `test/gemini-ssrf.test.mjs:126-138` ("Cloudflare gateway detection uses parsed hostname boundaries") asserts `gateway.ai.cloudflare.com.evil.com` is NOT a gateway. Task 2.3 lists only "two `isDirectGoogleHost()` guards + `buildKeyParam`" → test fails after merge.

### E6. Task 2.4 ("minimal: F4 only") omits two fork feature blocks in `gemini-search.ts`, each with a named test file
`git diff 58ce1566 main -- gemini-search.ts` contains, besides `takeAuto`/`isEmptyResponse`/`lastEmpty`:
1. **Grounding-redirect SSRF hardening**: `parseGroundingRedirectUrl` (exact host + path-prefix), `resolveRedirect(URL)` requiring https + `validateRemoteUrl()` from `ssrf-protection.ts` (`gemini-search.ts:610-668`). Upstream still does `url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")` and returns the raw `location` (`upstream/main:gemini-search.ts:906-928`). Guarded by 4 tests in `test/gemini-ssrf.test.mjs:91-124`.
2. **Gemini API-path options**: `appendSearchConstraints` (recency/domain constraints appended to the API prompt), `normalizeResultCount` (1..20, invalid → no cap), `dedupeResultsByUrl` (`gemini-search.ts:200-231`, `~503-510`). Upstream sends the bare query (`contents: [{parts:[{text: query}]}]`) and has no cap/dedupe. Guarded by all 6 tests in `test/gemini-options.test.mjs`.
`gemini-options.test.mjs` is absent from the F1–F10 table altogether. Both blocks must be re-applied in Task 2.4 or these 10 tests fail.

### E7. Test counts: "expect ~75 files" — WRONG
Upstream `test/` = 74 `.test.mjs`; ours = 41; fork-only = 8 (`brave-sanitize, error-redaction, fallback-empty, gemini-key-binding, gemini-options, gemini-ssrf, openai-key-binding, perplexity-fixes`). Upstream deleted none of our base 33. Merge-tree result = **82** test files; Task 0.3 adds `provider-endpoints.test.mjs` → **83**. "74 vs 41" and "8 fork-only" are CONFIRMED; "~75" is wrong.

### E8. Task 0.4 verify grep and F3 "every provider `!response.ok` path" — WRONG
- `rg 'redactCredential\(await response.text' *.ts → empty` fails **pre-merge**: `anysearch.ts`, `parallel.ts`, `serpdive.ts` match today (they are not in the 5-provider scope). Post-merge, 20 upstream files match. The acceptance criterion must be scoped to the 5 files.
- F3 says redaction is on "every provider `!response.ok` path". `grep -c redactError`: `openai-search.ts:0`, `tavily.ts:0` (also parallel 0, gemini-* 0). Only brave/exa/perplexity use `redactError` today. Not a merge blocker, but the invariant table overstates current coverage; Task 0.4 would actually *extend* F3 to tavily/openai (fine — say so).

### E9. `citationsToKeep` semantics — partially WRONG / overstated
`upstream/main:perplexity.ts:120-127`: `Math.min(available, MAX_CITATIONS /*20*/, Math.max(numResults, highestCited))` where `highestCited` is the max `[n]` (1–3 digits) in the answer. Plan omits the hard cap of 20. "Strictly better than keep ALL" is a judgment, not a superset: the fork test fixture (9 citations, answer cites `[8]`, `numResults:5`) yields **8** upstream vs 9 fork (uncited trailing citation dropped). The plan's decision to delete `perplexity-fixes.test.mjs:57` is therefore *required*, not optional. Also confirmed: the upstream test rename target "Perplexity normalizes invalid result counts" with `[1, 5, 3]` exists (`upstream/main:test/search-providers.test.mjs:96,117`), and upstream adds "Perplexity retains cited sources beyond numResults" (`:119`).

### E10. Minor naming: "keep upstream's `getApiBaseUrl()` as-is" (Task 1.3)
Upstream: `exa.ts:83 getApiBaseUrl()` (returns base), but `brave.ts:49 getApiUrl()` and `tavily.ts:61 getApiUrl()` (return base + `/web/search` / `/search`). Not a logic error; will trip a mechanical search-and-replace.

---

## 2) Missing

### M1. Brave proxyPath vs upstream base+suffix model — the plan hand-waves a gateway-contract change
Confirmed: upstream defaults are bases (`BRAVE_API_BASE_URL = "https://api.search.brave.com/res/v1"`, `TAVILY_API_BASE_URL = "https://api.tavily.com"`, `EXA_API_BASE_URL = "https://api.exa.ai"`) and brave appends `/web/search`, tavily `/search` (`upstream/main:brave.ts:50-56`, `tavily.ts:62-68`). Upstream test asserts `…/brave/res/v1/web/search?q=` (`upstream/main:test/search-providers.test.mjs:296`).
Fork today: `PROVIDER_ENDPOINTS.brave.proxyPath = "/v1/brave/search"` is the **full** gateway endpoint (`provider-endpoints.ts:83`, documented `README.md:416`). Under the plan's design (`defaultValue: proxied`, brave appends `/web/search`) the proxied URL becomes `https://airpx.cc/v1/brave/search/web/search` — wrong — unless the gateway also serves `/v1/brave/web/search` with `proxyPath = "/v1/brave"`. Task 2.1 step 3 says "update proxyPath accordingly" without stating the new value or acknowledging that the gateway route is an external contract not in this repo. Needs an explicit decision: (a) new proxyPath + gateway confirmation, or (b) keep a per-provider `kind: "base" | "full"` in `PROVIDER_ENDPOINTS` (perplexity/openai stay full URLs anyway — upstream perplexity has no base-URL override at all: `upstream/main:perplexity.ts:7` hardcodes the full URL; upstream `openaiResponsesUrl` is a full URL).

### M2. Config-semantics break for existing fork users
Fork `braveBaseUrl` / `tavilyBaseUrl` were FULL endpoint URLs (`brave.ts:9-10` comment "The value is the FULL search URL"); upstream's same keys are bases. A user with `braveBaseUrl: "https://gw/v1/brave/search"` silently gets `…/search/web/search` after 1.2.0. Needs a CHANGELOG "breaking" note + README fix; plan's Task 3.1 mentions neither.

### M3. README assertions live in 7 upstream tests, not one
Task 3.1 verifies README only via `tool-registration-config`. Upstream README regexes also in `auto-summary-source`, `curator-fallback`, `jina-search` (`JINA_API_KEY`, `jinaApiKey`), `summary-model-scope` (`"summaryGenerationDeadlineMs": 30000`, ``capped at `600000` ``), `tool-registration-config` (`"tools": {`, `"commands": {`, "Pi restart is required…"). Add them to the Task 3.1 verify line so a README resolution that drops an upstream section is caught.

### M4. `tool-registration-config.test.mjs` needs more than "insert at same index"
Upstream version adds ~95 lines with five `deepEqual` arrays (`upstream/main:test/tool-registration-config.test.mjs:68,87,145,146,162`) that will not contain `memory_search`. The auto-merge keeps our 3 edited arrays and upstream's new ones → several failures until all are updated. Plan says "the two tests" but under-counts the work.

### M5. Fork test env-scrub lists are stale for the 17 new providers
`fallback-empty.test.mjs:12-17` deletes only 0.14-era keys. Upstream auto chain now also consults `SEARXNG_BASE_URL, TINYFISH_API_KEY, SEARCH1API_KEY, SEARCHINFINITY_API_KEY, QUERIT_API_KEY, FIRECRAWL_BASE_URL, JINA_API_KEY, SERPDIVE_API_KEY, KAGI_API_KEY, BOCHA_API_KEY, OLLAMA_API_KEY, CLOUDFLARE_API_KEY, GOOGLE_GEMINI_BASE_URL` (`upstream/main:gemini-search.ts:584-760`). On a dev box with any of those set, brave-empty→perplexity ordering assertions break for reasons unrelated to code. Same for `brave-sanitize` (deletes 4 vars) though it uses explicit provider so less exposed. This is the F10 hermeticity principle applied to env, not just config dir.

### M6. `resolveApiBaseUrl` edge semantics the plan inherits without saying so
`upstream/main:utils.ts:40-71`: (a) `defaultValue` is returned **unvalidated** — so a proxy-derived default bypasses the HTTPS/no-creds checks; `proxyBaseUrl()` itself must be validated separately or the plan's "we inherit its HTTPS/no-creds validation" is only true for per-provider overrides; (b) `environmentValue !== undefined` counts as an override, so `EXA_BASE_URL=""` throws, whereas fork `normalizeBaseUrl` treats empty as unset; (c) trailing slashes stripped, `url.toString()` normalization applied.

### M7. Cache divergence between `provider-endpoints.ts` and upstream providers
`provider-endpoints.ts:139-160` caches `web-search.json` for process lifetime (`cachedConfig`, `resetEndpointCache()`); upstream providers' `loadConfig()` re-read per call. Upstream in-process tests that rewrite `web-search.json` after first import would see fresh keys but stale `*BaseUrl`/proxy values once `providerUrl()` is in the path. Not observed in the one base-URL test I read (config written before import), but worth a grep during Phase 3.

### M8. Phase 4 "four consumers" under-counts
Besides `searchWithResolvedProvider`, `isResolvedProviderAvailable`, `ALL_SEARCH_PROVIDERS`, and the auto chain, upstream also has `searchWithProviders` (for `"all"`/arrays, `upstream/main:gemini-search.ts:475`) and `searchWithConfiguredRouting` (`:580`). F4 semantics for `"all"` mode (should an empty provider be reported or skipped?) is undefined in the plan.

### M9. `parallel.ts` not in any task
Fork-modified (`providerUrl("parallel")`), auto-merges, has no `proxyPath`, and appears in the live script — fine — but should be in Task 2.1's file list since `providerUrl` semantics change there.

---

## 3) Doubtful assumptions

- **D1.** "Both proxies orthogonal, no code coupling." Confirmed `proxy` is a transport hop via curl (`upstream/main:utils.ts:306-328,444`) and the fork's is an API gateway — genuinely orthogonal. But the leak-check script mocks `globalThis.fetch`; `installGlobalProxyFetch()` captures `nativeFetch` at init and delegates to it when no proxy is active, so a mock installed *before* `index.ts` import is wrapped, one installed *after* replaces the wrapper. Either works with `proxy` unset; the plan's caveat is correct.
- **D2.** Task 2.2(c) routes `openaiResponsesUrl` through `resolveApiBaseUrl`. Upstream's `resolveConfiguredResponsesUrl` accepts `http:` (`upstream/main:openai-search.ts:177-191`); ours becomes https-only. No upstream test asserts http acceptance (only `https://gateway.example.com/v1/responses`, `:918`), so safe — but it is a deliberate tightening and should be stated.
- **D3.** Task 2.3: "`isDirectGoogleHost` also true for Vertex `aiplatform.googleapis.com`" — `isDirectGoogleHost()` reads `getApiHost()` (base host), while upstream's Vertex base comes from `getVersionedApiBase()` when ADC is active (`upstream/main:gemini-api.ts:82-89`). In ADC mode the API key is null anyway (`fetchGeminiApi` `adcMode`), so the guard is moot there; the proposed assertion tests a path that doesn't matter.
- **D4.** Task 2.2 step 2 mock: `getAll: () => [{provider:"openai-codex", id:"gpt-5.6-terra"}]` — CONFIRMED upstream uses `ctx.modelRegistry.getAll()` then `getApiKeyAndHeaders(preferred)` (`upstream/main:openai-search.ts:218-240`) and never `find`. Our mock (`test/openai-key-binding.test.mjs:41`) only provides `find` → `getAll` is undefined → caught → `resolvePiAuth` returns undefined → "direct OpenAI destination uses the personal model-registry key" fails. Plan is right that this must change. Note `pickSearchModel` excludes ids with `pro`/`ultra` segments and prefers `terra`; `gpt-5.6-terra` passes.
- **D5.** Task 0.3 helper signature `resolveProviderKey(provider, opts: {provider: string; …})` carries `provider` twice (id + display name). Feasible — `CredentialOptions.runCommand` is injectable (`credential-source.ts:66-73`) so the TDD spy works — but the API is awkward.
- **D6.** Exa: `isExaAvailable()` is hard-coded `true` in both trees (`exa.ts:371`, `upstream/main:exa.ts:442`); the plan's "every `isXAvailable()` uses `providerHasCredential`" doesn't apply to exa. Fine, just don't force it.
- **D7.** The "one merge commit" strategy with Phase 0 commits on `main` first is sound, and Task 0.2's revert makes `test/search-providers.test.mjs` merge trivially (confirmed both sides' hunks are disjoint). Good.
- **D8.** "Volume: index.ts 3036→3572" CONFIRMED (`wc -l`). Fork index.ts changes are purely additive (three hunks: header, import, memory_search block) — upstream-as-base is the right call.

---

## Claim-by-claim table

| Claim | Status |
|---|---|
| 10 conflicting files | WRONG — 11 (list is right, count wrong); + `parallel.ts`, 2 tests auto-merge |
| provider-endpoints.ts / redact.ts / memory-search.ts untouched upstream | CONFIRMED — absent in both merge-base and upstream |
| upstream perplexity has `citationsToKeep`, semantics = max(numResults, highestCited) | CONFIRMED exists; semantics incomplete (also `min(available, 20)`) |
| upstream utils has `resolveApiBaseUrl({configKey, configuredValue, defaultValue, environmentKey, environmentValue})` | CONFIRMED (`utils.ts:32-40`) |
| upstream utils has `fetchWithCredentialRedirects(url, init, credentialHeaders)` | CONFIRMED (`utils.ts:78-82`); used by brave/exa/tavily only — perplexity/openai still bare `fetch` |
| upstream defaults are bases for brave/tavily/exa | CONFIRMED |
| upstream index.ts uses feature-config.ts per-tool gates | WRONG — gate is `isToolEnabled()` in index.ts via `tools.<key>.enabled` |
| upstream openai-search uses `getAll()` not `find()` | CONFIRMED |
| 74 upstream vs 41 ours test files | CONFIRMED; merged = 82 (+1 new = 83), not ~75 |
| F1 guarded by perplexity-fixes / openai-key-binding / fallback-empty | CONFIRMED (fallback-empty only indirectly — it deletes proxy env; no proxy assertion) |
| F2 guarded by openai-key-binding / gemini-key-binding / gemini-ssrf | CONFIRMED |
| F3 guarded by error-redaction; "every provider" | Test CONFIRMED; "every provider" WRONG (tavily/openai have none) |
| F4 guarded by fallback-empty | CONFIRMED (3 tests: fall-through, all-empty, explicit strict) |
| F5 guarded by perplexity-fixes | CONFIRMED (`timeoutMs: 30000`, `AbortSignal.any`) |
| F6 guarded by tool-registration-config / lazy-extract-load | CONFIRMED (both assert `memory_search` at index 3) |
| F7 guarded by package-typebox-dependency (adapted) | CONFIRMED (`skills/` present, `pi-ext-int-search` name) |
| F8 `buildKeyParam` guarded by gemini-key-binding / gemini-ssrf | CONFIRMED |
| F9 stripHtml "already upstreamed" | WRONG — fork-only |
| F10 source-check hermetic | CONFIRMED (`test/source-check.test.mjs:9`) |
| upstream `.npmignore` dead because `files[]` | CONFIRMED (everything `.npmignore` excludes is either not in `files[]` or explicitly in it) |
| upstream added `package-lock.json`, `defuddle`, `undici` deps | CONFIRMED |
| 180 commits / +36K / 30 new files / ~40 new tests | CONFIRMED (180 / +36,288 / 31 non-test new files / 41 new tests) |
| `searchWithConfiguredRouting`, `"all"`, Codex-first auto (0.24.2) | CONFIRMED (`gemini-search.ts:568-599`) |

## Which of the 8 fork-only test files need changes, and why

1. **perplexity-fixes.test.mjs** — MUST delete "preserves every citation…" (upstream returns 8 of 9 for that fixture). Keep proxy-availability + 30 s timeout tests unchanged.
2. **openai-key-binding.test.mjs** — MUST replace `modelRegistry.find` mock with `getAll()` returning an `openai-codex` model (`terra`/plain `gpt-N` id, no `pro`/`ultra`). Assertions otherwise still valid.
3. **fallback-empty.test.mjs** — SHOULD extend env-scrub list with the 13 new provider env vars (M5). Assertions unchanged if takeAuto is re-applied to the same providers.
4. **brave-sanitize.test.mjs** — test unchanged, but passes only if `stripHtml` is re-applied (E2). Mocked `Response` 200 is fine with `fetchWithCredentialRedirects` (`redirect:"manual"`, non-3xx returned as-is).
5. **error-redaction.test.mjs** — test file: add the `redactProviderError` unit case (Task 0.4). Passes only if brave/exa invalid-JSON guards and exa MCP redaction are re-applied (E3). `callExaMcp(toolName, args, signal)` signature is identical in both trees — no change needed there.
6. **gemini-ssrf.test.mjs** — test unchanged; requires re-applying grounding-redirect hardening in gemini-search.ts (E6) and parsed-host `isCloudflareGateway` in gemini-api.ts (E5). `validateRemoteUrl(rawUrl, options)` export is unchanged upstream (`upstream/main:ssrf-protection.ts:183`).
7. **gemini-options.test.mjs** — test unchanged; requires re-applying `appendSearchConstraints`/`normalizeResultCount`/`dedupeResultsByUrl` (E6). Not in the plan at all.
8. **gemini-key-binding.test.mjs** — likely unchanged; `isGeminiApiAvailable` upstream = `isGeminiAdcAvailable() || hasGeminiApiKeySource() || isGatewayConfigured()`; the `isDirectGoogleHost()` guard goes inside `hasGeminiApiKeySource`. ADC is off unless explicitly selected (`gemini-adc.ts:270-280`), so `available:false` for override host still holds.

Plus the 5 adapted shared tests: `tool-registration-config` (5+ arrays, M4), `lazy-extract-load` (1 array), `package-typebox-dependency` (no change), `source-check` (no change), `search-providers` (revert in Task 0.2).

---

## 4) VERDICT: **CONDITIONAL GO** — maturity **6/10**

The skeleton is right (upstream-as-base, Phase 0 shrink, dependency-ordered resolution, single merge commit, hermetic tests, correct diagnosis of the `getAll()` drift and the transport-vs-gateway naming collision). But the plan's inventory of fork code is incomplete: it would drop **five** fork behaviours that **twelve** currently-green tests assert (stripHtml; brave/exa invalid-JSON guards + exa MCP redaction; parsed-host Cloudflare detection; grounding-redirect SSRF hardening; Gemini numResults/constraints), and its memory_search gate design targets a file (`feature-config.ts`) that doesn't do what the plan thinks. The base-vs-full URL change for brave is a real behavioural break for the gateway and for existing configs that the plan does not decide.

### Top-3 changes before executing
1. **Rebuild the fork-touch inventory from `git diff 58ce1566 main -- <file>` for each of the 8 conflicting `.ts` files** and map every hunk to a test. Add to Task 1.3: brave `stripHtml` + invalid-JSON guard; exa invalid-JSON ×2 + MCP `redactError` ×3 + MCP-under-override. Add to Task 2.3: parsed-host `isCloudflareGateway`. Add to Task 2.4: `parseGroundingRedirectUrl`/`validateRemoteUrl` redirect hardening and `appendSearchConstraints`/`normalizeResultCount`/`dedupeResultsByUrl`. Add `gemini-options.test.mjs` to the invariants table (F11: Gemini numResults/recency/domain contract).
2. **Fix Task 2.5's gate**: no `feature-config.ts`; add `memorySearch` to `ToolNames`/`DEFAULT_TOOL_NAMES` in `index.ts`, gate with `isToolEnabled(initConfig, "memorySearch")` (config shape `tools.memorySearch.enabled`), register `name: toolNames.memorySearch`; update all five upstream `deepEqual` arrays in `tool-registration-config.test.mjs`; document under README's existing `"tools": {` block (which a test asserts).
3. **Decide the URL-kind model in Task 2.1 explicitly**: either add `kind: "base" | "full"` to `PROVIDER_ENDPOINTS` (brave/tavily/exa/parallel = base with provider-appended suffix; perplexity/openai = full) and state the new brave `proxyPath` against the actual gateway route, or confirm the gateway serves `/v1/brave/web/search`. Validate `proxyBaseUrl()` through `resolveApiBaseUrl` too (defaults are returned unvalidated). Add a CHANGELOG "breaking: `braveBaseUrl`/`tavilyBaseUrl` are now bases" note. Also fix the verification lines: test count 83, Task 0.4 grep scoped to the 5 files, Task 3.1 README verify = the 5 README-asserting test files.
