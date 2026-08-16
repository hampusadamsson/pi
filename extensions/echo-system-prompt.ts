/**
 * Echo Full Payload Extension
 *
 * Echoes out the ENTIRE provider payload (system prompt + all messages)
 * exactly as it is being sent to the model. Logs everything to a file
 * and provides status widgets showing prompt length and message counts.
 * Uses `before_provider_request` to capture the exact payload sent to
 * the provider, and also uses `ctx.getSystemPrompt()` for a clean string
 * representation of just the system prompt.
 *
 * Provides /tools (active only) and /tools-all (all tools) for tool context sizes,
 * and /tools-detailed to see each tool's parameters schema and the full system prompt text
 * (with tool definitions) exactly as it appears to the model.
 *
 * Place in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local).
 * Test with: pi -e ./echo-system-prompt.ts
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Format byte size for display.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Calculate the byte length of a string using Buffer (Node.js).
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Calculate the context size of a tool definition.
 * This measures how much space the tool's serialized definition
 * would occupy when included in the system prompt sent to the model.
 * The total includes: name, description, parameters schema JSON, and prompt guidelines.
 */
function calculateToolContextSize(tool: {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
}): { chars: number; bytes: number; descriptionChars: number; schemaBytes: number } {
  const namePart = tool.name;
  const descriptionPart = tool.description || "";

  // Serialize the parameters schema to get its size
  let schemaStr = "";
  try {
    schemaStr = JSON.stringify(tool.parameters);
  } catch {
    schemaStr = String(tool.parameters);
  }

  // Guidelines also contribute to context
  const guidelinesStr = tool.promptGuidelines?.join("\n") || "";

  // Total context = name + description + parameters JSON + guidelines
  const totalStr = [namePart, descriptionPart, schemaStr, guidelinesStr].filter(Boolean).join("\n");

  return {
    chars: totalStr.length,
    bytes: byteLength(totalStr),
    descriptionChars: descriptionPart.length,
    schemaBytes: byteLength(schemaStr),
  };
}

/**
 * Extract the system prompt text from a provider-agnostic payload object.
 *
 * Handles:
 * - Anthropic: payload.system (string) or embedded in messages as role "system"
 * - OpenAI / compatible: payload.messages[0] with role "system"
 * - Generic: any payload format with messages array
 */
