/**
 * Roles extension
 *
 * Role = named bundle of { model, thinkingLevel, system prompt, tools, skills, context files }.
 *
 * Config (JSON, merged in this order — later wins per role):
 *   ~/.pi/agent/roles.json                { "active": "coder", "keys": {...}, "roles": { ... } }
 *   ~/.pi/agent/roles/<name>.json         single role, name = filename
 *   <cwd>/.pi/roles.json                  project-local (only when project is trusted)
 *   <cwd>/.pi/roles/<name>.json           project-local single role
 *
 * Switching:
 *   /role                 picker
 *   /role <name>          switch
 *   /role none            disable role (startup tool set restored, prompt untouched)
 *   /role reload          re-read config files
 *   /role keys            show which cycle keys are active
 *   ctrl+m                cycle forward     (override with "keys": { "next": "..." })
 *   shift+ctrl+m          cycle backward    (override with "keys": { "previous": "..." })
 *
 * On macOS: alt+<letter> only works if "Option as Meta / Esc+" is enabled in your terminal.
 * ctrl+m works everywhere. shift+ctrl+m needs Kitty protocol or modifyOtherKeys.
 *
 * Active role is session-scoped: persisted as a custom session entry, restored on
 * /resume and /fork. `"active"` in the config file is only the default for fresh sessions.
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ToolSpec {
	allow?: string[];
	deny?: string[];
}

interface RoleConfig {
	description?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	systemPromptFile?: string;
	promptMode?: "append" | "replace";
	/** Either a glob list (allow) or { allow, deny }. */
	tools?: string[] | ToolSpec;
	/** Legacy aliases. */
	allowedTools?: string[];
	deniedTools?: string[];
	/** Skill name globs kept in the system prompt. Omit = keep none. */
	skills?: string[];
	/** Extra files appended to the system prompt. */
	contextFiles?: string[];
	/** Exclude from picker and cycling. */
	hidden?: boolean;
}

interface CycleKeys {
	next?: string | string[];
	previous?: string | string[];
}

interface RolesFile {
	active?: string;
	/** Cycle keybindings. Read from global roles.json only (shortcuts register at factory time). */
	keys?: CycleKeys;
	roles?: Record<string, RoleConfig>;
}

interface LoadedConfig {
	defaultRole?: string;
	roles: Record<string, RoleConfig>;
	/** Directory each role was loaded from — used to resolve relative paths. */
	baseDirs: Record<string, string>;
	diagnostics: string[];
}

const ENTRY_TYPE = "role-switch";
const STATUS_KEY = "role";
// Substring-only match (no leading "\n\n"): pi's skill formatter has shipped both
// with and without a leading blank line before this sentence, so anchoring on the
// bare sentence text matches either variant instead of silently failing to strip.
const SKILLS_PREAMBLE = "The following skills provide specialized instructions for specific tasks.";
const SKILLS_OPEN = "<available_skills>";
const SKILLS_CLOSE = "</available_skills>";

/**
 * Default cycle keys.
 * ctrl+m is free in the main editor (app.session.rename uses ctrl+r, not ctrl+m).
 * shift+ctrl+m needs Kitty protocol / modifyOtherKeys; use /role <name> as fallback.
 * alt+<letter> on macOS needs "Option as Meta" enabled in the terminal — not the default.
 */
const DEFAULT_NEXT_KEYS = ["ctrl+h"];
const DEFAULT_PREV_KEYS = ["shift+ctrl+h"];

// ---------------------------------------------------------------- glob utils

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns: string[]): boolean {
	return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

// -------------------------------------------------------------- config loading

function globalRolesDir(): string {
	return join(getAgentDir(), "roles");
}

function readJson(path: string, diagnostics: string[]): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		diagnostics.push(`${path}: ${(error as Error).message}`);
		return undefined;
	}
}

function mergeRolesFile(
	target: LoadedConfig,
	path: string,
	baseDir: string,
	raw: unknown,
): void {
	const file = raw as RolesFile | undefined;
	if (!file || typeof file !== "object") return;
	if (typeof file.active === "string") target.defaultRole = file.active;
	for (const [name, role] of Object.entries(file.roles ?? {})) {
		if (!role || typeof role !== "object") {
			target.diagnostics.push(`${path}: role "${name}" is not an object`);
			continue;
		}
		target.roles[name] = { ...target.roles[name], ...role };
		target.baseDirs[name] = baseDir;
	}
}

function mergeRoleDir(target: LoadedConfig, dir: string): void {
	if (!existsSync(dir)) return;
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "roles.json");
	} catch {
		return;
	}
	for (const file of files.sort()) {
		const path = join(dir, file);
		const raw = readJson(path, target.diagnostics);
		if (!raw || typeof raw !== "object") continue;
		const name = file.slice(0, -".json".length);
		target.roles[name] = { ...target.roles[name], ...(raw as RoleConfig) };
		target.baseDirs[name] = dir;
	}
}

