# BLIND Review 3 — Product Conformance & Correctness

**Scope reviewed:** `memory-search.ts` (new, 630 lines), `index.ts` tool wiring (`index_tool.diff`).
Endpoint-registry changes in `search.diff` / `provider-endpoints.ts` are unrelated to the
memory-search requirements and were not evaluated for conformance (they are a separate
web-search proxy refactor).

First-time read. I checked the delivered code against the 5 stated requirements, tracing each
trigger phrase and time-window path by hand.

---

## Executive summary

Requirements **1 (default = sessions+recall), 2 (docs opt-in), 4 (scope=all broadens all
sources), 5 (relevance×recency ranking)** are met and cleanly implemented.

Requirement **3 (git opt-in + time-window "list ALL commits + expand diffs")** is only
**partially** met: the *exact* example `поищи в гит истории за последний месяц` works, but
common natural phrasings silently fall out of window mode, "ALL commits" is capped, and git
detection over-triggers on English substrings. These are the material findings below.

---

## 1. Requirement mismatches / gaps

### G1 — [HIGH] Window-mode misses common commands: `покажи все коммиты за неделю`
`searchGit` decides window mode as
`windowMode = contentTokens.length === 0 && sinceMs !== undefined` (memory-search.ts,
`searchGit`, ≈line 430), where `contentTokens = tokens.filter(t => !GIT_STOPWORDS.has(t))`.

For the task's own probe phrase **`покажи все коммиты за неделю`** this fails on **two**
independent grounds:

1. **`покажи` is not in `GIT_STOPWORDS`** (the set only anticipates `поищи`, `найди`,
   `поиск` — memory-search.ts, `GIT_STOPWORDS`, ≈lines 380–392). So
   `contentTokens = ["покажи"]` (length ≠ 0) → window mode never fires → it runs a keyword
   search for the literal verb "покажи".
2. **`parseRecency("...за неделю")` returns `undefined`** (see G2), so `sinceMs` is unset —
   which alone also disables window mode.

Both must be fixed for this phrase. The stopword list is too narrow: natural imperatives
`покажи / выведи / дай / список / посмотри / глянь / show / list / выведи все` all leak a
content token and break the "list all commits" intent. Verdict on the task's explicit
question: **`покажи все коммиты за неделю` does NOT trigger window mode — bug confirmed.**
(By contrast `поищи в гит истории за последний месяц` **does** correctly reduce to zero
content tokens and fire window mode — that path is correct.)

### G2 — [MED] `parseRecency` does not parse bare `за неделю` (and several RU forms)
`parseRecency` (memory-search.ts, ≈lines 560–575) handles week only via `прошл\S* недел`
(→14d) and `эт\S* недел` (→7d). The very common **`за неделю`** matches neither, so returns
`undefined`. Note the asymmetry: `за месяц` **is** handled (`последн\S* месяц|за месяц`), but
`за неделю` is not — an inconsistency a user will hit immediately.
Also unhandled: `за последние две недели`, `позавчера`, `N дней назад`, `месяц назад`,
`за год`. Requirement's headline case `за последний месяц` is handled correctly
(`последн\S* месяц` → 31d).

### G3 — [MED] "list ALL commits in the window" is capped, not ALL
Requirement 3 says a time window should list **ALL** commits. Implementation caps twice:
`const top = hits.slice(0, perSourceCap)` and the orchestrator's final
`hits.slice(0, limit)` (memory-search.ts, `searchGit` end ≈line 500 and `searchMemory`
≈line 620). `perSourceCap = max(limit, 10)`, `limit` default 15. So a month with 100 commits
returns only 15. Diff-expansion within window mode *is* correct (all returned commits are
expanded, `expandCount = min(top.length, perSourceCap)`), but the "ALL" promise is not kept
for busy repos. Either raise the cap for window mode or document the limit in the tool schema.

### G4 — [LOW] Git treated as an exclusive *replacement*, not an *addition*
Requirement 3 phrases git as something to *include* when asked. `index.ts` execute
(index_tool.diff, ≈+2075) does `if (wantsGit(query)) sources = ["git"]`, dropping
sessions+memory entirely. So `поищи в переписке и в гит истории` returns git only. Defensible
UX ("full replacement intent" per the comment) but a deviation from "included when asked".

### G5 — [LOW] `scope='all'` breadth is `~/work` + `~/.pi/agent` only
Requirement 4 ("every project on this machine") is satisfied for the common case, but docs
(`WORK_ROOT`, `PI_AGENT_ROOT`) and git (`~/work` **top-level only**, non-recursive) miss
repos/projects living outside `~/work` (e.g. `~/local/...`) and nested repos. Sessions and
recall *are* fully broadened (all session folders; `is_active=1` with no project filter), so
the core of R4 holds. Worth noting as a scoping assumption.

---

## 2. Trigger-phrase detection holes

