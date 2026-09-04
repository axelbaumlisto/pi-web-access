# Blind architecture review — merge plan upstream v0.27.0 → pi-ext-int-search

Reviewer role: senior TS architect (SOLID/DRY/KISS). First read of `/tmp/merge-plan-clean.md`.
Evidence gathered from the working tree (`main`) and `upstream/main` via `git show` / `git diff` / `git merge-tree`.
No `git log`, no `research/**`, no prior reviews consulted.

---

## 1. Errors (with evidence)

### E1 — Task 1.2 drops F1 for Perplexity (URL touch missing)
Upstream `perplexity.ts` has **no** `resolveApiBaseUrl` and **no** base-URL override at all:
```
upstream/main:perplexity.ts:7    const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
upstream/main:perplexity.ts:166  response = await fetch(PERPLEXITY_API_URL, {
```
Our fork routes it through the gateway: `perplexity.ts:13 const getPerplexityUrl = () => providerUrl("perplexity");` and `perplexity.ts:150 fetch(getPerplexityUrl(), …)`.
Task 1.2 says "Take upstream for everything; re-apply only: getApiKey, isPerplexityAvailable, 30s signal, redactProviderError" — the **URL** is not in the list, and `perplexity.ts` is also absent from Task 2.1's file list. Result after the plan as written: `resolveProviderKey("perplexity")` returns the **proxy key** (destination resolves to airpx.cc) while the request goes to **api.perplexity.ai** → proxy key sent to Perplexity's real origin. That is an F1 loss and an F2 inversion, and `perplexity-fixes.test.mjs` "available with only unified proxy config" would still pass (it only checks availability). Acceptance text "F1 via resolveProviderKey" is therefore wrong: F1 needs the URL touch too.

### E2 — F9 is NOT upstreamed; Task 1.3 "exactly three fork touches" for brave is one short
Plan: "Brave HTML-sanitized snippets (already upstreamed in 0.14 — verify still there)".
```
$ git show v0.14.0:brave.ts       | grep -c stripHtml   → 0
$ git show upstream/main:brave.ts | grep -c stripHtml   → 0
ours brave.ts:61  function stripHtml(s: string): string
ours brave.ts:236/238  title: stripHtml(item.title…), snippet: stripHtml(item.description…)
```
It was never upstream. Taking upstream-as-base with only getApiKey/isAvailable/redaction re-applied deletes `stripHtml` → `brave-sanitize.test.mjs` fails. The Verify catches it, but the task description, the invariant table and the acceptance criterion are factually wrong; a mechanical executor would ship the loss or scramble to fix it inside 1.3 without a listed step.

### E3 — Layering regression: availability checks become throwing
Plan 2.1 routes `resolveProviderEndpoint()` through upstream `resolveApiBaseUrl()`, which **throws** on invalid/HTTP/credentialed URLs (`upstream/main:utils.ts:48-66`). Plan 0.3 routes `isXAvailable()` → `providerHasCredential()` → `providerProxyApiKey()` → `resolveProviderEndpoint()` (this call chain exists today: `provider-endpoints.ts:246 sameOrigin(resolveProviderEndpoint(provider).url, base)`).
Upstream's auto chain calls `isBraveAvailable()` etc. **outside** the `try` (`upstream/main:gemini-search.ts:601,616,…`), and upstream's `isBraveAvailable()` never touches the URL. After the plan, a bad `BRAVE_BASE_URL` makes `isBraveAvailable()` throw → the **whole auto chain aborts** with a Brave URL error even when the user has Exa/Tavily configured. Upstream and today's fork both degrade gracefully (error pushed to `fallbackErrors`, chain continues). New failure mode introduced purely by the "on top" layering. Fix: `providerHasCredential`/`providerProxyApiKey` must catch resolver errors and treat the provider as not-proxied; the real fetch path will still throw the good message.

### E4 — Task 2.1 does not deliver what its acceptance claims for `proxyBaseUrl`
"we inherit its HTTPS/no-creds validation" is true only for *per-provider* overrides. The proxy URL is passed as `defaultValue`, and `resolveApiBaseUrl` returns `defaultValue` **untouched** (`utils.ts:43 if (value === undefined) return options.defaultValue;`). So `WEB_SEARCH_PROXY_URL=http://…` or `https://u:p@airpx.cc` sails through unvalidated — in a fork whose primary mechanism IS the proxy base. Add an explicit validation of `proxyBaseUrl()` (reuse `resolveApiBaseUrl` with `configKey:"proxyBaseUrl"`, `environmentKey:"WEB_SEARCH_PROXY_URL"`), otherwise the security claim in README §(2) of Task 3.1 is false.

