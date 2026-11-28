/**
 * Smoke test for the subagents extension.
 *
 * Loads the real default export via jiti against a fake ExtensionAPI/ctx,
 * then checks registration, the tool parameter schema, the before_agent_start
 * prompt composition, and one real end-to-end spawn/wait against the `small`
 * role (hence ~15s and a live model call).
 *
 * Mirrors the pattern of the roles harness (jiti + alias map + fake pi/ctx).
 *
 *   node ~/.pi/agent/extensions/subagents/_smoke.mjs
 */

import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PKG = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": `${PKG}/dist/index.js`,
		"@earendil-works/pi-tui": `${PKG}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		"@earendil-works/pi-agent-core": `${PKG}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
		"@earendil-works/pi-ai": `${PKG}/node_modules/@earendil-works/pi-ai/dist/index.js`,
		typebox: `${PKG}/node_modules/typebox/build/index.mjs`,
	},
});

// ---------------------------------------------------------------- results

let passed = 0;
let total = 0;

function check(name, ok, detail) {
	total++;
	if (ok) passed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	return ok;
}

// ---------------------------------------------------------------- fake pi

const handlers = {}; // event -> [handler]
const tools = {}; // name -> tool definition
const cmds = {}; // name -> command definition

const pi = {
	on: (e, h) => ((handlers[e] ||= []).push(h)),
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: (name, opts) => {
		cmds[name] = opts;
	},
	registerFlag: (n) => console.log("registerFlag:", n),
	getFlag: () => undefined,
	sendMessage: (msg, opts) => console.log("sendMessage:", JSON.stringify({ msg, opts }).slice(0, 200)),
	appendEntry: () => {},
	getAllTools: () => [],
	getActiveTools: () => [],
	setActiveTools: () => {},
};

const theme = { fg: (_c, t) => t, bold: (t) => t };
const notes = [];
const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	isProjectTrusted: () => false,
	ui: {
		notify: (m, t) => {
			notes.push(m);
			console.log(`notify[${t ?? "info"}] ${m}`);
		},
		setStatus: (k, v) => console.log("status:", k, v),
		theme,
	},
};

// ---------------------------------------------------------------- load + register

const mod = await jiti.import("/Users/hampus/.pi/agent/extensions/subagents/index.ts", { default: true });
mod(pi);

// session_start loads config and captures currentCtx.
for (const h of handlers.session_start ?? []) await h({ reason: "startup" }, ctx);

console.log("events:", Object.keys(handlers).map((k) => `${k}x${handlers[k].length}`).join(", "));
console.log("tools:", Object.keys(tools).join(", ") || "(none)");
console.log("commands:", Object.keys(cmds).join(", ") || "(none)");

// ---------------------------------------------------------------- (a) registration

const toolNames = Object.keys(tools);
check(
	"(a) registers exactly one tool named `subagents`",
	toolNames.length === 1 && toolNames[0] === "subagents",
	`tools=[${toolNames.join(",")}]`,
);
check("(a) registers a `subagents` command", typeof cmds.subagents?.handler === "function", `typeof=${typeof cmds.subagents?.handler}`);

const tool = tools.subagents;

// ---------------------------------------------------------------- (b) parameter schema

function actionOptions(schema) {
	const node = schema?.properties?.action;
	if (!node) return [];
	if (Array.isArray(node.anyOf)) return node.anyOf.map((n) => n?.const).filter((v) => typeof v === "string");
	if (Array.isArray(node.enum)) return node.enum;
	if (typeof node.const === "string") return [node.const];
	return [];
}

const actions = actionOptions(tool?.parameters);
const wanted = ["spawn", "status", "list", "wait", "stop"];
check(
	"(b) parameters expose spawn/status/list/wait/stop",
	wanted.every((a) => actions.includes(a)),
	`actions=[${actions.join(",")}]`,
);

// ---------------------------------------------------------------- (c) before_agent_start

const event = { systemPrompt: "BASE", systemPromptOptions: { sections: {} } };
let promptResult;
for (const h of handlers.before_agent_start ?? []) {
	const r = await h(event, ctx);
	if (r !== undefined) promptResult = r;
}

