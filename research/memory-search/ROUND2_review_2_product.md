# memory_search — Product Quality Review (search relevance & real-world usefulness)

Blind first-time evaluation. Subject: `memory-search.ts` + registration in `index.ts` (pi-web-access).
Method: read source (read-only), then ran ~25 real queries via `node --experimental-strip-types` against exported `searchMemory()` with `cwd=/Users/shamash/work/llm_proxy` (rich RU/EN history: pi sessions, claude-recall DB, git). All evidence below is from actual runs.

---

## Numbered findings

### 1. [HIGH] No deduplication — the same content eats 5+ of 15 result slots

pi copies conversation history into every forked/resumed session file and subagent `run-N/session.jsonl`, so one assistant message exists verbatim in many files. `searchMemory` treats each copy as an independent hit.

**Evidence** — query `"Rust litellm миграция"`, limit 15:
```
hits=15, distinct snippets=3
  ×5: Разобрался. Уточню, что «Rust API» у litellm — это несколько разных вещей…
  ×5: Коротко: **litellm переписывает ядро на Rust не ради «нового API»…
  ×5: …litellm в основном Python. Но я заметил в его репо `.cargo/config.toml`…
```
15 slots → **3 distinct pieces of information**. Same pattern reproduced on `"бэкап падал"` (3/3 identical), `"usque NAT64"` (4/6 identical), `"что мы решили про bedrock"` (5/6 identical). For an LLM consumer this is the single worst product defect: the context budget is spent on repeats, and genuinely different hits ranked 16–30 are silently cut. A snippet-hash (or file-agnostic content-hash) dedup before the final sort would triple effective recall at zero ranking risk.

*Where: `searchMemory()` orchestrator (memory-search.ts, final `hits.sort(...).slice(...)` — no dedup step exists anywhere).*

### 2. [HIGH] Question-form queries — the tool's own advertised use case — return garbage

The tool description in `index.ts:2045` explicitly says: *"Use when the user refers to earlier work — … 'what did we decide about X'"*. That exact form fails: filler words (`что, мы, про, what, did, we, about`) are scored as real tokens, and `keywordScore`'s matched-fraction multiplier **penalizes** documents that contain only the meaningful keyword while **rewarding** filler-dense boilerplate.

**Evidence** — `"what did we decide about bedrock"` (limit 5): all 5 hits are the *same injected subagent-charter boilerplate* ("The user is paying attention to *speed of feedback*…") from 2026-06-22 — score 12.7–17.9, **zero mention of bedrock**. Meanwhile plain `"bedrock"` instantly returns the 4 curated Bedrock memories (score 5.04). The RU twin `"что мы решили про bedrock"` was equally polluted (litellm-Rust chatter, one hit mentioning bedrock incidentally).

Root cause chain: (a) no general stopword list — `GIT_STOPWORDS` exists but is applied **only** to the git source; (b) occurrence-capped counting (`count < 5`) lets a doc with 5×"what" + 5×"did" + 5×"we" + 5×"about" score 20 against `bedrock`-only docs scoring ~1–2. The fix is cheap: apply a (larger) stopword list to all sources, or weight tokens by inverse frequency.

*Where: `keywordScore()` + `tokenize()` (no stopword filtering); `GIT_STOPWORDS` scoped to `searchGit` only.*

### 3. [HIGH] No score floor / no honesty on "nothing relevant found"

A query with zero real matches still returns confident-looking results if any filler token substring-matches anything.

**Evidence** — `"kubernetes helm chart отвалился"` (nothing about k8s in this history): returned 5 hits, all score **0.90**, all irrelevant boilerplate (matched only the substring "chart"→"charter" inside injected prompt text). An LLM agent receiving `Found 5 match(es)` will hallucinate that this history exists. There is no minimum-score threshold, no relative cutoff (e.g. drop hits < 20% of top score), and `formatHits` gives no "these are weak matches" signal.

*Where: `searchMemory()` — no floor; `formatHits()` — no confidence indication.*

### 4. [MED] Russian morphology: exact-substring matching misses inflected forms; masked by corpus richness but measurably loses the right answer

`keywordScore` uses `indexOf` (substring), so a query token matches only if it is a literal prefix/substring of corpus text. Russian case endings break this in the realistic direction (user types inflected form, corpus has another form).

**Evidence** — target: the canonical "global discount" memory (`proxy_discounts` / "ГЛОБАЛЬНАЯ СКИДКА"):
```
скидка            → discount-memory: YES @ rank 2
скидки  (gen/pl)  → discount-memory: NO (15 other hits)
скидку  (acc)     → discount-memory: NO
глобальная скидка → YES @ rank 2
глобальную скидку → NO
```
And transliteration: `grounding` → 15 hits (all relevant); `граундинг` → **1 hit** (and it's this review's own task prompt!); `граундинга` (genitive) → **0 hits**, even though `rg` confirms "граундинга" exists in the corpus (`4ec90731/run-1/session.jsonl:8`). A RU-speaking user asking "что там было про граундинг" gets essentially nothing about a feature that dominates recent history under its EN name.