function loadConfig(ctx: ExtensionContext): LoadedConfig {
	const config: LoadedConfig = { roles: {}, baseDirs: {}, diagnostics: [] };

	const agentDir = getAgentDir();
	const globalFile = join(agentDir, "roles.json");
	if (existsSync(globalFile)) {
		mergeRolesFile(config, globalFile, agentDir, readJson(globalFile, config.diagnostics));
	}
	mergeRoleDir(config, globalRolesDir());

	if (ctx.isProjectTrusted()) {
		const projectDir = join(ctx.cwd, CONFIG_DIR_NAME);
		const projectFile = join(projectDir, "roles.json");
		if (existsSync(projectFile)) {
			mergeRolesFile(config, projectFile, projectDir, readJson(projectFile, config.diagnostics));
		}
		mergeRoleDir(config, join(projectDir, "roles"));
	}

	return config;
}

/**
 * Shortcuts must be registered during the factory call (before any session context exists),
 * so cycle keys are read from the global roles.json only, synchronously.
 */
function loadCycleKeys(): { next: string[]; previous: string[] } {
	const path = join(getAgentDir(), "roles.json");
	let keys: CycleKeys | undefined;
	if (existsSync(path)) {
		try {
			keys = (JSON.parse(readFileSync(path, "utf8")) as RolesFile).keys;
		} catch {
			keys = undefined;
		}
	}
	const normalize = (value: string | string[] | undefined, fallback: string[]): string[] => {
		if (typeof value === "string") return value.trim() ? [value.trim()] : [];
		if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim());
		return fallback;
	};
	return {
		next: normalize(keys?.next, DEFAULT_NEXT_KEYS),
		previous: normalize(keys?.previous, DEFAULT_PREV_KEYS),
	};
}

// ------------------------------------------------------------------- helpers

function toolSpec(role: RoleConfig): ToolSpec {
	if (Array.isArray(role.tools)) return { allow: role.tools, deny: role.deniedTools };
	const spec = (role.tools ?? {}) as ToolSpec;
	return {
		allow: spec.allow ?? role.allowedTools,
		deny: spec.deny ?? role.deniedTools,
	};
}

function resolveTools(role: RoleConfig, allTools: string[]): string[] {
	const { allow = ["*"], deny = [] } = toolSpec(role);
	return allTools.filter((name) => matchesAny(name, allow) && !matchesAny(name, deny));
}

function findModel(ctx: ExtensionContext, spec: string) {
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const direct = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (direct) return direct;
	}
	const available = ctx.modelRegistry.getAvailable();
	return (
		available.find((m) => `${m.provider}/${m.id}` === spec) ??
		available.find((m) => m.id === spec)
	);
}

function filterSkills(prompt: string, patterns: string[] | undefined): string {
	const allowed = patterns ?? [];

	const open = prompt.indexOf(SKILLS_OPEN);
	if (open === -1) return prompt;
	const close = prompt.indexOf(SKILLS_CLOSE, open);
	if (close === -1) return prompt;

	const blockEnd = close + SKILLS_CLOSE.length;
	const block = prompt.slice(open, blockEnd);
	const entries = block.match(/[ \t]*<skill>[\s\S]*?<\/skill>/g) ?? [];
	const kept = entries.filter((entry) => {
		const name = /<name>([\s\S]*?)<\/name>/.exec(entry)?.[1]?.trim() ?? "";
		return matchesAny(name, allowed);
	});

	if (kept.length === entries.length) return prompt;

	if (kept.length === 0) {
		const preambleIdx = prompt.lastIndexOf(SKILLS_PREAMBLE, open);
		const sectionStart = preambleIdx === -1 ? open : preambleIdx;
		// Trim whitespace on both sides of the cut so removing the section never leaves
		// a dangling blank gap or glues unrelated lines together.
		const before = prompt.slice(0, sectionStart).replace(/\s+$/, "");
		const after = prompt.slice(blockEnd).replace(/^\s+/, "");
		if (!before) return after;
		if (!after) return before;
		return `${before}\n\n${after}`;
	}

	const rebuilt = `${SKILLS_OPEN}\n${kept.join("\n")}\n${SKILLS_CLOSE}`;
	return prompt.slice(0, open) + rebuilt + prompt.slice(blockEnd);
}

