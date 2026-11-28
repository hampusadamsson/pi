/**
 * Subagents extension — background role-based delegation.
 *
 * Spawns child `pi --mode rpc --role <role>` processes (task sent over stdin)
 * as background runs, managed through the `subagents` tool
 * (spawn/status/list/wait/stop). Non-blocking: spawn returns a run id immediately. On timeout the child is
 * killed (SIGTERM, then SIGKILL after 5s) and the run is marked timed_out with
 * its partial transcript. A run that produces no output at all for
 * `idleTimeoutSeconds` is also killed early (state: stalled) — a hung child
 * (stuck MCP connect, wedged tool call, dead provider stream) never reaches the
 * absolute deadline otherwise. A deadline alone does not bound cost: hundreds of
 * cheap turns fit inside one wall-clock budget, so rpc runs are also capped by
 * turn count (`maxTurns` / `roleMaxTurns`), steered to wrap up before the cap and
 * killed with state turn_limited at it.
 *
 * Turn cap (rpc only): each child `turn_end` event increments the run's own turn
 * counter (separate from `usage.turns`, which counts assistant messages). At
 * `cap - 2` turns, for caps of 3 or more, the child is sent one `steer` command
 * telling it to wrap up (smaller caps get no steer — there is no room before the
 * kill); at `cap` turns it is killed (state: turn_limited) with the partial transcript. The
 * cap is `roleMaxTurns[role] ?? maxTurns`, and `0` means unlimited (backwards
 * compatible default). `mode: "json"` ignores the cap entirely — json children
 * are single-shot, with the run bounded only by its deadline (and the idle
 * watchdog).
 *
 * Agents are pi roles (roles.json / roles/*.json): a subagent inherits the
 * role's model, tools, skills, system prompt and MCP access. MCP servers
 * connect in the child per mcp.json.
 *
 * Config: ~/.pi/agent/subagents.json
 *   {
 *     "timeoutSeconds": 600,           // default run deadline
 *     "idleTimeoutSeconds": 300,       // kill a run with no output for this long; 0 disables
 *     "roleTimeouts": { "researcher": 900 },
 *     "maxConcurrent": 4,              // extra spawns queue until a slot frees
 *     "maxDepth": 1,                  // max nesting depth; 1 = a subagent may not spawn subagents
 *                                     // (0 = the top-level agent may not spawn at all). Tracked via
 *                                     // PI_SUBAGENT_DEPTH, which children inherit +1.
 *     "maxTurns": 40,                  // rpc only: kill a run after this many child turns
 *                                     // (0 = unlimited, the default). One steer to wrap up is
 *                                     // sent at maxTurns-2 turns, for caps of 3 or more.
 *                                     // Ignored in "json" mode.
 *     "roleMaxTurns": { "researcher": 60 },  // per-role override of maxTurns (0 = unlimited)
 *     "outputCapKb": 50,               // final output cap returned to the model
 *     "mode": "rpc",                  // child transport: "rpc" (JSONL over stdin+stdout, default)
 *                                      // or "json" (legacy: task as trailing arg, stdout-only)
 *     "piBin": "/opt/homebrew/bin/pi" // optional: explicit pi CLI to spawn
 *   }
 *
 * Transport: children run `pi --mode rpc --no-session --role <role>`; the task is
 * written as a single `{"id":"1","type":"prompt","message":<task>}` line to
 * the child's stdin. stdout is parsed line-by-line: `message_end` supplies the
 * transcript, `response` with `success:false` supplies an error, and
 * `extension_ui_request` dialogs (select/confirm/input/editor) are always
 * answered with `{"type":"extension_ui_response","id":...,"cancelled":true}`
 * so a child can never block waiting for a human. `agent_settled` is the
 * completion signal (the child is then shut down by closing its stdin); the
 * `close` handler stays as the fallback that finalises state. `mode: "json"`
 * keeps the old behaviour exactly: task as the trailing `--` argument,
 * stdout-only events, exit code decides the outcome.
 *
 * `idleTimeoutSeconds` (default 300) is a watchdog on total silence: any stdout
 * or stderr chunk resets the timer. A run quiet for that long is killed
 * (SIGTERM, then SIGKILL) and marked stalled. Silence alone is not proof of a
 * hang: between `tool_execution_start` and `tool_execution_end` the child emits
 * no bytes at all for a legitimate reason (a 10-minute file review, a slow
 * shell command), so the watchdog is skipped entirely while a tool is in
 * flight — a slow tool cannot be distinguished from a wedged one, and the
 * absolute `timeoutSeconds` / role deadline already bounds that case. Set it
 * to 0 (or a negative value) to disable the watchdog and keep only the
 * absolute `timeoutSeconds` deadline.
 *
 * Every run contributes a `subagents` system-prompt *section* (the `sections` map
 * on `systemPromptOptions`, diffed and persisted as a patch — never a
 * `systemPrompt` override, which would reproject the whole prompt and break the
 * prompt cache). The section names the active runs, or says "none" when nothing
 * is running, so the section set stays stable across turns. The footer shows the
 * active count. Ended runs notify the user, and completed/
 * failed/timed_out/stalled/turn_limited runs also wake the model (custom message, followUp +
 * triggerTurn) so it can collect or retry — unless a `wait` is already
 * blocking on that run. Stopped runs never wake the model.
 * Tool name: `subagents` (plural) to match the roles.json tool allowlists.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------- config

interface SubagentsConfig {
	timeoutSeconds: number;
	/** Kill a run that produced no output for this many seconds; 0 (or negative) disables. */
	idleTimeoutSeconds: number;
	roleTimeouts: Record<string, number>;
	/** rpc only: max child turns per run; 0 (default) = unlimited. */
	maxTurns: number;
	/** Per-role override of `maxTurns`; 0 = unlimited. */
	roleMaxTurns: Record<string, number>;
	maxConcurrent: number;
	/** Max subagent nesting depth; 1 (default) = a subagent may not spawn further subagents. */
	maxDepth: number;
	outputCapKb: number;
	/** Child transport: "rpc" (JSONL over stdin+stdout, default) or "json" (legacy trailing-arg). */
	mode: "rpc" | "json";
	piBin?: string;
}

