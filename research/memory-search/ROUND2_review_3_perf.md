# memory-search.ts — Performance & Failure-Mode Review (blind, first read)

Reviewer lens: operations — latency, degradation, memory, blocking, scaling cliffs, concurrency.
All numbers below are **measured on this machine** (24 GB RAM, macOS, node v22.23.0, rg 14.x, warm-ish page cache unless noted).

Corpus at review time:
- `~/.pi/agent/sessions` = **8.0 GB**, **2,604** `*.jsonl` files (NOT ~700 — the scan recurses into subagent trees `<ts>_<uuid>/<runid>/run-N/session.jsonl`), 27 project dirs. Largest single project dir: google_ads 2.6 GB, soup 2.1 GB, llm_proxy 1.8 GB (319 files).
- `~/.claude-recall/claude-recall.db` = 1,261 active-ish rows, full TSV/JSON dump ≈ 0.96 MB.
- `~/work` = **16 git repos** (of 29 entries).

---

## Measured latency (p50 of 3 runs where repeated)

| call | ms | notes |
|---|---|---|
| sessions+memory, scope=current (llm_proxy, 1.8 GB) | **1,700–3,600** | dominated by JS post-processing, not rg |
| sessions+memory, scope=all (8 GB) | **3,300–5,500** | 'прокси' 4.8 s, 'deploy' 5.5 s, 'model' 3.3 s |
| sessions+memory, scope=current, tiny project (pi-web-access) | **56–72** | great when the project is small |
| docs, scope=current | 244 | fine |
| docs, scope=all (~/work + ~/.pi/agent) | 3,467 | acceptable |
| memory (sqlite3 alone) | **64 ms** | never a problem at 1.3k rows |
| git, scope=current (llm_proxy) | 2,187 | ok |
| **git, scope=all (16 repos)** | **23,555** | ~1.5 s/repo avg; clipshot 4.3 s, cmux 5.7 s, soup 2.9 s, llm_proxy 2.6 s for the `-G` pickaxe pass alone |
| git window-mode ("все диффы за месяц"), scope=all | 6,403 | but see finding 2 — output is the real problem |
| raw rg full 8 GB scan, no match | 4,424 cold / 3,107 warm | rg itself is fast |

Where time goes for sessions: rg alone on llm_proxy dir for `model` = **457 ms**; the full `searchSessions` for the same query = **2,576 ms** → **~80% of wall time is Node-side**: materializing a giant stdout string, `split("\n")`, per-line `JSON.parse`, scoring. rg is not the bottleneck; the single-string funnel is.

---

## Findings

### 1. [HIGH] execFileSync blocks the pi event loop for the entire search; AbortSignal is ignored
Measured with a 10 ms interval probe: a scope=current search froze the event loop for **8,431 ms in one contiguous gap** (cold cache; warm runs still 1.7–3.6 s). During that time the pi TUI cannot render, stream, process keys, or run any other tool. `execute()` is `async` in name only — every child process (`rg` ×2, `sqlite3`, `git` × up to 16 repos × 2 passes + 3 diff expansions) runs via `execFileSync` sequentially on the main thread. The `_signal` parameter is received and **never used**: the user cannot cancel a stuck search; Esc/abort will only take effect after the sync chain finishes. Worst-case chain (each exec has its own 20 s budget): sessions 20 s + sqlite 20 s + docs 20 s + git 16 repos × 2 passes × 20 s + expansions — theoretical multi-minute freeze; the *measured* real case (git scope=all) already freezes **23.5 s**, beyond any reasonable agent-turn budget. Fix direction: `spawn` + `Promise.all` per source (also gives free inter-source parallelism, would roughly halve default-path latency), wire `_signal` to `child.kill()`.

### 2. [HIGH] git window-mode floods the model context: 200 commits × expanded diffs = **1.4 MB ≈ 358k tokens** in one tool result
Measured: `formatHits` on a scope=all month window returned **1,399 KB** of formatted text (200 hits, `expandCount = top.length` → *every* hit gets up to 200 diff lines). Even scope=current on an active repo will produce hundreds of KB. This blows the context window of any model in a single turn (compare: total context is ~0.4–1 M tokens; the tool alone injects 358k), triggers compaction/overflow, and costs real money on paid tokens. GIT_WINDOW_MAX=200 × GIT_DIFF_MAX_LINES=200 is an unbounded-in-practice product. There is no total-output-size cap anywhere in `formatHits`. Needs a hard byte budget on the formatted result (e.g. 32–64 KB) with "N more commits omitted".

