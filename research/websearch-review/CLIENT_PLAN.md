# pi-web-access: клиентские фиксы areview (B5 + int#6 + product#1/#2)

Источник: /Users/shamash/work/llm_proxy/research/websearch-review/BLIND_{1,2}_*.md.
Фиксим клиентские находки плагина web_search. Verify = `npm test` (node --test, 69 базовых).
Уже исправлено ранее: provider-endpoints.ts destination-first key routing + origin-compare.

### Task 1: Gemini destination-aware key (B5b [HIGH])
**Files:** gemini-api.ts, test/gemini-key-binding.test.mjs
**Steps:**
1. `getApiKey()` возвращает personal `GEMINI_API_KEY` (env) или `geminiApiKey` (config)
   независимо от хоста, а `buildKeyParam` аппендит его как `?key=...` на ЛЮБОЙ
   `getApiHost()` (включая override/proxy). Уязвимость: ambient personal Google-ключ
   уходит в query-string произвольного сконфигурированного хоста (airpx/прокси), где
   он и логируется, и утекает. Нужно destination-aware: personal Google-ключ можно
   слать ТОЛЬКО на прямой Google-эндпоинт (`generativelanguage.googleapis.com`
   = DEFAULT_API_HOST). Для override-хоста (proxy) — НЕ аппендить personal env-ключ;
   слать только ключ, явно предназначенный этому хосту (config `geminiApiKey`,
   который в unified-режиме и есть proxy-ключ), либо ничего (proxy инжектит pool-ключ).
2. Реализация (минимальная, зеркалит provider-endpoints destination-first): ввести
   helper `isDirectGoogleHost()` (host === DEFAULT_API_HOST или заканчивается на
   `.googleapis.com`). `buildKeyParam`/резолв ключа: если хост прямой Google —
   можно env||config; если override-хост — только config `geminiApiKey` (явно заданный
   для этого хоста), НИКОГДА ambient `GEMINI_API_KEY` env. CF-gateway ветка без
   изменений (уже отдаёт "" в buildKeyParam и шлёт cf-aig header). Не ломать
   `isGeminiApiAvailable`.
3. Тесты (mock env/config, без сети): (a) прямой Google-хост + env GEMINI_API_KEY →
   `?key=<personal>` присутствует; (b) override-хост (geminiBaseUrl=https://airpx.cc)
   + ТОЛЬКО ambient env personal key → personal key НЕ уходит в URL (buildKeyParam
   пуст либо использует config-ключ, но не env-personal); (c) override-хост + config
   geminiApiKey=<proxy key> → уходит proxy-ключ; (d) CF-gateway → buildKeyParam "" +
   cf-aig header (регресс).
**Acceptance:**
- Ambient personal GEMINI_API_KEY НЕ отправляется на override/proxy-хост.
- Прямой Google-хост по-прежнему получает personal ключ.
- CF-gateway путь не сломан.
- Изменены только 2 файла.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test

### Task 2: OpenAI destination-first key (B5a [HIGH])
**Files:** openai-search.ts, test/openai-key-binding.test.mjs
**Steps:**
1. `resolveOpenAIAuth` берёт ключ из `ctx.modelRegistry.getApiKeyAndHeaders` (personal
   model-registry ключ) ПЕРВЫМ, а URL отдельно из `providerUrl("openai")`. Если URL
   срезолвился на unified-proxy (airpx), а model-registry вернул personal OpenAI-ключ —
   personal ключ уходит на прокси как Bearer. Нужно связать destination и ключ: personal
   model-registry/OpenAI-ключ можно слать ТОЛЬКО на OpenAI/Codex-ориджин; если
   назначение — proxy, использовать proxy-ключ (`providerApiKey("openai")`, который в
   destination-first режиме уже отдаёт shared proxy-ключ для proxy-хоста).
2. Реализация: определить назначение до выбора ключа. Резолвить `providerUrl("openai")`
   и сравнить ориджин с ожидаемым OpenAI/Codex (api.openai.com / chatgpt.com) через
   `URL().origin`. Если назначение — НЕ OpenAI-ориджин (значит proxy/override) →
   пропустить model-registry ветку и вернуть auth с `providerApiKey("openai")` (proxy
   ключ). Если назначение — OpenAI-ориджин → текущее поведение (model-registry
   personal ключ ок, он идёт к настоящему OpenAI). Сохранить codex-flow (isCodexJwt).
3. Тесты (mock ctx.modelRegistry + provider-endpoints env, без сети): (a) без proxy
   (default OpenAI URL) + model-registry personal key → уходит personal на api.openai.com;
   (b) proxyBaseUrl=airpx + model-registry personal key присутствует → auth.apiKey ==
   proxy-ключ, personal НЕ уходит на airpx; (c) proxy без personal → proxy-ключ.
**Depends:** Task 1
**Acceptance:**
- Personal model-registry OpenAI-ключ НЕ уходит на proxy-хост.
- Прямой OpenAI-хост по-прежнему получает personal ключ (codex-flow цел).
- Изменены только 2 файла.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test

### Task 3: Perplexity — availability + сохранение цитат + таймаут (int#6, product#1, int#11)
**Files:** perplexity.ts, test/perplexity-fixes.test.mjs
**Steps:**
1. int#6: `isPerplexityAvailable` (стр ~106) проверяет только env PERPLEXITY_API_KEY /
   config perplexityApiKey, но запрос шлёт `providerApiKey("perplexity")` (видит и unified
   proxy-ключ). Из-за этого auto-режим молча пропускает полностью настроенный через
   прокси Perplexity. Переписать: `isPerplexityAvailable` = `providerApiKey("perplexity")
   !== null`.
2. product#1 [HIGH]: ответ содержит маркеры [1..N], но `citations` обрезаются до
   `numResults` (стр ~184 `Math.min(citations.length, numResults)`) — цитаты [6..9] в
   тексте ссылаются на удалённые URL, неверифицируемо. Исправить: возвращать ВСЕ
   цитаты, на которые реально ссылается ответ (как минимум — не обрезать ниже
   максимального маркера [k], встречающегося в answer; проще и безопаснее — вернуть все
   citations, не обрезая по numResults, т.к. это источники, а не сами результаты). Не
   ломать нумерацию: results[i] должен соответствовать citation i+1.
3. int#11: у perplexity нет собственного таймаута (стр ~146 полагается только на внешний
   signal). Добавить `AbortSignal.timeout(...)` скомбинированный с options.signal (как в
   gemini-search: `AbortSignal.any([AbortSignal.timeout(30000), ...(signal?[signal]:[])])`).