### T1 — [MED] `wantsGit` over-triggers on English substrings `diff` / `commit`
`wantsGit` (memory-search.ts, ≈lines 545–552):
`/(\bgit\b|гит|коммит|commit|диф|\bdiff|commit history|git log)/`.
- `\bdiff` has a **leading** boundary but no trailing one → matches **`different`,
  `difference`, `difficult`, `diffuse`** ("search for a *different* approach" → git-only!).
- `commit` unbounded → matches **`commitment`, `committed`, `committee`, `commits`**.
- `диф` unbounded → matches inside Russian words; `гит` unbounded → `агитация`,
  `легитимный` (rarer).

Because a git match forces `sources = ["git"]` (G4), a false positive **silently drops
chat+memory** and returns unrelated commits. This is the worst direction for a requirement
that says git is opt-in "ONLY when asked". The author bounded the Latin `git` (`\bgit\b`, per
the comment) but left `commit`/`diff` unbounded. Recommend `\bcommit`, `\bdiff\b` or a
whole-word/anchored pattern.

### T2 — [PASS] Docs trigger is tight and correct
`wantsDocs` matches `документац`, `доках`, `\bdocs?\b`, `documentation`, `markdown`, `.md`,
`md файл`. Verified: `поищи в документации` ✓ (`документац`), `search the docs` ✓ (`docs`),
`документ` (singular) does NOT false-trigger (`\bdocs?\b` needs doc/docs at a boundary).
Default correctly excludes docs. Good.

### T3 — [PASS] Default correctly excludes docs AND git
Orchestrator only runs `searchDocs`/`searchGit` when `sources.includes(...)`, and default is
`["sessions","memory"]` (memory-search.ts `searchMemory` ≈line 590; index_tool.diff execute).
`поищи в переписке`, `search our chat`, `what did we decide about X` → sessions+memory only.
Confirmed.

### T4 — [PASS] Window trigger for the headline phrase
`поищи в гит истории за последний месяц`: tokens `[поищи, гит, истории, за, последний, месяц]`
(the 1-char `в` is dropped by the `length >= 2` filter) are **all** in `GIT_STOPWORDS`;
`parseRecency` returns 31d → `contentTokens.length === 0 && sinceMs` → window mode fires,
`git log --since` lists commits newest-first, diffs expanded. Correct.

---

## 3. Doubtful assumptions

### A1 — [MED, unverifiable here] pi session folder slug scheme
`sessionFolderForCwd` (≈lines 130–135) builds the current-scope folder as
`--<cwd-with-slashes→dashes, leading/trailing dashes stripped>--`. If pi's real scheme keeps
the leading dash from the absolute path (e.g. `---Users-...--` rather than `--Users-...--`),
`existsSync` filters the dir out and **current-scope session search silently returns zero
hits** with no error. The stored session-structure note (`--<project-path-dashes>--`) is
ambiguous about the leading-slash→dash edge. This should be verified against a real
`~/.pi/agent/sessions/` listing before shipping; it's the single highest-impact silent-empty
risk for the primary use case (`поищи в переписке`, current project).

### A2 — [MED, unverifiable here] claude-recall DB schema
`searchRecall` assumes table `memories(type, project_id, scope, timestamp, value, is_active)`
and that `value` is JSON with a `.content` field (≈lines 300–340). Any column mismatch makes
the `sqlite3` call throw → caught → **returns `[]` silently** (recall disappears from every
default search). The provided Failures log shows a prior
`sqlite3 ~/.claude-recall/claude-recall.db ".tables"` attempt *failed*, so this schema is
unconfirmed. Also the JSON column key is accessed as the literal
`r["COALESCE(project_id,'')"]` — correct for `sqlite3 -json` without an alias, but fragile;
`AS project_id` would be safer. Recommend verifying `.schema memories` before trusting recall.

### A3 — [LOW] `yesterday` → 48h, `вчера` → 48h
Intentional buffer, but a user asking for "yesterday" gets a 2-day window. Harmless, just note
it's wider than literal.

### A4 — [LOW] Bare `поищи в гит истории` (no time phrase)
`sinceMs` undefined → not window mode; falls into keyword mode with `contentTokens = []`,
producing `git log --grep`(none) and `-G` with an **empty** pattern. This effectively returns
recent commits recency-ranked but only expands the top 3 (`GIT_EXPAND_TOP`), and relies on
git's tolerance of an empty `-G` regex. Works in practice but is an under-specified edge.

---

## 4. What conforms (praise)

- **R1 default** — `["sessions","memory"]` is exactly the user's "переписка + память". Clean.
- **R2 docs opt-in** — tight detection, correct default exclusion, correct plumbing to
  `searchDocs`. (T2)
- **R4 scope=all** — genuinely broadens **all four** sources: sessions (all folders), recall
  (drops `project_id` filter → all rows incl. universal), docs (`~/work` + `~/.pi/agent`), git
  (all `~/work` repos). The recall broadening the task specifically called out is correct.
