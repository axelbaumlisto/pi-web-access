import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { getApiKey, getVersionedApiBase, fetchGeminiApi, isGatewayConfigured, isGeminiApiAvailable, redactGeminiApiResponse } from "./gemini-api.ts";
import { getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import { isParallelAvailable, searchWithParallel } from "./parallel.ts";
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
import { getWebSearchConfigPath } from "./utils.ts";
import { validateRemoteUrl } from "./ssrf-protection.ts";

export type SearchProvider = "auto" | "openai" | "brave" | "parallel" | "tavily" | "searxng" | "perplexity" | "gemini" | "exa" | "serpdive" | "anysearch";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;
export type SearchProviderErrorKind =
	| "transient"
	| "quota"
	| "network"
	| "credential"
	| "config"
	| "auth"
	| "invalid-request"
	| "invalid-response"
	| "aborted"
	| "unknown";

export interface SearchRoutingConfig {
	providers: ResolvedSearchProvider[];
	fallbackOn: Array<Extract<SearchProviderErrorKind, "transient" | "quota" | "network">>;
}

export class SearchProviderError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly kind: SearchProviderErrorKind;
	readonly status?: number;
	readonly causeError: unknown;

	constructor(
		provider: ResolvedSearchProvider,
		kind: SearchProviderErrorKind,
		message: string,
		status: number | undefined,
		cause: unknown,
	) {
		super(`${provider} search failed (${kind}): ${message}`);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.kind = kind;
		this.status = status;
		this.causeError = cause;
	}
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = getWebSearchConfigPath();
const DEFAULT_SEARCH_MODEL = "gemini-2.5-flash";
const VALID_SEARCH_PROVIDERS: SearchProvider[] = ["auto", "openai", "brave", "parallel", "tavily", "searxng", "perplexity", "gemini", "exa", "serpdive", "anysearch"];
const VALID_ROUTING_KINDS = ["transient", "quota", "network"] as const;

type SearchConfig = {
	searchProvider: SearchProvider;
	searchProviderConfigured: boolean;
	searchRouting?: SearchRoutingConfig;
	searchModel?: string;
};

let cachedSearchConfig: SearchConfig | null = null;

function getSearchConfig(): SearchConfig {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto", searchProviderConfigured: false };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		raw = parsed as Record<string, unknown>;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const searchModel = normalizeSearchModel(raw.searchModel);
	const searchProviderConfigured = Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
	cachedSearchConfig = {
		searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider),
		searchProviderConfigured,
		...(Object.hasOwn(raw, "searchRouting") ? { searchRouting: normalizeSearchRouting(raw.searchRouting) } : {}),
		...(searchModel ? { searchModel } : {}),
	};
	return cachedSearchConfig;
}

