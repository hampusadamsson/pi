/**
 * Hotkeys extension — vim/LazyVim-inspired modal launcher.
 *
 * Opener (default super+e / cmd+e on macOS, needs Kitty keyboard protocol —
 * works in Ghostty/Kitty/WezTerm) opens a small centered modal.
 *
 * Root modal (which-key style key grid):
 *   m        → model picker (MRU first, current model marked ●)
 *   r        → role picker (reads the roles extension config, dispatches /role)
 *   s        → session picker (resume a session)
 *   S        → skill picker (reads /skill:* commands)
 *   n        → new session immediately
 *   c        → compact context immediately
 *   R        → reload extensions/config immediately
 *   u        → run `pi update --all`, then reload
 *   /        → fuzzy search over all actions
 *   y        → copy submenu: (l) last output, (f) full context → clipboard
 *   <other>  → unbound printable char jumps straight into fuzzy search
 *   esc / q  → exit
 *
 * Selection modal (replaces root content):
 *   /        → enter filter mode (fzf-style fuzzy)
 *   j/k/↑↓   → navigate, gg → top, G → bottom
 *   enter    → select
 *   i        → close modal, focus input in INSERT (except in free-text filter)
 *   esc      → clear query (if any), else step back to root
 *
 * Vim input mode ("vim": false in hotkeys.json to disable, /vim-mode toggles):
 *   INSERT   default mode; esc → NORMAL; status bar shows -- INSERT --
 *   NORMAL   motions h j k l w b e 0 ^ $ gg G · x X r s S · dd dw db de d$ D ·
 *            yy Y p P · cc c$ C · J join · u (undo) · i I a A o O → INSERT ·
 *            v V → VISUAL · enter submits · ctrl+c passes through
 *   VISUAL   motions extend selection · d/x delete · y yank · c change ·
 *            esc/v exit · border turns warning-colored while active
 *   leader   space in NORMAL/VISUAL opens the hotkeys modal (which-key style);
 *            follow-up key dispatches inside the modal: m models · r roles ·
 *            s sessions · S skills · n new · c compact · R reload · u update ·
 *            / action search · i INSERT
 *   i        from anywhere (modal or NORMAL mode) focuses input in INSERT
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
 *   "vim": true,
 *   "actions": {
 *     "m": { "type": "models" },
 *     "r": { "type": "roles" },
 *     "s": { "type": "sessions" },
 *     "S": { "type": "skills" },
 *     "n": { "type": "new" },
 *     "c": { "type": "compact" },
 *     "R": { "type": "reload" },
 *     "u": { "type": "update" },
 *     "t": { "type": "setThinking", "value": "high" },
 *     "w": { "type": "role", "name": "work" }
 *   }
 * }
 * ```
 *
 * Action types:
 *   models      model picker
 *   roles       role picker (roles extension)
 *   skills      skill picker (dispatch /skill:<name>)
 *   sessions    session picker (resume, lists current project sessions)
 *   new         start a new session immediately
 *   compact     trigger compaction immediately
 *   reload      reload extensions/config immediately
 *   update      run `pi update --all`, then reload
 *   role        switch to a fixed role immediately
 *   setThinking set thinking level
 *   command     dispatch any extension slash command
 *
 * Also available as /hotvim command.
 * Opener key changes require /reload (shortcuts register at startup).
 */

import {
	CONFIG_DIR_NAME,
	copyToClipboard,
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	SessionManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	CURSOR_MARKER,
	fuzzyFilter,
	type Focusable,
	type EditorTheme,
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
	| { type: "skills"; label?: string }
	| { type: "sessions"; label?: string }
	| { type: "new"; label?: string }
	| { type: "compact"; label?: string }
	| { type: "reload"; label?: string }
	| { type: "update"; label?: string }
	| { type: "role"; label?: string; name: string }
	| { type: "setThinking"; label?: string; value: ThinkingLevel }
	| { type: "command"; label?: string; name: string; args?: string };

interface HotkeysConfig {
	opener?: string;
	width?: string;
	maxHeight?: string;
	vim?: boolean;
	actions?: Record<string, ActionDef>;
}

const DEFAULT_ACTIONS: Record<string, ActionDef> = {
	m: { type: "models" },
	r: { type: "roles" },
	s: { type: "sessions" },
	S: { type: "skills" },
	n: { type: "new" },
	c: { type: "compact" },
	R: { type: "reload" },
	u: { type: "update" },
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
		case "skills":
		case "sessions":
		case "new":
		case "compact":
		case "reload":
		case "update":
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
		vim: typeof file.vim === "boolean" ? file.vim : undefined,
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
		if (typeof file.vim === "boolean") cfg.vim = file.vim;
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
		case "skills":
			return "skills";
		case "sessions":
			return "sessions";
		case "new":
			return "new session";
		case "compact":
			return "compact";
		case "reload":
			return "reload";
		case "update":
			return "update pi";
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

function sessionLabel(s: SessionInfo): string {
	if (s.name) return s.name;
	const first = s.firstMessage.trim().split("\n")[0];
	if (first) return first.length > 60 ? `${first.slice(0, 57)}…` : first;
	return s.created.toISOString().slice(0, 16).replace("T", " ");
}

// ---------------------------------------------------------------- clipboard helpers

/** Extract plain text from a message content (string or content blocks). */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/** Text of the most recent assistant message in the current session branch. */
function lastOutputText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!msg || msg.role !== "assistant") continue;
		const text = extractText(msg.content);
		if (text.trim()) return text;
	}
	return undefined;
}

