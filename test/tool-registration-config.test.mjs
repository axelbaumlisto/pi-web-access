import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import initializeExtension from "../index.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function runRegistration(config) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-tool-names-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const tools = [];
			initializeExtension({
				registerTool(tool) { tools.push(tool.name); },
				registerCommand() {},
				registerShortcut() {},
				on() {},
			});
			console.log(JSON.stringify(tools));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: "", HOME: join(root, "home"), USERPROFILE: join(root, "home") },
	});
}

function registeredToolNames(config) {
	const child = runRegistration(config);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function registrationError(config) {
	const child = runRegistration(config);
	assert.notEqual(child.status, 0, child.stdout);
	return child.stderr;
}

test("web_search registration is gated by webSearch.enabled", () => {
	assert.match(indexSrc, /webSearch\?: \{\n\t\tenabled\?: boolean;\n\t\};/);
	assert.match(indexSrc, /toolNames\?: Partial<ToolNames>;/);
	assert.match(indexSrc, /if \(initConfig\.webSearch\?\.enabled !== false\) pi\.registerTool\(\{\n\t\tname: toolNames\.webSearch/);
});

test("fetch tools remain registered outside the web_search gate", () => {
	const gateIndex = indexSrc.indexOf("if (initConfig.webSearch?.enabled !== false)");
	const fetchIndex = indexSrc.indexOf("name: toolNames.fetchContent");
	assert.ok(gateIndex >= 0, "web_search gate not found");
	assert.ok(fetchIndex > gateIndex, "fetch_content registration should remain after web_search gate");
	assert.match(indexSrc, /\n\t}\);\n\n\tpi\.registerTool\(\{\n\t\tname: toolNames\.fetchContent/);
});

test("web activity shortcut renders through the supported string-array API", async () => {
	const shortcuts = [];
	initializeExtension({
		registerTool() {},
		registerCommand() {},
		registerShortcut(name, shortcut) { shortcuts.push({ name, shortcut }); },
		on() {},
	});

	const activityShortcut = shortcuts.find(({ shortcut }) => shortcut.description === "Toggle web search activity");
	assert.ok(activityShortcut, "activity shortcut was not registered");
	const widgets = [];
	const ctx = {
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget(key, content) { widgets.push({ key, content }); },
		},
	};

	await activityShortcut.shortcut.handler(ctx);
	assert.equal(widgets[0].key, "web-activity");
	assert.ok(Array.isArray(widgets[0].content), "activity widget content must be a string array");
	assert.ok(widgets[0].content.length > 0);

	await activityShortcut.shortcut.handler(ctx);
});

test("tool names can be configured without changing defaults", () => {
	// Fork: memory_search is always registered (internal search).
	assert.deepEqual(registeredToolNames({}), ["web_search", "source_check", "fetch_content", "memory_search", "get_search_content"]);
	assert.deepEqual(registeredToolNames({
		toolNames: {
			webSearch: "research_web",
			sourceCheck: "verify_sources",
			fetchContent: "grab_content",
			getSearchContent: "open_content",
		},
	}), ["research_web", "verify_sources", "grab_content", "memory_search", "open_content"]);
});

test("tool name config rejects invalid and duplicate registered names", () => {
	assert.match(registrationError({ toolNames: { webSearch: "1bad" } }), /toolNames\.webSearch/);
	assert.match(registrationError({ toolNames: { webSearch: "same_name", fetchContent: "same_name" } }), /duplicates/);
});

test("webSearch.enabled false registers only fetch tools and ignores disabled-name duplicates", () => {
	assert.deepEqual(registeredToolNames({
		webSearch: { enabled: false },
		toolNames: {
			webSearch: "content_only",
			sourceCheck: "content_only",
			fetchContent: "grab_content",
			getSearchContent: "open_content",
		},
	}), ["grab_content", "memory_search", "open_content"]);
	assert.match(registrationError({
		webSearch: { enabled: false },
		toolNames: { fetchContent: "same_name", getSearchContent: "same_name" },
	}), /duplicates/);
});

test("README documents webSearch.enabled and toolNames", () => {
	assert.match(readmeSrc, /"webSearch": \{\n    "enabled": true\n  \}/);
	assert.match(readmeSrc, /webSearch\.enabled` to `false` to unregister the configured search and source-check tools/);
	assert.match(readmeSrc, /`toolNames` can opt into alternate public tool names/);
});