function normalizeSearchRouting(value: unknown): SearchRoutingConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
		throw new Error(`searchRouting.providers in ${CONFIG_PATH} must be a non-empty array`);
	}
	const providers: ResolvedSearchProvider[] = [];
	for (const provider of raw.providers) {
		const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : "";
		if (!VALID_SEARCH_PROVIDERS.includes(normalized as SearchProvider) || normalized === "auto") {
			throw new Error(`searchRouting.providers in ${CONFIG_PATH} contains an invalid provider: ${String(provider)}`);
		}
		if (providers.includes(normalized as ResolvedSearchProvider)) {
			throw new Error(`searchRouting.providers in ${CONFIG_PATH} must not contain duplicates: ${normalized}`);
		}
		providers.push(normalized as ResolvedSearchProvider);
	}
	if (!Array.isArray(raw.fallbackOn) || raw.fallbackOn.length === 0) {
		throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
	}
	const fallbackOn: SearchRoutingConfig["fallbackOn"] = [];
	for (const kind of raw.fallbackOn) {
		if (typeof kind !== "string" || !VALID_ROUTING_KINDS.includes(kind as typeof VALID_ROUTING_KINDS[number])) {
			throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, or network`);
		}
		if (!fallbackOn.includes(kind as SearchRoutingConfig["fallbackOn"][number])) {
			fallbackOn.push(kind as SearchRoutingConfig["fallbackOn"][number]);
		}
	}
	return { providers, fallbackOn };
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
	const config = getSearchConfig();
	return config.searchProviderConfigured ? undefined : config.searchRouting;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return VALID_SEARCH_PROVIDERS.includes(normalized as SearchProvider) ? normalized as SearchProvider : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
	extensionContext?: ExtensionContext;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function shouldTryOpenAIInAuto(options: SearchOptions): boolean {
	if (options.recencyFilter) return false;
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && Math.floor(options.numResults) !== 5) {
		return false;
	}
	return true;
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	strictErrors: boolean,
): Promise<SearchResponse | null> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		if (apiResult) return apiResult;
	} catch (err) {
		if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
		errors.push(`Gemini API: ${errorMessage(err)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		if (webResult) return webResult;
		const diagnostic = getGeminiWebAvailabilityDiagnostic();
		if (diagnostic) errors.push(`Gemini Web: ${diagnostic}`);
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini Web: ${errorMessage(err)}`);
	}

	if (strictErrors && errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	return null;
}

/** A provider response with neither a synthesized answer nor any source. */
function isEmptyResponse(r: SearchResponse): boolean {
	return (!r.results || r.results.length === 0) && !r.answer?.trim();
}

function providerErrorStatus(message: string): number | undefined {
	const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
	if (!match) return undefined;
	return Number(match[1]);
}

function classifyProviderError(provider: ResolvedSearchProvider, err: unknown): SearchProviderError {
	if (err instanceof SearchProviderError) return err;
	const message = errorMessage(err);
	const lower = message.toLowerCase();
	const status = providerErrorStatus(message);
	let kind: SearchProviderErrorKind = "unknown";
	if (err instanceof CredentialResolutionError || /(?:api )?key (?:not found|missing)|credential resolution/.test(lower)) {
		kind = "credential";
	} else if (isAbortError(err)) {
		kind = "aborted";
	} else if (status === 401 || status === 403) {
		kind = "auth";
	} else if (status === 400 || status === 422) {
		kind = "invalid-request";
	} else if (status === 402 || status === 429) {
		kind = "quota";
	} else if (status !== undefined && (status === 408 || status === 425 || status >= 500)) {
		kind = "transient";
	} else if (/rate limit|quota|too many requests/.test(lower)) {
		kind = "quota";
	} else if (/unauthorized|forbidden|permission denied/.test(lower)) {
		kind = "auth";
	} else if (/bad request|invalid request/.test(lower)) {
		kind = "invalid-request";
	} else if (/invalid json|no parseable response|returned invalid response|returned empty response/.test(lower)) {
		kind = "invalid-response";
	} else if (/temporar|service unavailable|server error/.test(lower)) {
		kind = "transient";
	} else if (err instanceof TypeError || /fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(lower)) {
		kind = "network";
	} else if (/invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(lower)) {
		kind = "config";
	}
	return new SearchProviderError(provider, kind, message, status, err);
}

async function searchWithResolvedProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Promise<AttributedSearchResponse> {
	if (provider === "openai") {
		const result = await searchWithOpenAI(query, options, options.extensionContext);
		return { ...result, provider };
	}
	if (provider === "brave") return { ...(await searchWithBrave(query, options)), provider };
	if (provider === "parallel") return { ...(await searchWithParallel(query, options)), provider };
	if (provider === "tavily") return { ...(await searchWithTavily(query, options)), provider };
	if (provider === "serpdive") return { ...(await searchWithSerpdive(query, options)), provider };
	if (provider === "anysearch") return { ...(await searchWithAnySearch(query, options)), provider };
	if (provider === "perplexity") return { ...(await searchWithPerplexity(query, options)), provider };
	if (provider === "searxng") return { ...(await searchWithSearXNG(query, options)), provider };
	if (provider === "gemini") {
		const result = await searchWithGemini(query, options, true);
		if (result) return { ...result, provider };
		throw new Error(
			"Gemini search unavailable. Either:\n" +
			`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
			"  3. Sign into gemini.google.com in a supported Chromium-based browser",
		);
	}
	const result = await searchWithExa(query, options);
	if (result) return { ...result, provider };
	throw new Error("Exa search returned no results.");
}

async function isResolvedProviderAvailable(provider: ResolvedSearchProvider, options: FullSearchOptions): Promise<boolean> {
	if (provider === "openai") return isOpenAISearchAvailable(options.extensionContext);
	if (provider === "brave") return isBraveAvailable();
	if (provider === "parallel") return isParallelAvailable();
	if (provider === "tavily") return isTavilyAvailable();
	if (provider === "serpdive") return isSerpdiveAvailable();
	if (provider === "anysearch") return isAnySearchAvailable();
	if (provider === "perplexity") return isPerplexityAvailable();
	if (provider === "searxng") return isSearXNGAvailable();
	if (provider === "gemini") return isGeminiApiAvailable() || !!(await isGeminiWebAvailable());
	return isExaAvailable();
}