/** Full conversation context (user + assistant text) as markdown-ish transcript. */
function fullContextText(ctx: ExtensionContext): string {
	const parts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry?.type !== "message") continue;
		const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const role = msg.role;
		const text = extractText(msg.content);
		if (!text.trim()) continue;
		parts.push(`## ${role}\n\n${text}`);
	}
	return parts.join("\n\n");
}

// ---------------------------------------------------------------- vim input mode

type VimMode = "normal" | "insert" | "visual" | "visual-line";

interface Pos {
	line: number;
	col: number;
}

/**
 * Bridge between the vim editor and the rest of the extension:
 * - modals push `i` back into the editor (close + focus input in INSERT)
 * - leader combos (space in NORMAL) open the hotkeys modal on a preset action
 */
const vimBridge: {
	editor: VimEditor | undefined;
	openLauncher: ((action?: string) => void) | undefined;
	opener?: KeyId;
} = { editor: undefined, openLauncher: undefined };

/** Extension context for status-bar updates; set once the UI is available. */
let uiCtx: ExtensionContext | undefined;
let vimEnabled = true;

/** Private Editor internals used for cursor/text manipulation. */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	setCursorCol(col: number): void;
	moveCursor(deltaLine: number, deltaCol: number): void;
	moveWordBackwards(): void;
	moveWordForwards(): void;
	deleteToEndOfLine(): void;
	pageScroll(direction: -1 | 1): void;
	pushUndoSnapshot(): void;
	undo(): void;
	getText(): string;
	onChange?: (text: string) => void;
}

const isWs = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** Start of next word (skips current run + following whitespace). */
function wordForward(lines: string[], pos: Pos): Pos {
	let { line, col } = pos;
	const ch = () => (lines[line] ?? "")[col];
	const len = () => (lines[line] ?? "").length;
	while (line < lines.length && col < len() && !isWs(ch())) col++;
	while (line < lines.length) {
		if (col >= len()) {
			line++;
			col = 0;
			continue;
		}
		if (isWs(ch())) {
			col++;
			continue;
		}
		break;
	}
	return { line, col };
}

/** Start of previous word. */
function wordBack(lines: string[], pos: Pos): Pos {
	let { line, col } = pos;
	const ch = () => (lines[line] ?? "")[col];
	col--;
	while (line >= 0) {
		if (col < 0) {
			line--;
			col = (lines[line] ?? "").length - 1;
			continue;
		}
		if (isWs(ch())) {
			col--;
			continue;
		}
		break;
	}
	while (line >= 0 && col >= 0 && !isWs(ch())) col--;
	col++;
	if (line < 0) return { line: 0, col: 0 };
	return { line, col: Math.max(0, col) };
}

/** Last char of current/next word. */
function wordEnd(lines: string[], pos: Pos): Pos {
	let { line, col } = pos;
	const ch = (c: number) => (lines[line] ?? "")[c];
	const len = () => (lines[line] ?? "").length;
	col++;
	while (line < lines.length) {
		if (col >= len()) {
			line++;
			col = 0;
			continue;
		}
		if (isWs(ch(col))) {
			col++;
			continue;
		}
		break;
	}
	while (line < lines.length && col + 1 < len() && !isWs(ch(col + 1))) col++;
	return { line, col };
}

function firstNonBlank(line: string): number {
	const m = /\S/.exec(line);
	return m ? m.index : 0;
}

