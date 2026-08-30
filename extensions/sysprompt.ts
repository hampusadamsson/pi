/**
 * /sysprompt — floating modal showing the effective system prompt plus
 * the base inputs Pi used to build it (tools, skills, context files).
 *
 * Keys:
 *   Tab / 1-4     switch section (prompt / tools / skills / context)
 *   j / Down      scroll down
 *   k / Up        scroll up
 *   Ctrl+d / u    half page down / up
 *   PageDown / u  full page down / up
 *   g, gg         jump to top
 *   G             jump to bottom
 *   q / Esc       close
 *
 * Note: tool JSON schemas are sent as a separate payload field and never
 * appear in the system-prompt text; the tools tab lists them explicitly.
 */
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const VIEWPORT_ROWS = 18;

interface Section {
	label: string;
	lines: string[];
	offset: number;
}

class SysPromptModal {
	private sections: Section[] = [];
	private active = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private builtForWidth?: number;

	public onClose: () => void = () => {};

	constructor(
		private readonly promptText: string,
		private readonly options: BuildSystemPromptOptions | undefined,
	) {}

	handleInput(data: string): void {
		const section = this.sections[this.active]!;

		if (matchesKey(data, Key.escape) || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.active = (this.active + 1) % this.sections.length;
			this.invalidate();
			return;
		}
		const num = data.match(/^[1-4]$/);
		if (num) {
			this.active = Number(num[0]) - 1;
			this.invalidate();
			return;
		}

		const maxOffset = Math.max(section.lines.length - VIEWPORT_ROWS, 0);

		if (matchesKey(data, Key.down) || data === "j") {
			section.offset = Math.min(section.offset + 1, maxOffset);
		} else if (matchesKey(data, Key.up) || data === "k") {
			section.offset = Math.max(section.offset - 1, 0);
		} else if (matchesKey(data, Key.ctrl("d"))) {
			section.offset = Math.min(section.offset + Math.ceil(VIEWPORT_ROWS / 2), maxOffset);
		} else if (matchesKey(data, Key.ctrl("u"))) {
			section.offset = Math.max(section.offset - Math.ceil(VIEWPORT_ROWS / 2), 0);
		} else if (matchesKey(data, Key.pageDown)) {
			section.offset = Math.min(section.offset + VIEWPORT_ROWS, maxOffset);
		} else if (matchesKey(data, Key.pageUp)) {
			section.offset = Math.max(section.offset - VIEWPORT_ROWS, 0);
		} else if (data === "G" || matchesKey(data, Key.end)) {
			section.offset = maxOffset;
		} else if (data === "g" || matchesKey(data, Key.home)) {
			// Plain g and gg both mean top (vim's gg).
			section.offset = 0;
		} else {
			return;
		}
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const innerWidth = Math.max(width - 4, 10); // borders + padding
		if (this.builtForWidth !== innerWidth) {
			// Re-wrap all sections so nothing is lost on narrower terminals.
			this.rebuildSections(innerWidth - 4);
			this.builtForWidth = innerWidth;
		}
		for (const section of this.sections) {
			section.offset = Math.min(
				section.offset,
				Math.max(section.lines.length - VIEWPORT_ROWS, 0),
			);
		}

		const section = this.sections[this.active]!;
		const view = section.lines.slice(section.offset, section.offset + VIEWPORT_ROWS);
		while (view.length < VIEWPORT_ROWS) view.push("");

		const pos =
			section.lines.length === 0
				? "empty"
				: `${section.offset + 1}-${Math.min(
						section.offset + VIEWPORT_ROWS,
						section.lines.length,
					)} / ${section.lines.length}`;

		const tabs = this.sections
			.map((s, i) => (i === this.active ? `[${i + 1} ${s.label}]` : `${i + 1} ${s.label}`))
			.join("  ");
		const hints = `Tab switch  j/k scroll  ctrl+d/u half-page  g/G top/bottom  q/Esc close`;

		const lines: string[] = [];
		lines.push(this.row(`╭${` ${tabs} `.padEnd(innerWidth + 2, "─")}╮`, width));
		for (const text of view) {
			lines.push(this.row(`│ ${text.padEnd(innerWidth)} │`, width));
		}
		lines.push(
			this.row(`├${`${pos}  ${hints}`.padEnd(innerWidth + 2, "─")}┤`, width),
		);
		lines.push(this.row(`╰${"".padEnd(innerWidth + 2, "─")}╯`, width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private row(line: string, width: number): string {
		return truncateToWidth(line, width);
	}

	private rebuildSections(wrapWidth: number): void {
		const old = new Map(this.sections.map((s) => [s.label, s.offset]));
		this.sections = [
			this.buildPromptSection(this.promptText, wrapWidth),
			this.buildToolsSection(this.options, wrapWidth),
			this.buildSkillsSection(wrapWidth),
			this.buildContextSection(this.options),
		];
		for (const section of this.sections) {
			section.offset = old.get(section.label) ?? 0;
		}
		this.active = Math.min(this.active, this.sections.length - 1);
	}

	private buildPromptSection(text: string, wrapWidth: number): Section {
		return { label: "prompt", lines: wrapTextWithAnsi(text, wrapWidth), offset: 0 };
	}

	private buildToolsSection(options: BuildSystemPromptOptions | undefined, wrapWidth: number): Section {
		if (!options?.selectedTools?.length) {
			return { label: "tools", lines: ["No active tools reported."], offset: 0 };
		}
		const lines: string[] = [
			`${options.selectedTools.length} active tool(s). Schemas go in the provider payload, not the prompt text.`,
			"",
		];
		for (const name of options.selectedTools) {
			const snippet = options.toolSnippets?.[name];
			if (snippet) {
				lines.push(`• ${name}`);
				for (const wrapped of wrapTextWithAnsi(snippet, wrapWidth - 4)) {
					lines.push(`    ${wrapped}`);
				}
			} else {
				lines.push(`• ${name}`);
			}
		}
		return { label: "tools", lines, offset: 0 };
	}

	/**
	 * The roles extension filters skills by rewriting the <available_skills> block
	 * in the prompt text itself; options.skills is the raw pre-filter discovery list.
	 * Derive the effective set from the prompt so the tab respects the active role.
	 */
	private effectiveSkills(): { kept: BuildSystemPromptOptions["skills"]; discovered: number } {
		const discovered = this.options?.skills ?? [];
		const open = this.promptText.indexOf("<available_skills>");
		if (open === -1) return { kept: [], discovered: discovered.length };
		const close = this.promptText.indexOf("</available_skills>", open);
		if (close === -1) return { kept: [], discovered: discovered.length };

		const block = this.promptText.slice(open, close);
		const byName = new Map(discovered.map((s) => [s.name, s]));
		const kept = (block.match(/<skill>[\s\S]*?<\/skill>/g) ?? [])
			.map((entry) => /<name>([\s\S]*?)<\/name>/.exec(entry)?.[1]?.trim() ?? "")
			.map((name) => byName.get(name))
			.filter((s): s is NonNullable<typeof s> => s !== undefined);
		return { kept, discovered: discovered.length };
	}

	private buildSkillsSection(wrapWidth: number): Section {
		const { kept, discovered } = this.effectiveSkills();
		if (discovered === 0) {
			return {
				label: "skills",
				lines: ["No skills discovered (check project trust, skill locations, frontmatter description)."],
				offset: 0,
			};
		}
		if (kept.length === 0) {
			return {
				label: "skills",
				lines: [
					`0 of ${discovered} skill(s) active — active role filtered all skills out of the prompt.`,
				],
				offset: 0,
			};
		}
		const filtered = kept.length < discovered;
		const lines: string[] = [
			filtered
				? `${kept.length} of ${discovered} skill(s) active (rest filtered by role).`
				: `${kept.length} skill(s) active.`,
		];
		if (kept.some((s) => s.disableModelInvocation)) {
			lines.push("Marked ✗ are hidden from the model (/skill:name only).");
		}
		lines.push("");
		for (const skill of kept) {
			const flag = skill.disableModelInvocation ? "✗" : "✓";
			lines.push(`${flag} ${skill.name}`);
			for (const wrapped of wrapTextWithAnsi(skill.description, wrapWidth - 4)) {
				lines.push(`    ${wrapped}`);
			}
		}
		return { label: "skills", lines, offset: 0 };
	}

	private buildContextSection(options: BuildSystemPromptOptions | undefined): Section {
		const files = options?.contextFiles ?? [];
		if (files.length === 0) {
			return { label: "context", lines: ["No context files loaded."], offset: 0 };
		}
		const lines: string[] = [`${files.length} context file(s), included in full:`];
		lines.push("");
		for (const file of files) {
			lines.push(`• ${file.path} (${file.content.length} chars)`);
		}
		return { label: "context", lines, offset: 0 };
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sysprompt", {
		description: "Show system prompt, tools, skills, and context in a scrollable modal",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("sysprompt requires interactive mode", "error");
				return;
			}

			const prompt = ctx.getSystemPrompt();
			const options = ctx.getSystemPromptOptions();
			if ((!prompt || prompt.length === 0) && !options) {
				ctx.ui.notify("No system prompt yet — run a turn first", "warning");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, _theme, _keybindings, done) => {
					const modal = new SysPromptModal(prompt ?? "", options);
					modal.onClose = () => done();
					return {
						render: (width) => modal.render(width),
						handleInput: (data) => {
							modal.handleInput(data);
							tui.requestRender();
						},
						invalidate: () => modal.invalidate(),
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "80%", minWidth: 60 },
				},
			);
		},
	});
}
