# pi-web-access: отложенные находки areview (int#7/#8, CF-gateway, product#3/#4/#5)

Источник: /Users/shamash/work/llm_proxy/research/websearch-review/BLIND_{1,2}_*.md.
Verify = `npm test` (node --test). Baseline после первого клиентского прогона = 85 тестов.

### Task 1: Gemini grounding redirect SSRF + CF-gateway hostname (int#8 + residual)
**Files:** gemini-search.ts, gemini-api.ts, test/gemini-ssrf.test.mjs
**Steps:**
1. int#8 [MED SSRF]: `resolveGroundingChunks` (gemini-search.ts ~413) считает URL
   grounding-редиректом если строка ПРОСТО СОДЕРЖИТ
   `vertexaisearch.cloud.google.com/grounding-api-redirect` (substring), затем
   `resolveRedirect` (~423) делает client-side HEAD без SSRF-валидации. URL вида
   `http://127.0.0.1/x?vertexaisearch.cloud.google.com/grounding-api-redirect`
   проходит. Исправить: парсить URL (`new URL`), требовать `https:` И точный host
   `vertexaisearch.cloud.google.com` И path начинается с `/grounding-api-redirect`
   ПЕРЕД HEAD. Резолвнутый `location` тоже провалидировать: только `https:` и не
   приватный/loopback хост (переиспользовать существующий SSRF-guard плагина если
   есть — grep ssrf/isPrivate/blockPrivate; иначе минимальная проверка: не
   localhost/127./10./192.168./169.254./::1/[::]/0.0.0.0/*.internal). Невалидный →
   пропустить чанк (не HEAD, не включать).
2. CF-gateway hostname (residual из прошлого прогона): `isCloudflareGateway`
   (gemini-api.ts ~52) использует `getApiHost().includes("gateway.ai.cloudflare.com")`
   — substring. Заменить на разбор host через `new URL(...).hostname` и проверку
   `=== "gateway.ai.cloudflare.com"` или суффикс с dot-boundary
   (`.endsWith(".gateway.ai.cloudflare.com")`). Не сломать buildKeyParam/
   buildAuthHeaders/isGatewayConfigured.
3. Тесты (mock fetch, без сети): (a) редирект-URL с host vertexaisearch... + https →
   HEAD вызывается, location резолвится; (b) `http://127.0.0.1/?vertexaisearch.cloud.google.com/grounding-api-redirect`
   → HEAD НЕ вызывается, чанк пропущен; (c) резолвнутый location на loopback →
   отклонён; (d) isCloudflareGateway: `gateway.ai.cloudflare.com.evil.com` → false,
   настоящий CF-хост → true.
**Acceptance:**
- Только точный https host vertexaisearch.cloud.google.com/grounding-api-redirect
  проходит на HEAD; loopback/private резолв отклоняется.
- CF-gateway распознаётся по hostname, не substring (evil-суффикс отклонён).
- Существующие gemini-тесты зелёные.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test

### Task 2: Редакция + ограничение upstream error-тел (int#7)
**Files:** redact.ts (создать), perplexity.ts, exa.ts, brave.ts, test/error-redaction.test.mjs
**Steps:**
1. int#7 [MED]: клиенты кидают upstream error-тела в user-facing ошибки без редакции;
   `perplexity.ts:137` вообще без ограничения длины (`errorText` целиком). Тела
   контролируются upstream и могут нести ключи/внутренние хосты/echo запроса.
2. Создать `redact.ts` с `redactError(text: string, max = 300): string`:
   (a) обрезать до `max`; (b) заменить секреты теми же паттернами, что в
   memory-search redactSecrets — `sk-[A-Za-z0-9_-]{16,}`, `AIza[0-9A-Za-z_-]{20,}`,
   `Bearer\s+\S+`, `X-Subscription-Token`-значения, `key=[^&\s]+` в URL,
   `(password|token|secret|api[_-]?key)\s*[:=]\s*\S+` (case-insensitive) → `[REDACTED]`.
   (DRY: если redactSecrets в memory-search.ts экспортируем — переиспользовать/вынести
   общий, но НЕ трогать memory-search в этом шаге; проще — автономный redact.ts.)
3. Применить в местах, где error-тело провайдера попадает в сообщение:
   perplexity.ts:137 (обрезать+редактировать), exa.ts:199 (уже slice 300 — добавить
   редакцию), brave.ts (error-путь если есть). Не менять смысл ошибок, только
   санитизировать.
4. Тесты: `redactError` вырезает sk-/AIza/Bearer/key=/password= и обрезает длину;
   perplexity error c внедрённым фейковым ключом → `[REDACTED]` в сообщении, не сырой.
**Depends:** Task 1
**Acceptance:**
- Все upstream error-тела ограничены по длине и прогнаны через redactError.
- perplexity error больше не безлимитный и не содержит сырых секретов.
- Существующие тесты зелёные.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test

### Task 3: Санитизация HTML в brave-сниппетах (product#3)
**Files:** brave.ts, test/brave-sanitize.test.mjs
**Steps:**
1. product#3: brave отдаёт `description` как snippet (brave.ts ~192) с сырым HTML
   (`<strong>`, entity `&#x27;` и т.п.). Добавить `stripHtml(s)`: убрать теги
   `<[^>]+>` и декодировать частые entity (`&amp; &lt; &gt; &quot; &#x27; &#39;
   &nbsp;` + числовые `&#\d+;`/`&#x[0-9a-f]+;`). Применить к `description` при
   построении snippet и к title если нужно.
2. Тесты: сниппет с `<strong>foo</strong> &#x27;bar&#x27; &amp; baz` →
   `foo 'bar' & baz` (без тегов/entity).
**Depends:** Task 2
**Acceptance:**
- brave-сниппеты без HTML-тегов и с декодированными entity.
- Существующие brave-тесты зелёные.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test

### Task 4: Auto-fallback на пустой результат (product#4/#5)
**Files:** gemini-search.ts, test/fallback-empty.test.mjs
**Steps:**
1. product#4/#5: в `search()` auto-цепочке (gemini-search.ts ~176-249) fallback
   переходит к следующему провайдеру ТОЛЬКО при брошенном исключении/null, но НЕ при
   успешном 200 с ПУСТЫМ результатом (провайдер вернул `{answer:"", results:[]}`).
   Из-за этого auto останавливается на провайдере, который вернул пустоту.
2. Исправить ТОЛЬКО auto-цепочку (не explicit-режим — explicit намеренно strict):
   считать результат провайдера в auto «неуспешным» и продолжать fallback, если
   `results.length === 0 && !answer` (пусто и по источникам, и по ответу). Последний
   провайдер в цепочке возвращается как есть (даже пустой) — не терять полностью.
   Аккумулировать в fallbackErrors пометку «provider: empty».
3. Тесты (mock провайдеров): (a) первый auto-провайдер возвращает пусто, второй —
   результаты → search возвращает результаты второго (не пустоту первого);
   (b) все пусто → возвращается последний (пустой) без throw; (c) explicit-режим
   пустой результат НЕ триггерит fallback (strict — возвращает/кидает как раньше).
**Depends:** Task 3
**Acceptance:**
- Auto-режим продолжает fallback при пустом 200, не залипает на пустом провайдере.
- Explicit-режим не изменил поведение.
- Последний провайдер возвращается даже пустым (нет полной потери).
- Существующие тесты зелёные.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test
