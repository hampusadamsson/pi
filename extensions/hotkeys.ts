/**
 * Hotkeys extension — vim/LazyVim-inspired modal launcher.
 *
 * Opener (default super+e / cmd+e on macOS, needs Kitty keyboard protocol —
 * works in Ghostty/Kitty/WezTerm) opens a small centered modal.
 *
 * Root modal (which-key style key grid):
 *   m        → model picker (MRU first, current model marked ●)
 *   r        → role picker (reads the roles extension config, dispatches /role)
 *   /        → fuzzy search over all actions
 *   <other>  → unbound printable char jumps straight into fuzzy search
 *   esc / q  → exit
 *
 * Selection modal (replaces root content):
 *   /        → enter filter mode (fzf-style fuzzy)
 *   j/k/↑↓   → navigate, gg → top, G → bottom
 *   enter    → select
 *   esc      → clear query (if any), else step back to root
 *
 * Config (merged, project overrides global):
 *   ~/.pi/agent/hotkeys.json
 *   <cwd>/.pi/hotkeys.json        (trusted projects only)
 *
 * ```json
 * {
 *   "opener": "super+e",
 *   "width": "50%",
 *   "maxHeight": "80%",
 *   "actions": {
 *     "m": { "type": "models" },
 *     "r": { "type": "roles" },
 *     "t": { "type": "setThinking", "value": "high" },
 *     "c": { "type": "command", "name": "compact" },
 *     "w": { "type": "role", "name": "work" }
 *   }
 * }
 * ```
 *
 * Action types:
 *   models      model picker
 *   roles       role picker (roles extension)
 *   role        switch to a fixed role immediately
 *   setThinking set thinking level
 *   command     dispatch any extension slash command
 *
 * Also available as /hotvim command.
 * Opener key changes require /reload (shortcuts register at startup).
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	CURSOR_MARKER,
	fuzzyFilter,
	type Focusable,
	matchesKey,
	type SelectItem,
	SelectList,
	type SizeValue,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type ActionDef =
	| { type: "models"; label?: string }
	| { type: "roles"; label?: string }
	| { type: "role"; label?: string; name: string }
	| { type: "setThinking"; label?: string; value: ThinkingLevel }
	| { type: "command"; label?: string; name: string; args?: string };

interface HotkeysConfig {
	opener?: string;
	width?: string;
	maxHeight?: string;
	actions?: Record<string, ActionDef>;
}

const DEFAULT_ACTIONS: Record<string, ActionDef> = {
	m: { type: "models" },
	r: { type: "roles" },
};

const MRU_ENTRY = "hotkeys-mru";
const MRU_MAX = 8;

// ---------------------------------------------------------------- config

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	} catch (err) {
		console.error(`hotkeys: failed to parse ${path}: ${(err as Error).message}`);
	}
	return undefined;
}

function toActionDef(raw: unknown): ActionDef | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const def = raw as Record<string, unknown>;
	switch (def.type) {
		case "models":
		case "roles":
			return { type: def.type, label: typeof def.label === "string" ? def.label : undefined };
		case "role":
			if (typeof def.name === "string") {
				return {
					type: "role",
					name: def.name,
					label: typeof def.label === "string" ? def.label : undefined,
				};
			}
			return undefined;
		case "setThinking":
			if (typeof def.value === "string") {
				return {
					type: "setThinking",
					value: def.value as ThinkingLevel,
					label: typeof def.label === "string" ? def.label : undefined,
				};
			}
			return undefined;
		case "command":
			if (typeof def.name === "string") {
				return {
					type: "command",
					name: def.name,
					args: typeof def.args === "string" ? def.args : undefined,
					label: typeof def.label === "string" ? def.label : undefined,
				};
			}
			return undefined;
	}
	return undefined;
}

function mergeActions(target: Record<string, ActionDef>, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (key.length !== 1) continue;
		const def = toActionDef(value);
		if (def) target[key] = def;
	}
}

function readGlobalConfig(): HotkeysConfig {
	const file = readJsonFile(join(getAgentDir(), "hotkeys.json")) ?? {};
	const actions: Record<string, ActionDef> = { ...DEFAULT_ACTIONS };
	mergeActions(actions, file.actions);
	return {
		opener: typeof file.opener === "string" ? file.opener : undefined,
		width: typeof file.width === "string" ? file.width : undefined,
		maxHeight: typeof file.maxHeight === "string" ? file.maxHeight : undefined,
		actions,
	};
}

function loadConfig(ctx: ExtensionContext): HotkeysConfig {
	const cfg = readGlobalConfig();
	if (!ctx.isProjectTrusted()) return cfg;
	const file = readJsonFile(join(ctx.cwd, CONFIG_DIR_NAME, "hotkeys.json"));
	if (file) {
		if (typeof file.opener === "string") cfg.opener = file.opener;
		if (typeof file.width === "string") cfg.width = file.width;
		if (typeof file.maxHeight === "string") cfg.maxHeight = file.maxHeight;
		if (file.actions) {
			const actions: Record<string, ActionDef> = {};
			mergeActions(actions, file.actions);
			cfg.actions = { ...cfg.actions, ...actions };
		}
	}
	return cfg;
}

// ---------------------------------------------------------------- roles (read-only view of the roles extension config)

interface RoleEntry {
	name: string;
	description?: string;
}

function loadRoles(ctx: ExtensionContext): RoleEntry[] {
	const roles = new Map<string, RoleEntry>();
	const add = (name: string, raw: unknown) => {
		if (!raw || typeof raw !== "object") return;
		const role = raw as Record<string, unknown>;
		if (role.hidden === true) return;
		roles.set(name, {
			name,
			description: typeof role.description === "string" ? role.description : undefined,
		});
	};

	const agentDir = getAgentDir();
	const globalFile = readJsonFile(join(agentDir, "roles.json"));
	if (globalFile?.roles && typeof globalFile.roles === "object") {
		for (const [name, role] of Object.entries(globalFile.roles as Record<string, unknown>)) {
			add(name, role);
		}
	}

	const readRoleDir = (dir: string) => {
		if (!existsSync(dir)) return;
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "roles.json");
		} catch {
			return;
		}
		for (const file of files.sort()) {
			add(file.slice(0, -".json".length), readJsonFile(join(dir, file)));
		}
	};
	readRoleDir(join(agentDir, "roles"));

	if (ctx.isProjectTrusted()) {
		const projectDir = join(ctx.cwd, CONFIG_DIR_NAME);
		const projectFile = readJsonFile(join(projectDir, "roles.json"));
		if (projectFile?.roles && typeof projectFile.roles === "object") {
			for (const [name, role] of Object.entries(projectFile.roles as Record<string, unknown>)) {
				add(name, role);
			}
		}
		readRoleDir(join(projectDir, "roles"));
	}

	return [...roles.values()];
}

/** Active role name, recovered from the roles extension's session entries. */
function activeRole(ctx: ExtensionContext): string | undefined {
	let active: string | undefined;
	let found = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "role-switch") {
			const data = entry.data as { role?: string | null } | undefined;
			active = data?.role ?? undefined;
			found = true;
		}
	}
	// No switch this session: roles applies `active` from roles.json without an entry
	if (!found) {
		const file = readJsonFile(join(getAgentDir(), "roles.json"));
		if (typeof file?.active === "string") return file.active;
	}
	return active;
}