- **R5 ranking** — relevance×recency is really implemented, not just claimed:
  `keywordScore(text,tokens) * recencyBoost(ts,now)` in sessions/docs, ×1.15 for curated
  memories, ×1.05 for git keyword hits; window-mode git ranks purely by recency (appropriate,
  since there are no keywords). `keywordScore` sensibly caps per-token counts (≤5) and rewards
  distinct-token coverage (`matched/tokens.length`). Final merge re-sorts globally by score.
- **Engineering quality** — ripgrep prefilter for sessions/docs (fast), regex-escaping of
  tokens before building `rg`/`git` patterns, `rg` exit-code-1 (no match) handled as
  non-error, per-source caps to bound output, recall `project_id` SQL-escaped (`''`), diff
  fenced as ```diff in `formatHits`. The window-mode expand-all-returned-diffs logic is
  correct within its cap.
- **R3 headline path** — `за последний месяц` window mode works end-to-end. (T4)

---

## 5. VERDICT

**CONDITIONAL GO — maturity 6.5/10.**

Four of five requirements are solid. Requirement 3 (git) is the weak leg and needs fixes
before it can be called done:

**Must-fix before ship (block R3 acceptance):**
- G1: broaden `GIT_STOPWORDS` with imperative verbs (`покажи/выведи/дай/список/посмотри/
  глянь/show/list`) so window mode fires on natural commands.
- G2: parse `за неделю` (and align week handling with the `за месяц` form).
- T1: bound `commit`/`diff` in `wantsGit` (`\bcommit`, `\bdiff\b`) to stop
  `different`/`commitment` from hijacking a search into git-only mode.

**Should-fix / verify:**
- G3: raise or document the window-mode commit cap so "ALL commits" is honest.
- A1, A2: empirically verify the pi session slug scheme and the claude-recall schema — both
  fail *silently to empty*, which would make the tool look broken on its two primary sources
  with zero diagnostics.

**Optional:** G4 (git as additive vs. exclusive), G5 (scope=all breadth beyond `~/work`).

None of the findings are invented; the two silent-empty risks (A1/A2) are the ones I'd chase
first since they hit the default happy path, followed by the R3 trigger holes the task
explicitly flagged.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Delivered concrete findings with file/function/approx-line references and severities: G1-G5 requirement gaps, T1-T4 trigger analysis, A1-A4 assumptions, plus conformance PASS notes and GO decision. Traced both task probe phrases: 'поищи в гит истории за последний месяц' PASS (window mode fires), 'покажи все коммиты за неделю' FAIL (двойной баг: 'покажи' not in GIT_STOPWORDS + 'за неделю' unparsed)."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Manual trace of tokenize/parseRecency/GIT_STOPWORDS for both required probe phrases",
    "Regex hand-evaluation of wantsGit (\\bdiff matches 'different'/'difficult'; 'commit' matches 'commitment') and wantsDocs (tight, correct)",
    "Confirmed default sources=['sessions','memory'] excludes docs AND git; scope='all' broadens all four sources incl. recall"
  ],
  "residualRisks": [
    "A1: pi session-folder slug scheme unverified against a real ~/.pi/agent/sessions listing — current-scope session search may silently return empty",
    "A2: claude-recall DB schema (memories table columns, value.content) unverified — recall may silently return empty on mismatch",
    "R3 git window mode: misses common phrasings and caps 'ALL commits' at limit; wantsGit over-triggers on English substrings"
  ],
  "noStagedFiles": true,
  "diffSummary": "Review only; no source modified. Findings written to research/memory-search/BLIND_review_3_conformance.md.",
  "reviewFindings": [
    "high: memory-search.ts searchGit/GIT_STOPWORDS (~L380-430) - 'покажи все коммиты за неделю' does not trigger window mode ('покажи' not a stopword + 'за неделю' unparsed)",
    "med: memory-search.ts parseRecency (~L560-575) - bare 'за неделю' returns undefined while 'за месяц' is handled (inconsistent)",
    "med: memory-search.ts searchGit (~L500) + searchMemory (~L620) - time-window 'list ALL commits' capped at perSourceCap/limit, not all",
    "med: memory-search.ts wantsGit (~L545-552) - '\\bdiff' and 'commit' unbounded match 'different'/'commitment' -> false git-only searches dropping chat+memory",
    "low: index.ts execute (~+2075) - wantsGit forces sources=['git'] exclusively rather than additive",
    "med: A1/A2 silent-empty risks - session slug scheme and recall DB schema unverified; failures degrade to [] with no error",
    "pass: R1 default sessions+memory, R2 docs opt-in, R4 scope=all broadens all sources incl recall, R5 relevance×recency implemented as claimed"
  ],
  "manualNotes": "CONDITIONAL GO, 6.5/10. R1/R2/R4/R5 solid; R3 git leg needs the 3 must-fixes (stopwords, 'за неделю', bound commit/diff) before acceptance. Chase A1/A2 first — they hit the default happy path and fail silently. Did not review provider-endpoints.ts unified-proxy changes (out of scope for these requirements)."
}
```
