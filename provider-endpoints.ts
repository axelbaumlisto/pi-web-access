/**
 * Central registry of search-provider endpoints + destination-first credentials.
 *
 * URL resolution (`providerUrl`), priority:
 *   1. per-provider env        (e.g. EXA_BASE_URL)
 *   2. per-provider config     (e.g. exaBaseUrl)
 *   3. unified proxy base + provider proxyPath (if both configured)
 *   4. hardcoded default
 * Steps 1–3 are validated by `resolveApiBaseUrl` (absolute HTTPS, no
 * credentials, no query/fragment). Defaults are trusted constants.
 *
 * `kind` tells callers what they get back:
 *   "base" — a base; the provider appends its own path (exa /search, tavily
 *            /search, parallel /v1/search). Proxy paths for these are bases too.
 *   "full" — the complete endpoint; caller adds only query/body. A per-provider
 *            override for a "full" provider is still a BASE (upstream semantics:
 *            `braveBaseUrl` is `…/res/v1`) and gets `overrideSuffix` appended;
 *            the proxy path is already complete (gateway route contract).
 *
 * UNIFIED PROXY MODE
 * ------------------
 * One gateway fronts several providers and injects a pooled key:
 *   env WEB_SEARCH_PROXY_URL / config proxyBaseUrl   (e.g. https://gateway.example)
 *   env WEB_SEARCH_PROXY_KEY / config proxyApiKey    (e.g. sk-proxy-...)
 * Each fronted provider's endpoint becomes `${proxyBase}${proxyPath}`.
 *
 * DESTINATION-FIRST KEY BINDING (security invariant)
 * ---------------------------------------------------
 * The credential is chosen AFTER the destination resolves:
 *   - destination is the proxy origin → the shared proxy key is the ONLY
 *     credential. If it is missing the provider is UNAVAILABLE — we never fall
 *     back to a personal per-provider key (env / $ENV / !cmd / registry).
 *   - destination is anywhere else → upstream's credential-source rules
 *     (`$ENV` / `!cmd` / literal, env-before-config for literals). The proxy
 *     key is never sent to a non-proxy host.
 * "Proxy origin" is a parsed-origin compare, not startsWith: an override to
 * `gateway.example.evil.com` is not the proxy.
 *
 * gemini is intentionally NOT here: gemini-api.ts has its own resolver
 * (Cloudflare AI Gateway detection, API_VERSION, ADC). OpenAI's codex
 * endpoint (chatgpt.com) stays hardcoded in openai-search.ts (OAuth flow).
 */

import { existsSync, readFileSync } from "node:fs";
import {
	hasCredentialSource,
	resolveCredential,
	type CredentialOptions,
} from "./credential-source.ts";
import { getWebSearchConfigPath, resolveApiBaseUrl } from "./utils.ts";

export type SearchProviderId =
	| "exa"
	| "brave"
	| "perplexity"
	| "tavily"
	| "parallel"
	| "openai";

export type EndpointKind = "base" | "full";

interface ProviderEndpoint {
	/** Human label used in credential-resolution errors ("Exa", "Brave", …). */
	label: string;
	/** What `providerUrl()` returns — see module doc. */
	kind: EndpointKind;
	/** Default endpoint when nothing overrides it (a base for kind:"base", complete for kind:"full"). */
	default: string;
	/** Environment variable that overrides the base. */
	env: string;
	/** web-search.json field that overrides the base. */
	configKey: string;
	/**
	 * Appended to a per-provider OVERRIDE (which is always a base) to form the
	 * full endpoint. Only meaningful for kind:"full". Never appended to the
	 * default (already complete) or to the proxy path (gateway route contract).
	 */
	overrideSuffix?: string;
	/**
	 * Path under the unified proxy base that serves this provider. Omit for
	 * providers the gateway does not front.
	 */
	proxyPath?: string;
}

const PROXY_BASE_ENV = "WEB_SEARCH_PROXY_URL";
const PROXY_BASE_CONFIG = "proxyBaseUrl";
const PROXY_KEY_ENV = "WEB_SEARCH_PROXY_KEY";
const PROXY_KEY_CONFIG = "proxyApiKey";

export const PROVIDER_ENDPOINTS: Record<SearchProviderId, ProviderEndpoint> = {
	exa: {
		label: "Exa",
		kind: "base",
		default: "https://api.exa.ai",
		env: "EXA_BASE_URL",
		configKey: "exaBaseUrl",
		proxyPath: "/v1/exa",
	},
	brave: {
		label: "Brave",
		kind: "full",
		default: "https://api.search.brave.com/res/v1/web/search",
		env: "BRAVE_BASE_URL",
		configKey: "braveBaseUrl",
		// upstream: braveBaseUrl is the `…/res/v1` base; provider appends /web/search
		overrideSuffix: "/web/search",
		// gateway route contract: this IS the complete search endpoint
		proxyPath: "/v1/brave/search",
	},
	perplexity: {
		label: "Perplexity",
		kind: "full",
		default: "https://api.perplexity.ai/chat/completions",
		env: "PERPLEXITY_BASE_URL",
		configKey: "perplexityBaseUrl",
		proxyPath: "/v1/chat/completions",
	},
	tavily: {
		label: "Tavily",
		kind: "base",
		default: "https://api.tavily.com",
		env: "TAVILY_BASE_URL",
		configKey: "tavilyBaseUrl",
		// not fronted by the gateway
	},
	parallel: {
		label: "Parallel",
		kind: "base",
		default: "https://api.parallel.ai",
		env: "PARALLEL_BASE_URL",
		configKey: "parallelBaseUrl",
		// not fronted by the gateway
	},
	openai: {
		label: "OpenAI",
		kind: "full",
		default: "https://api.openai.com/v1/responses",
		env: "OPENAI_RESPONSES_URL",
		configKey: "openaiResponsesUrl",
		proxyPath: "/v1/responses",
	},
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

let cachedConfig: Record<string, unknown> | null = null;

/** Drop the cached web-search.json so the next call re-reads it (tests / key rotation). */
export function resetEndpointCache(): void {
	cachedConfig = null;
}

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
		// A malformed file must not silently turn into "no proxy": the proxy URL
		// may still arrive via env. Callers handle the missing-key case as
		// "provider unavailable" (see resolveProviderKey), never as a fallback.
		cachedConfig = {};
	}
	return cachedConfig;
}

function trimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = value.trim();
	return t.length > 0 ? t : undefined;
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

/**
 * The unified proxy base, validated (HTTPS, no creds, no query), or null when
 * not configured. THROWS on an invalid value — this is the one URL that
 * receives every key, so it gets the same rules as per-provider overrides.
 */
export function proxyBaseUrl(): string | null {
	const resolved = resolveApiBaseUrl({
		configKey: PROXY_BASE_CONFIG,
		configuredValue: loadRawConfig()[PROXY_BASE_CONFIG],
		defaultValue: "",
		environmentKey: PROXY_BASE_ENV,
		environmentValue: process.env[PROXY_BASE_ENV],
	});
	return resolved === "" ? null : resolved;
}

/** The shared proxy API key (env > config), or null. */
export function proxyApiKey(): string | null {
	return trimmedString(process.env[PROXY_KEY_ENV]) ?? trimmedString(loadRawConfig()[PROXY_KEY_CONFIG]) ?? null;
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

export type EndpointSource = "override" | "proxy" | "default";

export interface ResolvedEndpoint {
	/** The endpoint according to `kind` (see module doc). */
	url: string;
	/** Where it came from. */
	source: EndpointSource;
	/** True unless the default is in effect (Exa: MCP only moves off mcp.exa.ai when overridden). */
	overridden: boolean;
}

/**
 * Resolve a provider's endpoint. May THROW when a configured URL (per-provider
 * override or proxy base) is invalid; the message names the offending
 * env var / config key. Availability checks must use `isProxiedDestination`,
 * which never throws.
 */
export function resolveProviderEndpoint(provider: SearchProviderId): ResolvedEndpoint {
	const ep = PROVIDER_ENDPOINTS[provider];

	// 1–2: per-provider override (env > config). Validated by resolveApiBaseUrl.
	// Sentinel default lets us tell "override present" from "use default".
	const SENTINEL = "";
	const override = resolveApiBaseUrl({
		configKey: ep.configKey,
		configuredValue: loadRawConfig()[ep.configKey],
		defaultValue: SENTINEL,
		environmentKey: ep.env,
		environmentValue: process.env[ep.env],
	});
	if (override !== SENTINEL) {
		const url = ep.kind === "full" && ep.overrideSuffix ? `${override}${ep.overrideSuffix}` : override;
		// An explicit override equal to the default is not an override (Exa MCP rule).
		if (url === ep.default) return { url, source: "default", overridden: false };
		return { url, source: "override", overridden: true };
	}

	// 3: unified proxy (validated inside proxyBaseUrl; may throw).
	if (ep.proxyPath) {
		const base = proxyBaseUrl();
		if (base !== null) return { url: `${base}${ep.proxyPath}`, source: "proxy", overridden: true };
	}

	// 4: default
	return { url: ep.default, source: "default", overridden: false };
}

/** Convenience: just the resolved URL for a provider. */
export function providerUrl(provider: SearchProviderId): string {
	return resolveProviderEndpoint(provider).url;
}

/** True when two URLs share the same parsed origin (scheme+host+port). */
function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

/**
 * Does this provider's request go to the unified proxy origin?
 * NEVER throws: an invalid proxy/override URL means "not proxied" here, and
 * the real fetch path surfaces the descriptive error. This keeps a single bad
 * URL from aborting the whole auto-search chain at the availability step.
 */
export function isProxiedDestination(provider: SearchProviderId): boolean {
	try {
		const base = proxyBaseUrl();
		if (base === null) return false;
		return sameOrigin(resolveProviderEndpoint(provider).url, base);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// credentials (destination-first)
// ---------------------------------------------------------------------------

/** Per-provider credential inputs; `provider` label is derived from the registry. */
export type ProviderCredentialOptions = Omit<CredentialOptions, "provider">;

function withLabel(provider: SearchProviderId, opts: ProviderCredentialOptions): CredentialOptions {
	return { ...opts, provider: PROVIDER_ENDPOINTS[provider].label };
}

/**
 * Resolve the API key for a provider request (async: honours `$ENV` / `!cmd`
 * sources via credential-source.ts).
 *   proxied destination → shared proxy key, or null (UNAVAILABLE — never a personal key)
 *   otherwise           → upstream resolveCredential(opts)
 */
export async function resolveProviderKey(
	provider: SearchProviderId,
	opts: ProviderCredentialOptions,
): Promise<string | null> {
	if (isProxiedDestination(provider)) return proxyApiKey();
	return resolveCredential(withLabel(provider, opts));
}

/**
 * Cheap availability check mirroring `resolveProviderKey` without running
 * `!cmd` sources or throwing.
 */
export function providerHasCredential(
	provider: SearchProviderId,
	opts: ProviderCredentialOptions,
): boolean {
	if (isProxiedDestination(provider)) return proxyApiKey() !== null;
	return hasCredentialSource(withLabel(provider, opts));
}
