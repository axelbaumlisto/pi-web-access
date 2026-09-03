import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import { redactCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";
import { providerHasCredential, providerUrl, resolveProviderKey } from "./provider-endpoints.ts";
import { redactError, redactProviderError } from "./redact.ts";

// Endpoint override lives in provider-endpoints.ts (env > config > default).
// The value is the FULL chat/completions URL, so it can front a proxy that
// injects a pooled Perplexity key (our airpx proxy passes choices+citations
// through verbatim).
const getPerplexityUrl = () => providerUrl("perplexity");
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
	// Destination-first (provider-endpoints.ts): proxied → shared proxy key or
	// unavailable; otherwise upstream credential sources ($ENV / !cmd / literal).
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

/** Hard ceiling on kept citations, matching the `numResults` clamp. */
const MAX_CITATIONS = 20;

/**
 * How many citations to keep.
 *
 * Perplexity's citations are the answer's footnotes, not a result list: sonar
 * numbers its `[n]` markers against the full array, so cutting the array to
 * `numResults` leaves the prose referencing sources that were dropped. Keep
 * every citation the answer actually cites, and let `numResults` govern only
 * the unreferenced remainder.
 */
function citationsToKeep(answer: string, available: number, numResults: number): number {
	let highestCited = 0;
	for (const match of answer.matchAll(/\[(\d{1,3})\]/g)) {
		const index = Number(match[1]);
		if (Number.isFinite(index) && index > highestCited) highestCited = index;
	}
	return Math.min(available, MAX_CITATIONS, Math.max(numResults, highestCited));
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	const apiKey = await getApiKey(options.signal);
	const numResults = typeof options.numResults === "number" && Number.isFinite(options.numResults)
		? Math.max(1, Math.min(Math.floor(options.numResults), 20))
		: 5;

	const requestBody: Record<string, unknown> = {
		model: "sonar",
		messages: [{ role: "user", content: query }],
		max_tokens: 1024,
		return_related_questions: false,
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

	let response: Response;
	try {
		// Redirect credential stripping (the endpoint may be a gateway under proxy mode).
		response = await fetchWithCredentialRedirects(getPerplexityUrl(), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
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

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactProviderError(await response.text(), apiKey);
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	let data: Record<string, unknown>;
	try {
		data = await response.json();
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${redactError(message)}`);
	}

	const answer = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || "";
	const citations = Array.isArray(data.citations) ? data.citations : [];

	const results: SearchResult[] = [];
	const citationCount = citationsToKeep(answer, citations.length, numResults);
	for (let i = 0; i < citationCount; i++) {
		const citation = citations[i];
		if (typeof citation === "string") {
			results.push({ title: `Source ${i + 1}`, url: citation, snippet: "" });
		} else if (citation && typeof citation === "object" && typeof citation.url === "string") {
			results.push({
				title: citation.title || `Source ${i + 1}`,
				url: citation.url,
				snippet: "",
			});
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer, results };
}
