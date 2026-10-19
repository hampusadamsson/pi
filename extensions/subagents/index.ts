/**
 * Subagents extension — background role-based delegation.
 *
 * Spawns child `pi --mode json --role <role> "<task>"` processes as background
 * runs, managed through the `subagents` tool (spawn/status/list/wait/stop).
 * Non-blocking: spawn returns a run id immediately. On timeout the child is
 * killed (SIGTERM, then SIGKILL after 5s) and the run is marked timed_out with
 * its partial transcript.
 *
 * Agents are pi roles (roles.json / roles/*.json): a subagent inherits the
 * role's model, tools, skills, system prompt and MCP access. MCP servers
 * connect in the child per mcp.json.
 *
 * Config: ~/.pi/agent/subagents.json
 *   {
 *     "timeoutSeconds": 600,           // default run deadline
 *     "roleTimeouts": { "researcher": 900 },
 *     "maxConcurrent": 4,              // extra spawns queue until a slot frees
 *     "outputCapKb": 50                // final output cap returned to the model
 *   }
 *
 * While background runs are active, an "Active subagents" section is appended
 * to the system prompt (composed with other extensions' prompt edits) and the
 * footer shows the active count. Completed/failed runs notify the user.
 * Tool name: `subagents` (plural) to match the roles.json tool allowlists.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------- config

interface SubagentsConfig {
	timeoutSeconds: number;
	roleTimeouts: Record<string, number>;
	maxConcurrent: number;
	outputCapKb: number;
}

const DEFAULT_CONFIG: SubagentsConfig = {
	timeoutSeconds: 600,
	roleTimeouts: {},
	maxConcurrent: 4,
	outputCapKb: 50,
};

function loadConfig(): SubagentsConfig {
	const path = join(homedir(), ".pi", "agent", "subagents.json");
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SubagentsConfig>;
		return {
			timeoutSeconds: raw.timeoutSeconds ?? DEFAULT_CONFIG.timeoutSeconds,
			roleTimeouts: raw.roleTimeouts ?? {},
			maxConcurrent: raw.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
			outputCapKb: raw.outputCapKb ?? DEFAULT_CONFIG.outputCapKb,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Role names from the same sources the roles extension reads. */
function discoverRoles(): string[] {
	const roles = new Set<string>();
	const agentDir = join(homedir(), ".pi", "agent");

	try {
		const file = JSON.parse(readFileSync(join(agentDir, "roles.json"), "utf8")) as {
			roles?: Record<string, unknown>;
		};
		for (const name of Object.keys(file.roles ?? {})) roles.add(name);
	} catch {
		/* missing or invalid — ignore */
	}

	const rolesDir = join(agentDir, "roles");
	if (existsSync(rolesDir)) {
		for (const f of readdirSync(rolesDir)) {
			if (f.endsWith(".json") && f !== "roles.json") roles.add(f.slice(0, -5));
		}
	}

	return [...roles].sort();
}

// ---------------------------------------------------------------- state

type RunState = "queued" | "running" | "completed" | "failed" | "timed_out" | "stopped";

interface Usage {
	input: number;
	output: number;
	turns: number;
	cost: number;
}

