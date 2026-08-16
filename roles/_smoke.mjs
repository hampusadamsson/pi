import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PKG = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": `${PKG}/dist/index.js`,
		"@earendil-works/pi-tui": `${PKG}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
});
const mod = await jiti.import("/Users/hampus.adamsson/.pi/agent/extensions/roles/index.ts", { default: true });

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
	getAllTools: () => ["read", "write", "edit", "bash", "grep", "find", "ls", "mcp_browser_action"].map((name) => ({ name })),
	getActiveTools: () => activeTools,
	setActiveTools: (n) => {
		activeTools = n;
		console.log("setActiveTools:", n.join(","));
	},
	setModel: async (m) => {
		console.log("setModel:", `${m.provider}/${m.id}`);
		return true;
	},
	setThinkingLevel: (l) => console.log("setThinkingLevel:", l),
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

for (const h of handlers.session_start ?? []) await h({ reason: "startup" }, ctx);

console.log("\n--- switch to architect");
await cmds.role.handler("architect", ctx);
console.log("completions(a):", JSON.stringify(cmds.role.getArgumentCompletions("a")));

const prompt = [
	"You are pi.",
	"",
	"Guidelines:",
	"- x",
	"",
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"",
	"<available_skills>",
	"  <skill>",
	"    <name>architecture-review</name>",
	"    <description>d</description>",
	"    <location>/a/SKILL.md</location>",
	"  </skill>",
	"  <skill>",
	"    <name>testing</name>",
	"    <description>d</description>",
	"    <location>/t/SKILL.md</location>",
	"  </skill>",
	"</available_skills>",
].join("\n");

for (const h of handlers.before_agent_start ?? []) {
	const r = await h({ systemPrompt: prompt }, ctx);
	console.log("\n--- prompt out ---\n" + (r?.systemPrompt ?? "(unchanged)"));
}

console.log("\n--- switch to reviewer (systemPromptFile + skills: [])");
await cmds.role.handler("reviewer", ctx);
for (const h of handlers.before_agent_start ?? []) {
	const r = await h({ systemPrompt: prompt }, ctx);
	console.log("\n--- prompt out ---\n" + (r?.systemPrompt ?? "(unchanged)"));
}

console.log("\nshortcuts:", shortcuts.join(" "));
console.log("\n--- role none");
await cmds.role.handler("none", ctx);