Mitigating observation: because matching is substring (not whole-token), typing a **stem** works great — `скидк` → correct memory at top, `ротаци ключ` → correct memory at top. But users don't know to type stems, and nothing in the tool description tells the agent to stem RU queries. Cheapest real fix: light RU suffix-stripping of query tokens (≥5-char tokens → chop 1–2 char endings), or at least a `promptSnippet` instruction to the agent: "for Russian, use word stems". Cross-script (граундинг↔grounding) needs a small transliteration map or is honestly out of scope — but say so.

*Where: `tokenize()` / `keywordScore()` — no stemming; `index.ts` description — no stem guidance.*

### 5. [MED] Chat "user" label lies: injected system/charter text dominates user-role hits

Every hit from finding #2 was labeled `user`, but the text is pi-injected orchestration boilerplate ("Task: You are a delegated subagent…", RULE sections, design-system charters), not anything the human typed. In this corpus the *majority* of high-scoring `user` hits are injected prompts (they're long, keyword-dense, duplicated across sessions).

**Evidence** — `"sk-proxy"` results include `[user] Task: You are a delegated subagent running from a fork…`; `"what did we decide…"` returned 5×`user` hits of pure charter text. For the product promise "search our chat / что мы обсуждали" this is noise the user never said. Filtering (or down-weighting) user-role messages that start with known injected markers ("Task: You are a delegated", "## RULE", project_instructions blocks) — or preferring short user messages — would markedly clean RU/EN "what did I ask" queries.

*Where: `extractMessageText()` — accepts any `role`, no heuristic for injected content.*

### 6. [MED] Git window-mode is a token bomb

Window mode ("все коммиты за неделю") expands the **full diff for every commit in the window** (`expandCount = top.length`, up to `GIT_WINDOW_MAX = 200` commits × `GIT_DIFF_MAX_LINES = 200` lines each = up to 40 000 lines in a single tool result).

**Evidence** — `"все коммиты за неделю"` on llm_proxy: **127 hits**, each with expanded `git show --stat --patch` up to 200 lines. That is far beyond what any agent context can absorb; the agent will truncate or drown. A humane product default: expand diffs for top N (≤10), list the rest as one-line subjects, and say "ask for a specific commit to expand".

*Where: `searchGit()` — `const expandCount = windowMode ? top.length : GIT_EXPAND_TOP`.*

### 7. [MED] Snippet shows only the FIRST matched token's neighborhood — multi-token queries lose the interesting term

`makeSnippetRaw` centers on the earliest match position; the second query term is often absent from the snippet entirely.

**Evidence** — `"cloudflare porkbun"` (the porkbun fact — registrar — is what makes this doc interesting): all 3 top hits' snippets contain "cloudflare" but **none contain "porkbun"**. The user must open the source to learn why the hit matched. Better: center on the densest window covering the most distinct tokens, or emit 2 short fragments.

*Where: `makeSnippetRaw()` — takes first `indexOf` across tokens.*

### 8. [MED] Phrase search is silently unsupported

Quotes are stripped by the tokenizer; `"Pool exhausted"` becomes OR(`pool`, `exhausted`).

**Evidence** — query `"\"Pool exhausted\""`: top 3 hits are about *pooled key rotation* (recent, high frequency of "pool"), not the DB-pool-exhaustion incident; the actually-wanted "Pool exhausted, falling back" memory shows up only at rank 4 with a lower score than fresher pool-rotation chatter. The tool schema even advertises `query: "keywords or a phrase"` — a user quoting an exact error string gets no exact-match behavior and no warning.

*Where: `tokenize()` (quotes discarded); no phrase pathway anywhere.*

### 9. [LOW] parseRecency coverage gaps → date+keyword combos silently do full-history search

**Evidence**:
```
parseRecency('баги за июнь')      → undefined   (month names unsupported)
parseRecency('3 дня назад')       → undefined   (numeric offsets unsupported)
parseRecency('last 3 days')       → undefined
```
`"баги за июнь"` still *worked by luck* (the token "июнь/июньские" appeared literally in a June session text — substring "июнь" ⊂ "июньские"), but that's keyword coincidence, not date filtering. Supported phrases (за неделю / last week / вчера / сегодня / за месяц) do work — the window is just narrower than a user would guess. Also 'last week'→14d and 'прошлый месяц'→60d are approximations that will occasionally surprise ("last week" returning 2-week-old items).

