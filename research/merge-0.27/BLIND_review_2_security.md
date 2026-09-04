# BLIND review #2 — application security (credentials, SSRF, proxy/gateway trust boundaries)

Scope: plan `/tmp/merge-plan-clean.md` vs. real code in `main` (fork) and `upstream/main` (v0.27.0).
Every claim below was checked against the working tree or `git show upstream/main:<file>`; I did not read
prior reviews or plans.

---

## 1) Errors (with evidence)

### E1 — F2 is already violated today and the plan's `resolveProviderKey` design preserves the hole
**Claim (plan F2):** "personal key … never sent to proxy origin".
**Reality:** `provider-endpoints.ts:223-233` (`providerApiKey`) and `openai-search.ts:165-186` (`resolveOpenAIAuth`)
do `proxyKey = providerProxyApiKey(p); if (proxyKey !== null) return proxyKey;` and then **fall through to the
personal credential** when the proxy key is *absent* even though the destination *is* the proxy origin.
`providerProxyApiKey` (`provider-endpoints.ts:243-248`) returns `null` both for "not proxied" and for
"proxied but no proxy key configured" — the two cases are indistinguishable to callers.

Reproduced (hermetic `PI_CODING_AGENT_DIR`, `WEB_SEARCH_PROXY_URL=https://airpx.cc`, **no** `WEB_SEARCH_PROXY_KEY`):
```
exa:    https://airpx.cc/v1/exa        exa-LEAK
openai: https://airpx.cc/v1/responses  sk-personal-LEAK
```
Realistic trigger: proxy URL set via env, proxy key only in `web-search.json`, and the JSON is malformed —
`loadRawConfig()` swallows the parse error and returns `{}` (`provider-endpoints.ts:151-165`), so the key vanishes
while the base URL from env survives → personal keys go to the gateway.

The plan's Task 0.3 algorithm ("1. `providerProxyApiKey(p)` non-null → return it, STOP; 2. `resolveCredential`")
re-implements exactly this. The Task 0.3 test list has no case for "proxied destination + no proxy key".
**Fix:** `resolveProviderKey` must branch on *destination*, not on key presence:
`if (isProxiedDestination(p)) return proxyApiKey(); /* may be null → provider unavailable */`. Same for
`providerHasCredential`. Add the test.

### E2 — Task 1.2 omits re-wiring the Perplexity URL → proxy key would be sent to `api.perplexity.ai`
Upstream `perplexity.ts:7` is `const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions"` and
`perplexity.ts:166` fetches that constant. Upstream never added `perplexityBaseUrl` (only brave/exa/tavily got
`resolveApiBaseUrl`). The fork's `perplexity.ts:13` uses `providerUrl("perplexity")`.
Task 1.2 says "re-apply only: getApiKey, isPerplexityAvailable, signal, redactProviderError" — the URL getter is
not in the list, and Task 2.1 step 4 only lists brave/exa/tavily. Result after a literal execution of the plan:
`resolveProviderKey("perplexity")` says "destination = proxy → proxy key" while the fetch goes to
`api.perplexity.ai` → **proxy key sent to a non-proxy host** (F2 second half), and proxy mode for Perplexity
silently stops working. Add `providerUrl("perplexity")` to Task 1.2 acceptance and to the 2.1 live check.

### E3 — Task 1.3 step 3 states a falsehood: "fetchWithCredentialRedirects is used for every keyed call (upstream does)"
Upstream uses `fetchWithCredentialRedirects` only in `brave.ts:175`, `exa.ts:470,490`, `tavily.ts:182`.
Bare `fetch` with default `redirect: "follow"` is still used for keyed calls in `perplexity.ts:166`,
`openai-search.ts:525`, `gemini-api.ts:183`, `parallel.ts:352`. For `Authorization` undici strips the header on
cross-origin redirects per the Fetch spec, so perplexity/openai/parallel are protected by the runtime, **but
`x-goog-api-key` (gemini) and `cf-aig-authorization` are custom headers and are NOT stripped by undici**. Fork users
are precisely the ones pointing `geminiBaseUrl` at a gateway, so a gateway 302 to another origin would forward
the Gemini key. Wrap `fetchGeminiApi`'s fetch (and, for defence in depth, perplexity/openai) in
`fetchWithCredentialRedirects(url, init, ["x-goog-api-key","cf-aig-authorization","Authorization"])`.

