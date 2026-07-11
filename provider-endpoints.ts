/**
 * Central registry of search-provider base URLs + override resolution.
 *
 * Every provider's endpoint can be overridden (e.g. to route through a proxy
 * that fronts a pooled API key) via, in priority order:
 *   1. environment variable  (e.g. EXA_BASE_URL)
 *   2. web-search.json config field  (e.g. exaBaseUrl)
 *   3. the hardcoded default
 *
 * This mirrors the pattern gemini-api.ts already used for
 * GOOGLE_GEMINI_BASE_URL / geminiBaseUrl, but keeps the exa/brave/perplexity
 * (etc.) endpoints in ONE place instead of copy-pasting normalizeBaseUrl + a
 * getter into each provider module.
 *
 * UNIFIED PROXY MODE
 * ------------------
 * When every provider is fronted by the SAME gateway (e.g. a self-hosted proxy
 * that injects a pooled key), setting one base host + one key is enough:
 *   env  WEB_SEARCH_PROXY_URL  / config proxyBaseUrl   (e.g. https://airpx.cc)
 *   env  WEB_SEARCH_PROXY_KEY  / config proxyApiKey     (e.g. sk-proxy-...)
 * Each provider's endpoint is then derived as `${proxyBase}${proxyPath}` and
 * its API key falls back to the shared proxy key — so you don't repeat the
 * per-provider *BaseUrl / *ApiKey fields. Per-provider overrides still win.
 */

import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

export type SearchProviderId =
	| "exa"
	| "brave"
	| "perplexity"
	| "tavily"
	| "parallel"
	| "openai";

// gemini is intentionally NOT here: gemini-api.ts keeps its own resolver
// (getApiHost) because it also detects Cloudflare AI Gateway routing and
// applies API_VERSION — logic that doesn't fit the simple base/URL swap here.
// OpenAI's codex endpoint (chatgpt.com backend) is likewise left hardcoded in
// openai-search.ts: it's a separate OAuth/codex flow, not a plain key swap.

interface ProviderEndpoint {
	/** Default base/URL when no override is set. */
	default: string;
	/** Environment variable that overrides it. */
	env: string;
	/** web-search.json field that overrides it. */
	configKey: string;
	/**
	 * Path under the unified proxy base that serves this provider. When set and
	 * a proxy base is configured (WEB_SEARCH_PROXY_URL / proxyBaseUrl), the
	 * endpoint becomes `${proxyBase}${proxyPath}`. Omit for providers the proxy
	 * does not front (they keep their own default / per-provider override).
	 */
	proxyPath?: string;
	/** Per-provider API-key env var (for the shared-key fallback resolver). */
	keyEnv: string;
	/** Per-provider API-key config field. */
	keyConfigKey: string;
}

// Unified-proxy config keys (single base + single key for all providers).
const PROXY_BASE_ENV = "WEB_SEARCH_PROXY_URL";
const PROXY_BASE_CONFIG = "proxyBaseUrl";
const PROXY_KEY_ENV = "WEB_SEARCH_PROXY_KEY";
const PROXY_KEY_CONFIG = "proxyApiKey";

/**
 * Default endpoints. For exa this is the API *base* (paths like /search,
 * /answer, /mcp are appended by the caller); for brave/perplexity it is the
 * FULL endpoint URL (query params / body are added by the caller).
 */
export const PROVIDER_ENDPOINTS: Record<SearchProviderId, ProviderEndpoint> = {
	exa: {
		default: "https://api.exa.ai",
		env: "EXA_BASE_URL",
		configKey: "exaBaseUrl",
		proxyPath: "/v1/exa",
		keyEnv: "EXA_API_KEY",
		keyConfigKey: "exaApiKey",
	},
	brave: {
		default: "https://api.search.brave.com/res/v1/web/search",
		env: "BRAVE_BASE_URL",
		configKey: "braveBaseUrl",
		proxyPath: "/v1/brave/search",
		keyEnv: "BRAVE_API_KEY",
		keyConfigKey: "braveApiKey",
	},
	perplexity: {
		default: "https://api.perplexity.ai/chat/completions",
		env: "PERPLEXITY_BASE_URL",
		configKey: "perplexityBaseUrl",
		proxyPath: "/v1/chat/completions",
		keyEnv: "PERPLEXITY_API_KEY",
		keyConfigKey: "perplexityApiKey",
	},
	tavily: {
		default: "https://api.tavily.com/search",
		env: "TAVILY_BASE_URL",
		configKey: "tavilyBaseUrl",
		// no proxyPath: the gateway does not front Tavily.
		keyEnv: "TAVILY_API_KEY",
		keyConfigKey: "tavilyApiKey",
	},
	// parallel is a *base* (paths /v1/search and /v1/extract are appended).
	parallel: {
		default: "https://api.parallel.ai",
		env: "PARALLEL_BASE_URL",
		configKey: "parallelBaseUrl",
		// no proxyPath: the gateway does not front Parallel.
		keyEnv: "PARALLEL_API_KEY",
		keyConfigKey: "parallelApiKey",
	},
	// openai's standard Responses endpoint (the codex endpoint stays hardcoded).
	openai: {
		default: "https://api.openai.com/v1/responses",
		env: "OPENAI_RESPONSES_URL",
		configKey: "openaiResponsesUrl",
		proxyPath: "/v1/responses",
		keyEnv: "OPENAI_API_KEY",
		keyConfigKey: "openaiApiKey",
	},
};

