# areview rounds — memory_search + provider-endpoints

round 1 (BLIND, 3 critics: integration / edge-case-security / conformance):
STRATEGIC. All CONDITIONAL GO, maturity 6.5/10. Converged findings:
- B1 [HIGH]: session event timestamp is ISO string -> Number()=NaN -> falls back to file mtime; recency/date broken for chat hits (R1+R2)
- B3-git [HIGH]: stop-word-only git query w/o time window -> empty --grep + empty -G = full-history scan of every repo (R1+R2)
- G1 [HIGH]: "покажи все коммиты за неделю" doesn't trigger window mode (покажи not stopword + "за неделю" unparsed) (R2+R3)
- no-timeout [MED]: execFileSync has no timeout, blocks event loop (R2)
- provB3 [MED]: proxy key can go to non-proxy host if per-provider URL override + proxyBase both set (R1)
- T1 [MED]: wantsGit 'commit'/'diff' unbounded -> false git-only routing dropping chat+memory (R2+R3)
- secrets [MED]: recall/git diffs emit secrets to output unredacted (R2)
- G3 [MED]: "ALL commits" capped at limit (R3); A1/A2 silent-empty risks unverified
Confirmed-good: no SQLi/RCE/ReDoS (tokenizer), default excludes docs+git, scope=all broadens all incl recall, relevance×recency real, proxy key not leaked to memory_search output.
NEXT: fix B1, B3-git, G1, timeouts (must); then provB3, T1, secrets, G3.

round 1 FIXES APPLIED (parent as sole writer, critics were read-only):
MECHANICAL/resolved. commit 264c4f6.
- B1 parseTimestamp (ISO/s/ms) ✓ live: chat dates real
- B4 git bail on no-keyword+no-window ✓
- G1/G2 GIT_STOPWORDS+imperatives, parseRecency "за неделю" ✓ live: "покажи все коммиты за неделю"→77 commits
- timeouts (20s) on all execFileSync ✓
- B3 shared key gated on resolved-url-is-proxy ✓ verified null on override host
- T1 wantsGit Unicode lookaround for гит + bounded commit/diff; docs/git additive ✓ 10/10 cases
- #1.3 redactSecrets (sk-/AIza/ghp_/password=) ✓ patterns confirmed
- G3 GIT_WINDOW_MAX=200 (not clipped to 15) ✓
- B2 sessions keep partial stdout on exit!=1; D4 SQL alias; B5 projectFromFolder; escapeRe dedup; -- rg guard
- A1/A2 verified OK empirically (slug scheme, recall schema)
DEFERRED (P2, low): D1 rg .jsonl: parsing (use --null later), D2 US/NUL in commit bodies, D3 Exa MCP-under-proxy assumption, M1 maxBuffer truncation note, M3 half-dead per-provider loadConfig, G5 scope=all beyond ~/work, FTS5 index.
STOP: round surfaced no new strategic finding after fixes; shifted to mechanics. Converged.

ROUND 2 (fresh lenses: architecture 6.5 / product 5.0 / perf 4.5 — NOT converged, new strategic layer):
reports ROUND2_review_{1,2,3}*.md.
ECHELON-1 FIXES APPLIED (commits bf2d92b..60aa247):
- arch#3+#4: destination-first key routing (personal key не уходит на прокси) + origin-compare гейт (evil-host mimic отсечён) + resetEndpointCache ✓ verified
- perf#2/product#6: git window token bomb (мой же G3-фикс р.1) — GIT_WINDOW_EXPAND=10 + formatHits 64KB byte budget + 4-backtick fence; 1400KB→67KB ✓
- product#1: dedup по normalized snippet; 15/3→13/13 distinct ✓
- product#2/#3: QUERY_STOPWORDS (RU+EN fillers, never-to-empty) + 20% relative score floor; bedrock question-form 0/5→5/5, k8s-мусор 5→2 ✓
- perf#3/arch#8: sourceStatus (ok/partial/failed/skipped) + честные ⚠-ноты в formatHits; broken PATH → FAILED surfaced ✓
- arch#1/perf#1: async execFile + Promise.all + AbortSignal; event-loop gap 8431ms→55ms, abort за ~100ms ✓
DEFERRED (эшелон 2): streaming line reader (RSS 1.2GB), FTS5 index (ENOBUFS cliff уже пересечён на broad-запросах — partial теперь хотя бы ЧЕСТНЫЙ), RU stemming/транслитерация, phrase queries, injected-prompt filtering, symlink cwd, тесты pure core, window-mode predicate 4×dup, configurable roots, mtime-prune для sinceMs, month-name recency.
STOP-RULE: раунд 3 не запускался — эшелон-1 фиксы верифицированы эмпирически (unit+live), остальное = roadmap, не дефекты ревью.