/** Vim-style modal input editor. INSERT by default; esc → NORMAL; v → VISUAL. */
class VimEditor extends CustomEditor {
	mode: VimMode = "insert";
	private pendingG = false;
	private pendingOp: "d" | "y" | "c" | undefined;
	private pendingReplace = false;
	private anchor: Pos | undefined;	private register: { type: "char" | "line"; text: string } | undefined;
	private defaultBorder: (str: string) => string;
	private lastEscAt = 0;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.defaultBorder = this.borderColor;
	}

	private ed(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	setMode(mode: VimMode): void {
		const was = this.mode;
		this.mode = mode;
		this.pendingG = false;
		this.pendingOp = undefined;
		this.pendingReplace = false;
		if (mode !== "visual" && mode !== "visual-line") this.anchor = undefined;
		const e = this.ed();
		if (was === "insert" && mode === "normal") {
			// vim: step left when leaving insert at end of line
			const line = e.state.lines[e.state.cursorLine] ?? "";
			if (e.state.cursorCol >= line.length && e.state.cursorCol > 0) {
				e.setCursorCol(line.length - 1);
			}
		}
		this.syncModeUI();
	}

	private syncModeUI(): void {
		const theme = uiCtx?.ui.theme;
		let label = "-- INSERT --";
		let border = this.defaultBorder;
		if (this.mode === "normal") {
			label = "-- NORMAL --";
			border = theme ? (s: string) => theme.fg("accent", s) : border;
		} else if (this.mode === "visual" || this.mode === "visual-line") {
			label = this.mode === "visual" ? "-- VISUAL --" : "-- V-LINE --";
			border = theme ? (s: string) => theme.fg("warning", s) : border;
		}
		this.borderColor = border;
		if (uiCtx?.hasUI) uiCtx.ui.setStatus("hotvim", label);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			const now = Date.now();
			const double = now - this.lastEscAt < 500;
			this.lastEscAt = now;
			if (double) {
				this.lastEscAt = 0;
				// cancel agent execution
				if (this.onEscape) this.onEscape();
				else super.handleInput(data);
				return;
			}
			if (this.mode === "insert") {
				this.setMode("normal");
				return;
			}
			this.handleModalKey(data); // clears pending/visual
			this.tui.requestRender();
			return;
		}
		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}
		// Pasting while in a modal mode → flip to INSERT and let it through
		if (data.startsWith("\u001b[200~")) {
			this.setMode("insert");
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			super.handleInput(data); // interrupt passthrough
			return;
		}
		if (this.passThroughAppKey(data)) {
			super.handleInput(data); // app/extension shortcuts work in all modes
			return;
		}
		this.handleModalKey(data);
		this.tui.requestRender();
	}

	/** Keys handled by the app (not text editing): extension shortcuts + app actions. */
	private passThroughAppKey(data: string): boolean {
		if (vimBridge.opener && matchesKey(data, vimBridge.opener)) return true;
		const self = this as unknown as {
			keybindings: { matches(d: string, a: string): boolean };
			actionHandlers: Map<string, () => void>;
		};
		if (self.keybindings.matches(data, "app.clipboard.pasteImage")) return true;
		for (const action of self.actionHandlers.keys()) {
			if (action === "app.interrupt" || action === "app.exit") continue;
			if (self.keybindings.matches(data, action)) return true;
		}
		return false;
	}

	// ------------------------------------------------------------ modal key handling

	private handleModalKey(data: string): void {
		const e = this.ed();
		const st = e.state;
		const visual = this.mode === "visual" || this.mode === "visual-line";

		if (matchesKey(data, "escape")) {
			if (visual) this.setMode("normal");
			else this.setMode(this.mode); // clears pending states
			return;
		}

		if (data === " ") {
			// leader → open the root hotkeys modal, which-key style
			vimBridge.openLauncher?.();
			return;
		}

		if (!visual && this.pendingReplace) {
			this.pendingReplace = false;
			if (isPrintable(data)) this.replaceChar(data);
			else this.syncModeUI();
			return;
		}

		if (!visual && this.pendingOp) {
			this.handleOperator(data);
			return;
		}

		if (this.tryMotion(data)) return;

		if (visual) {
			if (data === "d" || data === "x") {
				this.deleteSel();
				this.setMode("normal");
				return;
			}
			if (data === "y") {
				this.yankSel();
				this.setMode("normal");
				return;
			}
			if (data === "c") {
				this.deleteSel();
				this.setMode("insert");
				return;
			}
			if (data === "v") {
				if (this.mode === "visual") this.setMode("normal");
				else {
					// visual-line → charwise visual, keep selection anchor
					this.anchor = { line: st.cursorLine, col: st.cursorCol };
					this.setMode("visual");
				}
				return;
			}
			if (data === "V") {
				if (this.mode === "visual-line") this.setMode("normal");
				else {
					// charwise visual → linewise visual, keep selection anchor
					this.anchor = { line: st.cursorLine, col: st.cursorCol };
					this.setMode("visual-line");
				}
				return;
			}
			if (data === "i" || data === "a") {
				// leave visual into INSERT at selection start (i) or after end (a)
				const { start, end } = this.selRange();
				const target = this.mode === "visual-line"
					? data === "i"
						? { line: start.line, col: 0 }
						: { line: end.line, col: (st.lines[end.line] ?? "").length }
					: data === "i"
						? start
						: { line: end.line, col: Math.min(end.col + 1, (st.lines[end.line] ?? "").length) };
				st.cursorLine = target.line;
				e.setCursorCol(target.col);
				this.setMode("insert");
				return;
			}
			return; // swallow everything else in visual
		}

		// NORMAL mode commands
		const enterInsert = (line?: number, col?: number) => {
			if (line !== undefined) st.cursorLine = line;
			if (col !== undefined) e.setCursorCol(col);
			this.setMode("insert");
		};
		switch (data) {
			case "i":
				this.setMode("insert");
				return;
			case "I":
				enterInsert(st.cursorLine, firstNonBlank(st.lines[st.cursorLine] ?? ""));
				return;
			case "a":
				enterInsert(st.cursorLine, Math.min(st.cursorCol + 1, (st.lines[st.cursorLine] ?? "").length));
				return;
			case "A":
				enterInsert(st.cursorLine, (st.lines[st.cursorLine] ?? "").length);
				return;
			case "o": {
				e.pushUndoSnapshot();
				st.lines.splice(st.cursorLine + 1, 0, "");
				st.cursorLine++;
				e.onChange?.(e.getText());
				enterInsert(st.cursorLine, 0);
				return;
			}
			case "O": {
				e.pushUndoSnapshot();
				st.lines.splice(st.cursorLine, 0, "");
				e.onChange?.(e.getText());
				enterInsert(st.cursorLine, 0);
				return;
			}
			case "x":
				this.deleteCharAt(1);
				return;
			case "X":
				this.deleteCharAt(-1);
				return;
			case "r":
				this.pendingReplace = true;
				return;
			case "s": {
				const line = st.lines[st.cursorLine] ?? "";
				if (st.cursorCol < line.length) this.deleteCharAt(1);
				this.setMode("insert");
				return;
			}
			case "S": {
				e.pushUndoSnapshot();
				this.register = { type: "line", text: (st.lines[st.cursorLine] ?? "") + "\n" };
				st.lines[st.cursorLine] = "";
				e.setCursorCol(0);
				e.onChange?.(e.getText());
				this.setMode("insert");
				return;
			}
			case "J": {
				if (st.cursorLine < st.lines.length - 1) {
					e.pushUndoSnapshot();
					const cur = st.lines[st.cursorLine] ?? "";
					const next = st.lines[st.cursorLine + 1] ?? "";
					st.lines[st.cursorLine] = cur + next;
					st.lines.splice(st.cursorLine + 1, 1);
					e.setCursorCol(cur.length);
					e.onChange?.(e.getText());
				}
				return;
			}
			case "D":
				e.deleteToEndOfLine();
				return;
			case "v":
				this.startVisual(false);
				return;
			case "V":
				this.startVisual(true);
				return;
			case "C":
				e.deleteToEndOfLine();
				this.setMode("insert");
				return;
			case "d":
			case "c":
			case "y":
				this.pendingOp = data as "d" | "c" | "y";
				return;
			case "Y":
				this.register = { type: "line", text: (st.lines[st.cursorLine] ?? "") + "\n" };
				return;
			case "u":
				e.undo();
				return;
			case "p":
				this.paste(true);
				return;
			case "P":
				this.paste(false);
				return;
		}
		if (matchesKey(data, "return")) {
			super.handleInput(data); // submit from NORMAL
			return;
		}
		// Unknown keys are swallowed so text is never inserted outside INSERT
	}

	// ------------------------------------------------------------ motions (shared NORMAL/VISUAL)

	private tryMotion(data: string): boolean {
		const e = this.ed();
		const st = e.state;
		const jump = (p: Pos) => {
			st.cursorLine = Math.max(0, Math.min(p.line, st.lines.length - 1));
			e.setCursorCol(Math.max(0, Math.min(p.col, (st.lines[st.cursorLine] ?? "").length)));
		};
		if (data === "h" || matchesKey(data, "left")) {
			e.moveCursor(0, -1);
			return true;
		}
		if (data === "l" || matchesKey(data, "right")) {
			e.moveCursor(0, 1);
			return true;
		}
		if (data === "j" || matchesKey(data, "down")) {
			e.moveCursor(1, 0);
			return true;
		}
		if (data === "k" || matchesKey(data, "up")) {
			e.moveCursor(-1, 0);
			return true;
		}
		if (data === "0") {
			e.setCursorCol(0);
			return true;
		}
		if (data === "^") {
			e.setCursorCol(firstNonBlank(st.lines[st.cursorLine] ?? ""));
			return true;
		}
		if (data === "$") {
			e.setCursorCol((st.lines[st.cursorLine] ?? "").length);
			return true;
		}
		if (data === "g") {
			if (this.pendingG) {
				this.pendingG = false;
				jump({ line: 0, col: 0 });
			} else {
				this.pendingG = true;
			}
			return true;
		}
		this.pendingG = false;
		if (data === "G") {
			st.cursorLine = st.lines.length - 1;
			e.setCursorCol(0);
			return true;
		}
		if (data === "w") {
			jump(wordForward(st.lines, { line: st.cursorLine, col: st.cursorCol }));
			return true;
		}
		if (data === "b") {
			jump(wordBack(st.lines, { line: st.cursorLine, col: st.cursorCol }));
			return true;
		}
		if (data === "e") {
			jump(wordEnd(st.lines, { line: st.cursorLine, col: st.cursorCol }));
			return true;
		}
		if (matchesKey(data, "ctrl+d")) {
			e.pageScroll(1);
			return true;
		}
		if (matchesKey(data, "ctrl+u")) {
			e.pageScroll(-1);
			return true;
		}
		return false;
	}

	// ------------------------------------------------------------ operators (d/y/c + motion)

	private handleOperator(data: string): void {
		const op = this.pendingOp!;
		this.pendingOp = undefined;
		const e = this.ed();
		const st = e.state;
		const cur = (): Pos => ({ line: st.cursorLine, col: st.cursorCol });

		// dd / cc / yy — linewise
		if (data === "d" || data === "c" || (op === "y" && data === "y")) {
			if (op === "y") {
				this.register = { type: "line", text: (st.lines[st.cursorLine] ?? "") + "\n" };
				return;
			}
			e.pushUndoSnapshot();
			const line = st.lines[st.cursorLine] ?? "";
			this.register = { type: "line", text: line + "\n" };
			if (op === "d") {
				st.lines.splice(st.cursorLine, 1);
				if (st.lines.length === 0) st.lines.push("");
				st.cursorLine = Math.min(st.cursorLine, st.lines.length - 1);
				e.setCursorCol(0);
				e.onChange?.(e.getText());
			} else {
				st.lines[st.cursorLine] = "";
				e.setCursorCol(0);
				e.onChange?.(e.getText());
				this.setMode("insert");
			}
			return;
		}

		// motion targets, end-exclusive
		const start = cur();
		let end: Pos | undefined;
		if (data === "w") end = wordForward(st.lines, start);
		else if (data === "b") end = start;
		else if (data === "e") {
			const p = wordEnd(st.lines, start);
			end = { line: p.line, col: p.col + 1 };
		} else if (data === "$") end = { line: st.cursorLine, col: (st.lines[st.cursorLine] ?? "").length };
		else if (data === "0") end = { line: st.cursorLine, col: 0 };
		else if (data === "^") end = { line: st.cursorLine, col: firstNonBlank(st.lines[st.cursorLine] ?? "") };
		else if (data === "h") end = { line: st.cursorLine, col: Math.max(0, st.cursorCol - 1) };
		else if (data === "l") end = { line: st.cursorLine, col: Math.min(st.cursorCol + 1, (st.lines[st.cursorLine] ?? "").length) };
		if (!end) return;

		if (op === "y") {
			this.register = { type: "char", text: this.extractRange(start, end) };
			return;
		}
		e.pushUndoSnapshot();
		this.deleteRange(start, end);
		this.register = { type: "char", text: this.lastDeleted ?? "" };
		this.lastDeleted = undefined;
		e.onChange?.(e.getText());
		if (op === "c") this.setMode("insert");
	}

	private lastDeleted: string | undefined;

	// ------------------------------------------------------------ ranges

	private selRange(): { start: Pos; end: Pos } {
		const e = this.ed();
		const a = this.anchor ?? { line: e.state.cursorLine, col: e.state.cursorCol };
		const c = { line: e.state.cursorLine, col: e.state.cursorCol };
		const fwd = a.line < c.line || (a.line === c.line && a.col <= c.col);
		return fwd ? { start: a, end: c } : { start: c, end: a };
	}

	private extractRange(start: Pos, end: Pos): string {
		const lines = this.ed().state.lines;
		if (start.line === end.line) return (lines[start.line] ?? "").slice(start.col, end.col);
		const parts: string[] = [(lines[start.line] ?? "").slice(start.col)];
		for (let l = start.line + 1; l < end.line; l++) parts.push(lines[l] ?? "");
		parts.push((lines[end.line] ?? "").slice(0, end.col));
		return parts.join("\n");
	}

	/** Delete [start, end); captures removed text in this.lastDeleted. */
	private deleteRange(start: Pos, end: Pos): void {
		const e = this.ed();
		const lines = e.state.lines;
		if (start.line === end.line) {
			const l = lines[start.line] ?? "";
			this.lastDeleted = l.slice(start.col, end.col);
			lines[start.line] = l.slice(0, start.col) + l.slice(end.col);
		} else {
			const first = (lines[start.line] ?? "").slice(0, start.col);
			const last = (lines[end.line] ?? "").slice(end.col);
			this.lastDeleted = this.extractRange(start, end);
			lines.splice(start.line, end.line - start.line + 1, first + last);
		}
		e.state.cursorLine = start.line;
		e.setCursorCol(Math.min(start.col, (lines[start.line] ?? "").length));
	}

	private deleteSel(): void {
		const e = this.ed();
		e.pushUndoSnapshot();
		if (this.mode === "visual-line") {
			const { start, end } = this.selRange();
			const removed = e.state.lines.splice(start.line, end.line - start.line + 1);
			this.register = { type: "line", text: removed.join("\n") + "\n" };
			if (e.state.lines.length === 0) e.state.lines.push("");
			e.state.cursorLine = Math.min(start.line, e.state.lines.length - 1);
			e.setCursorCol(0);
			e.onChange?.(e.getText());
			return;
		}
		const { start, end } = this.selRange();
		this.deleteRange(start, { line: end.line, col: end.col + 1 });
		this.register = { type: "char", text: this.lastDeleted ?? "" };
		this.lastDeleted = undefined;
		e.onChange?.(e.getText());
	}

	private yankSel(): void {
		const { start, end } = this.selRange();
		if (this.mode === "visual-line") {
			const out: string[] = [];
			for (let l = start.line; l <= end.line; l++) out.push(this.ed().state.lines[l] ?? "");
			this.register = { type: "line", text: out.join("\n") + "\n" };
			return;
		}
		this.register = { type: "char", text: this.extractRange(start, { line: end.line, col: end.col + 1 }) };
	}

	// ------------------------------------------------------------ misc commands

	private deleteCharAt(dir: 1 | -1): void {
		const e = this.ed();
		const st = e.state;
		const line = st.lines[st.cursorLine] ?? "";
		const col = st.cursorCol;
		if (dir === 1 && col < line.length) {
			e.pushUndoSnapshot();
			this.register = { type: "char", text: line[col] ?? "" };
			st.lines[st.cursorLine] = line.slice(0, col) + line.slice(col + 1);
			e.setCursorCol(Math.min(col, (st.lines[st.cursorLine] ?? "").length));
			e.onChange?.(e.getText());
		} else if (dir === -1 && col > 0) {
			e.pushUndoSnapshot();
			this.register = { type: "char", text: line[col - 1] ?? "" };
			st.lines[st.cursorLine] = line.slice(0, col - 1) + line.slice(col);
			e.setCursorCol(col - 1);
			e.onChange?.(e.getText());
		}
	}

	private replaceChar(ch: string): void {
		const e = this.ed();
		const st = e.state;
		const line = st.lines[st.cursorLine] ?? "";
		if (st.cursorCol >= line.length) return; // vim: r at EOL does nothing
		e.pushUndoSnapshot();
		st.lines[st.cursorLine] = line.slice(0, st.cursorCol) + ch + line.slice(st.cursorCol + 1);
		e.setCursorCol(st.cursorCol);
		e.onChange?.(e.getText());
		this.syncModeUI();
	}

	private paste(after: boolean): void {
		const e = this.ed();
		const reg = this.register;
		if (!reg) return;
		e.pushUndoSnapshot();
		const st = e.state;
		if (reg.type === "line") {
			const at = st.cursorLine + (after ? 1 : 0);
			st.lines.splice(at, 0, ...reg.text.replace(/\n$/, "").split("\n"));
			st.cursorLine = at;
			e.setCursorCol(0);
		} else {
			const line = st.lines[st.cursorLine] ?? "";
			const col = st.cursorCol + (after && line.length > 0 ? 1 : 0);
			st.lines[st.cursorLine] = line.slice(0, col) + reg.text + line.slice(col);
			// vim: p → cursor on last pasted char, P → cursor on first pasted char
			e.setCursorCol(after ? col + reg.text.length - 1 : col);
		}
		e.onChange?.(e.getText());
	}

	/**
	 * Mode-shaped cursor: thin bar in INSERT, block elsewhere. The editor draws a
	 * fake cursor as a reverse-video cell; rewrite it after super.render().
	 */
	render(width: number): string[] {
		const lines = super.render(width);
		if (this.mode !== "insert") return lines;
		// Underline the cursor char instead of swapping in ▏: terminal cursor is a
		// fake reverse-video cell, so a bar glyph would hide the char underneath.
		return lines.map((line) => {
			const m = line.match(/\x1b\[7m([^\x1b]*)\x1b\[0m/);
			if (!m) return line;
			const ch = m[1] || " ";
			const colored = uiCtx?.ui.theme ? uiCtx.ui.theme.fg("accent", ch) : ch;
			return line.replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/, `\x1b[4m${colored}\x1b[24m`);
		});
	}

	/** Enter visual mode (used by modals/tests too). */
	startVisual(linewise: boolean): void {
		const st = this.ed().state;
		this.anchor = { line: st.cursorLine, col: st.cursorCol };
		this.mode = linewise ? "visual-line" : "visual";
		this.syncModeUI();
	}
}