export function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\/+$/, "");
	return normalized.length > 0 ? normalized : null;
}

let cachedConfig: Record<string, unknown> | null = null;

function loadRawConfig(): Record<string, unknown> {
	if (cachedConfig) return cachedConfig;
	const path = getWebSearchConfigPath();
	if (!existsSync(path)) {
		cachedConfig = {};
		return cachedConfig;
	}
	try {
		cachedConfig = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch {
		cachedConfig = {};
	}
	return cachedConfig;
}

/** The unified proxy base host, if configured (env > config). */
export function proxyBaseUrl(): string | null {
	return (
		normalizeBaseUrl(process.env[PROXY_BASE_ENV]) ??
		normalizeBaseUrl(loadRawConfig()[PROXY_BASE_CONFIG])
	);
}

/** The shared proxy API key, if configured (env > config). */
export function proxyApiKey(): string | null {
	const envVal = process.env[PROXY_KEY_ENV];
	if (typeof envVal === "string" && envVal.trim().length > 0) return envVal.trim();
	const cfgVal = loadRawConfig()[PROXY_KEY_CONFIG];
	if (typeof cfgVal === "string" && cfgVal.trim().length > 0) return cfgVal.trim();
	return null;
}

/**
 * Resolve a provider's endpoint. Priority:
 *   1. per-provider env    (e.g. EXA_BASE_URL)
 *   2. per-provider config  (e.g. exaBaseUrl)
 *   3. unified proxy base + provider proxyPath (if both configured)
 *   4. hardcoded default
 *
 * `overridden` is true for cases 1–3 (used by Exa: its MCP endpoint only moves
 * off mcp.exa.ai when an override is explicitly in effect).
 */
export function resolveProviderEndpoint(
	provider: SearchProviderId,
): { url: string; overridden: boolean } {
	const ep = PROVIDER_ENDPOINTS[provider];
	const perProvider =
		normalizeBaseUrl(process.env[ep.env]) ?? normalizeBaseUrl(loadRawConfig()[ep.configKey]);
	if (perProvider !== null) return { url: perProvider, overridden: true };

	const base = proxyBaseUrl();
	if (base !== null && ep.proxyPath) {
		return { url: `${base}${ep.proxyPath}`, overridden: true };
	}

	return { url: ep.default, overridden: false };
}

/** Convenience: just the resolved URL for a provider. */
export function providerUrl(provider: SearchProviderId): string {
	return resolveProviderEndpoint(provider).url;
}

/**
 * Resolve a provider's API key. Priority:
 *   1. per-provider env    (e.g. EXA_API_KEY)
 *   2. per-provider config  (e.g. exaApiKey)
 *   3. shared proxy key — ONLY when this provider's endpoint ACTUALLY resolved
 *      to the unified proxy base. Gating on the resolved URL (not merely
 *      "proxyPath + base configured") prevents leaking the proxy key to a
 *      per-provider override host: if the user sets exaBaseUrl to a custom
 *      third-party host while a proxyBaseUrl is also configured, the URL wins
 *      case 1/2 (override) and the shared key must NOT be sent there (B3).
 * Returns null when none is set.
 */
export function providerApiKey(provider: SearchProviderId): string | null {
	const ep = PROVIDER_ENDPOINTS[provider];
	const envKey = process.env[ep.keyEnv];
	if (typeof envKey === "string" && envKey.trim().length > 0) return envKey.trim();
	const cfgKey = loadRawConfig()[ep.keyConfigKey];
	if (typeof cfgKey === "string" && cfgKey.trim().length > 0) return cfgKey.trim();
	// Shared key only if the resolved endpoint really is the proxy base.
	const base = proxyBaseUrl();
	if (base !== null && resolveProviderEndpoint(provider).url.startsWith(base)) {
		return proxyApiKey();
	}
	return null;
}