function readContextFiles(role: RoleConfig, baseDir: string, cwd: string): string {
	if (!role.contextFiles?.length) return "";
	const chunks: string[] = [];
	for (const file of role.contextFiles) {
		const candidates = isAbsolute(file) ? [file] : [resolve(cwd, file), resolve(baseDir, file)];
		const path = candidates.find((candidate) => existsSync(candidate));
		if (!path) {
			chunks.push(`<role_context path="${file}">\n[missing file]\n</role_context>`);
			continue;
		}
		try {
			chunks.push(`<role_context path="${path}">\n${readFileSync(path, "utf8")}\n</role_context>`);
		} catch (error) {
			chunks.push(`<role_context path="${path}">\n[read error: ${(error as Error).message}]\n</role_context>`);
		}
	}
	return chunks.length > 0 ? `\n\n${chunks.join("\n\n")}` : "";
}

function rolePromptText(role: RoleConfig, baseDir: string, cwd: string): string {
	if (role.systemPromptFile) {
		const candidates = isAbsolute(role.systemPromptFile)
			? [role.systemPromptFile]
			: [resolve(baseDir, role.systemPromptFile), resolve(cwd, role.systemPromptFile)];
		const path = candidates.find((candidate) => existsSync(candidate));
		if (path) {
			try {
				const fileText = readFileSync(path, "utf8").trim();
				return role.systemPrompt ? `${role.systemPrompt.trim()}\n\n${fileText}` : fileText;
			} catch {
				// fall through to inline prompt
			}
		}
	}
	return role.systemPrompt?.trim() ?? "";
}

