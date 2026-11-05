/**
 * Shell policy extension
 *
 * Command-level allow/deny for `hypa_shell` and `bash`, on top of the role-level
 * tool allowlists in roles.json. A role's tool list decides *whether* the model
 * may run shell commands; this extension decides *which* commands.
 *
 * Config (same files the roles extension reads, merged per-role shallow):
 *   ~/.pi/agent/roles.json                { "shellPolicy": {...}, "roles": { "<name>": { "shellPolicy": {...} } } }
 *   ~/.pi/agent/roles/<name>.json
 *   <cwd>/.pi/roles.json                  project-local (trusted projects only)
 *   <cwd>/.pi/roles/<name>.json
 *
 * Policy shape:
 *   { "allow": ["git *", "kubectl get *"], "deny": ["git push *"] }
 *
 * Semantics:
 *   - No config at all           → allow everything (current behavior, unchanged).
 *   - deny always wins over allow.
 *   - allow non-empty            → fail closed: every segment must match one.
 *   - allow empty/absent         → fail open: anything not denied runs.
 *   - Global allow is a ceiling   → a role's allow entries narrow within it; a role
 *     can never grant a command the global allowlist does not already permit.
 *   - Global deny is additive     → a role cannot remove a global deny.
 *
 * Commands are split on `;`, `&&`, `||`, `|` and newlines, and each segment is
 * matched against whitespace-collapsed globs. The split is naive (not quote-aware):
 * a `;` inside a quoted string produces a segment that likely matches nothing and
 * therefore blocks. That is the safe direction for a guardrail.
 *
 * Not a sandbox: `$(...)`, backticks and process substitution are denied outright
 * when an allowlist is active because their expansion cannot be evaluated, but
 * aliases, functions, sourced files, and the contents of any allowed script are out
 * of scope. Use pi-sandbox for real isolation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	evaluate,
	mergeFile,
	mergePolicy,
	type EffectivePolicy,
	type LoadedPolicy,
} from "./policy.ts";

/** Tools whose `command` argument this extension gates. `user_bash` is deliberately excluded. */
const GATED_TOOLS = new Set(["hypa_shell", "bash"]);

const ROLE_ENTRY_TYPE = "role-switch";

function readJson(path: string, diagnostics: string[]): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		diagnostics.push(`${path}: ${(error as Error).message}`);
		return undefined;
	}
}

/** Read every roles config file, mirroring the roles extension's merge order. */
export function loadPolicy(ctx: ExtensionContext): LoadedPolicy {
	const loaded: LoadedPolicy = { roles: {}, diagnostics: [] };

	const agentDir = getAgentDir();
	const globalFile = join(agentDir, "roles.json");
	if (existsSync(globalFile)) mergeFile(loaded, readJson(globalFile, loaded.diagnostics));

	const globalRolesDir = join(agentDir, "roles");
	if (existsSync(globalRolesDir)) {
		let files: string[] = [];
		try {
			files = readdirSync(globalRolesDir).filter(
				(f) => f.endsWith(".json") && f !== "roles.json",
			);
		} catch {
			files = [];
		}
		for (const file of files.sort()) {
			mergeFile(loaded, readJson(join(globalRolesDir, file), loaded.diagnostics));
		}
	}

	if (ctx.isProjectTrusted()) {
		const projectDir = join(ctx.cwd, CONFIG_DIR_NAME);
		const projectFile = join(projectDir, "roles.json");
		if (existsSync(projectFile)) {
			mergeFile(loaded, readJson(projectFile, loaded.diagnostics));
		}
		const projectRolesDir = join(projectDir, "roles");
		if (existsSync(projectRolesDir)) {
			let files: string[] = [];
			try {
				files = readdirSync(projectRolesDir).filter((f) => f.endsWith(".json"));
			} catch {
				files = [];
			}
			for (const file of files.sort()) {
				mergeFile(loaded, readJson(join(projectRolesDir, file), loaded.diagnostics));
			}
		}
	}

	return loaded;
}

/**
 * The active role is the last `role-switch` entry on the session branch — the same
 * source the roles extension restores from, so the two cannot drift.
 */
export function activeRoleFromSession(ctx: ExtensionContext): string | undefined {
	let restored: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === ROLE_ENTRY_TYPE) {
			const data = entry.data as { role?: string | null } | undefined;
			restored = data?.role ?? undefined;
		}
	}
	return restored;
}

export default function (pi: ExtensionAPI) {
	/** Suppress repeat notifications for an unparseable config within one session. */
	let notified = false;

	function policyFor(ctx: ExtensionContext): {
		policy: EffectivePolicy;
		role?: string;
		diagnostics: string[];
	} {
		const loaded = loadPolicy(ctx);
		const role = activeRoleFromSession(ctx);
		const roleRule = role ? loaded.roles[role] : undefined;
		return {
			policy: mergePolicy(loaded.global, roleRule),
			role,
			diagnostics: loaded.diagnostics,
		};
	}

	pi.on("tool_call", (event, ctx) => {
		if (!GATED_TOOLS.has(event.toolName)) return;

		const input = event.input as { command?: unknown } | undefined;
		if (typeof input?.command !== "string") return;
		const command = input.command;

		const { policy, role, diagnostics } = policyFor(ctx);

		// A config that exists but cannot be parsed fails closed. Absent config keeps
		// the historical "no policy" behavior, so an untouched setup is unchanged.
		if (diagnostics.length > 0) {
			if (!notified && ctx.hasUI) {
				ctx.ui.notify(`shell-policy config: ${diagnostics.join(" | ")}`, "warning");
				notified = true;
			}
			return {
				block: true,
				reason:
					`blocked by shell-policy: roles config could not be parsed, failing closed ` +
					`(${diagnostics.join(" | ")})`,
			};
		}

		const verdict = evaluate(command, policy, role);
		if (verdict.allowed) return;
		return { block: true, reason: verdict.reason };
	});

	pi.registerCommand("shell-policy", {
		description: "Show the effective shell command policy for the active role",
		handler: async (_args, ctx) => {
			const { policy, role, diagnostics } = policyFor(ctx);
			const lines: string[] = ["Shell policy", `Role: ${role ?? "(none)"}`];

			if (diagnostics.length > 0) {
				lines.push(`Config errors (failing closed): ${diagnostics.join(" | ")}`);
			}

			if (!policy.configured) {
				lines.push("Configured: no — every command is allowed (default behavior)");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (policy.allow.length > 0) {
				lines.push(`Allow (${policy.allow.length}): ${policy.allow.join(", ")}`);
			} else {
				lines.push("Allow: (no allow rules)");
			}

			lines.push(`Deny (${policy.deny.length}): ${policy.deny.join(", ") || "(none)"}`);
			lines.push(`Default: ${policy.default} (unmatched segments are ${policy.default === "deny" ? "blocked" : "allowed"})`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