// NB: subagents only contributes a section when runs are active. With no runs it
// must return nothing and leave BASE untouched. When it does return, it must
// compose onto event.systemPrompt rather than replacing it.
const outPrompt = promptResult?.systemPrompt ?? event.systemPrompt;
console.log("\n--- before_agent_start ---");
console.log("returned:", promptResult === undefined ? "(undefined)" : JSON.stringify(promptResult).slice(0, 400));
console.log("sections keys (mutated):", JSON.stringify(Object.keys(event.systemPromptOptions.sections)));
check(
	"(c) before_agent_start does not clobber BASE",
	typeof outPrompt === "string" && outPrompt.startsWith("BASE"),
	`prompt starts with BASE: ${String(outPrompt).slice(0, 20)}…`,
);

// ---------------------------------------------------------------- (e) depth guard

// With PI_SUBAGENT_DEPTH = 1 and the default maxDepth of 1, a spawn must be
// refused rather than launching a child. Must run BEFORE the real spawn in (d)
// and the env var must be removed again so (d) is not affected.
console.log("\n--- depth guard ---");
console.log("PI_SUBAGENT_DEPTH =", JSON.stringify(process.env.PI_SUBAGENT_DEPTH ?? null));

process.env.PI_SUBAGENT_DEPTH = "1";
let guardText = "";
let guardIsError;
try {
	const res = await tool.execute(
		"smoke-depth-guard",
		{ action: "spawn", role: "small", task: "should not run" },
		undefined,
		undefined,
		ctx,
	);
	guardText = (res.content ?? []).map((c) => c.text ?? "").join("\n");
	guardIsError = res.isError;
} catch (err) {
	guardText = `threw: ${err instanceof Error ? err.message : String(err)}`;
} finally {
	delete process.env.PI_SUBAGENT_DEPTH;
}
console.log("depth guard result:", JSON.stringify(guardText).slice(0, 300), "| isError:", guardIsError);
check(
	"(e) spawn is refused by the recursion depth guard",
	guardIsError === true && guardText.includes("Recursion depth guard"),
	`isError=${guardIsError} includesGuardText=${guardText.includes("Recursion depth guard")}`,
);

// ---------------------------------------------------------------- (d) real spawn + wait

console.log("\n--- spawn (real model call, ~15s) ---");
let spawnText = "";
let runId;
try {
	const res = await tool.execute("smoke-spawn", { action: "spawn", role: "small", task: "Reply with exactly: OK" }, undefined, undefined, ctx);
	spawnText = (res.content ?? []).map((c) => c.text ?? "").join("\n");
	runId = res.details?.id;
	console.log("spawn:", JSON.stringify(spawnText).slice(0, 300));
	console.log("spawn id:", runId, "| isError:", res.isError);
} catch (err) {
	console.log("spawn threw:", err instanceof Error ? err.message : String(err));
}

if (!runId) {
	check("(d) spawn returns a run id", false, "no id returned");
	check("(d) wait text contains OK", false, "skipped — no run id");
} else {
	check("(d) spawn returns a run id", true, runId);
	console.log("\n--- wait (up to 120s) ---");
	let waitText = "";
	let waitErr;
	const started = Date.now();
	try {
		const res = await tool.execute("smoke-wait", { action: "wait", id: runId, timeoutSeconds: 120 }, undefined, undefined, ctx);
		waitText = (res.content ?? []).map((c) => c.text ?? "").join("\n");
		waitErr = res.isError;
	} catch (err) {
		waitText = `threw: ${err instanceof Error ? err.message : String(err)}`;
	}
	console.log(`wait took ${Math.round((Date.now() - started) / 1000)}s | isError: ${waitErr}`);
	console.log("--- wait output ---\n" + waitText);
	check("(d) wait text contains OK", /\bOK\b/.test(waitText), waitText.includes("OK") ? "found OK" : "no OK in output");
}

// ---------------------------------------------------------------- cleanup + summary

for (const h of handlers.session_shutdown ?? []) {
	try {
		await h({}, ctx);
	} catch (err) {
		console.log("session_shutdown:", err instanceof Error ? err.message : String(err));
	}
}

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
