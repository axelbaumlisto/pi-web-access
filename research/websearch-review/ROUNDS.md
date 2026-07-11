
── CLIENT FIXES (ado, форк pi-web-access, 2026-07-12) ──
Base 76f2679..16ec2aa. worker+reviewer = o/gpt-5.6-sol (дефолт давал refusal).
- Task 1 (B5b HIGH) gemini destination-aware key: ambient GEMINI_API_KEY не уходит
  на override/proxy-хост (?key=); прямой Google/CF-gateway целы. r1 APPROVE. b34b15a
- Task 2 (B5a HIGH) openai destination-first: personal model-registry ключ только для
  api.openai.com/chatgpt.com origin (Set of URL().origin); proxy → providerApiKey.
  codex-flow цел. r1 APPROVE. 749ef3d
- Task 3 (int#6+product#1+int#11) perplexity: availability через providerApiKey (auto
  видит proxy-ключ); ВСЕ цитаты (не обрезаются до numResults); свой 30s timeout.
  r1 APPROVE. 9bb46b3. LIVE: 9 источников (было бы 5).
- Task 4 (product#2 HIGH) gemini: grounded-промпт reuse appendSearchConstraints
  (recency/domain), chunks dedup-by-URL + cap ТОЛЬКО при явном numResults
  (normalizeResultCount finite/int/≤20; invalid/absent → все unique). r1 REJECT-FIX
  (дефолтный кап 5 регрессировал no-options — вернул все чанки в r2), r2 APPROVE. 16ec2aa
Full gate 85/85. Форк запушен, установлен в активный git-плагин. LIVE exa+pplx зелёные.
ОТЛОЖЕНО (не блокеры): product#3 (raw concat под "AI-synthesized" вывеской + HTML
sanitize brave), product#4/#5 (auto-fallback только на исключения, не на пустые/мусорные
200 + confidence gate), int#7 (upstream error JSON редакция), int#8 (gemini grounding
redirect SSRF substring→exact host), CF-gateway substring→hostname (r1-Task1 residual),
per-key configurable search-RPM (backend).

── CLIENT FIXES 2 (ado plan CLIENT_PLAN2, отложенные находки, 2026-07-12) ──
Base aa26d6f..6f15e73. worker+reviewer = o/gpt-5.6-sol.
- Task 1 (int#8 SSRF + CF-gateway): gemini grounding redirect — parse URL, require
  https+exact host vertexaisearch.cloud.google.com + path ===/grounding-api-redirect
  (или /child) до HEAD; resolved location через ssrf-protection.validateRemoteUrl;
  isCloudflareGateway по hostname. r1 REJECT-FIX (path startsWith пропускал
  -evil суффикс) → r2 APPROVE. 513df9a
- Task 2 (int#7 redaction): redact.ts redactError (truncate+redact sk-/AIza/Bearer/
  ?key=/JSON-quoted password/api_key + trailing partial). Применён к non-2xx телам,
  exa JSON-RPC error.message + result.content[].text(isError HTTP200), invalid-JSON
  SyntaxError всех 3 провайдеров. r1 REJECT-FIX (3 HIGH обхода: JSON-quoted, exa
  JSON-RPC, invalid-JSON leak + monkey= + truncation-through-secret) → r2 APPROVE. feae346
- Task 3 (product#3): brave stripHtml (strip тегов ПЕРЕД decode → <x> выживает;
  named+decimal+hex entity). r1 APPROVE (прямое ревью оркестратора — subagent budget
  40/40 исчерпан; diff мал, strip-then-decode проверен тестом). 6f15e73
Gate 104/104. Запушено + установлено.
НЕ СДЕЛАНО (budget исчерпан): Task 4 product#4/#5 (auto-fallback на пустой 200 +
confidence gate) — требует новой сессии для ado worker→reviewer.