### E4 — `proxyBaseUrl` gets none of the URL validation the plan advertises
Task 2.1 routes per-provider overrides through upstream `resolveApiBaseUrl` but feeds the proxy-derived URL in as
`defaultValue`. `utils.ts:40-43`: `if (value === undefined) return options.defaultValue;` — **defaults are returned
unvalidated**. `proxyBaseUrl()` itself (`provider-endpoints.ts:171-176`) is only `normalizeBaseUrl` (trim + strip
slashes). Reproduced: `WEB_SEARCH_PROXY_URL='http://user:pw@airpx.cc'` → `http://user:pw@airpx.cc/v1/exa` with
`proxy-K` attached. Plaintext HTTP + embedded creds accepted for the *one* URL that receives every key.
Fix: validate `proxyBaseUrl` with the same rules (call `resolveApiBaseUrl({configKey:"proxyBaseUrl", environmentKey:
"WEB_SEARCH_PROXY_URL", configuredValue, environmentValue, defaultValue: ""})` and treat `""` as unset), and add
the test `proxyBaseUrl=http://…` → throws.

### E5 — Task 2.3's new test asserts something vacuous
"`geminiAuth:"adc"` + override host → `getApiKey()` null, ADC path unaffected by our guard". Upstream
`gemini-adc.ts:270-281`: `isGeminiAdcAvailable()` returns `false` whenever `hasExplicitApiBase()` is true. So with
an override host ADC is *off by upstream design*; the test would pass regardless of our guard and proves nothing
about ADC + guard coexistence. The useful test is: `geminiAuth:"adc"`, **no** override, ADC file present, **no**
`GEMINI_API_KEY` → `isGeminiApiAvailable()` true and `fetchGeminiApi` targets `https://aiplatform.googleapis.com`
without ever calling `getApiKey`. (Note also `gemini-adc.ts:283-288` has its *own* `hasGeminiApiKeySource()` that
counts the ambient env key without our destination guard — harmless because it only *disables* ADC, but it means
the fork guard lives in two places semantically.)

---

## 2) Missing

### M1 — F3 ("every provider `!response.ok` path") silently shrinks to 5 of ~24 providers
Task 0.4 covers brave/exa/tavily/perplexity/openai. Upstream's 17 new providers, gemini, parallel, kimi, xai use only
`redactCredential(text, apiKey).slice(0,300)` — exact-match scrub, no pattern scrub, no trailing-partial handling.
The invariants table will be wrong after merge. Cheapest complete fix: apply `redactError()` once at the aggregation
points in `gemini-search.ts` (`fallbackErrors.push(\`X: ${errorMessage(err)}\`)`) and in `render-search-error.ts`,
rather than 24 per-provider edits. Either do that or state the reduced scope in README/SECURITY.

### M2 — Inherited SSRF bypass via the model-controlled `proxy` tool parameter (upstream, not fork-introduced)
`index.ts:1799-1805, 2388-2393, 2509-2523` accept `proxy` as an LLM-supplied tool param and pass it to
`runWithProxy` → `normalizeProxyUrl` (`utils.ts:214-232`) checks only scheme + non-empty host. `ssrf-protection.ts`
validates the **target** URL; the **proxy host** is never checked, and `isProxyBypassedUrl` applies to the target.
A prompt-injected `proxy: "http://127.0.0.1:8080"` or `http://169.254.169.254` makes curl open a TCP connection to
an internal host and send `GET http://public.example/ …`; a non-proxy HTTP service will typically answer with its own
`/` and the body is returned to the model. This is exactly the class `ssrf-protection.ts` exists to block. The fork
already positions itself as the "safe proxy story", so at minimum: run `assertPublicAddress`/DNS preflight on the
proxy hostname (respecting `ssrf.allowRanges`), or add a config gate (`proxy` param honoured only when
`web-search.json` opts in). Document it in the README "orthogonal proxies" section the plan already promises.