const DEFAULT_CONFIG: SubagentsConfig = {
	timeoutSeconds: 600,
	idleTimeoutSeconds: 300,
	roleTimeouts: {},
	maxTurns: 0,
	roleMaxTurns: {},
	maxConcurrent: 4,
	maxDepth: 1,
	outputCapKb: 50,
	mode: "rpc",
};

function loadConfig(): SubagentsConfig {
	const path = join(getAgentDir(), "subagents.json");
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SubagentsConfig>;
		return {
			timeoutSeconds: raw.timeoutSeconds ?? DEFAULT_CONFIG.timeoutSeconds,
			idleTimeoutSeconds: raw.idleTimeoutSeconds ?? DEFAULT_CONFIG.idleTimeoutSeconds,
			roleTimeouts: raw.roleTimeouts ?? {},
			maxTurns:
				typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) && raw.maxTurns > 0
					? Math.floor(raw.maxTurns)
					: 0,
			roleMaxTurns: raw.roleMaxTurns ?? {},
			maxConcurrent: raw.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
			maxDepth: typeof raw.maxDepth === "number" && Number.isFinite(raw.maxDepth) ? raw.maxDepth : DEFAULT_CONFIG.maxDepth,
			outputCapKb:
				typeof raw.outputCapKb === "number" && Number.isFinite(raw.outputCapKb) && raw.outputCapKb > 0
					? raw.outputCapKb
					: DEFAULT_CONFIG.outputCapKb,
			mode: raw.mode === "json" ? "json" : "rpc",
			...(typeof raw.piBin === "string" && raw.piBin.trim() ? { piBin: raw.piBin.trim() } : {}),
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Session cwd, captured at session_start — project roles are only discoverable with it. */
let projectCwd: string | undefined;
/** Whether the current project is trusted (project-local roles are only read when it is). */
let projectTrusted = false;

/**
 * Merged role config, in the same order the roles extension merges it (later wins
 * per role): global roles.json -> global roles/*.json -> project roles.json ->
 * project roles/*.json. Project sources are skipped when the cwd is unknown or
 * the project is untrusted. Malformed files are ignored.
 *
 * Memoized: the merge is pure fs reading, is consulted several times per spawn
 * (`discoverRoles`, `roleModel`, `roleExcludesMcp`, turn cap) and once per
 * `renderCall`, so re-reading every role file on each call would put synchronous
 * fs I/O in the render path. The cache is keyed on the inputs that can change
 * the result and is invalidated on `session_start`.
 */
let roleConfigCacheKey: string | undefined;
let roleConfigCache: Record<string, any> | undefined;

function loadRoleConfig(): Record<string, any> {
	const agentDir = getAgentDir();
	// Cache key: the consulted sources are determined by these three values only.
	const key = `${agentDir}|${projectCwd ?? ""}|${projectTrusted}`;
	if (roleConfigCache && roleConfigCacheKey === key) return roleConfigCache;

	const roles: Record<string, any> = {};

	const mergeFile = (path: string): void => {
		try {
			const file = JSON.parse(readFileSync(path, "utf8")) as { roles?: Record<string, any> };
			for (const [name, role] of Object.entries(file?.roles ?? {})) {
				if (!role || typeof role !== "object") continue;
				roles[name] = { ...roles[name], ...role };
			}
		} catch {
			/* missing or invalid — ignore */
		}
	};

	const mergeDir = (dir: string): void => {
		let files: string[];
		try {
			if (!existsSync(dir)) return;
			files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "roles.json");
		} catch {
			return;
		}
		for (const f of files.sort()) {
			try {
				const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
				if (!raw || typeof raw !== "object") continue;
				const name = f.slice(0, -".json".length);
				roles[name] = { ...roles[name], ...(raw as Record<string, any>) };
			} catch {
				/* missing or invalid — ignore */
			}
		}
	};

	mergeFile(join(agentDir, "roles.json"));
	mergeDir(join(agentDir, "roles"));

	if (projectTrusted && projectCwd) {
		const projectDir = join(projectCwd, CONFIG_DIR_NAME);
		mergeFile(join(projectDir, "roles.json"));
		mergeDir(join(projectDir, "roles"));
	}

	roleConfigCacheKey = key;
	roleConfigCache = roles;
	return roles;
}

