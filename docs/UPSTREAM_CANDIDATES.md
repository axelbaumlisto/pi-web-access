# What this fork could give back

The fork is 66 files ahead of `nicobailon/pi-web-access`. Most of that is ours
by definition — `memory_search`, unified proxy mode, destination-first
credential gating — and belongs here. What follows is the rest: changes that fix
something upstream has too, with no trace of this fork's features in them.

Sorted by what upstream gains per line of review.

## 1. An empty provider response must not end the AUTO chain

**Where:** `gemini-search.ts` · ~48 lines · no upstream equivalent (`nonEmptyOrThrow` appears 0 times upstream)

A provider that answers HTTP 200 with neither an answer nor a single source
currently stops AUTO mode. The user gets "no results" while four configured
providers were never asked. `nonEmptyOrThrow` turns such a response into an
`EmptyResultError`, so the provider's own `catch` records it and the loop
continues; the attributed empty response is kept, so if *every* provider comes
back empty the caller still gets an honest answer from a real provider rather
than a synthetic one. Explicit provider, `all`, and routing modes stay strict —
only AUTO falls through, because only AUTO promised to try the next one.

Carries its own test (`test/fallback-empty.test.mjs`): an empty Brave 200
followed by a working Perplexity must produce Perplexity's answer.

## 2. Brave returns HTML inside titles and snippets

**Where:** `brave.ts` · ~35 lines · `stripHtml` appears 0 times upstream

Brave's API puts `<strong>` around matched terms and HTML entities everywhere.
Those reach the model and the UI verbatim, so a result titled
`Node.js &mdash; <strong>fs</strong> module` is what the summary model reads and
what the curator shows. Tags are stripped and the common entities decoded at the
provider boundary, where the quirk belongs. Test: `test/brave-sanitize.test.mjs`.

## 3. Perplexity requests have no deadline of their own

**Where:** `perplexity.ts` · 5 lines · `AbortSignal.timeout` appears 0 times upstream

Every other provider here inherits only the caller's signal. If Perplexity (or
anything fronting it) accepts the connection and then stalls, the search holds
the turn until the agent-level timeout, with no result and no error. A 30-second
`AbortSignal.any` next to the caller's signal bounds it without changing
behaviour on healthy responses.

This one is five lines and would be the easiest to take.

## 4. The summary prompt carries no evidence

**Where:** `summary-review.ts` · ~90 lines, of which the fork-specific part is a `kind` discriminator

Each source reaches the summary model as `title — url`. For providers that
return raw results and no answer text, the model is asked to summarise material
it was never shown, and honestly reports that there is no body text. Snippets
now travel with their source under a split budget: 600 characters per source
and 12 000 per query when there is no answer to lean on, 200 and 3 000 when the
provider already answered — because full snippets overran the 30-second
generation deadline on a fast model and degraded to the deterministic fallback.

Upstream would want the snippet plumbing and the budgets; the `kind`
discriminator (web vs history) is only needed because this fork summarises two
corpora, and can be dropped from the patch.

## Deliberately not offered

- `memory_search` and everything under it (`memory-search.ts`,
  `session-digest.ts`) — a second tool with its own product decisions.
- Unified proxy mode (`provider-endpoints.ts`) and destination-first credential
  gating — these exist because this fork runs behind a gateway; upstream has no
  such concept and would inherit a large surface for one deployment's benefit.
- `redact.ts` — overlaps with upstream's `redactCredential`; the extra URL
  redaction only matters when endpoints are overridden, which is proxy mode
  again.
- `scripts/smoke-fleet.mjs` — assumes this fleet and its SSH names.

## Order to send

1 and 3 are self-contained and testable in isolation. 2 is small but touches
output the curator renders, so it should go on its own. 4 is the largest and
needs the `kind` discriminator stripped first, so it goes last.