### M3 — Inherited credential exposure through curl argv
`utils.ts:409-412`: every request header, including `Authorization: Bearer <token>` / `x-api-key`, is passed as
`-H "name: value"` on the `curl` command line. `/proc/*/cmdline` (Linux) and `ps` (macOS) expose argv to other
local users for the lifetime of the request. Not fork-introduced, but the merge ships it. Mitigation is trivial
(`-H @headersfile` in the same temp dir already used for the body, or `--config`). At least add a SECURITY.md note.

### M4 — No test for `WEB_SEARCH_PROXY_URL` env + config-file proxy key with malformed JSON (the E1 trigger).

### M5 — Task 0.3's "inject a spy runCommand" requires the new `resolveProviderKey` signature to forward
`runCommand` (upstream `credential-source.ts:65-77` exposes `runCommand?: CredentialCommandRunner`). The plan's
signature `{provider, configuredValue, environmentValue, signal}` drops it; the spy test cannot be written as specified.

### M6 — Gemini guard scheme check
`isDirectGoogleHost()` (`gemini-api.ts:62-70`) accepts `http://…googleapis.com`; the ambient key would then travel
in plaintext (and the 301→https hop is cross-origin, so undici keeps the custom header — see E3). Require `https:`.

---

## 3) Doubtful assumptions

### D1 — (a) fetchWithCredentialRedirects / installGlobalProxyFetch / runWithProxy vs. F2 — **sound**
- `fetchWithCredentialRedirects` (`utils.ts:78-118`) always sends `redirect: "manual"`, compares parsed `origin`, and
  deletes only the named credential headers on cross-origin hops (max 5, HTTP(S) only). It strictly strengthens F2:
  gateway→elsewhere strips the proxy key; provider→gateway strips the personal key.
- Under the curl transport, `installGlobalProxyFetch` (`utils.ts:307-330`) wraps `globalThis.fetch`, so the
  `fetch(...)` call inside `fetchWithCredentialRedirects` goes to `fetchViaCurl`. `fetchViaCurlOnce` never passes
  `-L`, and `fetchViaCurl` returns immediately when `redirect === "manual"` (`utils.ts:372`), so the origin logic
  stays in the caller. For non-manual callers `fetchViaCurl` drops **all** headers cross-origin (`utils.ts:390-393`),
  i.e. the curl path is at least as strict as native. No bypass found.
- Key *selection* (F2) happens before any fetch and is transport-independent, so `runWithProxy` cannot change which
  key is bound. Verified.

### D2 — (b) Upstream sends the registry Codex token to `openaiResponsesUrl` without an origin check — **confirmed**
`openai-search.ts:245-252` (`resolveOpenAIAuth`) and `273-276` (`isOpenAISearchAvailable`): `if (ctx) resolvePiAuth(ctx,
responsesUrl, providers, …)` with `responsesUrl = resolveConfiguredResponsesUrl(config.openaiResponsesUrl)`, which
(`177-192`) accepts **http:** as well. `runOpenAISearch` (`525`) then POSTs `Authorization: Bearer <registry token>`
to `auth.responsesUrl`. The fork's `isOpenAIAuthOrigin` gate (`openai-search.ts:118-129`, origin set = api.openai.com +
chatgpt.com, scheme-inclusive) is a real fix and must survive as the plan says. Note `searchWithCurrentModelOpenAI`
(`resolveCurrentModelSearchTarget`, `59-79`) already hard-pins `api.openai.com`/`chatgpt.com` over HTTPS, so it is
fine as is. Also good: `useCodexEndpoint` gate (d) is needed — upstream's `isCodexJwt(auth.apiKey)` (`505`) would
redirect a JWT-shaped *proxy* key to `chatgpt.com`.

### D3 — (c) Gemini `isDirectGoogleHost` vs. Vertex and lookalikes — **sound, with two caveats**
`hostname.endsWith(".googleapis.com")` covers `aiplatform.googleapis.com` and `*-aiplatform.googleapis.com` (all
`getVertexApiBase` output, `gemini-adc.ts:11,73`). The leading dot defeats `evil-googleapis.com`,
`googleapis.com.evil.com`, and `x.googleapis.com.` (trailing-dot → treated as non-Google → env key withheld, which is
the safe direction). The only third-party-influenced `*.googleapis.com` names are GCS bucket hosts
(`<bucket>.storage.googleapis.com`); the request still terminates at Google and the bucket owner cannot read request
headers, and the user must configure that host themselves — not a practical leak. Caveats: no `https:` check (M6),
and in ADC mode the guard is irrelevant because ADC is disabled by any override (E5).

