# merge-upstream-0.27 plan — review rounds

round 1 (BLIND, 3 critics: arch / security / conformance): STRATEGIC. Verdicts: CONDITIONAL GO ×3, maturity 6/6/6.
Converged (≥2 of 3): perplexity URL not re-applied (F1/F2 inversion); F9 stripHtml NOT upstreamed (fork-only);
proxyBaseUrl returned as unvalidated defaultValue; brave proxyPath base-vs-full = gateway contract change;
feature-config.ts wrong mechanism (gate is index.ts isToolEnabled/tools.<key>.enabled); search-providers.test in
verify lines before its deps are resolved; helper signature must accept CredentialOptions (runCommand spy);
fetchWithCredentialRedirects NOT used by perplexity/openai/gemini upstream; parallel.ts untracked; count 11 not 10.
Unique: [sec] F2 hole exists TODAY — proxied dest + no proxy key → falls through to personal key (branch on
destination not key presence); gemini x-goog-api-key/cf-aig not stripped by undici on redirect; F3 shrinks to 5/24
providers → apply redactError at aggregation points; inherited upstream SSRF via model-controlled `proxy` param +
curl argv creds. [arch] availability checks become throwing (auto chain aborts); Phase 0.3/0.4 call-site swaps are
moot under upstream-as-base; Phase 4 = wrong PR (highest-churn region) → nonEmptyOrThrow() wrap instead.
[conf] 5 more fork behaviours w/ 12 green tests missing from inventory: brave/exa invalid-JSON guards, exa MCP
redactError ×3, parsed-host isCloudflareGateway, grounding-redirect SSRF hardening, appendSearchConstraints/
normalizeResultCount/dedupeResultsByUrl (gemini-options.test absent from F-table); braveBaseUrl/tavilyBaseUrl
semantics break (full→base) for existing users; test count 83 not ~75; fallback-empty env-scrub stale.
Action: full rewrite of plan → v2 (inventory rebuilt from git diff 58ce1566 main per file; kind:"base"|"full";
destination-branching resolver; Phase 4 dropped to follow-up).