/** Role names from the same sources the roles extension reads. */
function discoverRoles(): string[] {
	return Object.keys(loadRoleConfig()).sort();
}

/** Model configured for a role, if any. */
function roleModel(role: string): string | undefined {
	const m = loadRoleConfig()[role]?.model;
	return typeof m === "string" && m ? m : undefined;
}

// ---------------------------------------------------------------- state

type RunState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "timed_out"
	| "stopped"
	| "stalled"
	| "turn_limited";

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
	escalationHandle?: ReturnType<typeof setTimeout>;
	queueHandle?: ReturnType<typeof setTimeout>;
	/** True once the child process has exited (error/close); SIGKILL escalation is gated on this. */
	exited?: boolean;
	/** True once the run-end notification has woken the model; prevents duplicate wake-ups. */
	notified?: boolean;
	/** True once the run-end UI note has been shown; the model wake is tracked separately. */
	endNotified?: boolean;
	messages: Message[];
	usage: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Exact `command + args` used to launch the child, for failure messages. */
	invocation?: string;
	/** Rolling tail of the child's stderr, so the real reason survives the stack header. */
	stderrTail: string;
	/** Number of `wait` calls currently polling this run (suppresses the wake-up). */
	waiters?: number;
	/** Time of the last byte of any output or event from the child (for idle detection). */
	lastEventAt?: number;
	/** Name of the tool currently executing in the child, if any (watchdog is skipped while set). */
	activeTool?: string;
	/** When `activeTool` started, for diagnostics. */
	activeToolAt?: number;
	/** Context size in tokens as of the last assistant message. */
	contextTokens?: number;
	/** Child `turn_end` events seen so far (the turn cap counter; not `usage.turns`). */
	turns?: number;
	/** True once the wrap-up steer has been written; the steer is sent once per run. */
	wrapUpSent?: boolean;
	/** Effective turn cap for this run (0 = unlimited); rpc transport only. */
	maxTurns?: number;
}

let config = loadConfig();
const runs = new Map<string, Run>();
const finishedOrder: string[] = [];
// Kept well above maxConcurrent (15 in practice): a fan-out of parallel spawns must not
// evict the results of its earliest runs before the model gets around to collecting them.
const FINISHED_KEPT = 50;

// ---------------------------------------------------------------- idle watchdog

let watchdogHandle: ReturnType<typeof setInterval> | undefined;

/** Start the idle watchdog once; no-op when disabled or already running. */
function startWatchdog(): void {
	if (config.idleTimeoutSeconds <= 0) return;
	if (watchdogHandle) return;
	const tickMs = Math.max(1000, Math.min(5000, (config.idleTimeoutSeconds * 1000) / 2));
	watchdogHandle = setInterval(checkIdleRuns, tickMs);
	watchdogHandle.unref?.();
}

function stopWatchdog(): void {
	if (!watchdogHandle) return;
	clearInterval(watchdogHandle);
	watchdogHandle = undefined;
}

/** Kill runs that have produced no output for `idleTimeoutSeconds`; skipped while a tool runs. */
function checkIdleRuns(): void {
	// Disabled: idleMs would be 0, `quiet >= 0` is always true, and this would kill
	// every running subagent on the first tick.
	if (config.idleTimeoutSeconds <= 0) {
		stopWatchdog();
		return;
	}
	const baseIdleMs = config.idleTimeoutSeconds * 1000;
	for (const run of runs.values()) {
		if (run.state !== "running") continue;
		// A tool call in flight legitimately emits nothing until it ends, and we cannot
		// tell a slow tool from a wedged one. The absolute timeoutMs deadline already
		// bounds that case, so the watchdog only judges runs between tool calls.
		if (run.activeTool) continue;
		const idleMs = baseIdleMs;
		const quiet = Date.now() - (run.lastEventAt ?? run.spawnedAt);
		if (quiet >= idleMs) {
			run.errorMessage = `no output for ${Math.round(quiet / 1000)}s (idle watchdog; role ${run.role})`;
			killRun(run, "stalled");
		}
	}
}

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
let piApi: ExtensionAPI | undefined;

function notifyRunEnded(run: Run): void {
	if (!run.endNotified) {
		run.endNotified = true;
		const note = `Subagent ${run.role} ${run.state.replace("_", " ")} (${run.id})`;
		if (currentCtx?.hasUI) {
			currentCtx.ui.notify(note, run.state === "completed" ? "info" : "warning");
		}
	}
	// Always re-check the wake: a duplicate end event after stop must not skip it.
	wakeModel(run);
}