function applyVimEditor(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	uiCtx = ctx;
	if (vimEnabled) {
		if (vimBridge.editor) return; // already installed
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const ed = new VimEditor(tui, theme, keybindings);
			vimBridge.editor = ed;
			ed.setMode("insert");
			return ed;
		});
	} else {
		ctx.ui.setEditorComponent(undefined);
		vimBridge.editor = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("hotvim", undefined);
	}
}

// ---------------------------------------------------------------- modal component

type ListKind = "models" | "roles" | "skills" | "sessions" | "actions" | "copy";

type SelectionResult =
	| { kind: "model"; value: string }
	| { kind: "role"; value: string }
	| { kind: "skill"; value: string }
	| { kind: "session"; value: string }
	| { kind: "copyLast" }
	| { kind: "copyContext" }
	| { kind: "direct"; def: ActionDef };

interface Deps {
	config: HotkeysConfig;
	buildItems: (kind: ListKind) => SelectItem[];
	loadSessions: () => Promise<SelectItem[]>;
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
		initialAction?: string,
	) {
		if (initialAction) {
			const def = deps.actionByKey(initialAction);
			if (def) this.runDef(def);
		}
	}

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
		if (data === "i") {
			// `i` from anywhere → close modal, focus input in INSERT
			vimBridge.editor?.setMode("insert");
			this.done(undefined);
			return;
		}
		if (data === "y") {
			this.openList("copy", "");
			return;
		}
		if (data === "/") {
			this.openList("actions", "");
			this.filterMode = true; // straight into free-text search
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
		if (data === "i") {
			vimBridge.editor?.setMode("insert");
			this.done(undefined);
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
		if (this.kind === "copy" && (data === "l" || data === "f")) {
			this.done(data === "f" ? { kind: "copyContext" } : { kind: "copyLast" });
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

	private newList(items: SelectItem[]): SelectList {
		return new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
	}

	private openList(kind: ListKind, seedQuery: string): void {
		this.view = "list";
		this.kind = kind;
		this.query = seedQuery;
		this.filterMode = seedQuery.length > 0;

		if (kind === "sessions") {
			// Sessions load async; show a placeholder and swap in the real list.
			this.allItems = [{ value: "", label: "  loading…", description: undefined }];
			this.list = this.newList(this.allItems);
			this.applyFilter();
			void this.loadSessionsAsync();
			return;
		}

		this.allItems = this.deps.buildItems(kind);
		this.list = this.newList(this.allItems);
		this.applyFilter();
	}

	private async loadSessionsAsync(): Promise<void> {
		const items = await this.deps.loadSessions();
		if (this.view !== "list" || this.kind !== "sessions") return;
		this.allItems = items;
		this.list = this.newList(items);
		this.applyFilter();
		this.tui.requestRender();
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
		if (this.kind === "skills") {
			this.done({ kind: "skill", value });
			return;
		}
		if (this.kind === "sessions") {
			this.done({ kind: "session", value });
			return;
		}
		if (this.kind === "copy") {
			this.done(value === "context" ? { kind: "copyContext" } : { kind: "copyLast" });
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
		if (def.type === "skills") {
			this.openList("skills", "");
			return;
		}
		if (def.type === "sessions") {
			this.openList("sessions", "");
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
		const row = (content: string) => th.fg("accent", "│") + pad(content, innerW) + th.fg("accent", "│");

		lines.push(th.fg("accent", `╭${"─".repeat(innerW)}╮`));

		if (this.view === "root") {
			lines.push(row(""));
			lines.push(row(` ${th.fg("accent", th.bold("⌨ hotkeys"))}`));
			lines.push(row(""));

			const entries = Object.entries(this.deps.config.actions ?? {})
				.filter(([key]) => key.length === 1)
				.map(([key, def]) => [key, actionLabel(key, def)] as const)
				.sort(([a], [b]) => a.localeCompare(b));

			if (entries.length === 0) {
				lines.push(row(` ${th.fg("dim", "(no actions configured)")}`));
			} else {
				for (const [key, label] of entries) {
					lines.push(row(` ${th.fg("accent", th.bold(key))}  ${th.fg("text", label)}`));
				}
			}

			lines.push(row(""));
			lines.push(
				row(
					` ${th.fg("dim", "i")} ${th.fg("dim", "insert")}   ${th.fg("dim", "␣")} ${th.fg("dim", "leader")}   ${th.fg("dim", "/")} ${th.fg("dim", "search")}   ${th.fg("dim", "esc")} ${th.fg("dim", "quit")}`,
				),
			);
			lines.push(row(""));
		} else {
			const title = this.kind === "models" ? "models" : this.kind === "roles" ? "roles" : this.kind === "skills" ? "skills" : this.kind === "sessions" ? "sessions" : this.kind === "copy" ? "copy" : "actions";
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

		lines.push(th.fg("accent", `╰${"─".repeat(innerW)}╯`));
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
	vimBridge.opener = (globalConfig.opener ?? "super+e") as KeyId;
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
			loadSessions: async () => {
				const current = ctx.sessionManager.getSessionFile();
				try {
					const list = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
					return list
						.sort((a, b) => b.modified.getTime() - a.modified.getTime())
						.map((s) => ({
							value: s.path,
							label: s.path === current ? `● ${sessionLabel(s)}` : `  ${sessionLabel(s)}`,
							description: s.cwd,
						}));
				} catch (err) {
					console.error(`hotkeys: failed to list sessions: ${(err as Error).message}`);
					return [];
				}
			},
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
				if (kind === "skills") {
					return pi
						.getCommands()
						.filter((c) => c.source === "skill")
						.map((c) => ({
							value: c.name,
							label: `  ${c.name.replace(/^skill:/, "")}`,
							description: c.description,
						}))
						.sort((a, b) => a.label.localeCompare(b.label));
				}
				// sessions list is loaded async via deps.loadSessions (buildItems is sync)
				if (kind === "sessions") return [];
				if (kind === "copy") {
					return [
						{ value: "last", label: "  l  last output", description: "copy most recent assistant message" },
						{ value: "context", label: "  f  full context", description: "copy full conversation context" },
					];
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

	async function open(ctx: ExtensionContext, initialAction?: string): Promise<void> {
		if (!ctx.hasUI) return;
		uiCtx = ctx;
		vimBridge.openLauncher = (action?: string) => {
			void open(ctx, action);
		};
		// Refresh config so edits to hotkeys.json/roles.json take effect without /reload
		config = loadConfig(ctx);

		const result = await ctx.ui.custom<SelectionResult | undefined>(
			(tui, theme, _kb, done) => new HotkeysModal(theme, tui, done, buildDeps(ctx), initialAction),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: (config.width ?? "50%") as SizeValue,
					minWidth: 40,
					maxHeight: (config.maxHeight ?? "90%") as SizeValue,
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

		if (result.kind === "copyLast" || result.kind === "copyContext") {
			const text = result.kind === "copyLast" ? lastOutputText(ctx) : fullContextText(ctx);
			if (!text || !text.trim()) {
				notify("hotkeys: nothing to copy yet", "warning");
				return;
			}
			try {
				await copyToClipboard(text);
				notify("copied to clipboard", "info");
			} catch {
				notify("hotkeys: clipboard unavailable", "error");
			}
			return;
		}

		if (result.kind === "role") {
			dispatchCommand(result.value === "(none)" ? "/role none" : `/role ${result.value}`);
			return;
		}

		if (result.kind === "skill") {
			dispatchCommand(`/${result.value}`);
			return;
		}

		if (result.kind === "session") {
			dispatchCommand(`/hotvim-do resume ${result.value}`);
			return;
		}

		// direct action
		const def = result.def;
		if (def.type === "new") {
			dispatchCommand("/hotvim-do new");
			return;
		}
		if (def.type === "compact") {
			ctx.compact();
			notify("compacting session", "info");
			return;
		}
		if (def.type === "reload") {
			dispatchCommand("/hotvim-do reload");
			return;
		}
		if (def.type === "update") {
			notify("updating pi (pi update --all)…", "info");
			const res = await pi.exec("pi", ["update", "--all"]);
			if (res.code === 0) {
				dispatchCommand("/hotvim-do reload");
			} else {
				const err = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
				notify(`hotkeys: pi update failed: ${err}`, "error");
			}
			return;
		}
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

	pi.registerCommand("hotvim-do", {
		description: "hotkeys internal: session control (new/reload/resume)",
		handler: async (args, ctx) => {
			const space = args.indexOf(" ");
			const op = space === -1 ? args.trim() : args.slice(0, space).trim();
			const arg = space === -1 ? "" : args.slice(space + 1).trim();
			if (op === "new") {
				await ctx.newSession();
				return;
			}
			if (op === "reload") {
				await ctx.reload();
				return;
			}
			if (op === "resume") {
				await ctx.switchSession(arg);
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(`hotkeys: unknown internal action: ${op || "(empty)"}`, "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx);
		vimEnabled = config.vim ?? true;
		applyVimEditor(ctx);
		vimBridge.openLauncher = (action?: string) => {
			if (uiCtx) void open(uiCtx, action);
		};
		// Restore model MRU from session entries
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MRU_ENTRY) {
				const data = entry.data as { models?: string[] } | undefined;
				if (Array.isArray(data?.models)) mruModels = data!.models!.slice(0, MRU_MAX);
			}
		}
	});

	pi.registerCommand("vim-mode", {
		description: "Toggle vim input mode (NORMAL/INSERT/VISUAL in the prompt editor)",
		handler: async (_args, ctx) => {
			vimEnabled = !vimEnabled;
			applyVimEditor(ctx);
			if (ctx.hasUI) ctx.ui.notify(`vim mode ${vimEnabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