// ---------------------------------------------------------------- helpers

function isPrintable(data: string): boolean {
	return data.length === 1 && data.charCodeAt(0) >= 32;
}

function actionLabel(key: string, def: ActionDef): string {
	if (def.label) return def.label;
	switch (def.type) {
		case "models":
			return "models";
		case "roles":
			return "roles";
		case "role":
			return `role: ${def.name}`;
		case "setThinking":
			return `thinking: ${def.value}`;
		case "command":
			return `/${def.name}`;
	}
}

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

// ---------------------------------------------------------------- modal component

type ListKind = "models" | "roles" | "actions";

type SelectionResult =
	| { kind: "model"; value: string }
	| { kind: "role"; value: string }
	| { kind: "direct"; def: ActionDef };

interface Deps {
	config: HotkeysConfig;
	buildItems: (kind: ListKind) => SelectItem[];
	actionByKey: (key: string) => ActionDef | undefined;
}

class HotkeysModal implements Focusable {
	focused = false;

	private view: "root" | "list" = "root";
	private kind: ListKind = "actions";
	private query = "";
	private filterMode = false;
	private pendingG = false;
	private list: SelectList | undefined;
	private allItems: SelectItem[] = [];
	private filteredCount = 0;

	constructor(
		private theme: Theme,
		private tui: TUI,
		private done: (result: SelectionResult | undefined) => void,
		private deps: Deps,
	) {}