### E5 — Verify commands for 1.2, 1.3, 2.1, 2.2, 2.4 are not runnable when scheduled
Every one of them includes `test/search-providers.test.mjs`. That file (auto-merged from upstream) spawns children importing `../index.ts`, `../openai-search.ts`, `../gemini-search.ts`:
```
upstream/main:test/search-providers.test.mjs  ModuleUrls: brave exa index openai-search perplexity gemini-search searxng tavily
```
`index.ts` is unresolved until 2.5, `gemini-search.ts` until 2.4, `openai-search.ts` until 2.2. `node --test test/search-providers.test.mjs` runs all 29 tests → guaranteed failures unrelated to the task. "Tests green at every phase boundary" cannot be demonstrated for Phase 1 or for 2.1–2.4 as written. Either use `--test-name-pattern` per task or move that file to 2.5/3.2.

### E6 — Task 2.5 cites the wrong mechanism
"Upstream `feature-config.ts` gates (per-tool enable)" — `feature-config.ts` only contains `image.enabled` (`upstream/main:feature-config.ts:6 type FeatureConfig = { image?: { enabled?: unknown } }`). Per-tool gating lives in `index.ts`: `isToolEnabled(config, key)` reading `config.tools?.[key]?.enabled` (`index.ts:259-263`) plus `DEFAULT_TOOL_NAMES`/`resolveToolNames` (`index.ts:215-300`). The config key is therefore `tools.memorySearch.enabled`, not `memorySearch.enabled` as the plan and the commit message say. Mechanism choice (add to `ToolNames`) is right; the description will mislead the README and test author.

### E7 — Task 0.3 helper signature cannot host the test it prescribes
Step 1 requires "inject a spy `runCommand` … assert not invoked". The proposed `resolveProviderKey(provider, {provider, configuredValue, environmentValue, signal})` has no `runCommand`/`environment` passthrough, but upstream's `CredentialOptions` does (`credential-source.ts:70-77`). Either accept `CredentialOptions` wholesale or the test is unwritable. Also the signature carries the provider id twice (`"brave"` + `provider:"Brave"` label) — add a `label` to `PROVIDER_ENDPOINTS` instead.

### E8 — Minor factual slips
- "conflicts in the same 10 files" — `git merge-tree` shows **11** (the list itself has 11).
- Task 2.3 Verify references `test/gemini-options.test.mjs` — exists in ours, fine; but `gemini-api-transport.test.mjs` is upstream's and depends on nothing conflicted — OK. (No error, noted as checked.)
- Task 2.1 live script prints the first 9 chars of live keys to the terminal; print a boolean.

---

## 2. Missing

### M1 — Gateway path contract for brave/tavily changes silently (Task 2.1 step 3)
Upstream treats `braveBaseUrl`/`tavilyBaseUrl` as **bases** and appends `/web/search` and `/search` in the provider (`upstream/main:brave.ts:50-56`, `tavily.ts:62-68`; asserted by upstream test `search-providers.test.mjs:290 "https://gateway.example.com/brave/res/v1/web/search?…"`). Today the fork's proxy full URL is `${base}/v1/brave/search`. If brave's `proxyPath` becomes a base, the request becomes `${base}${proxyPath}/web/search` — i.e. the gateway must serve `/v1/brave/web/search` (or `proxyPath` must be `/v1/brave` **and** the gateway route changed). The plan says "update proxyPath accordingly" without stating what the gateway serves. The live check only asserts "shows airpx.cc", not the full path → the mismatch would go unnoticed until a real search. Needed: explicit target URLs per provider in Acceptance and a check against the gateway's route table (external dependency).

### M2 — Redirect-credential stripping is not extended to the proxied providers that lack it
Plan sells `fetchWithCredentialRedirects` as closing "a real hole in our proxy mode", but upstream applies it only to brave/exa/tavily. Of the four proxied providers, **perplexity** (`upstream/main:perplexity.ts:166 fetch(`) and **openai** (`openai-search.ts:525 fetch(`) still use bare `fetch`. Either add it as a fork touch in 1.2/2.2 or don't claim the hole is closed.