/** Inject a short custom message so the model can collect/retry; queued if mid-turn. */
function wakeModel(run: Run): void {
	if (!piApi) return;
	if (
		run.state !== "completed" &&
		run.state !== "failed" &&
		run.state !== "timed_out" &&
		run.state !== "stalled" &&
		run.state !== "turn_limited"
	)
		return;
	if (run.waiters) return; // a wait call is already delivering the result
	if (run.notified) return; // this run already woke the model once
	const elapsed = Math.round(((run.endedAt ?? Date.now()) - run.spawnedAt) / 1000);
	const quietSeconds = Math.round(
		((run.endedAt ?? Date.now()) - (run.lastEventAt ?? run.spawnedAt)) / 1000,
	);
	const hint =
		run.state === "completed"
			? `Collect the result with subagents wait/status id "${run.id}".`
			: run.state === "stalled"
				? `${run.errorMessage ?? `Run stalled (no output for ${quietSeconds}s) — it was killed.`} Retry with a smaller/split task or a larger timeoutSeconds. Fetch the partial output with subagents status/wait id "${run.id}".`
				: run.state === "turn_limited"
					? `${run.errorMessage ?? `Run hit its turn cap (${run.maxTurns ?? 0} turns).`} The work is probably unfinished: split it into smaller tasks or raise maxTurns/roleMaxTurns in ~/.pi/agent/subagents.json. Fetch the partial output with subagents status/wait id "${run.id}".`
					: `You may retry (larger timeoutSeconds or a smaller split task). Fetch the partial output with subagents status/wait id "${run.id}".`;
	const content = [
		`Subagent run ${run.id} (${run.role}) ${run.state} after ${elapsed}s.`,
		`task: ${run.task.slice(0, 200)}`,
		hint,
	].join("\n");
	try {
		piApi.sendMessage(
			{ customType: "subagents", content, display: true, details: { id: run.id, state: run.state } },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		run.notified = true;
	} catch (err) {
		run.notified = false;
		console.warn(`[subagents] wake-up failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ---------------------------------------------------------------- child process

/**
 * Nesting depth of this process: 0 for a top-level agent, incremented by 1 in every
 * spawned child (`PI_SUBAGENT_DEPTH`). Missing or non-numeric → 0.
 */
function subagentDepth(): number {
	const parsed = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "", 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// 1. Explicit override always wins.
	const piBin = config.piBin;
	if (piBin) {
		if (existsSync(piBin)) return { command: piBin, args };
		console.warn(`[subagents] configured piBin not found: ${piBin} — falling back to auto-detection`);
	}

	// 2. Re-exec the pi CLI directly when argv[1] really is the pi CLI. Embedded in
	//    another host (e.g. uipi's server), argv[1] is the host's entrypoint and
	//    spawning it with pi's flags dies with ERR_MODULE_NOT_FOUND or starts a
	//    second server.
	const currentScript = process.argv[1];
	const isPiScript = !!currentScript && /pi-coding-agent/.test(currentScript);
	if (isPiScript && !currentScript!.startsWith("/$bunfs/root/") && existsSync(currentScript!)) {
		return { command: process.execPath, args: [currentScript!, ...args] };
	}

	// 3. Only re-exec the current binary if it *is* a JS runtime; otherwise it's an
	//    app binary that doesn't accept pi's flags.
	const execName = (process.execPath.split("/").pop() ?? "").toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}

	// 4. Plain node/bun runner: resolve `pi` from PATH.
	return { command: "pi", args };
}

/** True when the role's allowlist can't match MCP tools (so the child must not get them). */
function roleExcludesMcp(role: string): boolean {
	const r = loadRoleConfig()[role];
	if (!r) return false;
	const allow: string[] | undefined = Array.isArray(r.tools) ? r.tools : (r.tools?.allow ?? r.allowedTools);
	if (!allow) return false;
	return !allow.some((p) => p === "*" || p.startsWith("mcp") || p.startsWith("*"));
}

/** Effective turn cap for a role: `roleMaxTurns[role] ?? maxTurns`; 0 = unlimited. */
function effectiveMaxTurns(role: string): number {
	const override = config.roleMaxTurns?.[role];
	const cap = typeof override === "number" && Number.isFinite(override) ? override : config.maxTurns;
	return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
}

function launchRun(run: Run): void {
	run.state = "running";
	// The deadline was armed when the run was created, so a queued run is bounded too;
	// re-arm it here for whatever budget is left after the queue wait.
	clearTimeout(run.timeoutHandle);
	const remainingMs = Math.max(1000, run.timeoutMs - (Date.now() - run.spawnedAt));
	run.timeoutHandle = setTimeout(() => killRun(run, "timed_out"), remainingMs);
	// Baseline the idle watchdog at launch, not at creation — otherwise a long queue
	// wait looks like silent output and the watchdog kills the child immediately.
	run.lastEventAt = Date.now();

	// Transport is fixed per run so a config change mid-run cannot mix protocols.
	const transport: "rpc" | "json" = config.mode === "json" ? "json" : "rpc";

	// Turn cap applies to rpc runs only: json children are single-shot, so their
	// only bound is the deadline. 0 = unlimited.
	run.turns = 0;
	run.wrapUpSent = false;
	run.maxTurns = transport === "rpc" ? effectiveMaxTurns(run.role) : 0;

	// pi's MCP extension auto-activates `direct` MCP tools regardless of the roles
	// extension's filter; drop them at the CLI level when the role doesn't allow them.
	const args = ["--mode", transport, "--no-session", "--role", run.role];
	if (roleExcludesMcp(run.role)) args.push("--exclude-tools", "mcp__*");
	// rpc mode takes the task on stdin; json mode takes it as the trailing argument.
	if (transport === "json") args.push("--", run.task);
	const invocation = getPiInvocation(args);
	// Keep the exact launch line so a spawn failure is diagnosable from the tool
	// result alone ("esm/resolve:241" with no command/cwd cost a long hunt once).
	run.invocation = [invocation.command, ...invocation.args].join(" ");
	let proc: ChildProcess;
	try {
		proc = spawn(invocation.command, invocation.args, {
			cwd: run.cwd,
			shell: false,
			env: { ...process.env, PI_SUBAGENT_DEPTH: String(subagentDepth() + 1) },
			stdio: [transport === "rpc" ? "pipe" : "ignore", "pipe", "pipe"],
		});
	} catch (err) {
		run.state = "failed";
		run.errorMessage = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
		run.endedAt = Date.now();
		clearTimeout(run.timeoutHandle);
		clearTimeout(run.queueHandle);
		markFinished(run);
		notifyRunEnded(run);
		return;
	}
	run.proc = proc;
	startWatchdog();

	/** Mark the run failed from a stdin failure — never throws out of the event loop. */
	const failFromStdin = (message: string) => {
		if (run.state !== "running") return;
		run.state = "failed";
		run.errorMessage = message;
		run.endedAt = Date.now();
		clearTimeout(run.queueHandle);
		markFinished(run);
		notifyRunEnded(run);
		// The child may be hung with a broken stdin; do not leave it until the deadline.
		try {
			if (!run.exited) run.proc?.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	};

	// Fire-and-forget: a stdin write is never awaited (a child that stops reading
	// would otherwise wedge the extension). Failures arrive via the `error` event.
	const writeStdin = (payload: unknown) => {
		const stdin = proc.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			failFromStdin("stdin closed before write");
			return;
		}
		try {
			stdin.write(`${JSON.stringify(payload)}\n`);
		} catch (err) {
			failFromStdin(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// Command ids must stay unique per child; the initial prompt takes "1".
	let stdinSeq = 1;
	const nextStdinId = () => String(++stdinSeq);

	proc.stdin?.on("error", (err) => {
		// EPIPE/ECONNRESET on the child's stdin must surface as a failed run, not as
		// an unhandled 'error' event that takes the parent down.
		failFromStdin(`stdin error: ${err.message}`);
	});

	/**
	 * `agent_settled` is the rpc completion signal: the child is idle and will not
	 * exit on its own (rpc mode stays alive for more commands). Finalise the run
	 * here and close stdin so the child shuts down; `close` then acts only as the
	 * fallback for a child that dies on its own.
	 */
	const settle = () => {
		if (run.state !== "running") return;
		run.state =
			run.stopReason === "aborted"
				? "stopped"
				: run.stopReason === "error"
					? "failed"
					: "completed";
		run.endedAt = Date.now();
		if (run.state === "failed" && !run.errorMessage) run.errorMessage = "child agent ended with an error";
		markFinished(run);
		notifyRunEnded(run);
		try {
			proc.stdin?.end();
		} catch {
			/* already gone */
		}
		clearTimeout(run.timeoutHandle);
		clearTimeout(run.queueHandle);
		// Safety net: a child that ignores the EOF must still be reaped.
		clearTimeout(run.escalationHandle);
		run.escalationHandle = setTimeout(() => {
			if (!run.exited && run.proc) run.proc.kill("SIGKILL");
		}, 5000);
	};

	let buffer = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		run.lastEventAt = Date.now();
		if (event.type === "response" && event.success === false) {
			// A rejected command (e.g. the initial prompt) is the run's real failure reason.
			run.errorMessage = typeof event.error === "string" && event.error ? event.error : "request failed";
		} else if (event.type === "extension_ui_request") {
			// Never let a child block forever on a dialog: cancel every interactive
			// request. notify/setStatus/setTitle/etc. are fire-and-forget and ignored.
			const method = event.method;
			if (
				(method === "select" || method === "confirm" || method === "input" || method === "editor") &&
				event.id
			) {
				writeStdin({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
			return;
		} else if (event.type === "agent_settled") {
			if (transport === "rpc") settle();
			return;
		} else if (event.type === "turn_end") {
			// A child turn completed. Count it (this is the turn cap's counter —
			// `usage.turns` counts assistant messages and is not the same thing) and
			// enforce the cap: one wrap-up steer, then a hard kill at the cap.
			run.turns = (run.turns ?? 0) + 1;
			const cap = run.maxTurns ?? 0;
			if (transport === "rpc" && cap > 0) {
				if (!run.wrapUpSent && cap >= 3 && run.turns >= cap - 2) {
					run.wrapUpSent = true;
					writeStdin({
						id: nextStdinId(),
						type: "steer",
						message:
							"Wrap up now: summarise what you have and end your reply. Do not start new work.",
					});
				}
				if (run.turns >= cap) {
					run.errorMessage = `turn cap reached: ${cap} turns (role ${run.role}); killed before completion`;
					killRun(run, "turn_limited");
					return;
				}
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			run.activeTool = typeof event.toolName === "string" ? event.toolName : "unknown";
			run.activeToolAt = Date.now();
		} else if (event.type === "tool_execution_end") {
			run.activeTool = undefined;
		}
		if (event.type === "message_end" && event.message) {
			const msg = event.message as Message;
			run.messages.push(msg);
			if (msg.role === "assistant") {
				run.usage.turns++;
				const usage = (msg as any).usage;
				if (usage) {
					run.contextTokens =
						usage.totalTokens ||
						(usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.output || 0);
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
		run.lastEventAt = Date.now();
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
	});
	proc.stderr!.on("data", (data) => {
		run.lastEventAt = Date.now();
		const text = data.toString();
		// Keep the newest stderr instead of locking on the first chunk: node prints a
		// bare `node:internal/modules/esm/resolve:241` header before the actual
		// `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...'` reason.
		run.stderrTail = (run.stderrTail + text).slice(-4000);
		// stderr is not itself a failure: warnings land here on successful runs too, so
		// the verdict decides (see the `close` handler) whether it becomes errorMessage.
	});

	proc.on("error", (err) => {
		run.exited = true;
		clearTimeout(run.timeoutHandle);
		clearTimeout(run.escalationHandle);
		clearTimeout(run.queueHandle);
		// Do not clobber a verdict the watchdog or stop already reached.
		if (run.state === "running") {
			run.state = "failed";
			run.errorMessage = `spawn failed: ${err.message}`;
			run.endedAt = Date.now();
		}
		markFinished(run);
		notifyRunEnded(run);
	});

	proc.on("close", (code) => {
		run.exited = true;
		clearTimeout(run.escalationHandle);
		clearTimeout(run.queueHandle);
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
			// A non-zero exit with no captured stderr still needs a reason attached.
			if (run.state === "failed" && !run.errorMessage) {
				run.errorMessage = run.stderrTail.trim() || `exited with code ${code}, no stderr`;
			}
		}
		run.proc = undefined;
		markFinished(run);
		notifyRunEnded(run);
	});

	if (transport === "rpc") {
		// The only command the child ever receives. One line, written once.
		writeStdin({ id: "1", type: "prompt", message: run.task });
	}
}

