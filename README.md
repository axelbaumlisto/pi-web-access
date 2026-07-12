<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# pi-ext-int-search

**External + internal search for the Pi coding agent.** One package, two complementary tools:

- **EXTERNAL — `web_search`**: the live internet across OpenAI/Codex, Exa, Brave, Parallel, Tavily, Perplexity, Gemini (+ URL fetch, GitHub clone, PDF, YouTube/video understanding).
- **INTERNAL — `memory_search`**: your OWN history — past Pi chat sessions, claude-recall memories, project markdown docs, and git commit history.

[![npm version](https://img.shields.io/npm/v/pi-ext-int-search?style=for-the-badge)](https://www.npmjs.com/package/pi-ext-int-search)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## External vs. internal search — the difference

| | EXTERNAL (`web_search`) | INTERNAL (`memory_search`) |
|---|---|---|
| **Searches** | the public internet | your own local history |
| **Sources** | OpenAI, Exa, Brave, Parallel, Tavily, Perplexity, Gemini | pi sessions (JSONL), claude-recall DB, `*.md` docs, git log/diffs |
| **Use when** | "what's the latest X", docs, news, code on the web | "what did we decide about X", "как мы это делали вчера", "поищи в переписке / в гит истории" |
| **Network** | yes (provider APIs / a unified proxy) | none — local `ripgrep` + `sqlite3` + `git` only |
| **Engine** | provider APIs with a fallback chain | on-the-fly `rg`/`sqlite3`/`git` scan, ranked relevance×recency |
| **Scope** | the web | current project (default) or `scope:"all"` = every project on the machine |

They never overlap: reach for `web_search` for the world, `memory_search` for what *you* already did. `memory_search` makes zero network calls and redacts secrets from snippets before they reach the model.

## Origins & lineage (first sources)

This package is a hardened fork, not original work — credit upstream:

- **Original / base:** [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) (MIT) — the external `web_search` + fetch/PDF/YouTube/GitHub feature set. Everything under "external search" derives from it.
- **Provider-endpoint layout** borrows the central-registry idea from [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) (the independent base of that genealogy).
- **This fork** ([`axelbaumlisto/pi-web-access`](https://github.com/axelbaumlisto/pi-web-access)) adds the parts that are NOT in upstream:
  1. **`memory_search`** — the entire internal-search tool (sessions + recall + docs + git).
  2. **Unified proxy mode** — one base host + one key fronting all providers (`provider-endpoints.ts`).
  3. **Security hardening** from a multi-round blind review: destination-first key binding (no personal key leaks to a proxy), grounding-redirect SSRF guard, upstream error-body redaction, HTML-sanitized snippets, empty-result auto-fallback, citation preservation.

Upstream commits are preserved in git history; fork changes sit on top.

## Why external search (from upstream)

**Zero Config** — Works out of the box with Exa MCP (no API key needed). If you're signed into Pi with a Codex subscription, OpenAI web search can reuse that auth. Add API keys for OpenAI, Brave, Parallel, Tavily, Exa, Perplexity, or Gemini API for more control, or opt into browser-cookie access for Gemini Web.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search tries OpenAI when suitable and available, then Exa, Brave, Parallel, Tavily, Perplexity, Gemini API, and Gemini Web when browser cookies are enabled. YouTube tries Gemini Web when enabled, then API, then Perplexity. Blocked pages retry through Jina Reader, Parallel, and Gemini extraction. Something always works.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-ext-int-search
```

Works immediately with no API keys — Exa MCP provides zero-config search. If Pi has Codex auth from `/login`, OpenAI search can also work without a separate key. For more providers or direct API access, add keys to `~/.pi/web-search.json`:

```json
{
  "openaiApiKey": "sk-...",
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

In `auto` mode (default), `web_search` tries OpenAI when suitable and available, then Exa (direct API if keyed, MCP if not), Brave, Parallel, Tavily, Perplexity, Gemini API, then Gemini Web when browser-cookie access is enabled.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

### web_search

Search the web via OpenAI, Brave, Parallel, Tavily, Exa, Perplexity AI, or Gemini. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "openai" })
web_search({ query: "...", includeContent: true })
web_search({ queries: ["query 1", "query 2"], workflow: "none" })
web_search({ queries: ["query 1", "query 2"], workflow: "summary-review" })
web_search({ queries: ["query 1", "query 2"], workflow: "auto-summary" })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default), `openai`, `brave`, `parallel`, `tavily`, `exa`, `perplexity`, or `gemini` |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `none` (skip curator), `summary-review` (open curator and auto-generate a summary draft, default), or `auto-summary` (generate a summary without opening the curator) |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Automatically detects and handles GitHub repos, YouTube videos, PDFs, local video files, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question to ask about a YouTube video or local video file |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Content over 30,000 chars is truncated in tool responses but stored in full for retrieval here.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
get_search_content({ responseId: "abc123", query: "original query" })
```

### memory_search (internal search)

Search your OWN history instead of the web — past Pi chat sessions, stored
claude-recall memories, project markdown docs, and git commit history. No
network; scans locally with `ripgrep` + `sqlite3` + `git`, ranks by keyword
relevance × recency, and redacts secrets from snippets before returning them.

```typescript
memory_search({ query: "what did we decide about bedrock" })
memory_search({ query: "поищи в переписке gemini grounding" })
memory_search({ query: "rotation key pool", scope: "all" })          // every project
memory_search({ query: "retry logic", sources: ["sessions", "memory", "docs"] })
memory_search({ query: "покажи все коммиты за неделю" })              // git time-window sweep
```

| Parameter | Description |
|-----------|-------------|
| `query` | Keywords or a phrase to find in your history (RU + EN) |
| `scope` | `current` (default, this project) or `all` (every project on the machine) |
| `sources` | Any of `sessions`, `memory`, `docs`, `git`. Default = `sessions` + `memory`. `docs`/`git` are also auto-added when the query mentions docs or git |
| `limit` | Max results (default 15) |

**Sources.** `sessions` = Pi chat transcripts (`~/.pi/agent/sessions/*.jsonl`);
`memory` = claude-recall DB (`~/.claude-recall/claude-recall.db`); `docs` =
`*.md` under the project (or `~/work` + `~/.pi/agent` for `scope:"all"`); `git`
= commit messages + diffs (keyword search expands the top hits; a query with a
time phrase like "за месяц"/"last week" lists ALL commits in the window). Output
notes any source that failed or was truncated, so "no matches" is never confused
with "the scan broke".

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web when browser cookies are enabled → Gemini API → Perplexity (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis.

Fallback: Gemini API (Files API upload) → Gemini Web when browser cookies are enabled.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles JS rendering server-side, no API key needed), then Gemini URL Context API, then Gemini Web extraction when browser cookies are enabled. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → Exa (direct API with key, MCP without) → Perplexity → Gemini API → Gemini Web (if browser cookies enabled)

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Perplexity
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader → Gemini fallback
               → Text/JSON/Markdown? Return directly
```

## Skills

### librarian

Bundled research workflow for investigating open-source libraries. Combines GitHub cloning, web search, and git operations (blame, log, show) to produce evidence-backed answers with permalinks. Pi loads it automatically based on your prompt. Also available via `/skill:librarian` with [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette).

## Commands

### /websearch

Open the search curator directly. Runs searches and lets you review, add, select results, and approve a summary before it is sent back to the agent — no LLM round-trip needed.

```
/websearch                                               # empty page, type your own searches
/websearch react hooks, next.js caching                  # pre-fill with comma-separated queries
```

Results get injected into the conversation when you approve the summary or click "Send selected results without summary". On timeout, the curator auto-submits and falls back to a deterministic summary if no approved draft is present.

### /curator

Toggle or configure the curator workflow at runtime.

```
/curator                    # toggle on/off
/curator on                 # enable curator (summary-review)
/curator off                # disable curator (raw results only)
/curator summary-review     # explicit workflow
```

Persists to `~/.pi/web-search.json` and takes effect on the next `web_search` call. When disabled, `web_search` returns raw results without opening the curator window.

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /google-account

Show the active Google account currently authenticated for Gemini Web. Useful when multiple Chromium profiles exist or `chromeProfile` is set in config.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

Config defaults to `~/.pi/web-search.json`, or `web-search.json` under `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME/pi` when set. Every field is optional.

```json
{
  "openaiApiKey": "sk-...",
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "parallelApiKey": "...",
  "tavilyApiKey": "tvly-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "provider": "openai",
  "webSearch": {
    "enabled": true
  },
  "chromeProfile": "Profile 2",
  "allowBrowserCookies": false,
  "searchModel": "gemini-2.5-flash",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "workflow": "summary-review",
  "curatorTimeoutSeconds": 20,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  },
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

`OPENAI_API_KEY`, `BRAVE_API_KEY`, `PARALLEL_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars take precedence over config file values. Configured Exa API keys use Exa's own account limits directly; any legacy local `exa-usage.json` file is ignored. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for Gemini generate-content calls such as search, URL context, YouTube, and local video analysis. Set it to a bare host with no trailing slash and no version segment, for example `https://my-gateway.example.com/gemini`; `geminiBaseUrl` is the config-file equivalent. When the configured host contains `gateway.ai.cloudflare.com`, authentication uses `cf-aig-authorization: Bearer <token>` from `CLOUDFLARE_API_KEY` or `cloudflareApiKey`, and `GEMINI_API_KEY` is not required for generate-content calls. Local video file upload still uses Google's Files API directly, so gateway-only video extraction falls back to Gemini Web unless a `GEMINI_API_KEY` is also configured. `provider` sets the default search provider: `"openai"`, `"brave"`, `"parallel"`, `"tavily"`, `"exa"`, `"perplexity"`, or `"gemini"`. This is also updated automatically when you change the provider in the curator UI. Set `webSearch.enabled` to `false` to unregister the `web_search` tool while leaving fetch/content tools available. `workflow` sets the default search workflow: `"summary-review"` (default, opens curator with auto-generated summary draft), `"auto-summary"` (returns a model-generated summary without opening the curator), or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on `web_search`, or toggled at runtime with `/curator`. `chromeProfile` overrides the Chromium profile directory used for Gemini Web cookie lookup. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. `searchModel` overrides the Gemini API model used by `web_search` without changing URL, YouTube, or video extraction defaults. `summaryModel` sets the default model used for generating summary drafts in the curator UI and `auto-summary` mode (e.g. `"anthropic/claude-haiku-4-5"`, `"openai-codex/gpt-5.3-codex-spark"`, or `"openrouter/nvidia/nemotron-3-super-120b-a12b:free"`). When Pi `enabledModels` is configured, summaries are limited to that allowlist; if no enabled summary model is available, the tool returns a deterministic summary instead of calling an unrelated model. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI. `ssrf.allowRanges` lists CIDR ranges (e.g. `"198.18.0.0/15"`, `"fd00::/8"`) exempted from the SSRF guard that otherwise blocks private/reserved IP ranges. This unblocks `fetch_content`/`web_search` on hosts whose network proxy runs in TUN + fake-IP mode (Surge, Clash, Mihomo, Stash, ...), where public domains resolve into a synthetic reserved range. It is **off by default** — the guard stays fully enabled unless you list ranges here. Use the narrowest range that covers your proxy's fake-IP pool. All-address CIDRs such as `0.0.0.0/0` and `::/0` are rejected.

### Shortcuts

Both shortcuts are configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Set `"enabled": false` under any feature to disable it. Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- If the curator cannot open a browser automatically, such as in Docker, WSL, SSH, or headless environments, the running curator URL is shown in the tool output. Copy it into a browser that can reach the Pi host, or use a tunnel/port-forward when needed.
- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`. On macOS, enabling it may trigger a Keychain dialog; Linux uses `secret-tool` when available and falls back to Chromium's default password otherwise.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `curator-page.ts` | HTML/CSS/JS generation for the curator UI with markdown rendering |
| `curator-server.ts` | Ephemeral HTTP server with SSE streaming and state machine |
| `summary-review.ts` | Summary prompt construction, model-based draft generation, and deterministic fallback summary |
| `openai-search.ts` | OpenAI Responses API web search provider with Codex/API-key auth |
| `brave.ts` | Brave Search API provider |
| `parallel.ts` | Parallel search provider and extraction fallback |
| `tavily.ts` | Tavily Search API provider |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `gemini-search.ts` | Search routing across OpenAI, Brave, Parallel, Tavily, Exa, Perplexity, Gemini API, Gemini Web |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `gemini-api.ts` | Gemini REST API client (generateContent) |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction (Keychain/secret-tool + SQLite) |
| `youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `perplexity.ts` | Perplexity API client with rate limiting |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |
| `skills/librarian/` | Bundled skill for library research |

</details>
