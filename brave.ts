import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { BraveRateLimitCoordinator } from "./brave-rate-limit.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import type { SearchOptions, SearchResult, SearchResponse } from "./perplexity.ts";
import { redactCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";
import { providerHasCredential, providerUrl, resolveProviderKey } from "./provider-endpoints.ts";
import { redactError, redactProviderError } from "./redact.ts";
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const braveRateLimit = new BraveRateLimitCoordinator();

interface WebSearchConfig {
	braveApiKey?: unknown;
	braveBaseUrl?: unknown;
}

// Fork: Brave returns HTML in titles/snippets; strip tags and decode entities.
function stripHtml(s: string): string {
	const namedEntities: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": "\"",
		"&#39;": "'",
		"&#x27;": "'",
		"&nbsp;": " ",
	};

	return s
		.replace(/<[^>]+>/g, "")
		.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);|&#\d+;|&#x[0-9a-f]+;/gi, (entity) => {
			const named = namedEntities[entity.toLowerCase()];
			if (named !== undefined) return named;

			const radix = entity.slice(0, 3).toLowerCase() === "&#x" ? 16 : 10;
			const value = Number.parseInt(entity.slice(radix === 16 ? 3 : 2, -1), radix);
			try {
				return String.fromCodePoint(value);
			} catch {
				return entity;
			}
		})
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	// Destination-first (provider-endpoints.ts): proxied → shared proxy key or
	// unavailable; otherwise upstream credential sources ($ENV / !cmd / literal).
	return resolveProviderKey("brave", {
		configuredValue: loadConfig().braveApiKey,
		environmentValue: process.env.BRAVE_API_KEY,
		signal,
	});
}

// kind:"full" — provider-endpoints.ts returns the complete search endpoint in
// every mode (default, `braveBaseUrl` base + /web/search, or the gateway's
// /v1/brave/search route under proxy); only query params are appended here.
function getApiUrl(): string {
	return providerUrl("brave");
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	if (!domainFilter?.length) return filters;

	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}

	return filters;
}

function buildBraveQuery(query: string, domainFilter: string[] | undefined): string {
	const filters = normalizeDomainFilters(domainFilter);
	const parts = [query];

	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map(domain => `site:${domain}`).join(" OR "));
	}

	for (const domain of filters.blocked) {
		parts.push(`NOT site:${domain}`);
	}

	return parts.join(" ");
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;

	let hostname = "";
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}

	if (filters.allowed.length > 0 && !filters.allowed.some(domain => hostMatchesDomain(hostname, domain))) {
		return false;
	}

	return !filters.blocked.some(domain => hostMatchesDomain(hostname, domain));
}

export function isBraveAvailable(): boolean {
	return providerHasCredential("brave", {
		configuredValue: loadConfig().braveApiKey,
		environmentValue: process.env.BRAVE_API_KEY,
	});
}

export async function searchWithBrave(
	query: string,
	options: SearchOptions = {},
): Promise<SearchResponse> {
	const apiUrl = getApiUrl();
	const apiKey = await getApiKey(options.signal);
	if (!apiKey) {
		throw new Error(
			"Brave Search API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "braveApiKey": "your-key" }\n` +
			"  2. Set BRAVE_API_KEY environment variable\n" +
			"Get a key at https://brave.com/search/api/",
		);
	}

	const numResults = normalizeSearchResultCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildBraveQuery(query, options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });
	const params = new URLSearchParams({
		q: searchQuery,
		count: String(options.domainFilter?.length ? 20 : numResults),
	});

	if (options.recencyFilter) {
		const freshnessMap: Record<string, string> = {
			day: "pd",
			week: "pw",
			month: "pm",
			year: "py",
		};
		const freshness = freshnessMap[options.recencyFilter];
		if (freshness) params.set("freshness", freshness);
	}

	try {
		const searchDeadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		const searchSignal = options.signal
			? AbortSignal.any([searchDeadline, options.signal])
			: searchDeadline;
		const response = await braveRateLimit.run(async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				const current = await fetchWithCredentialRedirects(`${apiUrl}?${params.toString()}`, {
					method: "GET",
					headers: {
						"X-Subscription-Token": apiKey,
						"Accept": "application/json",
						"Accept-Encoding": "gzip",
					},
					signal: searchSignal,
				}, ["X-Subscription-Token"]);

				braveRateLimit.observe(current.headers);
				if (current.status !== 429 || attempt === 1) return current;
				const retryDelay = braveRateLimit.retryDelay(current.headers);
				if (retryDelay === null) return current;
				braveRateLimit.recordRetryDelay(retryDelay);
				await current.body?.cancel().catch(() => undefined);
				await braveRateLimit.waitForRecordedCooldown(searchSignal);
			}
			throw new Error("Brave Search retry loop exited unexpectedly");
		}, searchSignal);

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactProviderError(await response.text(), apiKey);
			throw new Error(`Brave Search API error ${response.status}: ${errorText}`);
		}

		let data: {
			web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
		};
		try {
			data = await response.json() as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Brave Search API returned invalid JSON: ${redactError(message)}`);
		}
		activityMonitor.logComplete(activityId, response.status);

		const results: SearchResult[] = [];
		for (const item of data.web?.results ?? []) {
			if (!item.url || !matchesDomainFilters(item.url, domainFilters)) continue;
			results.push({
				title: stripHtml(item.title || "") || item.url,
				url: item.url,
				snippet: stripHtml(item.description || ""),
			});
			if (results.length >= numResults) break;
		}

		const answer = results
			.map((result) => {
				if (result.snippet) return `${result.snippet}\nSource: ${result.title} (${result.url})`;
				return `Source: ${result.title} (${result.url})`;
			})
			.join("\n\n");

		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