function killRun(run: Run, state: "timed_out" | "stopped" | "stalled" | "turn_limited"): void {
	clearTimeout(run.timeoutHandle);
	clearTimeout(run.escalationHandle);
	clearTimeout(run.queueHandle);
	// `proc.killed` flips as soon as a signal is *sent*, so gate on real exit and
	// always re-arm the escalation timer — a stale one must never block the SIGKILL.
	if (run.proc && !run.exited) {
		run.proc.kill("SIGTERM");
		run.escalationHandle = setTimeout(() => {
			if (!run.exited && run.proc) run.proc.kill("SIGKILL");
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
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= cap) return text;
	// Byte cap, so cut bytes and let the decoder drop any incomplete trailing
	// sequence (`stream: true`) instead of slicing chars and overshooting.
	const kept = new TextDecoder("utf-8").decode(Buffer.from(text, "utf8").subarray(0, cap), { stream: true });
	return `${kept}\n\n[Output truncated: ${bytes - Buffer.byteLength(kept, "utf8")} bytes omitted.]`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

/**
 * A subagent asked for more information rather than guessing. `spawn` is
 * fire-and-forget, so without an explicit marker a blocked run looks exactly
 * like a finished one and its guesswork gets accepted as the answer.
 */
const CLARIFY_TAG = "NEEDS-CLARIFICATION:";

function clarificationOf(text: string): string | undefined {
	const at = text.lastIndexOf(CLARIFY_TAG);
	if (at === -1) return undefined;
	const question = text.slice(at + CLARIFY_TAG.length).trim();
	return question || "(no question given)";
}

function runSummaryLine(run: Run): string {
	const parts: string[] = [run.id, run.role, run.state];
	if (isActive(run)) {
		parts.push(`elapsed ${Math.round((Date.now() - run.spawnedAt) / 1000)}s`);
	} else if (run.endedAt) {
		parts.push(`took ${Math.round((run.endedAt - run.spawnedAt) / 1000)}s`);
	}
	parts.push(`${run.usage.turns} turns, ↑${fmtTokens(run.usage.input)} ↓${fmtTokens(run.usage.output)}`);
	if (run.maxTurns && run.maxTurns > 0) parts.push(`cap ${run.turns ?? 0}/${run.maxTurns} turns`);
	if (run.usage.cost > 0) parts.push(`$${run.usage.cost.toFixed(4)}`);
	if (run.model) parts.push(run.model);
	if (clarificationOf(finalOutput(run))) parts.push("NEEDS CLARIFICATION");
	return parts.join(" · ");
}

function describeRun(run: Run, includeOutput: boolean, tailLines: number): string {
	const lines = [runSummaryLine(run), `task: ${run.task.slice(0, 200)}`];
	// Lead with an unanswered question, so a blocked run is never mistaken for a
	// completed one and its partial/guessed work is not accepted silently.
	const question = clarificationOf(finalOutput(run));
	if (question) {
		lines.push(`needs clarification (the task was NOT completed):\n${capOutput(question)}`);
	}
	if (run.errorMessage) {
		// Show the whole message, not just the first line: node's stack header
		// (`node:internal/modules/esm/resolve:241`) carries no information, the
		// reason is on the line below it along with our launch command.
		const err = run.errorMessage.trim();
		lines.push(`error:\n${capOutput(err)}`);
		if (run.invocation) lines.push(`command: ${run.invocation}`);
		lines.push(`cwd: ${run.cwd}`);
	}
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

// ---------------------------------------------------------------- command helpers

const IDLE_AFTER_MS = 15_000;

function statusLine(run: Run): string {
	const parts = [run.id, run.role, run.state];
	if (run.state === "running") {
		const quiet = Date.now() - (run.lastEventAt ?? run.spawnedAt);
		parts.push(quiet >= IDLE_AFTER_MS ? `idle ${Math.round(quiet / 1000)}s` : "active");
	}
	parts.push(`ctx ${run.contextTokens ? fmtTokens(run.contextTokens) : "-"}`);
	parts.push(`${run.usage.turns} turns`);
	if (run.maxTurns && run.maxTurns > 0) parts.push(`cap ${run.turns ?? 0}/${run.maxTurns}`);
	return parts.join(" · ");
}

function messageText(msg: Message): string {
	const content = (msg as any).content;
	if (typeof content === "string") return content;
	const out: string[] = [];
	for (const part of content ?? []) {
		if (part.type === "text") out.push(part.text);
		else if (part.type === "toolCall") out.push(`[tool ${part.name} ${JSON.stringify(part.arguments ?? {}).slice(0, 200)}]`);
		else if (part.type === "thinking") continue;
	}
	return out.join("\n").trim();
}

function lastMessages(run: Run, count = 5): string {
	const tail = run.messages.slice(-count);
	if (tail.length === 0) return `${run.id}: no messages yet.`;
	const body = tail
		.map((m) => `[${m.role}] ${messageText(m).slice(0, 2000) || "(empty)"}`)
		.join("\n\n");
	return `${statusLine(run)}\n\n${body}`;
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
			"spawn: start a background run (needs role + task); status: inspect one run (needs id); list: all runs; wait: block until one run finishes (needs id — use list to enumerate); stop: kill a run (needs id)",
	}),
	role: Type.Optional(Type.String({ description: "spawn: role name defined in ~/.pi/agent/roles.json (or ~/.pi/agent/roles/<name>.json)" })),
	task: Type.Optional(Type.String({ description: "spawn: task prompt for the subagent" })),
	cwd: Type.Optional(Type.String({ description: "spawn: working directory (default: session cwd)" })),
	id: Type.Optional(
		Type.String({ description: "status/wait/stop: run id (required for all three; use list to enumerate)" }),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"spawn: run deadline override in seconds (default: subagents.json roleTimeouts/timeoutSeconds); wait: how long to block (default: 30)",
		}),
	),
});

