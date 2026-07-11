
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
