# Roles

Config for the `roles` extension (`~/.pi/agent/extensions/roles/index.ts`).

## Files

| Path | Purpose |
|------|---------|
| `~/.pi/agent/roles/roles.json` | Global roles + `"active"` default |
| `~/.pi/agent/roles/<name>.json` | One role per file (name = filename), merged over `roles.json` |
| `<project>/.pi/roles.json` | Project-local, wins over global (trusted projects only) |
| `<project>/.pi/roles/<name>.json` | Project-local single role |

Merge is per-role shallow merge; later source wins.

## Role fields

```jsonc
{
  "description": "shown in /role picker + completions",
  "model": "provider/model-id",       // optional; bare "model-id" also resolved
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "systemPrompt": "inline text",
  "systemPromptFile": "prompts/x.md", // relative to this config dir, or cwd
  "promptMode": "append",             // "append" (default) | "replace"
  "tools": { "allow": ["read", "mcp_*"], "deny": ["bash"] },
  "skills": ["test*"],                // name globs kept in prompt; omit = keep all
  "contextFiles": ["docs/arch.md"],   // appended to system prompt each turn
  "hidden": false                     // exclude from picker + cycling
}
```

`"tools": ["read", "grep"]` is shorthand for `{ "allow": [...] }`.
Legacy `allowedTools` / `deniedTools` also accepted.
Globs support `*` only.

## Usage

- `/role` — picker
- `/role <name>` — switch
- `/role none` — clear role, restore startup tool set
- `/role reload` — re-read config files
- `alt+r` — cycle next, `alt+b` (or `shift+alt+r` on Kitty-protocol terminals) — cycle previous
- Footer shows `◆ <role>`

## Semantics

- Active role is **session-scoped**: stored as a `role-switch` custom session entry, restored on `/resume` and `/fork`. `"active"` in JSON is only the fresh-session default.
- Tool pool = tools active at session start, plus any tool registered later (MCP, dynamic). A role can never enable a tool you disabled globally.
- Switching is refused while the agent is busy.
- `skills` filters the `<available_skills>` block in the system prompt. It does **not** hide `/skill:<name>` slash commands — pi has no runtime API for that.
- `promptMode: "replace"` drops pi's base prompt for that turn, including built-in tool guidelines.
- Model failures (unknown model / missing API key) warn and keep the current model; everything else in the role still applies.

## Dev

`node roles/_smoke.mjs` runs the extension against a mock `ExtensionAPI` and prints tool/model/prompt effects.