/** Poll until the run is terminal or the deadline passes; returns the run. */
async function waitPoll(id: string, deadlineMs: number, signal?: AbortSignal): Promise<Run | undefined> {
	const started = Date.now();
	return new Promise((resolve) => {
		let held: Run | undefined; // run flagged as being waited on
		let pollHandle: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const done = (r: Run | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(pollHandle);
			signal?.removeEventListener("abort", onAbort);
			let pending: Run | undefined;
			if (held) {
				held.waiters = Math.max(0, (held.waiters ?? 1) - 1);
				// Last waiter left WITHOUT delivering the result: the model still needs the wake.
				if (held.waiters === 0 && !isActive(held) && !held.notified && held !== r) pending = held;
			}
			resolve(r);
			if (pending) queueMicrotask(() => wakeModel(pending));
		};
		const onAbort = () => done(undefined);
		const tick = () => {
			// id is required and validated by the caller: guessing "newest active run" is a
			// coin flip when several spawns queue.
			const target = runs.get(id);
			if (!target) return done(undefined);
			if (!held) {
				held = target;
				target.waiters = (target.waiters ?? 0) + 1;
			}
			if (!isActive(target)) return done(target);
			if (Date.now() - started >= deadlineMs) return done(target);
			pollHandle = setTimeout(tick, 500);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) return done(undefined);
		tick();
	});
}

