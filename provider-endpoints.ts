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
}

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
	},
	brave: {
		default: "https://api.search.brave.com/res/v1/web/search",
		env: "BRAVE_BASE_URL",
		configKey: "braveBaseUrl",
	},
	perplexity: {
		default: "https://api.perplexity.ai/chat/completions",
		env: "PERPLEXITY_BASE_URL",
		configKey: "perplexityBaseUrl",
	},
	tavily: {
		default: "https://api.tavily.com/search",
		env: "TAVILY_BASE_URL",
		configKey: "tavilyBaseUrl",
	},
	// parallel is a *base* (paths /v1/search and /v1/extract are appended).
	parallel: {
		default: "https://api.parallel.ai",
		env: "PARALLEL_BASE_URL",
		configKey: "parallelBaseUrl",
	},
	// openai's standard Responses endpoint (the codex endpoint stays hardcoded).
	openai: {
		default: "https://api.openai.com/v1/responses",
		env: "OPENAI_RESPONSES_URL",
		configKey: "openaiResponsesUrl",
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

/**
 * Resolve a provider's endpoint: env > config > default.
 *
 * Returns `{ url, overridden }` — `overridden` is true when either the env var
 * or the config field supplied a value (useful for providers like Exa whose
 * MCP endpoint lives on a different host by default and should only move when
 * an override is explicitly set).
 */
export function resolveProviderEndpoint(
	provider: SearchProviderId,
): { url: string; overridden: boolean } {
	const ep = PROVIDER_ENDPOINTS[provider];
	const override =
		normalizeBaseUrl(process.env[ep.env]) ?? normalizeBaseUrl(loadRawConfig()[ep.configKey]);
	return { url: override ?? ep.default, overridden: override !== null };
}

/** Convenience: just the resolved URL for a provider. */
export function providerUrl(provider: SearchProviderId): string {
	return resolveProviderEndpoint(provider).url;
}