### 3. [HIGH] Silent partial results — timeout, ENOBUFS, and missing binaries all degrade to a confident-looking answer
Verified empirically:
- **Timeout** (ETIMEDOUT, SIGTERM): `e.status` is `null`/undefined ≠ 1 → the catch keeps partial stdout and continues. The user sees `Found 15 match(es)` with **no indication** that 90% of the corpus was never scanned. Recall (`searchRecall`) returns `[]` on *any* error including timeout — silently.
- **ENOBUFS**: a plain query `model` over sessions produces **2.1 GB** of rg output; even a normal 3-token query (`fable|signature|400`) over the *single* llm_proxy dir produces **946 MB** — both exceed the 256 MB maxBuffer. Node kills rg (SIGTERM) and hands back a 257 MB truncated prefix. Matches are then whatever files rg happened to walk first — a **systematic bias toward early-walked directories**, presented as a complete ranked answer. This is not an exotic case: I hit ENOBUFS on the first realistic multi-token query I tried.
- **Missing rg/sqlite3** (ENOENT): `e.status` undefined, `e.stdout` undefined → `return []` → user sees `No matches in your history for "..."`. A broken PATH masquerades as "you never discussed this". ENOENT must be surfaced as an error, and killed/truncated scans must set a `partial: true` marker that `formatHits` renders ("results may be incomplete — scan truncated").

### 4. [MED] Memory: measured **1.2 GB RSS** per search on common queries
`fable signature 400`, scope=current: RSS **1,204–1,214 MB**, heap 533–545 MB, on three consecutive runs (256 MB stdout string + `split("\n")` array of substrings + per-line parse). scope=all `deploy`: 1,177 MB. On this 24 GB machine it survives; on a 8–16 GB laptop with pi + browser + LSPs this is swap territory, and two tool calls in one turn (finding 6) means the allocation happens twice back-to-back. A streaming line reader over spawned rg stdout would cap this at ~MBs. Also note the 256 MB buffer is *by construction* the working set — lowering maxBuffer alone just moves the ENOBUFS cliff closer.

### 5. [MED] git scope=all is already past the turn budget and scales linearly with repo count
Measured 23.5 s for 16 repos today (pickaxe `-G` is the cost: 2.5–5.7 s on the bigger repos). Each `gitOut` has an *individual* 20 s timeout, so the aggregate is unbounded — 30 repos ≈ 45–60 s of frozen UI. There is no per-source overall deadline. Either parallelize with a global budget (e.g. 10 s, return what finished) or cap repo count with a by-recent-mtime priority.

### 6. [LOW] Concurrency/reentrancy: safe but additive
No shared mutable state across calls (mtimeCache is per-call; module state is constants), so two `memory_search` calls in one turn are *correct* — but since everything is sync, they serialize and the UI freeze doubles (~2×p50). No locking issues observed on the recall DB (WAL mode, read-only CLI query, 64 ms). sqlite3 is invoked without `?mode=ro` — a hung writer holding an exclusive lock would make the read wait up to the 20 s timeout, then silently return `[]` (finding 3).

### 7. [MED] Scaling cliffs — the design fails quietly, in stages, well before the timeout cliff
- **ENOBUFS cliff: already crossed** at 8 GB for common tokens (946 MB matched output from ONE project dir). Grows with corpus; over time an increasing share of queries returns silently truncated, early-walk-biased results.
- **Timeout cliff**: full-scan rg is 3.1–4.4 s at 8 GB → linear → ~**35–40 GB** puts the raw scan at the 20 s kill line even before JS parse. At current growth (multi-GB/mo per memory of session sprawl) this is roughly 6–12 months away.
- **JS-parse cliff** arrives sooner: parse time scales with *matched bytes*, not corpus size; broad queries already spend 2–5 s in JS.
- The header comment says "no index yet — that comes later" — there is no FTS5 or incremental path in the code. Migration cost is real but bounded: sessions are append-only JSONL, so an incremental indexer (mtime/size watermark per file → extract message events → FTS5 with BM25) directly replaces `searchSessions` and fixes findings 1/3/4/5-adjacent latency at once. The current rg design also **rescans identical bytes on every call** (no per-file mtime skip, no result cache), and the `sinceMs` filter is applied *after* the full scan — a "yesterday" query still scans all 8 GB even though file mtimes could prune ~95% of files before rg runs.
- Subagent-tree noise: 2,604 files scanned vs ~hundreds of top-level user sessions; subagent runs duplicate user content (inherited history), inflating both scan cost and duplicate hits.