async function searchWithConfiguredRouting(
	query: string,
	options: FullSearchOptions,
	routing: SearchRoutingConfig,
): Promise<AttributedSearchResponse> {
	const diagnostics: string[] = [];
	for (const provider of routing.providers) {
		if (!(await isResolvedProviderAvailable(provider, options))) {
			diagnostics.push(`${provider}: unavailable`);
			continue;
		}
		try {
			return await searchWithResolvedProvider(provider, query, options);
		} catch (err) {
			const classified = classifyProviderError(provider, err);
			diagnostics.push(`${provider} [${classified.kind}]: ${errorMessage(err)}`);
			if (!routing.fallbackOn.includes(classified.kind as SearchRoutingConfig["fallbackOn"][number])) {
				throw classified;
			}
		}
	}
	throw new Error(`Configured search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`);
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider === undefined || options.provider === "auto"
		? config.searchProvider
		: options.provider;
	if (provider !== "auto") return searchWithResolvedProvider(provider, query, options);
	if (!config.searchProviderConfigured && config.searchRouting) {
		return searchWithConfiguredRouting(query, options, config.searchRouting);
	}

	const fallbackErrors: string[] = [];
	// product#4/#5: in AUTO mode a provider that returns HTTP 200 with an EMPTY
	// result (no answer, no sources) must NOT stop the chain — keep falling
	// through to the next provider. The last empty response is retained so a
	// genuinely empty web (all providers empty) still returns something rather
	// than throwing. Explicit-provider mode above is intentionally strict and
	// unchanged.
	let lastEmpty: AttributedSearchResponse | undefined;
	const takeAuto = (
		result: SearchResponse | null | undefined,
		name: ResolvedSearchProvider,
	): AttributedSearchResponse | undefined => {
		if (!result) return undefined;
		const attributed = { ...result, provider: name };
		if (isEmptyResponse(result)) {
			lastEmpty = attributed;
			fallbackErrors.push(`${name}: empty result`);
			return undefined;
		}
		return attributed;
	};

	if (isSearXNGAvailable()) {
		try {
			const hit = takeAuto(await searchWithSearXNG(query, options), "searxng");
			if (hit) return hit;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`SearXNG: ${errorMessage(err)}`);
		}
	}

	if (shouldTryOpenAIInAuto(options)) {
		try {
			if (await isOpenAISearchAvailable(options.extensionContext)) {
				const hit = takeAuto(await searchWithOpenAI(query, options, options.extensionContext), "openai");
				if (hit) return hit;
			}
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`OpenAI: ${errorMessage(err)}`);
		}
	}

	if (isExaAvailable()) {
		try {
			const hit = takeAuto(await searchWithExa(query, options), "exa");
			if (hit) return hit;
		} catch (err) {
			if (err instanceof CredentialResolutionError || isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (isBraveAvailable()) {
		try {
			const hit = takeAuto(await searchWithBrave(query, options), "brave");
			if (hit) return hit;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Brave: ${errorMessage(err)}`);
		}
	}

	if (isParallelAvailable()) {
		try {
			const hit = takeAuto(await searchWithParallel(query, options), "parallel");
			if (hit) return hit;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Parallel: ${errorMessage(err)}`);
		}
	}

	if (isTavilyAvailable()) {
		try {
			const hit = takeAuto(await searchWithTavily(query, options), "tavily");
			if (hit) return hit;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Tavily: ${errorMessage(err)}`);
		}
	}

	if (isSerpdiveAvailable()) {
		try {
			const hit = takeAuto(await searchWithSerpdive(query, options), "serpdive");
			if (hit) return hit;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`SERPdive: ${errorMessage(err)}`);
		}
	}

	if (isPerplexityAvailable()) {
		try {
			const hit = takeAuto(await searchWithPerplexity(query, options), "perplexity");
			if (hit) return hit;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Perplexity: ${errorMessage(err)}`);
		}
	}

	try {
		const hit = takeAuto(await searchWithGemini(query, options, false), "gemini");
		if (hit) return hit;
	} catch (err) {
		if (isAbortError(err)) throw err;
		fallbackErrors.push(`Gemini: ${errorMessage(err)}`);
	}

	// All available providers returned empty (but none errored fatally) — return
	// the last empty response rather than throwing, so the caller gets an honest
	// "no results" from a real provider instead of an error.
	if (lastEmpty) return lastEmpty;

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		"  1. Use /login to sign in with a Codex subscription for OpenAI web search\n" +
		`  2. Set openaiApiKey, braveApiKey, parallelApiKey, tavilyApiKey, serpdiveApiKey, searxngBaseUrl, perplexityApiKey, exaApiKey, geminiApiKey, or cloudflareApiKey in ${CONFIG_PATH}\n` +
		"  3. Set OPENAI_API_KEY, BRAVE_API_KEY, PARALLEL_API_KEY, TAVILY_API_KEY, SERPDIVE_API_KEY, SEARXNG_BASE_URL, EXA_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, or CLOUDFLARE_API_KEY env vars\n" +
		"  4. Set GOOGLE_GEMINI_BASE_URL with CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
		"  5. Sign into gemini.google.com in a supported Chromium-based browser\n" +
		"  6. Explicitly select provider: \"anysearch\" for anonymous AnySearch"
	);
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const requestSignal = AbortSignal.any([
		AbortSignal.timeout(60000),
		...(options.signal ? [options.signal] : []),
	]);
	const apiKey = await getApiKey(requestSignal);
	if (!apiKey && !isGatewayConfigured()) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? DEFAULT_SEARCH_MODEL;
		const body = {
			contents: [{ role: "user", parts: [{ text: appendSearchConstraints(query, options) }] }],
			tools: [{ google_search: {} }],
		};

		const res = await fetchGeminiApi(`${getVersionedApiBase()}/models/${model}:generateContent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal,
		}, apiKey);

		if (!res.ok) {
			const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
			throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as GeminiSearchResponse;
		activityMonitor.logComplete(activityId, res.status);

		const answer = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		const metadata = data.candidates?.[0]?.groundingMetadata;
		const resolvedResults = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);
		const uniqueResults = dedupeResultsByUrl(resolvedResults);
		// Cap ONLY when the caller supplies a valid explicit count; otherwise return
		// every unique chunk (preserving the original no-default-cap behavior).
		const cap = normalizeResultCount(options.numResults);
		const results = cap === null ? uniqueResults : uniqueResults.slice(0, cap);

		if (!answer && results.length === 0) return null;
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			model: "gemini-3-flash-preview",
			signal: options.signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function appendSearchConstraints(prompt: string, options: SearchOptions): string {
	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	const prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;
	return appendSearchConstraints(prompt, options);
}

// Public numResults contract: integer 1..20. Anything absent/invalid means
// "no cap" — return all unique chunks.
const MAX_NUM_RESULTS = 20;

function normalizeResultCount(numResults: number | undefined): number | null {
	if (typeof numResults !== "number" || !Number.isFinite(numResults)) return null;
	const count = Math.floor(numResults);
	if (count < 1) return null;
	return Math.min(count, MAX_NUM_RESULTS);
}

function dedupeResultsByUrl(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		if (seen.has(result.url)) return false;
		seen.add(result.url);
		return true;
	});
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		results.push({ title: match[1], url: match[2], snippet: "" });
	}
	return dedupeResultsByUrl(results);
}

const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PATH = "/grounding-api-redirect";

function parseGroundingRedirectUrl(rawUrl: string): URL | null {
	try {
		const url = new URL(rawUrl);
		return url.protocol === "https:" &&
			url.hostname === GROUNDING_REDIRECT_HOST &&
			(url.pathname === GROUNDING_REDIRECT_PATH || url.pathname.startsWith(GROUNDING_REDIRECT_PATH + "/"))
			? url
			: null;
	} catch {
		return null;
	}
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes(GROUNDING_REDIRECT_PATH.slice(1))) {
			const redirectUrl = parseGroundingRedirectUrl(url);
			if (!redirectUrl) continue;
			const resolved = await resolveRedirect(redirectUrl, signal);
			if (!resolved) continue;
			url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: URL, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		const location = res.headers.get("location");
		if (!location) return null;
		const resolved = new URL(location, proxyUrl);
		if (resolved.protocol !== "https:") return null;
		return (await validateRemoteUrl(resolved)).toString();
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}