// ----------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	let config: LoadedConfig = { roles: {}, baseDirs: {}, diagnostics: [] };
	let activeRole: string | undefined;
	/** Tools active at session start, before any role narrowed the set. */
	let baselineActive: string[] = [];
	/** Tool names known at session start — anything newer (MCP, dynamic) joins the pool. */
	let baselineKnown = new Set<string>();

	const cycleKeys = loadCycleKeys();

	/** Tools a role may choose from: baseline-active plus anything registered later. */
	function toolPool(): string[] {
		const all = pi.getAllTools().map((tool) => tool.name);
		const allowed = new Set(baselineActive);
		for (const name of all) {
			if (!baselineKnown.has(name)) allowed.add(name);
		}
		return all.filter((name) => allowed.has(name));
	}

	const visibleRoles = () =>
		Object.entries(config.roles)
			.filter(([, role]) => !role.hidden)
			.map(([name]) => name);

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!activeRole) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `◆ ${activeRole}`));
	}

	async function applyRole(
		name: string | undefined,
		ctx: ExtensionContext,
		options: { quiet?: boolean } = {},
	): Promise<boolean> {
		const warnings: string[] = [];

		if (name === undefined) {
			activeRole = undefined;
			pi.setActiveTools(toolPool());
			updateStatus(ctx);
			if (!options.quiet && ctx.hasUI) ctx.ui.notify("Role cleared", "info");
			return true;
		}

		const role = config.roles[name];
		if (!role) {
			if (ctx.hasUI) ctx.ui.notify(`Unknown role: ${name}`, "error");
			return false;
		}

		activeRole = name;

		// Tools
		const selected = resolveTools(role, toolPool());
		if (selected.length === 0) {
			warnings.push("tool filter matched nothing, keeping current tools");
		} else {
			pi.setActiveTools(selected);
		}

		// Model
		if (role.model) {
			const model = findModel(ctx, role.model);
			if (!model) {
				warnings.push(`model not found: ${role.model}`);
			} else if (!(await pi.setModel(model))) {
				warnings.push(`no API key for ${role.model}`);
			}
		}

		// Thinking level
		if (role.thinkingLevel) pi.setThinkingLevel(role.thinkingLevel);

		updateStatus(ctx);

		if (!options.quiet && ctx.hasUI) {
			const suffix = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
			ctx.ui.notify(`Role: ${name}${suffix}`, warnings.length > 0 ? "warning" : "info");
		}
		return true;
	}

	async function switchRole(
		name: string | undefined,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!ctx.isIdle()) {
			if (ctx.hasUI) ctx.ui.notify("Agent busy — switch roles when idle", "error");
			return;
		}
		// Re-read config files before switching so edits made mid-session (e.g. adding
		// a `skills` allowlist to a role) take effect immediately instead of applying a
		// stale snapshot from session start / the last explicit `/role reload`.
		if (name !== undefined) {
			config = loadConfig(ctx);
			if (ctx.hasUI && config.diagnostics.length > 0) {
				ctx.ui.notify(`roles config: ${config.diagnostics.join(" | ")}`, "warning");
			}
		}
		const ok = await applyRole(name, ctx);
		if (ok) pi.appendEntry(ENTRY_TYPE, { role: name ?? null });
	}

	function restoreRoleFromSession(ctx: ExtensionContext): string | undefined {
		let restored: string | undefined;
		let found = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as { role?: string | null } | undefined;
				restored = data?.role ?? undefined;
				found = true;
			}
		}
		return found ? restored : config.defaultRole;
	}

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx);
		baselineActive = pi.getActiveTools();
		baselineKnown = new Set(pi.getAllTools().map((tool) => tool.name));

		if (ctx.hasUI && config.diagnostics.length > 0) {
			ctx.ui.notify(`roles config: ${config.diagnostics.join(" | ")}`, "warning");
		}

		const target = restoreRoleFromSession(ctx);
		if (target && !config.roles[target]) {
			if (ctx.hasUI) ctx.ui.notify(`roles: unknown role "${target}"`, "warning");
			activeRole = undefined;
			updateStatus(ctx);
			return;
		}
		await applyRole(target, ctx, { quiet: true });
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!activeRole) return;
		const role = config.roles[activeRole];
		if (!role) return;

		// Tools discovered after session_start (e.g. MCP servers connecting during
		// resources_discover) aren't filtered by the active role's tool patterns yet.
		// Re-resolve and re-apply here so every turn reflects the role's tool set
		// without needing a manual role cycle.
		const selected = resolveTools(role, toolPool());
		if (selected.length > 0) pi.setActiveTools(selected);

		const baseDir = config.baseDirs[activeRole] ?? ctx.cwd;
		let prompt = filterSkills(event.systemPrompt, role.skills);

		const roleText = rolePromptText(role, baseDir, ctx.cwd);
		if (roleText) {
			prompt =
				role.promptMode === "replace"
					? roleText
					: `${prompt}\n\n# Active role: ${activeRole}\n\n${roleText}`;
		}

		prompt += readContextFiles(role, baseDir, ctx.cwd);
		return { systemPrompt: prompt };
	});

	// -------------------------------------------------------------- commands

	const RESERVED = new Set(["none", "off", "reload", "keys"]);

	pi.registerCommand("role", {
		description: "Switch agent role (no args = picker; none | reload | keys)",
		getArgumentCompletions: (prefix) => {
			const items = [...Object.keys(config.roles), "none", "reload", "keys"]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({
					value: name,
					label: name,
					description: config.roles[name]?.description,
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "keys") {
				ctx.ui.notify(
					`cycle keys — next: ${cycleKeys.next.join(", ") || "(none)"}` +
						` | previous: ${cycleKeys.previous.join(", ") || "(none)"}`,
					"info",
				);
				return;
			}

			if (arg === "reload") {
				config = loadConfig(ctx);
				const msg =
					config.diagnostics.length > 0
						? `roles reloaded with errors: ${config.diagnostics.join(" | ")}`
						: `roles reloaded (${Object.keys(config.roles).length}). Key changes need /reload.`;
				ctx.ui.notify(msg, config.diagnostics.length > 0 ? "warning" : "info");
				if (activeRole && config.roles[activeRole]) await applyRole(activeRole, ctx, { quiet: true });
				return;
			}

			if (arg === "none" || arg === "off") {
				await switchRole(undefined, ctx);
				return;
			}

			if (arg && !RESERVED.has(arg)) {
				await switchRole(arg, ctx);
				return;
			}

			// No arg — show picker
			const names = visibleRoles();
			if (names.length === 0) {
				ctx.ui.notify("No roles configured. Create ~/.pi/agent/roles.json", "warning");
				return;
			}
			const labels = names.map((name) => {
				const marker = name === activeRole ? "● " : "  ";
				const desc = config.roles[name]?.description;
				return `${marker}${name}${desc ? ` — ${desc}` : ""}`;
			});
			labels.push("  (none)");
			const choice = await ctx.ui.select("Select role:", labels);
			if (!choice) return;
			const index = labels.indexOf(choice);
			await switchRole(index === names.length ? undefined : names[index], ctx);
		},
	});

	// ------------------------------------------------------------- shortcuts

	async function cycle(ctx: ExtensionContext, delta: number): Promise<void> {
		const names = visibleRoles();
		if (names.length === 0) return;
		const current = activeRole ? names.indexOf(activeRole) : -1;
		const next =
			current === -1
				? delta > 0 ? 0 : names.length - 1
				: (current + delta + names.length) % names.length;
		await switchRole(names[next], ctx);
	}

	for (const key of cycleKeys.next) {
		pi.registerShortcut(key as KeyId, {
			description: "Cycle to next role",
			handler: (ctx) => cycle(ctx, 1),
		});
	}

	for (const key of cycleKeys.previous) {
		pi.registerShortcut(key as KeyId, {
			description: "Cycle to previous role",
			handler: (ctx) => cycle(ctx, -1),
		});
	}
}