export default function (pi: ExtensionAPI) {
	piApi = pi;
	pi.registerTool({
		name: "subagents",
		label: "Subagent",
		description: [
			"Delegate a task to a background subagent running as a pi role (defined in ~/.pi/agent/roles.json or ~/.pi/agent/roles/<name>.json).",
			"spawn is non-blocking: it returns a run id immediately; the child runs in its own session with the role's model, tools, skills and system prompt.",
			"Manage runs with status (one run, needs id), list (all runs), wait (needs id; block until that run is done), stop (kill).",
			"Runs have deadlines (per-spawn timeoutSeconds > roleTimeouts > timeoutSeconds); a timed-out run is killed and its partial output returned.",
			"rpc runs are also capped by turn count (roleMaxTurns/maxTurns in subagents.json, 0 = unlimited): the child is steered to wrap up shortly before the cap and killed (state turn_limited) at it.",
			"If a subagent is blocked, tell it to end its reply with `NEEDS-CLARIFICATION: <question>`; such a run is flagged in its result so you do not mistake it for finished work.",
		].join(" "),
		promptSnippet: "Background subagent delegation to pi roles from ~/.pi/agent/roles.json (spawn/status/list/wait/stop).",
		parameters: SubagentToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "spawn": {
					if (!params.role || !params.task) {
						return toolText("spawn requires role and task.", { action: "spawn" }, true);
					}
					const depth = subagentDepth();
					if (depth >= config.maxDepth) {
						return toolText(
							`Recursion depth guard: this agent is at subagent depth ${depth} and maxDepth is ${config.maxDepth} — refusing to spawn another subagent. To allow deeper nesting, raise maxDepth in ~/.pi/agent/subagents.json.`,
							{ action: "spawn", role: params.role },
							true,
						);
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

					const turnCap = config.mode === "json" ? 0 : effectiveMaxTurns(params.role);
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
						stderrTail: "",
					};
					runs.set(run.id, run);

					// Concurrency gate: launch when a slot frees up.
					// Arm the run's deadline now: a run waiting for a slot must not be unbounded.
					run.timeoutHandle = setTimeout(() => killRun(run, "timed_out"), run.timeoutMs);

					const maybeLaunch = () => {
						if (!isActive(run) || run.state !== "queued") return;
						// maxConcurrent <= 0 means unlimited (a `> 0` guard: 0 would never let anything start).
						if (config.maxConcurrent > 0 && activeCount() > config.maxConcurrent) {
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
							...(turnCap > 0
								? [
										turnCap >= 3
											? `Turn cap: ${turnCap} turns (it is steered to wrap up at ${turnCap - 2}).`
											: `Turn cap: ${turnCap} turns.`,
									]
								: []),
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
					if (!params.id) {
						return toolText(
							"wait requires id — pass the run id (use list to enumerate runs).",
							{ action: "wait", id: params.id },
							true,
						);
					}
					const deadlineMs = (params.timeoutSeconds ?? 30) * 1000;
					const run = await waitPoll(params.id, deadlineMs, _signal);
					if (_signal?.aborted && !run) {
						return toolText(`wait aborted; run may still be running`, {
							action: "wait",
							id: run?.id ?? params.id,
						});
					}
					if (!run) {
						return toolText(`wait: no run found for id ${params.id}. Use list.`, { action: "wait", id: params.id }, true);
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
			const oneLine = args.task ? args.task.replace(/\s+/g, " ").trim() : "";
			const preview = oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine;
			const model = args.action === "spawn" && args.role ? roleModel(args.role) : undefined;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.action ?? "?");
			if (args.role) text += theme.fg("accent", ` ${args.role}`);
			if (model) text += theme.fg("muted", ` (${model})`);
			if (args.id) text += theme.fg("muted", ` ${args.id}`);
			if (preview) text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const block = result.content?.[0];
			const text = block?.type === "text" ? block.text : "";
			return new Text(theme.fg(result.isError ? "error" : "toolOutput", text), 0, 0);
		},
	});

	// ------------------------------------------------------------- command

	pi.registerCommand("subagents", {
		description: "Subagents: status | <id> (last messages) | kill (stop all)",
		getArgumentCompletions: (prefix) => {
			const items = ["status", "kill", ...runs.keys()]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const arg = args.trim();
			if (arg === "" || arg === "status") {
				const all = [...runs.values()];
				ctx.ui.notify(all.length ? all.map(statusLine).join("\n") : "No subagents.", "info");
				return;
			}
			if (arg === "kill") {
				const active = [...runs.values()].filter(isActive);
				for (const run of active) killRun(run, "stopped");
				updateStatus();
				ctx.ui.notify(`Killed ${active.length} subagent${active.length === 1 ? "" : "s"}.`, "info");
				return;
			}
			const run = runs.get(arg);
			if (!run) {
				ctx.ui.notify(`No subagent with id ${arg}. Try /subagents status.`, "warning");
				return;
			}
			ctx.ui.notify(lastMessages(run), "info");
		},
	});

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", (_e, ctx) => {
		currentCtx = ctx;
		projectCwd = ctx.cwd;
		try {
			projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() === true : false;
		} catch {
			projectTrusted = false;
		}
		config = loadConfig();
		// Roles may have changed on disk between sessions; drop the memoized merge
		// (the key also covers cwd/trust, but an explicit reset keeps it airtight).
		roleConfigCacheKey = undefined;
		roleConfigCache = undefined;
		updateStatus();
	});

	pi.on("session_shutdown", () => {
		// Kill active children so nothing outlives the session.
		for (const run of runs.values()) {
			if (isActive(run)) killRun(run, "stopped");
		}
		stopWatchdog();
	});

	// Contribute the active runs as a system-prompt *section* instead of
	// returning `systemPrompt`: a returned `systemPrompt` is a full
	// forceSystemPrompt override, which reprojects the whole prompt head on
	// every request and invalidates the prompt cache. Sections are diffed by
	// `diffSystemPromptSections` and persisted as patches, so the content must be
	// deterministic and the key must be emitted on every run — when nothing is
	// active it collapses to the constant "none" form, keeping the section set
	// (and therefore the cache) stable across turns.
	pi.on("before_agent_start", (event) => {
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		const active = [...runs.values()].filter(isActive);
		sections.subagents =
			active.length === 0
				? "none (no subagent runs are active)"
				: [
						"Background work launched earlier is still running. Do not re-spawn these tasks.",
						...active.map(
							(r) =>
								`- ${r.id} ${r.role} (state: ${r.state === "queued" ? "queued (waiting for a free slot)" : r.state})`,
						),
						"Use subagent status/list/wait to check or collect results.",
					].join("\n");
		return undefined;
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
