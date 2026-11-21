/**
 * Dev smoke test for the roles extension.
 *
 * Loads extensions/roles/index.ts against a mock ExtensionAPI and asserts the
 * prompt effects of both prompt modes. Runs against the real roles.json.
 *
 *   node roles/_smoke.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PKG = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "extensions", "roles", "index.ts");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": `${PKG}/dist/index.js`,
		"@earendil-works/pi-tui": `${PKG}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
});
const mod = await jiti.import(EXTENSION, { default: true });

const handlers = {};
const cmds = {};
const shortcuts = [];
let activeTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];

const pi = {
	on: (e, h) => ((handlers[e] ||= []).push(h)),
	registerCommand: (n, o) => (cmds[n] = o),
	registerShortcut: (k) => shortcuts.push(k),
	registerTool: () => {},
	appendEntry: (t, d) => console.log("appendEntry", t, JSON.stringify(d)),
	getAllTools: () =>
		["read", "write", "edit", "bash", "grep", "find", "ls", "mcp_browser_action"].map((name) => ({
			name,
		})),
	getActiveTools: () => activeTools,
	setActiveTools: (n) => {
		activeTools = n;
	},
	setModel: async (m) => {
		console.log("setModel:", `${m.provider}/${m.id}`);
		return true;
	},
	setThinkingLevel: (l) => console.log("setThinkingLevel:", l),
	registerFlag: (n, o) => console.log("registerFlag:", n, JSON.stringify(o)),
	getFlag: (n) => (n === "role" ? process.env.SMOKE_ROLE_FLAG : undefined),
};

mod(pi);

const theme = { fg: (_c, t) => t };
const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	isProjectTrusted: () => false,
	isIdle: () => true,
	ui: {
		notify: (m, t) => console.log(`notify[${t ?? "info"}] ${m}`),
		setStatus: (k, v) => console.log("status:", k, v),
		select: async (_t, o) => o[1],
		theme,
	},
	sessionManager: { getBranch: () => [] },
	modelRegistry: { find: (p, i) => ({ provider: p, id: i }), getAvailable: () => [] },
};

/** A fresh structured-options object, as pi hands it to before_agent_start. */
function freshOptions() {
	return {
		customPrompt: undefined,
		forceSystemPrompt: undefined,
		selectedTools: ["read", "write", "edit"],
		hiddenTools: [],
		toolSnippets: { read: "read a file" },
		toolGuidelines: {},
		promptGuidelines: [],
		appendSystemPrompt: "USER APPENDED TEXT",
		sections: { subagents: "none" },
		cwd: process.cwd(),
		contextFiles: [{ path: "/x/AGENTS.md", content: "ctx" }],
		skills: [
			{ name: "obsidian", description: "d" },
			{ name: "jira", description: "d" },
		],
	};
}

const BASE_PROMPT = "You are pi.\n\n<available_skills>\n</available_skills>";

/** Fire before_agent_start and report what the handler did. */
async function fire() {
	const options = freshOptions();
	let result;
	for (const h of handlers.before_agent_start ?? []) {
		result = await h({ systemPrompt: BASE_PROMPT, systemPromptOptions: options }, ctx);
	}
	return { result, options };
}

function report(label, { result, options }) {
	console.log(`\n--- ${label}`);
	console.log("   returned systemPrompt:", result?.systemPrompt === undefined ? "(none — options mutated)" : "SET");
	console.log("   customPrompt:", JSON.stringify(options.customPrompt)?.slice(0, 90));
	console.log("   appendSystemPrompt:", JSON.stringify(options.appendSystemPrompt)?.slice(0, 90));
	console.log("   sections:", Object.keys(options.sections ?? {}).join(",") || "(cleared)");
	console.log("   skills:", (options.skills ?? []).map((s) => s.name).join(",") || "(cleared)");
	console.log("   contextFiles:", (options.contextFiles ?? []).length);
	console.log("   activeTools:", activeTools.join(","));
	return { result, options };
}

let failures = 0;
const expect = (label, cond, detail) => {
	if (!cond) {
		failures++;
		console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		console.log(`   ok   ${label}`);
	}
};

for (const h of handlers.session_start ?? []) await h({ reason: "startup" }, ctx);

// ---- replace mode: the role text must be the whole prompt
console.log("\n=== replace mode (work)");
await cmds.role.handler("work", ctx);
{
	const r = report("work", await fire());
	expect("no forced systemPrompt returned", r.result?.systemPrompt === undefined);
	expect("customPrompt carries the role text", /You are a developer/.test(r.options.customPrompt ?? ""));
	expect("appendSystemPrompt cleared", r.options.appendSystemPrompt === "");
	expect("skills cleared", (r.options.skills ?? []).length === 0);
	expect("contextFiles cleared", (r.options.contextFiles ?? []).length === 0);
	expect("custom sections cleared", Object.keys(r.options.sections ?? {}).length === 0);
}

// ---- append mode: base prompt survives, role lands in appendSystemPrompt
console.log("\n=== append mode (architect)");
await cmds.role.handler("architect", ctx);
{
	const r = report("architect", await fire());
	expect("no forced systemPrompt returned", r.result?.systemPrompt === undefined);
	expect("customPrompt untouched", r.options.customPrompt === undefined);
	expect(
		"role text appended after existing append text",
		(r.options.appendSystemPrompt ?? "").startsWith("USER APPENDED TEXT\n\n# Active role: architect"),
	);
	expect("skills filtered to role allowlist", !(r.options.skills ?? []).some((s) => s.name === "jira"));
}

// ---- fallback: no structured options (older pi) keeps the forced-prompt path
console.log("\n=== fallback: no systemPromptOptions");
{
	let result;
	for (const h of handlers.before_agent_start ?? []) {
		result = await h({ systemPrompt: BASE_PROMPT }, ctx);
	}
	console.log("   returned systemPrompt:", result?.systemPrompt ? "SET (fallback)" : "(none)");
	expect("falls back to returning systemPrompt", typeof result?.systemPrompt === "string");
}

// ---- /role none restores the startup tool set
console.log("\n=== /role none");
await cmds.role.handler("none", ctx);
expect("tools restored", activeTools.length === 7, activeTools.join(","));

console.log("\nshortcuts:", shortcuts.join(" ") || "(none)");
console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