4. Тесты (mock fetch, без сети): (a) isPerplexityAvailable true при ТОЛЬКО proxy-конфиге
   (proxyBaseUrl+proxyApiKey, без perplexityApiKey); (b) ответ с 9 цитатами и маркером
   [8] → все реально цитируемые URL присутствуют (не обрезаны до 5); (c) запрос без
   внешнего signal всё равно имеет таймаут (проверить, что fetch вызван с signal,
   который абортится по таймауту — можно проверить наличие AbortSignal).
**Depends:** Task 2
**Acceptance:**
- Auto-режим видит Perplexity через unified-proxy ключ.
- Цитаты, на которые ссылается ответ, не выкидываются.
- У запроса есть собственный таймаут независимо от внешнего signal.
- Изменён только perplexity.ts + новый тест.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test

### Task 4: Gemini — применять recency/domain/numResults + кап/дедуп чанков (product#2 [HIGH])
**Files:** gemini-search.ts, test/gemini-options.test.mjs
**Steps:**
1. product#2: `searchWithGeminiApi` (стр ~262) шлёт в grounded-запрос только сырой
   `query` + `google_search` tool — `recencyFilter`/`domainFilter`/`numResults` НЕ
   применяются (хотя explicit-режим их рекламирует), и число groundingChunks не
   капается под numResults. Из-за этого gemini может вернуть 10 чанков на numResults=5
   и игнорировать «official/last month».
2. Исправить: обогатить промпт grounded-запроса теми же ограничениями, что строит
   `buildSearchPrompt` (recency/domain — стр ~344+): вместо `parts:[{text: query}]`
   передавать query + строки-ограничения (переиспользовать существующую логику
   построения ограничений, DRY — если есть функция, вызвать её; иначе вынести общий
   билдер). После получения — кап и дедуп `results` под `numResults`
   (`Math.min` + дедуп по URL), чтобы контракт numResults соблюдался.
3. Тесты (mock fetch + resolveGroundingChunks, без сети): (a) recencyFilter/domainFilter
   заданы → тело запроса (parts text) содержит соответствующие ограничения; (b)
   numResults=5, а API вернул 10 чанков → results.length <= 5 и без дублей по URL;
   (c) базовый запрос без опций не сломан.
**Depends:** Task 3
**Acceptance:**
- recencyFilter/domainFilter отражены в grounded-запросе.
- numResults ограничивает число results (с дедупом по URL).
- Существующие gemini-тесты зелёные.
- Изменён только gemini-search.ts + новый тест.
**Verify:** cd /Users/shamash/work/pi-web-access && npm test