function extractSystemPrompt(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const p = payload as Record<string, unknown>;

  // Anthropic-style: payload.system as a string
  if (typeof p.system === "string") return p.system;

  // Anthropic-style: payload.system as an array of content blocks
  if (Array.isArray(p.system)) {
    return p.system
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // OpenAI / compatible: messages array with a system message
  if (Array.isArray(p.messages)) {
    const systemMsg = p.messages.find(
      (m: unknown) => m && typeof m === "object" && (m as Record<string, unknown>).role === "system",
    );
    if (systemMsg) {
      const sm = systemMsg as Record<string, unknown>;
      if (typeof sm.content === "string") return sm.content;
      if (Array.isArray(sm.content)) {
        return sm.content
          .map((block: unknown) => {
            if (typeof block === "string") return block;
            if (block && typeof block === "object") {
              const b = block as Record<string, unknown>;
              if (b.type === "text" && typeof b.text === "string") return b.text;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
    }
  }

  return null;
}

/**
 * Extract all messages from a provider-agnostic payload object.
 * Returns an array of { role, summary, content } for each message.
 */
function extractAllMessages(payload: unknown): Array<{
  role: string;
  summary: string;
  contentPreview: string;
}> {
  if (!payload || typeof payload !== "object") return [];

  const p = payload as Record<string, unknown>;
  const messages: Array<{ role: string; summary: string; contentPreview: string }> = [];

  // Anthropic-style: messages array
  if (Array.isArray(p.messages)) {
    for (const msg of p.messages) {
      if (!msg || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const role = String(m.role ?? "unknown");

      let contentText = "";
      if (typeof m.content === "string") {
        contentText = m.content;
      } else if (Array.isArray(m.content)) {
        contentText = m.content
          .map((block: unknown) => {
            if (typeof block === "string") return block;
            if (block && typeof block === "object") {
              const b = block as Record<string, unknown>;
              if (b.type === "text" && typeof b.text === "string") return b.text;
              if (b.type === "tool_use" || b.type === "tool_call") {
                return `[ToolCall: ${b.name ?? "?"} id=${b.id ?? "?"}]`;
              }
              if (b.type === "tool_result") {
                return `[ToolResult: ${b.tool_use_id ?? "?"}]`;
              }
              return `[${b.type ?? "block"}]`;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }

      // Build a one-line summary
      let summary = role;
      if (role === "tool" && m.tool_call_id) {
        summary += ` call=${m.tool_call_id}`;
      }
      if (m.name) {
        summary += ` name=${m.name}`;
      }

      // Content preview (first 120 chars)
      const preview = contentText.slice(0, 120).replace(/\n/g, "\\n");

      messages.push({ role, summary, contentPreview: preview });
    }
  }

  return messages;
}

/**
 * Format a timestamp for the log file.
 */
function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Pretty-print a JSON value with limited depth and string truncation.
 */
function limitedJsonStringify(obj: unknown, maxDepth = 6, maxStringLen = 500): string {
  const seen = new WeakSet();

  function recurse(val: unknown, depth: number): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === "string") {
      if (val.length > maxStringLen) return val.slice(0, maxStringLen) + `... [truncated, total ${val.length} chars]`;
      return val;
    }
    if (typeof val === "number" || typeof val === "boolean") return val;
    if (depth > maxDepth) return "[max depth]";

    if (Array.isArray(val)) {
      if (seen.has(val)) return "[circular]";
      seen.add(val);
      const arr = val.map((v) => recurse(v, depth + 1));
      return arr;
    }

    if (typeof val === "object") {
      if (seen.has(val)) return "[circular]";
      seen.add(val);
      const obj: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
        obj[key] = recurse(v, depth + 1);
      }
      return obj;
    }

    return String(val);
  }

  return JSON.stringify(recurse(obj, 0), null, 2);
}

export default function echoSystemPrompt(pi: ExtensionAPI) {
  // ----- Persistent right sidebar showing active tools -----
  let sidebarHandle: { hide(): void; unfocus(): void } | null = null;
  let sidebarRequestRender: (() => void) | null = null;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    void ctx.ui.custom<void>(
      (tui, theme, _kb, _done) => {
        sidebarRequestRender = () => tui.requestRender();

        return {
          render(width: number): string[] {
            const activeNames = new Set(pi.getActiveTools());
            const activeTools = pi.getAllTools()
              .filter(t => activeNames.has(t.name))
              .sort((a, b) => a.name.localeCompare(b.name));

            const lines: string[] = [];
            const innerW = width - 1; // 1 char for left border
            const bdr = (s: string) => theme.fg("border", s);

            // Title: │ Tools
            lines.push(
              bdr("│") + truncateToWidth(" " + theme.bold(theme.fg("accent", "Tools")), innerW),
            );
            // Separator: │──────...
            lines.push(bdr("│" + "─".repeat(innerW)));

            // One tool per row, sorted by name
            for (const tool of activeTools) {
              lines.push(bdr("│") + truncateToWidth(" " + tool.name, innerW));
            }

            if (activeTools.length === 0) {
              lines.push(bdr("│") + truncateToWidth(" " + theme.fg("muted", "(none)"), innerW));
            }

            // Gap between sections
            lines.push(bdr("│"));

            // Skills section
            const skills = pi.getCommands()
              .filter(c => c.source === "skill")
              .sort((a, b) => a.name.localeCompare(b.name));

            lines.push(
              bdr("│") + truncateToWidth(" " + theme.bold(theme.fg("accent", "Skills")), innerW),
            );
            lines.push(bdr("│" + "─".repeat(innerW)));

            for (const skill of skills) {
              const displayName = skill.name.startsWith("skill:") ? skill.name.slice(6) : skill.name;
              lines.push(bdr("│") + truncateToWidth(" " + displayName, innerW));
            }

            if (skills.length === 0) {
              lines.push(bdr("│") + truncateToWidth(" " + theme.fg("muted", "(none)"), innerW));
            }

            // Bottom padding
            lines.push(bdr("│"));
            lines.push(bdr("│"));

            return lines;
          },
          handleInput(_data: string): void {},
          invalidate(): void {},
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-right",
          width: 28,
          margin: 0,
          visible: (w) => w >= 80,
        },
        onHandle: (handle) => {
          sidebarHandle = handle;
          handle.unfocus();
        },
      },
    );
  });

  // Trigger sidebar re-render when tool set may have changed
  pi.on("before_agent_start", (_event, _ctx) => {
    sidebarRequestRender?.();
  });

  pi.on("agent_end", (_event, _ctx) => {
    sidebarRequestRender?.();
  });

  // ----- Echo via before_provider_request (exact payload sent to the model) -----
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;

    // Determine log directory: use project's .pi or a sensible fallback
    const logDir = join(ctx.cwd, CONFIG_DIR_NAME);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const sysLogFile = join(logDir, "system-prompt.log");
    const fullLogFile = join(logDir, "full-payload.log");

    // 1. Extract system prompt
    const extracted = extractSystemPrompt(payload);
    const systemPrompt = extracted ?? "";
    const piSystemPrompt = ctx.getSystemPrompt() ?? "";
    const effectivePrompt = systemPrompt || piSystemPrompt;

    // 2. Extract all messages
    const allMessages = extractAllMessages(payload);

    // 3. Build system prompt log entry (backwards compatible)
    const sysLogEntry = [
      `=== System Prompt Dump [${timestamp()}] ===`,
      `--- Source: ${extracted ? "provider_payload" : "ctx.getSystemPrompt()"} ---`,
      `Length: ${effectivePrompt.length.toLocaleString()} chars`,
      `--- BEGIN SYSTEM PROMPT ---`,
      effectivePrompt,
      `--- END SYSTEM PROMPT ---`,
      "",
    ].join("\n");

    // 4. Build full payload log entry
    const messageSummary = allMessages
      .map((m) => `  [${m.summary}] ${m.contentPreview}`)
      .join("\n");

    // Count by role
    const roleCounts: Record<string, number> = {};
    for (const m of allMessages) {
      roleCounts[m.role] = (roleCounts[m.role] || 0) + 1;
    }
    const roleSummary = Object.entries(roleCounts)
      .map(([r, c]) => `${r}:${c}`)
      .join(", ");

    const fullLogEntry = [
      `=== Full Payload Dump [${timestamp()}] ===`,
      `Messages: ${allMessages.length} total (${roleSummary})`,
      `--- MESSAGE SUMMARY ---`,
      messageSummary || "  (no messages in payload)",
      `--- END MESSAGE SUMMARY ---`,
      "",
      `--- RAW PAYLOAD (truncated) ---`,
      limitedJsonStringify(payload, 6, 500),
      `--- END RAW PAYLOAD ---`,
      "",
    ].join("\n");

    // // Write to log files
    // try {
    //   appendFileSync(sysLogFile, sysLogEntry, "utf8");
    // } catch {
    //   // Silently fail
    // }
    // try {
    //   appendFileSync(fullLogFile, fullLogEntry, "utf8");
    // } catch {
    //   // Silently fail
    // }
    //
    // Echoing to stdout removed — use /tools-detailed to view the full prompt


  });

  // ----- Register a command to view the last logged system prompt -----
  pi.registerCommand("sysprompt", {
    description: "Show the last logged system prompt in the TUI",
    handler: async (_args, ctx) => {
      const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "system-prompt.log");
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(logFile, "utf8");
        const dumps = content.split("=== System Prompt Dump [");
        if (dumps.length <= 1) {
          ctx.ui.notify("No system prompt logged yet", "warning");
          return;
        }
        const lastDump = dumps[dumps.length - 1];
        const match = lastDump.match(/--- BEGIN SYSTEM PROMPT ---\n([\s\S]*?)\n--- END SYSTEM PROMPT ---/);
        if (match) {
          const prompt = match[1];
          ctx.ui.setWidget("sysprompt", [
            "--- System Prompt ---",
            ...prompt.split("\n").slice(0, 50),
            prompt.split("\n").length > 50 ? `... (${prompt.split("\n").length - 50} more lines)` : "",
          ]);
          ctx.ui.notify(`System prompt: ${prompt.length.toLocaleString()} chars`, "info");
        } else {
          ctx.ui.notify("Could not parse last system prompt dump", "error");
        }
      } catch {
        ctx.ui.notify("No system prompt log found. Send a message first.", "warning");
      }
    },
  });

  // ----- Register a command to view the last full payload -----
  pi.registerCommand("payload", {
    description: "Show the last logged full provider payload in the TUI",
    handler: async (_args, ctx) => {
      const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "full-payload.log");
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(logFile, "utf8");
        const dumps = content.split("=== Full Payload Dump [");
        if (dumps.length <= 1) {
          ctx.ui.notify("No full payload logged yet", "warning");
          return;
        }
        const lastDump = dumps[dumps.length - 1];

        // Show the message summary in a widget
        const summaryMatch = lastDump.match(/--- MESSAGE SUMMARY ---\n([\s\S]*?)\n--- END MESSAGE SUMMARY ---/);
        if (summaryMatch) {
          const summary = summaryMatch[1];
          ctx.ui.setWidget("payload", [
            "--- Messages Being Sent ---",
            ...summary.split("\n"),
          ]);
          ctx.ui.notify(`Payload logged — see widget`, "info");
        } else {
          ctx.ui.notify("Could not parse last payload dump", "error");
        }
      } catch {
        ctx.ui.notify("No payload log found. Send a message first.", "warning");
      }
    },
  });

  // ----- Register a command to show ACTIVE tools with context sizes -----
  pi.registerCommand("tools", {
    description: "Show each ACTIVE tool with its context size (deactivated tools are hidden; use /tools-all to see all)",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const activeToolNames = new Set(pi.getActiveTools());

      // Filter to only active tools
      const activeTools = allTools.filter(t => activeToolNames.has(t.name));

      if (activeTools.length === 0) {
        ctx.ui.notify("No active tools", "warning");
        return;
      }

      // Calculate context size for each active tool
      const toolSizes = activeTools.map((tool) => ({
        tool,
        size: calculateToolContextSize(tool),
      }));

      // Sort by bytes descending (largest first)
      toolSizes.sort((a, b) => b.size.bytes - a.size.bytes);

      const totalBytes = toolSizes.reduce((sum, t) => sum + t.size.bytes, 0);
      const totalChars = toolSizes.reduce((sum, t) => sum + t.size.chars, 0);

      // Build display lines
      const lines: string[] = [
        `Tools: ${activeTools.length} active (${allTools.length} total, ${allTools.length - activeTools.length} deactivated)`,
        `Total context: ${formatSize(totalBytes)} (${totalChars.toLocaleString()} chars)`,
        "",
      ];

      for (const { tool, size } of toolSizes) {
        const pct = totalBytes > 0 ? ((size.bytes / totalBytes) * 100).toFixed(1) : "0.0";
        lines.push(
          `  ● ${tool.name}`,
          `      Size: ${formatSize(size.bytes)} (${size.chars.toLocaleString()} chars, ${pct}% of total)`,
          `      Description: ${tool.description ? (tool.description.length > 80 ? tool.description.slice(0, 80) + "…" : tool.description) : "(none)"}`,
          `      Schema: ${formatSize(size.schemaBytes)}`,
        );
      }

      // Also show how many deactivated tools there are
      if (allTools.length > activeTools.length) {
        lines.push(
          "",
          `${allTools.length - activeTools.length} tool(s) deactivated — use /tools-all to see all`,
        );
      }

      // Always print the list to stdout
      console.log("\n" + lines.join("\n"));

      // Show a compact summary widget
      if (ctx.hasUI) {
        const summaryLines = [
          `Tools: ${activeTools.length} active, ${allTools.length - activeTools.length} deactivated`,
          `Total context: ${formatSize(totalBytes)} (${totalChars.toLocaleString()} chars)`,
          `Full list printed to stdout above ↑`,
        ];
        ctx.ui.setWidget("tools", summaryLines);
        ctx.ui.notify(`Tools: ${activeTools.length} active, ${formatSize(totalBytes)} combined — see stdout for list`, "info");
      }
    },
  });

  // ----- Register a command to show ALL tools (including deactivated) -----
  pi.registerCommand("tools-all", {
    description: "Show ALL registered tools (including deactivated) with context sizes",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const activeToolNames = new Set(pi.getActiveTools());

      if (allTools.length === 0) {
        ctx.ui.notify("No tools registered", "warning");
        return;
      }

      // Calculate context size for each tool
      const toolSizes = allTools.map((tool) => ({
        tool,
        size: calculateToolContextSize(tool),
      }));

      // Sort by bytes descending (largest first)
      toolSizes.sort((a, b) => b.size.bytes - a.size.bytes);

      const totalBytes = toolSizes.reduce((sum, t) => sum + t.size.bytes, 0);
      const totalChars = toolSizes.reduce((sum, t) => sum + t.size.chars, 0);

      // Build display lines
      const lines: string[] = [
        `Tools: ${allTools.length} total, ${activeToolNames.size} active`,
        `Total context: ${formatSize(totalBytes)} (${totalChars.toLocaleString()} chars)`,
        "",
      ];

      for (const { tool, size } of toolSizes) {
        const active = activeToolNames.has(tool.name) ? "●" : "○";
        const pct = totalBytes > 0 ? ((size.bytes / totalBytes) * 100).toFixed(1) : "0.0";
        lines.push(
          `  ${active} ${tool.name}`,
          `      Size: ${formatSize(size.bytes)} (${size.chars.toLocaleString()} chars, ${pct}% of total)`,
          `      Description: ${tool.description ? (tool.description.length > 80 ? tool.description.slice(0, 80) + "…" : tool.description) : "(none)"}`,
          `      Schema: ${formatSize(size.schemaBytes)}`,
        );
      }

      // Always print the full list to stdout
      console.log("\n" + lines.join("\n"));

      // Show a compact summary widget
      if (ctx.hasUI) {
        const summaryLines = [
          `Tools: ${allTools.length} total, ${activeToolNames.size} active`,
          `Total context: ${formatSize(totalBytes)} (${totalChars.toLocaleString()} chars)`,
          `Full list printed to stdout above ↑`,
        ];
        ctx.ui.setWidget("tools-all", summaryLines);
        ctx.ui.notify(`Tools-all: ${allTools.length} total, ${formatSize(totalBytes)} combined — see stdout for full list`, "info");
      }
    },
  });

  // ----- Register a command to show tools + the full system prompt -----
  pi.registerCommand("tools-detailed", {
    description: "Show each registered tool with context size, parameters schema, AND the full system prompt as it appears to the model",
    handler: async (_args, ctx) => {
      const allTools = pi.getAllTools();
      const activeToolNames = new Set(pi.getActiveTools());

      // 1. Print tool listing (same as /tools)
      if (allTools.length > 0) {
        const toolSizes = allTools.map((tool) => ({
          tool,
          size: calculateToolContextSize(tool),
        }));

        toolSizes.sort((a, b) => b.size.bytes - a.size.bytes);

        const totalBytes = toolSizes.reduce((sum, t) => sum + t.size.bytes, 0);
        const totalChars = toolSizes.reduce((sum, t) => sum + t.size.chars, 0);

        const lines: string[] = [
          `Tools: ${allTools.length} total, ${activeToolNames.size} active`,
          `Total context: ${formatSize(totalBytes)} (${totalChars.toLocaleString()} chars)`,
          "",
        ];

        for (const { tool, size } of toolSizes) {
          const active = activeToolNames.has(tool.name) ? "●" : "○";
          const pct = totalBytes > 0 ? ((size.bytes / totalBytes) * 100).toFixed(1) : "0.0";
          const schemaStr = JSON.stringify(tool.parameters, null, 2);
          const schemaPreview = schemaStr;
          lines.push(
            `  ${active} ${tool.name}`,
            `      Size: ${formatSize(size.bytes)} (${size.chars.toLocaleString()} chars, ${pct}% of total)`,
            `      Description: ${tool.description ? (tool.description.length > 80 ? tool.description.slice(0, 80) + "…" : tool.description) : "(none)"}`,
            `      Schema:`,
            ...schemaPreview.split("\n").map(line => `        ${line}`),
          );
        }

        console.log("\n" + lines.join("\n"));
      }

      // 2. Print the full system prompt from the last logged dump
      const logFile = join(ctx.cwd, CONFIG_DIR_NAME, "system-prompt.log");
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(logFile, "utf8");
        const dumps = content.split("=== System Prompt Dump [");
        if (dumps.length > 1) {
          const lastDump = dumps[dumps.length - 1];
          const match = lastDump.match(/--- BEGIN SYSTEM PROMPT ---\n([\s\S]*?)\n--- END SYSTEM PROMPT ---/);
          if (match) {
            const prompt = match[1];
            console.log(`\n=== FULL SYSTEM PROMPT (${prompt.length.toLocaleString()} chars) ===`);
            console.log(prompt);
            console.log(`=== END SYSTEM PROMPT ===\n`);
          } else {
            console.log("\n(Could not parse last system prompt dump)\n");
          }
        } else {
          console.log("\n(No system prompt logged yet — send a message first)\n");
        }
      } catch {
        console.log("\n(No system prompt log found — send a message first)\n");
      }

      // Show a compact summary widget
      if (ctx.hasUI) {
        ctx.ui.setWidget("tools-detailed", [
          `Tools: ${allTools.length} total, ${activeToolNames.size} active`,
          `Full prompt printed to stdout above ↑`,
        ]);
        ctx.ui.notify(`Tools-detailed: full prompt printed to stdout`, "info");
      }
    },
  });

  // Clean up widgets on shutdown
  pi.on("session_shutdown", (_event, ctx) => {
    sidebarHandle?.hide();
    sidebarHandle = null;
    sidebarRequestRender = null;
    ctx.ui.setWidget("sysprompt", undefined);
    ctx.ui.setWidget("payload", undefined);
    ctx.ui.setWidget("tools", undefined);
    ctx.ui.setWidget("tools-detailed", undefined);
    ctx.ui.setWidget("tools-all", undefined);
  });
}