### 8. [MED] provider-endpoints: config cached forever, no invalidation hook
`cachedConfig` in provider-endpoints.ts is module-level and there is **no reset function** (unlike `github-extract.ts:633` and `parallel.ts:75`, which do null it). In a long-lived pi session: rotating `proxyApiKey` or changing `proxyBaseUrl` in `web-search.json` never propagates — searches keep using the revoked key until restart, surfacing as sudden 401s with no obvious cause. Env vars *are* read live per call, so `WEB_SEARCH_PROXY_KEY` rotation works — an inconsistency that makes debugging worse ("env override works, config edit doesn't"). Also note the config is *separately* cached in 8+ other modules (brave/exa/gemini/openai-search/parallel/perplexity/tavily/gemini-web-config), so a stale-config incident manifests inconsistently per provider. Operationally: export a `resetEndpointCache()` and call it from wherever the extension reloads config, or cache with the file's mtime as the key.

### 9. [LOW] Misc operational edges
- **rg `--max-columns 1000000`**: lines beyond 1 MB come back as `[Omitted long matching line]` (found 3 such matches live) — they fail the `.jsonl:` JSON.parse and are silently dropped. Fine as a guard, but it's another invisible loss channel; no 1 MB+ lines exist in the corpus today.
- **Non-UTF8**: `encoding:"utf-8"` replaces invalid sequences → JSON.parse fails → line skipped silently. Acceptable.
- **rg output parsing by `.jsonl:`**: a file path containing `.jsonl:` inside a directory name would mis-split; not present today (paths are pi-generated), low risk.
- **Slow/NFS disk**: the 20 s timeouts convert IO stalls into silent empty/partial results (finding 3 again); disk-full is read-only-safe.
- **Recall SQL**: string-interpolated `project_id` with `''` escaping — injectable-shaped but cwd-derived; fine, though a parameterless `-json` + WHERE on the JS side would cost nothing at 1.3k rows.
- **Zombie processes**: none observed; execFileSync SIGTERM on timeout is reaped correctly.

---

## What works well

- **Source choice per default path is sane**: default `sessions+memory` scope=current is the common case and lands at 1.7–3.6 s on the *largest* project and <100 ms on small ones; recall via sqlite3 is effectively free (64 ms).
- **rg as the scan engine is the right call** — 8 GB in 3–4.4 s, and the `--glob '*.jsonl'` + fixed-string alternation keeps it tight; the "JSON.parse only matched lines" strategy is the correct shape, it just needs a streaming funnel instead of one giant string.
- **Partial-stdout retention on rg exit≠1** (keeping matches from permission-error runs) is genuinely better than discarding — it just needs to be *labelled*.
- **Timeouts exist at all** (20 s on every exec) — a hung git/sqlite cannot freeze pi forever, only per-command.
- **Secret redaction before snippets reach the model** covers the realistic key formats and runs on the final snippet path including expanded git diffs.
- **Per-call mtime stat cache**, per-source caps, and the token stop-word gate for git (avoiding a full `--all` pickaxe on an empty pattern) all show failure-mode awareness.
- **provider-endpoints key-gating** (shared proxy key only sent when the resolved URL is actually the proxy base) is a correct leak guard; env-over-config precedence is consistent.

---

## VERDICT: CONDITIONAL GO — maturity 4.5/10

Acceptable **today** for its default path (scope=current, sessions+memory) on this machine, but it ships with three operational landmines measured live: (1) whole-UI freezes of 8–24 s with no cancel path, (2) a context-flooding git window mode (358k tokens in one result), and (3) systematically silent partial/truncated/empty results that are indistinguishable from honest answers — ENOBUFS is already triggered by ordinary queries at current corpus size. Conditions for GO: cap `formatHits` total bytes; surface partial/truncated/ENOENT states in the result text; move rg/git to async spawn with a global deadline and wire the AbortSignal. FTS5 indexing is the right medium-term fix and the migration path is straightforward (append-only JSONL + mtime watermark).
