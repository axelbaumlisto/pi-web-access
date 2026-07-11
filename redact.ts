// Secret patterns for upstream error bodies. The sk-/AIza prefixes are matched
// from a word boundary with a low length floor so that even a short fragment
// (e.g. the ~10-char body window a JSON.parse SyntaxError echoes back, like
// `sk-proxy-A`) is scrubbed — not just full-length keys. Over-redacting a noisy
// error string is preferred to leaking a credential fragment.
const SECRET_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{2,}/gi,
	/\bAIza[0-9A-Za-z_-]{2,}/gi,
	/\bBearer\s+\S+/gi,
	// password/api_key style secrets, incl. JSON-quoted forms
	// ({"password":"secret"}): optional quote/space around the field name,
	// the `:`/`=` separator, and the value.
	/\b(password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?[^"'\s,}]+/gi,
	// URL/form `key=` param, bounded to start/`?`/`&`/whitespace so it does not
	// fire inside words like `monkey=value`.
	/(?<=^|[?&\s])key=[^&\s]+/gi,
];

// Trailing partial-secret cleanup: when truncation cuts through a recognizable
// credential (e.g. `…Bearer ` or a single-char `sk-A`) below the floors above,
// redact any dangling secret prefix left at the very end.
const TRAILING_PARTIAL = /\b(?:sk-[A-Za-z0-9_-]*|AIza[0-9A-Za-z_-]*|Bearer\s+\S*)$/i;

/**
 * Bound and redact an upstream error body before exposing it to a user.
 * Truncation happens first; when it slices through a secret, the trailing
 * partial is redacted too so no recognizable credential fragment survives.
 */
export function redactError(text: string, max = 300): string {
	const truncated = text.length > max;
	let body = truncated ? text.slice(0, max) : text;
	for (const pattern of SECRET_PATTERNS) {
		body = body.replace(pattern, "[REDACTED]");
	}
	if (truncated) {
		body = body.replace(TRAILING_PARTIAL, "[REDACTED]");
	}
	return truncated ? `${body}…` : body;
}
