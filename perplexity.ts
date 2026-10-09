import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import { redactCredential } from "./credential-source.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";
import { perplexitySearchUrl, providerHasCredential, providerUrl, resolveProviderKey } from "./provider-endpoints.ts";
import { redactError, redactProviderError } from "./redact.ts";

// Endpoints come from provider-endpoints (env > config > default) so unified
// proxy mode keeps working.
const chatUrl = () => providerUrl("perplexity");
const CONFIG_PATH = getWebSearchConfigPath();

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

interface WebSearchConfig {
	perplexityApiKey?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const content = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(content) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveProviderKey("perplexity", {
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
		signal,
	});
	if (!key) {
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

export function isPerplexityAvailable(): boolean {
	return providerHasCredential("perplexity", {
		configuredValue: loadConfig().perplexityApiKey,
		environmentValue: process.env.PERPLEXITY_API_KEY,
	});
}

interface PerplexityRequestOptions {
	activityQuery: string;
	signal?: AbortSignal;
}

async function postPerplexity(
	url: string,
	body: Record<string, unknown>,
	options: PerplexityRequestOptions,
): Promise<Record<string, unknown>> {
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query: options.activityQuery });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	const apiKey = await getApiKey(options.signal);

	let response: Response;
	try {
		response = await fetchWithCredentialRedirects(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			// Fork: every request carries its own 30s deadline. Without it a
			// stalled gateway holds the search for the rest of the turn.
			signal: AbortSignal.any([
				AbortSignal.timeout(30000),
				...(options.signal ? [options.signal] : []),
			]),
		}, ["Authorization"]);
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

	activityMonitor.logComplete(activityId, response.status);

	if (!response.ok) {
		const errorText = redactProviderError(await response.text(), apiKey);
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	try {
		return await response.json();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${redactError(message)}`);
	}
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const numResults = typeof options.numResults === "number" && Number.isFinite(options.numResults)
		? Math.max(1, Math.min(Math.floor(options.numResults), 20))
		: 5;

	const requestBody: Record<string, unknown> = {
		query,
		max_results: numResults,
		search_type: "fast",
		search_context_size: "medium",
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	const data = await postPerplexity(perplexitySearchUrl(), requestBody, { activityQuery: query, signal: options.signal });

	const results: SearchResult[] = [];
	for (const entry of Array.isArray(data.results) ? data.results : []) {
		if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || !entry.url) continue;
		results.push({
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `Source ${results.length + 1}`,
			url: entry.url,
			snippet: typeof entry.snippet === "string" ? entry.snippet.trim() : "",
		});
		if (results.length >= numResults) break;
	}

	return { answer: formatSearchResultsAsAnswer(results), results };
}

/** Asks Sonar for a prose answer. The Search API returns only ranked pages, so prompts that need prose use this. */
export async function askPerplexity(prompt: string, options: { signal?: AbortSignal } = {}): Promise<string> {
	const data = await postPerplexity(chatUrl(), {
		model: "sonar",
		messages: [{ role: "user", content: prompt }],
		max_tokens: 1024,
		return_related_questions: false,
	}, { activityQuery: prompt, signal: options.signal });

	const content = (data.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
	return typeof content === "string" ? content : "";
}