*Where: `parseRecency()`.*

### 10. [LOW] `wantsDocs` misses common RU phrasing

**Evidence**: `wantsDocs("покажи доки") → false` (regex has `доках`/`в доках` but not the bare plural `доки`/`доков`). A user saying "поищи в доках" works; "проверь доки" doesn't add the docs source.

*Where: `wantsDocs()` regex.*

### 11. [LOW] Session `location` is not actionable for an agent

Hits point at e.g. `--Users-shamash-work-llm_proxy--/2026-07-08T06-41-35-742Z_019f4075….jsonl` with no line number, message index, or timestamp-within-file. A follow-up "show me the full message" forces the agent to re-grep a possibly-100MB JSONL. Docs hits give a usable path; git hits give `repo@hash` (good). Sessions are the weakest source on follow-through.

### 12. [LOW] Empty/weak result gives no guidance

`formatHits` on zero hits: `No matches in your history for "X".` — no suggestion to try scope='all', drop filler words, use stems, or add sources. Combined with #3 (junk instead of empty), the agent gets either false confidence or a dead end.

---

## What works well

- **Exact-keyword EN/RU recall is genuinely good.** `"grounding gemini"`, `"bedrock"`, `"invalid signature thinking block"`, `"brave search прокси"`, `"retry.py"`, `"sk-proxy"`, `"http 502"` all returned the right memories/sessions at the top. Tokenizer keeps digits and `_`, so `502`, `retry.py` (→`retry`+`py`), `sk-proxy` (→`sk`+`proxy` substring) behave acceptably in practice.
- **Ranking relevance×recency is reasonably balanced when tokens are meaningful.** In `"invalid signature thinking block"` the *older* (06-28/07-03) highly-relevant memories correctly beat newer weak mentions — the gentle decay curve (30d→0.6, 90d→0.4) does not crush old exact hits. The observed ranking failures come from filler tokens (#2), not from the recency curve.
- **The 1.15× recall-memory boost pays off**: curated memories consistently surface at rank 1–2 above raw chat, which matches user intent ("что мы решили" is usually in a memory).
- **Git keyword search + top-3 diff expansion is a strong feature**: `"поищи в гит истории grounding"` → the exact grounding commit first, with useful commit·diff hits behind it; window mode correctly triggers on stopword-only queries (`все коммиты за неделю` → 127 commits, newest first).
- **Secret redaction** works and targets exactly the right patterns for this corpus (sk-, AIza, key=value).
- **Latency is fine**: 0.5–3.5s current-scope, ~6.5s scope=all — acceptable for a tool call.
- **Timestamps in output are real event times** (ISO parse with mtime fallback), and the `[chat 2026-07-11] assistant · llm_proxy` header line gives the LLM source/date/role/project at a glance — the format itself is consumable; it's the *content* (dupes) that wastes it.

---

## Product gaps not yet accounted for (roadmap material)

1. **Dedup by content hash** (#1) — highest ROI, trivial.
2. **Global stopword list + score floor** (#2, #3) — second highest ROI.
3. **RU light stemming / query-token suffix stripping**; optionally RU↔EN transliteration for tech terms (граундинг↔grounding, деплой↔deploy).
4. **Phrase queries** (respect quoted strings as exact substrings — rg already supports fixed-string search, plumbing is easy).
5. **Injected-prompt filtering** for the `user` role (#5).
6. **Diff-expansion budget** in git window mode (#6).
7. **Pagination / "N more hits beyond limit"** indicator; currently truncation is silent.
8. **Empty-result guidance** (suggest scope='all', stems, other sources).
9. **Month-name and numeric recency parsing** ('за июнь', '3 дня назад').
10. Negation is unsupported ("не связанные с X" boosts X) — probably acceptable to leave out, but the description should not imply natural-language understanding.

---

## Verdict

The core loop — exact keywords in, curated memories + chat + commits out, ranked sanely — already delivers real value, and several deliberate touches (recall boost, gentle recency, git diff expansion, redaction) show good product sense. But three defects hit *every* realistic session: duplicates consume most of the result budget, natural-language question forms (advertised in the tool's own description) return boilerplate garbage, and weak matches masquerade as confident results. All three have cheap fixes and none require the FTS5/BM25 rewrite the header defers to.

VERDICT: CONDITIONAL GO — maturity 5/10

---

*Test artifacts: /tmp/memsearch-test/ (run.mjs, morph.mjs, dedup.mjs, rank.mjs, label.mjs, gitwin.mjs, june.mjs, snip.mjs, substr.mjs, floor.mjs). Read-only w.r.t. source; no files under research/ were read.*