### D4 — (d) The leak check mocking `globalThis.fetch` — **still valid, but for a different reason than the plan gives**
`installGlobalProxyFetch()` runs only inside the extension entry (`index.ts:1059-1061`), not at import, so a script
that imports provider modules never sees the wrapper; the plan's "run with no `proxy` configured" note is harmless
but not the real constraint. The real constraints: (1) brave/exa/tavily now call `fetch(URL, {redirect:"manual"})`
with a `URL` object and then read `response.status` / `response.headers.get("location")` — the mock must return a
real `Response` (fork tests already do: `test/error-redaction.test.mjs:113`, `fallback-empty.test.mjs:35` uses
`String(url)` — fine), and (2) the leak script must also cover the *negative* case from E1 (proxy URL, no proxy key)
and the Perplexity URL from E2. I could not inspect "the leak script from 2026-07-26" — it is not in the repo.

### D5 — (e) Dropped items
- `.npmignore` removal: verified `npm pack --dry-run` on `main` already ships `pi-web-fetch-demo.mp4` (5.1 MB)
  despite `.npmignore` excluding it, and excludes `research/`, `test/`, `.pi/` purely via `files[]`. So the file is
  dead and removing it loses no security property. Side effect: the *intent* of the `.npmignore` (drop the mp4) is lost;
  if wanted, remove it from `files[]` instead.
- Perplexity "keep all citations" removal: `citationsToKeep` (`upstream perplexity.ts:120-127`) is bounded by
  `available`/`MAX_CITATIONS`; no security dimension. Fine to drop.
- No other security property is dropped. `ssrf-protection.ts`, `credential-source.ts`, `memory-search.ts` have no
  fork-side security changes that the merge would discard.

### D6 — Task 2.1 "defaults are bases; providers append paths" changes gateway routes
Brave `proxyPath` is today `/v1/brave/search` (full path). If brave.ts appends `/web/search` to the base (as upstream
does), the gateway URL becomes `https://airpx.cc/v1/brave/search/web/search` unless `proxyPath` and the *external*
gateway routes are changed together. Not a leak, but a coordinated change the plan hand-waves ("accordingly").

---

## 4) VERDICT

**CONDITIONAL GO** — maturity **6/10**.

The architecture (destination-first key binding layered on upstream's resolver, single helpers, upstream-as-base
resolution) is right, and the F2 analysis of upstream's redirect/curl layers holds up. But the plan re-encodes an
existing F2 hole (E1), drops Perplexity's proxy URL wiring (E2), misstates upstream's redirect coverage (E3), and leaves
the gateway URL itself unvalidated (E4). Two inherited transport-proxy issues (M2, M3) should at least be documented
because the fork's README will now describe both proxies side by side.

**Top-3 changes before executing:**
1. **Make `resolveProviderKey`/`providerHasCredential` branch on destination, not key presence** (E1): proxied
   destination → `proxyApiKey()` or `null`, never a personal credential; validate `proxyBaseUrl` (HTTPS, no creds,
   no query) instead of passing it as an unvalidated `defaultValue` (E4). Add tests for "proxy URL + no proxy key +
   personal env key → unavailable" and "http://proxy → throws".
2. **Fix Task 1.2/2.1 to re-apply `providerUrl("perplexity")`** (upstream has a hard-coded constant) and correct
   Task 1.3 step 3: wrap `fetchGeminiApi` (custom `x-goog-api-key`), perplexity and openai fetches in
   `fetchWithCredentialRedirects` (E2, E3). Extend the live leak check to assert the Perplexity URL.
3. **Close the F3 scope gap centrally and document inherited transport-proxy risks**: apply `redactError` at the
   `gemini-search.ts`/`render-search-error.ts` aggregation points so all ~24 providers get pattern redaction (M1);
   validate or gate the model-controlled `proxy` tool param against the SSRF guard (M2) and note curl-argv credential
   exposure in SECURITY.md (M3).
