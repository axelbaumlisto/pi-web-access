/**
 * Test preload (node --import): make EVERY test process hermetic by default.
 *
 * Several modules read `~/.pi/web-search.json` (or `$XDG_CONFIG_HOME/pi/`) at
 * import time and cache the directory. A developer with a real config there
 * (a unified-proxy `proxyBaseUrl`, a `geminiApiKey`, a `provider` default…)
 * would otherwise have provider requests silently rerouted in tests that mock
 * `globalThis.fetch` and assert the vendor origin.
 *
 * Unless a test explicitly sets `PI_CODING_AGENT_DIR` itself (hermetic child
 * processes do), point it at an empty temp dir. Tests that need a config file
 * write one into `process.env.PI_CODING_AGENT_DIR`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-access-test-"));
}
// A real XDG config would also be picked up by utils.getWebSearchConfigDir().
delete process.env.XDG_CONFIG_HOME;