### M3 — Dead sync resolver left beside the new async one
`provider-endpoints.ts:222 providerApiKey()` has zero callers in `*.ts`/`test/**` (only the plan's live script uses it) and ignores `$ENV`/`!cmd` sources. After 0.3 there will be two "resolve the key" functions with divergent semantics. Delete it in 0.3 (or make the live script use `resolveProviderKey`).

### M4 — The leak check is not in the repo
Task 3.2's gate depends on "the leak script from 2026-07-26 session". Not reproducible by anyone else, not run by CI, not run at Phase 4. Commit it as a hermetic test (`PI_CODING_AGENT_DIR` temp dir, fake proxy config, five fake personal keys, mocked `fetch` asserting header value per destination). `openai-key-binding`/`gemini-key-binding` cover two of five providers today.

### M5 — Task 3.1 Verify runs one README-asserting test; upstream has six more
`git grep -l README upstream/main -- test/` → `auto-summary-source, brightdata-serp, curator-fallback, github-extract, jina-search, summary-model-scope, tool-registration-config`. Resolving README against upstream can drop sentences these tests match. Run all of them in 3.1 (they are caught in 3.2, but then the README loop happens late).

### M6 — Intermediate F2 inversion between 1.3 and 2.1 is not called out
At the 1.3 boundary, `getApiKey` → `resolveProviderKey` decides "proxied" by *our* resolver while `getApiUrl()` is upstream's (no proxy). Hermetic tests don't configure a proxy, so they are green while the tree would send the proxy key to api.search.brave.com. Acceptable inside one uncommitted merge, but the plan should say "do not run live checks before 2.1" — the live check in 2.1 step 5 is exactly where someone would first try it.

### M7 — `parallel.ts` is a fork-touched, auto-merging file not mentioned anywhere
`parallel.ts:7 import { providerUrl } from "./provider-endpoints.ts"` — it will inherit the new throwing semantics of 2.1 and appears in the live script, but is in no task's file list. Harmless, but the "fork-only files untouched" sentence understates the footprint.

---

## 3. Doubtful assumptions

### D1 — "Pre-merge refactor makes our side smaller" (Phase 0.3/0.4) — the merge tactic is moot
The plan resolves every conflicted file **upstream-as-base + surgical re-apply**. Under that strategy the fork's pre-merge call-site edits in brave/exa/tavily/perplexity/openai are discarded on `git checkout --theirs`-style resolution; only the helpers in `provider-endpoints.ts`/`redact.ts` (non-conflicting files) survive. So 0.3/0.4 are not a merge-surface reduction; they are a standalone refactor done twice (once pre-merge, once during re-apply). Recommendation: 0.3/0.4 = **helpers + tests only**; swap call sites during 1.2/1.3/2.2. The DRY win itself is real but modest (5×3 lines → 5×1 line); its actual value is that every future re-apply is a one-liner per provider — that's the argument to make, not "smaller diff".

### D2 — `resolveApiBaseUrl` "on top" is only half the providers
The layered design works cleanly for brave/exa/tavily (upstream already funnels through the same function with the same config keys). For perplexity and openai upstream has no such call (E1) or a different validator (`resolveConfiguredResponsesUrl`, allows `http:`). Adopting `resolveApiBaseUrl` for openai tightens to HTTPS-only and changes the error text — no upstream test asserts the openai message (checked), so it's safe, but it is a behavior change the CHANGELOG should mention.

### D3 — `PROVIDER_ENDPOINTS` stays heterogeneous (bases vs full URLs)
After 2.1: exa/brave/tavily/parallel = bases, perplexity/openai = full URLs. That is exactly today's comment (`provider-endpoints.ts:71-73`), so nothing new breaks, but the plan sentence "providers append `/web/search`, `/search` themselves (as upstream does)" is only true for three of six. Keep the per-entry comment; don't imply uniformity.

### D4 — Phase 4 `PROVIDER_TABLE` is the right shape but the wrong PR
Value is real: F4 currently covers 9 of ~18 auto providers; upstream added 17 providers in 13 releases and will add more. Cost: the four lists (`searchWithResolvedProvider` 30-way switch, `isResolvedProviderAvailable`, `ALL_SEARCH_PROVIDERS`, 17-block auto chain) are the **highest-churn region** of upstream's `gemini-search.ts`. Owning a table there guarantees a conflict on every future sync, and the table must model: `useCurrentModel` for openai, `CredentialResolutionError` rethrow only for exa, `shouldTryOpenAIInAuto` + Codex-first rank, gemini `strictErrors`, async `isGeminiWebOptionallyAvailable`, the "explicit-only" set — six optional fields for ~18 rows. It is not over-engineering per se; it is a refactor upstream should own. Either (a) propose it upstream and rebase F4 on it, or (b) get F4 uniformly with the smallest footprint: a `nonEmptyOrThrow()` wrapper (throws `EmptyResultError`, records `lastEmpty`) applied at each `searchWithX(...)` call in the auto chain — one token per site, the existing `catch` does the continuation, and re-apply on the next merge is mechanical. Keep it out of this PR either way.

### D5 — `overridden = url !== ep.default` for Exa MCP
Works because `resolveApiBaseUrl` normalises trailing slashes, but an explicit `exaBaseUrl: "https://api.exa.ai"` now reads as *not overridden* (MCP stays on mcp.exa.ai). Same as today's `normalizeBaseUrl`, so acceptable — just confirm the test in 2.1 step 1 pins it.

### D6 — Empty-string env var semantics change
Today `normalizeBaseUrl("")` = unset. Upstream `resolveApiBaseUrl` treats `environmentValue !== undefined` as set → `BRAVE_BASE_URL=""` throws "must be an absolute HTTP(S) URL". Matches upstream, fine, but it is a fork behavior change; note it.

### D7 — Task 0.2 is correct and necessary (positive finding)
`test/search-providers.test.mjs` **auto-merges** (merge-tree), and since only our side touched the `[1,5,3]→[5,5,5]` lines, git would keep `[5,5,5]` against upstream's `citationsToKeep` → test failure. Reverting pre-merge is the right call. Upstream's `citationsToKeep` (`perplexity.ts:120-127`) is indeed a superset of our intent.

### D8 — Sound parts, explicitly
- Naming-collision analysis (transport `proxy` vs gateway `proxyBaseUrl`) is correct; no coupling in upstream code (`utils.ts:253-330`), no config-key whitelist that would reject ours.
- Task 2.3 (gemini) is right: upstream ADC path bypasses `getApiKey` when `adcMode` (`gemini-api.ts:160`), so the `isDirectGoogleHost()` guard is orthogonal; `.googleapis.com` suffix covers Vertex.
- Task 2.2 (a)/(b)/(d) map cleanly onto upstream's `resolvePiAuth(ctx, responsesUrl, providers, modelOverride)` and `useCodexEndpoint ?? (...)` (`openai-search.ts:505`); the `getAll()`+`pickSearchModel` mock note is accurate.
- Task 2.4 note about Codex-first ordering (0.24.2) is accurate (`gemini-search.ts:594-596, 611-614`).
- Task 0.1 is correct: `files[]` already wins; `.npmignore`'s mp4 exclusion is already ineffective.
- Package/rollback steps are fine.

---

## 4. VERDICT

**CONDITIONAL GO** — maturity **6/10**.

The architecture decision (proxy as `defaultValue` under upstream's resolver; destination-first key selection in one module; upstream-as-base resolution order) is sound and the phase ordering is dependency-correct. But the plan has two invariant-losing task descriptions (E1 perplexity URL, E2 brave `stripHtml`), one layering regression it does not see (E3 throwing availability), one hollow security claim (E4), and verify commands that cannot pass when scheduled (E5). None is hard to fix; all would bite a literal executor.

### Top-3 changes before executing
1. **Correct the fork-touch inventories and harden the helper layer.** Task 1.2: add `providerUrl("perplexity")` to the re-apply list (and to 2.1's file list). Task 1.3: brave has four touches (`stripHtml`); drop "already upstreamed" from F9. In `provider-endpoints.ts`: `providerHasCredential`/`providerProxyApiKey` must not throw (catch resolver errors → not proxied), and `proxyBaseUrl()` must be validated with `resolveApiBaseUrl` itself. Delete dead `providerApiKey()`. Accept `CredentialOptions` in `resolveProviderKey`.
2. **Make every Verify actually runnable and the leak check reproducible.** Remove `search-providers.test.mjs` from 1.2/1.3/2.1/2.2/2.4 (or filter with `--test-name-pattern`); run all seven README-asserting tests in 3.1; commit the five-provider leak check as a hermetic test and make 2.1's Acceptance state the **exact** full URLs per provider (`https://airpx.cc/v1/brave/…`) after confirming the gateway's route for brave/tavily under the new base semantics (M1).
3. **Right-size Phase 0 and Phase 4.** Phase 0.3/0.4: helpers + tests only, call-site swaps during re-apply (D1). Phase 4: out of this PR; pursue as an upstream contribution or implement F4-for-all via a one-token `nonEmptyOrThrow()` wrap rather than owning upstream's highest-churn lists (D4).
