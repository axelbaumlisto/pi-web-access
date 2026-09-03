# Security Policy

Please report suspected vulnerabilities through GitHub private vulnerability reporting for this repository. Do not post exploit details, secrets, or proof-of-concept payloads in public issues or pull requests.

If private vulnerability reporting is unavailable for your account or this repository, open a minimal public issue asking for a private contact path without including technical details.

## Fork notes (pi-ext-int-search)

**Unified proxy mode** (`proxyBaseUrl` / `proxyApiKey`): credentials are bound to the resolved destination. A gateway
destination without a configured `proxyApiKey` makes the provider unavailable; it never falls back to a personal key.
See README → "Unified proxy mode (fork)". Hermetic regression tests: `test/provider-endpoints.test.mjs`,
`test/proxy-key-binding.test.mjs`.

**Transport `proxy` (inherited from upstream) — known limitations, not fork-introduced:**

- The `proxy` value accepted as a *tool parameter* is model-controlled and is not checked against the SSRF guard: the
  target URL is validated, the proxy host is not. A prompt-injected `proxy: "http://169.254.169.254"` makes `curl` open a
  connection to that host. Prefer setting `proxy` in `web-search.json` on shared or agentic hosts, or gate the tool
  parameter behind config in a hardened deployment.
- `curl` receives request headers, including `Authorization`, on its command line (`-H`), which is visible to other local
  users via `ps` for the lifetime of the request.

Both are tracked as follow-ups; report new findings through the channel above.