interface Run {
	id: string;
	role: string;
	task: string;
	cwd: string;
	state: RunState;
	spawnedAt: number;
	endedAt?: number;
	timeoutMs: number;
	proc?: ChildProcess;
	timeoutHandle?: ReturnType<typeof setTimeout>;
	queueHandle?: ReturnType<typeof setTimeout>;
	messages: Message[];
	usage: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

let config = loadConfig();
const runs = new Map<string, Run>();
const finishedOrder: string[] = [];
const FINISHED_KEPT = 20;

let newRunCounter = 0;
function newRunId(): string {
	return `sa-${Date.now().toString(36)}-${++newRunCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function isActive(run: Run): boolean {
	return run.state === "running" || run.state === "queued";
}

function activeCount(): number {
	let n = 0;
	for (const run of runs.values()) if (isActive(run)) n++;
	return n;
}

function markFinished(run: Run): void {
	if (finishedOrder.includes(run.id)) return;
	finishedOrder.push(run.id);
	while (finishedOrder.length > FINISHED_KEPT) {
		const evict = finishedOrder.shift();
		if (evict) runs.delete(evict);
	}
}

/** Latest session context for notify + footer status. */
let currentCtx: ExtensionContext | undefined;

function notifyRunEnded(run: Run): void {
	const note = `Subagent ${run.role} ${run.state.replace("_", " ")} (${run.id})`;
	if (currentCtx?.hasUI) {
		currentCtx.ui.notify(note, run.state === "completed" ? "info" : "warning");
	}
}

// ---------------------------------------------------------------- child process

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = (process.execPath.split("/").pop() ?? "").toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** True when the role's allowlist can't match MCP tools (so the child must not get them). */
function roleExcludesMcp(role: string): boolean {
	try {
		const file = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "roles.json"), "utf8")) as {
			roles?: Record<string, any>;
		};
		const r = file.roles?.[role];
		if (!r) return false;
		const allow: string[] | undefined = Array.isArray(r.tools) ? r.tools : (r.tools?.allow ?? r.allowedTools);
		if (!allow) return false;
		return !allow.some((p) => p === "*" || p.startsWith("mcp") || p.startsWith("*"));
	} catch {
		return false;
	}
}

function launchRun(run: Run): void {
	run.state = "running";
	run.spawnedAt = Date.now();

	// pi's MCP extension auto-activates `direct` MCP tools regardless of the roles
	// extension's filter; drop them at the CLI level when the role doesn't allow them.
	const args = ["--mode", "json", "--no-session", "--role", run.role];
	if (roleExcludesMcp(run.role)) args.push("--exclude-tools", "mcp__*");
	args.push("--", run.task);
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd: run.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	run.proc = proc;

	let buffer = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			run.messages.push(msg);
			if (msg.role === "assistant") {
				run.usage.turns++;
				const usage = (msg as any).usage;
				if (usage) {
					run.usage.input += usage.input || 0;
					run.usage.output += usage.output || 0;
					run.usage.cost += usage.cost?.total || 0;
				}
				if (!run.model && msg.model) run.model = msg.model;
				if ((msg as any).stopReason) run.stopReason = (msg as any).stopReason;
				if ((msg as any).errorMessage) run.errorMessage = (msg as any).errorMessage;
			}
		}
	};

	proc.stdout!.on("data", (data) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});
	proc.stderr!.on("data", (data) => {
		const text = data.toString();
		if (!run.errorMessage) run.errorMessage = text.slice(0, 2000);
	});

	proc.on("error", (err) => {
		clearTimeout(run.timeoutHandle);
		run.state = "failed";
		run.errorMessage = err.message;
		run.endedAt = Date.now();
		markFinished(run);
		notifyRunEnded(run);
	});

	proc.on("close", (code) => {
		if (buffer.trim()) processLine(buffer);
		clearTimeout(run.timeoutHandle);
		if (run.state === "running") {
			run.state =
				run.stopReason === "aborted"
					? "stopped"
					: code === 0 && run.stopReason !== "error"
						? "completed"
						: "failed";
			run.endedAt = Date.now();
		}
		markFinished(run);
		notifyRunEnded(run);
	});

	run.timeoutHandle = setTimeout(() => killRun(run, "timed_out"), run.timeoutMs);
}

function killRun(run: Run, state: "timed_out" | "stopped"): void {
	clearTimeout(run.timeoutHandle);
	clearTimeout(run.queueHandle);
	if (run.proc?.pid && !run.proc.killed) {
		run.proc.kill("SIGTERM");
		setTimeout(() => {
			if (run.proc?.pid && !run.proc.killed) run.proc.kill("SIGKILL");
		}, 5000);
	}
	if (!isActive(run)) return;
	run.state = state;
	run.endedAt = Date.now();
	markFinished(run);
	notifyRunEnded(run);
}

// ---------------------------------------------------------------- output shaping

function finalOutput(run: Run): string {
	for (let i = run.messages.length - 1; i >= 0; i--) {
		const msg = run.messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content as any[]) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

function capOutput(text: string): string {
	const cap = config.outputCapKb * 1024;
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	return `${text.slice(0, cap)}\n\n[Output truncated: ${Buffer.byteLength(text, "utf8") - cap} bytes omitted.]`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function runSummaryLine(run: Run): string {
	const parts: string[] = [run.id, run.role, run.state];
	if (isActive(run)) {
		parts.push(`elapsed ${Math.round((Date.now() - run.spawnedAt) / 1000)}s`);
	} else if (run.endedAt) {
		parts.push(`took ${Math.round((run.endedAt - run.spawnedAt) / 1000)}s`);
	}
	parts.push(`${run.usage.turns} turns, ↑${fmtTokens(run.usage.input)} ↓${fmtTokens(run.usage.output)}`);
	if (run.usage.cost > 0) parts.push(`$${run.usage.cost.toFixed(4)}`);
	if (run.model) parts.push(run.model);
	return parts.join(" · ");
}

function describeRun(run: Run, includeOutput: boolean, tailLines: number): string {
	const lines = [runSummaryLine(run), `task: ${run.task.slice(0, 200)}`];
	if (run.errorMessage) lines.push(`error: ${run.errorMessage.split("\n")[0]}`);
	if (includeOutput) {
		const output = finalOutput(run);
		if (output) {
			const shown = tailLines > 0 ? output.split("\n").slice(-tailLines).join("\n") : output;
			lines.push(`output:\n${capOutput(shown)}`);
		} else {
			lines.push(`output: ${isActive(run) ? "(still running)" : "(none)"}`);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------- tool

interface ToolDetails {
	action: string;
	id?: string;
	role?: string;
	runs?: Array<{ id: string; role: string; state: RunState }>;
}

function toolText(text: string, details: ToolDetails, isError = false): AgentToolResult<ToolDetails> {
	return { content: [{ type: "text", text }], details, isError };
}

const SubagentToolParams = Type.Object({
	action: StringEnum(["spawn", "status", "list", "wait", "stop"] as const, {
		description:
			"spawn: start a background run (needs role + task); status: inspect one run (needs id); list: all runs; wait: block until a run finishes; stop: kill a run (needs id)",
	}),
	role: Type.Optional(Type.String({ description: "spawn: role name from roles.json" })),
	task: Type.Optional(Type.String({ description: "spawn: task prompt for the subagent" })),
	cwd: Type.Optional(Type.String({ description: "spawn: working directory (default: session cwd)" })),
	id: Type.Optional(Type.String({ description: "status/wait/stop: run id" })),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"spawn: run deadline override in seconds (default: subagents.json roleTimeouts/timeoutSeconds); wait: how long to block (default: 30)",
		}),
	),
});

/** Poll until the run is terminal or the deadline passes; returns the run. */
async function waitPoll(id: string | undefined, deadlineMs: number): Promise<Run | undefined> {
	const started = Date.now();
	return new Promise((resolve) => {
		const tick = () => {
			const candidates = id ? [runs.get(id)] : [...runs.values()];
			const target = candidates.find((r) => r !== undefined);
			if (!target) return resolve(undefined);
			if (id && target.id !== id) return resolve(undefined);
			if (!isActive(target)) return resolve(target);
			if (Date.now() - started >= deadlineMs) return resolve(target);
			setTimeout(tick, 500);
		};
		tick();
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagents",
		label: "Subagent",
		description: [
			"Delegate a task to a background subagent running as a pi role (roles.json).",
			"spawn is non-blocking: it returns a run id immediately; the child runs in its own session with the role's model, tools, skills and system prompt.",
			"Manage runs with status (one run, needs id), list (all runs), wait (block until done), stop (kill).",
			"Runs have deadlines (per-spawn timeoutSeconds > roleTimeouts > timeoutSeconds); a timed-out run is killed and its partial output returned.",
		].join(" "),
		promptSnippet: "Background subagent delegation to pi roles (spawn/status/list/wait/stop).",
		parameters: SubagentToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "spawn": {
					if (!params.role || !params.task) {
						return toolText("spawn requires role and task.", { action: "spawn" }, true);
					}
					const roles = discoverRoles();
					if (roles.length > 0 && !roles.includes(params.role)) {
						return toolText(
							`Unknown role "${params.role}". Available roles: ${roles.join(", ")}`,
							{ action: "spawn", role: params.role },
							true,
						);
					}

					const timeoutMs =
						params.timeoutSeconds !== undefined
							? params.timeoutSeconds * 1000
							: config.roleTimeouts[params.role] !== undefined
								? config.roleTimeouts[params.role] * 1000
								: config.timeoutSeconds * 1000;

					const run: Run = {
						id: newRunId(),
						role: params.role,
						task: params.task,
						cwd: params.cwd ?? ctx.cwd,
						state: "queued",
						spawnedAt: Date.now(),
						timeoutMs,
						messages: [],
						usage: { input: 0, output: 0, turns: 0, cost: 0 },
					};
					runs.set(run.id, run);

					// Concurrency gate: launch when a slot frees up.
					const maybeLaunch = () => {
						if (!isActive(run) || run.state !== "queued") return;
						if (activeCount() > config.maxConcurrent) {
							run.queueHandle = setTimeout(maybeLaunch, 1000);
							return;
						}
						launchRun(run);
						updateStatus();
					};
					maybeLaunch();

					return toolText(
						[
							`Spawned background subagent ${run.id} (role: ${params.role}).`,
							`Timeout: ${Math.round(timeoutMs / 1000)}s. Non-blocking — continue other work and collect later.`,
							`Collect with action "wait" (id "${run.id}"), inspect with "status", or "list" all runs.`,
						].join(" "),
						{ action: "spawn", id: run.id, role: params.role },
					);
				}

				case "status": {
					if (!params.id) return toolText("status requires id.", { action: "status" }, true);
					const run = runs.get(params.id);
					if (!run) {
						return toolText(`No run with id ${params.id}. Use list.`, { action: "status", id: params.id }, true);
					}
					return toolText(describeRun(run, true, 0), {
						action: "status",
						id: run.id,
						runs: [{ id: run.id, role: run.role, state: run.state }],
					});
				}

				case "list": {
					if (runs.size === 0) return toolText("No subagent runs.", { action: "list", runs: [] });
					const ordered = [...runs.values()].sort((a, b) => b.spawnedAt - a.spawnedAt);
					return toolText(
						ordered.map((r) => describeRun(r, false, 0)).join("\n"),
						{
							action: "list",
							runs: ordered.map((r) => ({ id: r.id, role: r.role, state: r.state })),
						},
					);
				}

				case "wait": {
					const deadlineMs = (params.timeoutSeconds ?? 30) * 1000;
					const run = await waitPoll(params.id, deadlineMs);
					if (!run || (params.id && run.id !== params.id)) {
						return toolText(
							`wait: no run found${params.id ? ` for id ${params.id}` : ""}. Use list.`,
							{ action: "wait", id: params.id },
							true,
						);
					}
					return toolText(
						isActive(run)
							? `Still running after ${Math.round(deadlineMs / 1000)}s.\n${describeRun(run, true, 20)}`
							: describeRun(run, true, 0),
						{
							action: "wait",
							id: run.id,
							runs: [{ id: run.id, role: run.role, state: run.state }],
						},
					);
				}

				case "stop": {
					if (!params.id) return toolText("stop requires id.", { action: "stop" }, true);
					const run = runs.get(params.id);
					if (!run) {
						return toolText(`No run with id ${params.id}. Use list.`, { action: "stop", id: params.id }, true);
					}
					if (!isActive(run)) {
						return toolText(`Run ${run.id} already ${run.state}.`, {
							action: "stop",
							id: run.id,
							runs: [{ id: run.id, role: run.role, state: run.state }],
						});
					}
					killRun(run, "stopped");
					updateStatus();
					return toolText(`Stopped ${run.id} (${run.role}).`, {
						action: "stop",
						id: run.id,
						runs: [{ id: run.id, role: run.role, state: run.state }],
					});
				}
			}
		},

		renderCall(args, theme) {
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "";
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.action ?? "?");
			if (args.role) text += theme.fg("accent", ` ${args.role}`);
			if (args.id) text += theme.fg("muted", ` ${args.id}`);
			if (preview) text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg(result.isError ? "error" : "toolOutput", text), 0, 0);
		},
	});

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", (_e, ctx) => {
		currentCtx = ctx;
		config = loadConfig();
		updateStatus();
	});

	pi.on("session_shutdown", () => {
		// Kill active children so nothing outlives the session.
		for (const run of runs.values()) {
			if (isActive(run)) killRun(run, "stopped");
		}
	});

	// Append active runs to the system prompt, composing with other
	// extensions' edits (roles) instead of replacing them: read the current
	// prompt, append the section, return the full string.
	pi.on("before_agent_start", (event) => {
		const active = [...runs.values()].filter(isActive).slice(0, 10);
		if (active.length === 0) return;
		const lines = active.map((r) => `- ${r.id} ${r.role} (state: ${r.state})`);
		const section = `\n\n# Active subagents\nBackground work launched earlier is still running. Do not re-spawn these tasks.\n${lines.join("\n")}\nUse subagent status/list/wait to check or collect results.`;
		return { systemPrompt: event.systemPrompt + section };
	});

	// Footer status refresh at turn boundaries.
	pi.on("turn_end", () => {
		updateStatus();
	});

	function updateStatus(): void {
		if (!currentCtx?.hasUI) return;
		const n = activeCount();
		currentCtx.ui.setStatus(
			"subagents",
			n > 0 ? currentCtx.ui.theme.fg("accent", `⚡ ${n} subagent${n === 1 ? "" : "s"}`) : undefined,
		);
	}
}