	// ------------------------------------------------------------ input

	handleInput(data: string): void {
		if (this.view === "root") this.handleRootInput(data);
		else this.handleListInput(data);
		this.tui.requestRender();
	}

	private handleRootInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "/") {
			this.openList("actions", "");
			return;
		}
		const def = this.deps.actionByKey(data);
		if (def) {
			this.runDef(def);
			return;
		}
		// Unbound printable char → jump straight into fuzzy action search
		if (isPrintable(data)) this.openList("actions", data);
	}

	private handleListInput(data: string): void {
		const list = this.list;
		if (!list) return;

		if (this.filterMode) {
			if (matchesKey(data, "escape")) {
				if (this.query) {
					this.query = "";
					this.applyFilter();
				} else {
					this.back();
				}
				return;
			}
			if (matchesKey(data, "return")) {
				this.confirm();
				return;
			}
			if (matchesKey(data, "backspace")) {
				this.query = this.query.slice(0, -1);
				this.applyFilter();
				return;
			}
			if (isPrintable(data)) {
				this.query += data;
				this.applyFilter();
				return;
			}
			list.handleInput(data); // arrows while filtering
			return;
		}

		if (matchesKey(data, "escape") || data === "q") {
			this.back();
			return;
		}
		if (data === "/") {
			this.filterMode = true;
			return;
		}
		if (matchesKey(data, "return")) {
			this.confirm();
			return;
		}
		if (data === "j") {
			list.handleInput("\x1b[B"); // down
			return;
		}
		if (data === "k") {
			list.handleInput("\x1b[A"); // up
			return;
		}
		if (data === "g") {
			if (this.pendingG) {
				this.pendingG = false;
				list.setSelectedIndex(0);
			} else {
				this.pendingG = true;
			}
			return;
		}
		this.pendingG = false;
		if (data === "G") {
			list.setSelectedIndex(Math.max(0, this.filteredCount - 1));
			return;
		}
		list.handleInput(data); // arrows, pageUp/pageDown, ctrl+c
	}

	// ------------------------------------------------------------ actions

	private openList(kind: ListKind, seedQuery: string): void {
		this.view = "list";
		this.kind = kind;
		this.allItems = this.deps.buildItems(kind);
		this.list = new SelectList(this.allItems, Math.min(this.allItems.length, 12), {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
		this.query = seedQuery;
		this.filterMode = seedQuery.length > 0;
		this.applyFilter();
	}

	private applyFilter(): void {
		const list = this.list;
		if (!list) return;
		const filtered = this.query
			? fuzzyFilter(this.allItems, this.query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allItems;
		this.filteredCount = filtered.length;
		// SelectList.setFilter is prefix-only; swap in fuzzy-filtered items directly
		const listInternals = this.list as unknown as {
			items: SelectItem[];
			filteredItems: SelectItem[];
			selectedIndex: number;
		};
		listInternals.items = filtered;
		listInternals.filteredItems = filtered;
		listInternals.selectedIndex = 0;
	}

	private back(): void {
		this.view = "root";
		this.list = undefined;
		this.query = "";
		this.filterMode = false;
		this.pendingG = false;
	}

	private confirm(): void {
		const item = this.list?.getSelectedItem();
		if (item) this.selectItem(item.value);
	}

	private selectItem(value: string): void {
		if (this.kind === "models") {
			this.done({ kind: "model", value });
			return;
		}
		if (this.kind === "roles") {
			this.done({ kind: "role", value });
			return;
		}
		// actions view: value is the action key
		const def = this.deps.actionByKey(value);
		if (def) this.runDef(def);
	}

	private runDef(def: ActionDef): void {
		if (def.type === "models") {
			this.openList("models", "");
			return;
		}
		if (def.type === "roles") {
			this.openList("roles", "");
			return;
		}
		this.done({ kind: "direct", def });
	}

	// ------------------------------------------------------------ render

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		if (this.view === "root") {
			lines.push(row(` ${th.fg("accent", th.bold("⌨ hotkeys"))}`));
			lines.push(row(""));

			const entries = Object.entries(this.deps.config.actions ?? {})
				.filter(([key]) => key.length === 1)
				.map(([key, def]) => [key, actionLabel(key, def)] as const)
				.sort(([a], [b]) => a.localeCompare(b));

			const twoCols = entries.length > 6;
			const colWidth = twoCols
				? Math.max(...entries.map(([, label]) => label.length)) + 5
				: 0;

			if (entries.length === 0) {
				lines.push(row(` ${th.fg("dim", "(no actions configured)")}`));
			} else if (twoCols) {
				const rows = Math.ceil(entries.length / 2);
				for (let i = 0; i < rows; i++) {
					const left = entries[i]!;
					const right = entries[i + rows];
					const cell = (e: readonly [string, string]) =>
						` ${th.fg("accent", th.bold(e[0]))}  ${th.fg("text", e[1])}`;
					const content = right
						? pad(cell(left), colWidth + 2) + cell(right)
						: cell(left);
					lines.push(row(content));
				}
			} else {
				for (const [key, label] of entries) {
					lines.push(row(` ${th.fg("accent", th.bold(key))}  ${th.fg("text", label)}`));
				}
			}

			lines.push(row(""));
			lines.push(
				row(
					` ${th.fg("dim", "/")} ${th.fg("dim", "search")}   ${th.fg("dim", "esc")} ${th.fg("dim", "quit")}`,
				),
			);
		} else {
			const title = this.kind === "models" ? "models" : this.kind === "roles" ? "roles" : "actions";
			lines.push(row(` ${th.fg("accent", th.bold(title))}`));

			// Filter row (always shown in list view so / state is visible)
			const marker = this.focused && this.filterMode ? CURSOR_MARKER : "";
			const filterLabel = th.fg("dim", " /");
			const queryText = this.filterMode
				? `${this.query}${marker}\x1b[7m \x1b[27m`
				: this.query
					? this.query
					: th.fg("dim", "type / to filter");
			lines.push(row(` ${filterLabel} ${queryText}`));
			lines.push(row(""));

			if (this.list) {
				for (const line of this.list.render(innerW)) lines.push(row(line));
			}
			if (this.filteredCount === 0) {
				lines.push(row(` ${th.fg("warning", "no matches")}`));
			}

			lines.push(row(""));
			lines.push(
				row(
					` ${th.fg("dim", "j/k nav · / filter · enter select · esc back")}`,
				),
			);
		}

		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {
		this.list?.invalidate();
	}
	dispose(): void {}
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	// Shortcut registration happens at factory time, so the opener key is read
	// from the global config only. Use /reload after changing it.
	const globalConfig = readGlobalConfig();
	let config = globalConfig;
	let mruModels: string[] = [];

	function buildDeps(ctx: ExtensionContext): Deps {
		function availableModels(): Model<never>[] {
			const scoped = ctx.scopedModels;
			if (scoped && scoped.length > 0) return scoped.map((s) => s.model) as Model<never>[];
			return ctx.modelRegistry.getAvailable() as Model<never>[];
		}

		return {
			config,
			actionByKey: (key) => config.actions?.[key],
			buildItems: (kind) => {
				if (kind === "models") {
					const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
					const models = availableModels();
					const byKey = new Map(models.map((m) => [modelKey(m), m]));
					const ordered: string[] = [
						...mruModels.filter((k) => byKey.has(k) && k !== currentKey),
						...models
							.map(modelKey)
							.filter((k) => !mruModels.includes(k) && k !== currentKey)
							.sort(),
					];
					if (currentKey) ordered.unshift(currentKey);
					return ordered.map((key) => ({
						value: key,
						label: key === currentKey ? `● ${key}` : `  ${key}`,
						description: byKey.get(key)?.name,
					}));
				}
				if (kind === "roles") {
					const active = activeRole(ctx);
					const items = loadRoles(ctx).map((role) => ({
						value: role.name,
						label: role.name === active ? `● ${role.name}` : `  ${role.name}`,
						description: role.description,
					}));
					items.push({
						value: "(none)",
						label: active === undefined ? "● (none)" : "  (none)",
						description: "clear role",
					});
					return items;
				}
				// actions
				return Object.entries(config.actions ?? {})
					.filter(([key]) => key.length === 1)
					.map(([key, def]) => ({
						value: key,
						label: `${key}  ${actionLabel(key, def)}`,
						description: undefined,
					}))
					.sort((a, b) => a.label.localeCompare(b.label));
			},
		};
	}

	async function open(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		// Refresh config so edits to hotkeys.json/roles.json take effect without /reload
		config = loadConfig(ctx);

		const result = await ctx.ui.custom<SelectionResult | undefined>(
			(tui, theme, _kb, done) => new HotkeysModal(theme, tui, done, buildDeps(ctx)),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: (config.width ?? "50%") as SizeValue,
					minWidth: 40,
					maxHeight: (config.maxHeight ?? "80%") as SizeValue,
					margin: 1,
				},
			},
		);

		// Side effects run only after the overlay is fully closed, so the TUI
		// focus stack is not mutated mid-render (this is what caused the freeze).
		if (!result) return;

		const notify = (msg: string, level: "info" | "warning" | "error") => {
			if (ctx.hasUI) ctx.ui.notify(msg, level);
		};
		const dispatchCommand = (text: string) => {
			pi.sendUserMessage(text, { expandPromptTemplates: true, deliverAs: "followUp" });
		};

		if (result.kind === "model") {
			const model = (ctx.scopedModels.length > 0
				? ctx.scopedModels.map((s) => s.model)
				: ctx.modelRegistry.getAvailable()) as Model<never>[];
			const found = model.find((m) => modelKey(m) === result.value);
			if (!found) {
				notify(`hotkeys: model not found: ${result.value}`, "error");
				return;
			}
			if (!(await pi.setModel(found))) {
				notify(`hotkeys: no API key for ${result.value}`, "warning");
				return;
			}
			mruModels = [result.value, ...mruModels.filter((k) => k !== result.value)].slice(0, MRU_MAX);
			pi.appendEntry(MRU_ENTRY, { models: mruModels });
			return;
		}

		if (result.kind === "role") {
			dispatchCommand(result.value === "(none)" ? "/role none" : `/role ${result.value}`);
			return;
		}

		// direct action
		const def = result.def;
		if (def.type === "setThinking") {
			pi.setThinkingLevel(def.value);
			notify(`thinking: ${def.value}`, "info");
			return;
		}
		if (def.type === "role") {
			dispatchCommand(`/role ${def.name}`);
			return;
		}
		if (def.type === "command") {
			dispatchCommand(`/${def.name}${def.args ? ` ${def.args}` : ""}`);
			return;
		}
		notify(`hotkeys: unexpected action: ${def.type}`, "warning");
	}

	pi.registerShortcut((globalConfig.opener ?? "super+e") as KeyId, {
		description: "Hotkeys modal (vim-style launcher)",
		handler: async (ctx) => {
			await open(ctx);
		},
	});

	pi.registerCommand("hotvim", {
		description: "Open hotkeys modal (vim-style launcher)",
		handler: async (_args, ctx) => {
			await open(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx);
		// Restore model MRU from session entries
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MRU_ENTRY) {
				const data = entry.data as { models?: string[] } | undefined;
				if (Array.isArray(data?.models)) mruModels = data!.models!.slice(0, MRU_MAX);
			}
		}
	});
}
