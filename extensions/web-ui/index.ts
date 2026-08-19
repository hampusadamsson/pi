/**
 * web-ui — localhost web UI for pi.
 *
 * Serves an OpenAI/Gemini-style chat interface at http://127.0.0.1:<port>
 * and bridges it to the live pi agent session via Server-Sent Events.
 *
 * Port: PI_WEBUI_PORT (default 4242). Host: PI_WEBUI_HOST (default 127.0.0.1).
 * Token: PI_WEBUI_TOKEN (default random). All /api/* routes require the token.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const HOST = process.env.PI_WEBUI_HOST || "127.0.0.1";
const DEFAULT_PORT = 4242;
const GLOBAL_KEY = "__pi_webui__";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolCallView {
  id: string;
  name: string;
  args: unknown;
  output?: string;
  isError?: boolean;
  status?: "running" | "done" | "error";
}

interface MsgView {
  id: string;
  role: string;
  text?: string;
  thinking?: string;
  toolCalls?: ToolCallView[];
  toolCallId?: string;
  toolName?: string;
  usage?: unknown;
  model?: string;
  stopReason?: string;
  running?: boolean;
  ts?: number;
}

interface ContextUsageView {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface WebUiState {
  server: ReturnType<typeof createServer> | null;
  port: number;
  token: string;
  announced: boolean;
  clients: Set<ServerResponse>;
  pi: ExtensionAPI | null;
  ctx: ExtensionContext | null;
  cwd: string;
  model: any;
  thinkingLevel: string;
  theme: string;
  activeTools: string[];
  allTools: any[];
  contextUsage: ContextUsageView | null;
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  costTotal: number;
  tokensTotal: number;
  transcript: MsgView[];
  busy: boolean;
  role: string | null;
  handler: ((req: IncomingMessage, res: ServerResponse) => void) | null;
  seq: number;
}

// ---------------------------------------------------------------------------
// Global singleton (survives extension reload / session switch)
// ---------------------------------------------------------------------------

function getState(): WebUiState {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    const port = Number(process.env.PI_WEBUI_PORT || DEFAULT_PORT) || DEFAULT_PORT;
    g[GLOBAL_KEY] = {
      server: null,
      port,
      token: process.env.PI_WEBUI_TOKEN || randomBytes(16).toString("hex"),
      announced: false,
      clients: new Set<ServerResponse>(),
      pi: null,
      ctx: null,
      cwd: process.cwd(),
      model: null,
      thinkingLevel: "off",
      theme: "dark",
      activeTools: [],
      allTools: [],
      contextUsage: null,
      sessionFile: null,
      sessionId: null,
      sessionName: null,
      costTotal: 0,
      tokensTotal: 0,
      transcript: [],
      busy: false,
      role: null,
      handler: null,
      seq: 0,
    } satisfies WebUiState;
  }
  return g[GLOBAL_KEY];
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === "text")
      .map((b: any) => (typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

function contentToThinking(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b && b.type === "thinking")
    .map((b: any) => (typeof b.thinking === "string" ? b.thinking : ""))
    .join("\n");
}

function contentToToolCalls(content: any): ToolCallView[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b && b.type === "toolCall")
    .map((b: any) => ({
      id: b.id ?? "",
      name: b.name ?? "",
      args: b.arguments ?? {},
      output: "",
      status: "done" as const,
    }));
}

function extractText(x: any): string {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (Array.isArray(x)) return x.map(extractText).join("\n");
  if (typeof x === "object") {
    if (Array.isArray(x.content)) {
      return x.content
        .map((b: any) => (b && b.type === "text" ? b.text : b && typeof b === "string" ? b : ""))
        .join("");
    }
    if (typeof x.text === "string") return x.text;
    if (typeof x.output === "string") return x.output;
    if (typeof x.delta === "string") return x.delta;
    if (typeof x.result === "string") return x.result;
  }
  return "";
}

function messageToView(m: any, id: string): MsgView {
  if (m.role === "user") {
    return { id, role: "user", text: contentToText(m.content), ts: m.timestamp };
  }
  if (m.role === "assistant") {
    return {
      id,
      role: "assistant",
      text: contentToText(m.content),
      thinking: contentToThinking(m.content),
      toolCalls: contentToToolCalls(m.content),
      usage: m.usage,
      model: m.provider && m.model ? `${m.provider}/${m.model}` : undefined,
      stopReason: m.stopReason,
      ts: m.timestamp,
    };
  }
  if (m.role === "toolResult") {
    return {
      id,
      role: "toolResult",
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      text: contentToText(m.content),
      isError: m.isError,
      ts: m.timestamp,
    };
  }
  if (m.role === "bashExecution") {
    return { id, role: "system", text: `$ ${m.command}\n${m.output ?? ""}` };
  }
  if (m.role === "compactionSummary") {
    return { id, role: "system", text: `[compacted] ${m.summary}` };
  }
  if (m.role === "branchSummary") {
    return { id, role: "system", text: `[branch] ${m.summary}` };
  }
  if (m.role === "custom") {
    return { id, role: "system", text: contentToText(m.content) };
  }
  return { id, role: "system", text: contentToText(m.content) || m.role };
}

function computeCost(entries: any[]): number {
  let total = 0;
  for (const e of entries) {
    const usage = e?.message?.usage ?? e?.usage;
    const cost = usage?.cost?.total;
    if (typeof cost === "number") total += cost;
  }
  return total;
}

function computeTokens(entries: any[]): number {
  let total = 0;
  for (const e of entries) {
    const usage = e?.message?.usage ?? e?.usage;
    const tok = usage?.totalTokens;
    if (typeof tok === "number") total += tok;
  }
  return total;
}

function buildTranscript(entries: any[]): MsgView[] {
  const msgs: MsgView[] = [];
  for (const e of entries) {
    if (e.type === "message") {
      const v = messageToView(e.message, e.id);
      if (v.role === "toolResult") {
        attachToolResult(msgs, v.toolCallId!, v.text ?? "", !!v.isError);
      } else {
        msgs.push(v);
      }
    } else if (e.type === "compaction") {
      msgs.push({ id: e.id, role: "system", text: `[compacted] ${e.summary}` });
    } else if (e.type === "branch_summary") {
      msgs.push({ id: e.id, role: "system", text: `[branch] ${e.summary}` });
    } else if (e.type === "model_change") {
      msgs.push({ id: e.id, role: "system", text: `model → ${e.provider}/${e.modelId}` });
    } else if (e.type === "thinking_level_change") {
      msgs.push({ id: e.id, role: "system", text: `thinking → ${e.thinkingLevel}` });
    }
  }
  return msgs;
}

function attachToolResult(msgs: MsgView[], toolCallId: string, output: string, isError: boolean) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant" && m.toolCalls) {
      const tc = m.toolCalls.find((t) => t.id === toolCallId);
      if (tc) {
        tc.output = output;
        tc.isError = isError;
        tc.status = isError ? "error" : "done";
        return;
      }
    }
  }
}

function lastAssistant(state: WebUiState): MsgView | null {
  for (let i = state.transcript.length - 1; i >= 0; i--) {
    const m = state.transcript[i];
    if (m.role === "assistant") return m;
  }
  return null;
}

function ensureToolCall(state: WebUiState, toolCallId: string, name: string, args: unknown): ToolCallView | null {
  const last = lastAssistant(state);
  if (!last) return null;
  if (!last.toolCalls) last.toolCalls = [];
  let tc = last.toolCalls.find((t) => t.id === toolCallId);
  if (!tc) {
    tc = { id: toolCallId, name, args: args ?? {}, output: "", status: "running" };
    last.toolCalls.push(tc);
  }
  return tc;
}

// ---------------------------------------------------------------------------
// Snapshot + broadcast
// ---------------------------------------------------------------------------

function buildState(state: WebUiState) {
  const m = state.model;
  return {
    model: m
      ? {
          provider: m.provider,
          id: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
          cost: m.cost,
        }
      : null,
    thinkingLevel: state.thinkingLevel,
    theme: state.theme,
    activeTools: state.activeTools,
    allTools: state.allTools.map((t: any) => ({
      name: t.name,
      description: t.description,
      source: t.sourceInfo?.source,
      scope: t.sourceInfo?.scope,
    })),
    contextUsage: state.contextUsage,
    cwd: state.cwd,
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    costTotal: state.costTotal,
    tokensTotal: state.tokensTotal,
    busy: state.busy,
    role: state.role,
    port: state.port,
  };
}

function broadcast(state: WebUiState, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(payload);
    } catch {
      /* client gone */
    }
  }
}

function pushState(state: WebUiState) {
  broadcast(state, "state", buildState(state));
}

function updateUsageAndContext(state: WebUiState) {
  const ctx = state.ctx;
  if (!ctx) return;
  try {
    const cu = ctx.getContextUsage();
    if (cu) state.contextUsage = { tokens: cu.tokens, contextWindow: cu.contextWindow, percent: cu.percent };
    const entries = ctx.sessionManager.buildContextEntries();
    state.costTotal = computeCost(entries);
    state.tokensTotal = computeTokens(entries);
  } catch {
    /* ignore */
  }
}

function refreshFromSession(state: WebUiState) {
  const ctx = state.ctx;
  if (!ctx) return;
  state.cwd = ctx.cwd;
  state.model = ctx.model ?? null;
  state.thinkingLevel = ctx.thinkingLevel ?? (state.pi ? state.pi.getThinkingLevel() : "off");
  state.theme = ctx.ui?.theme?.name ?? state.theme;
  state.activeTools = state.pi ? state.pi.getActiveTools() : [];
  state.allTools = state.pi ? state.pi.getAllTools() : [];
  const sm = ctx.sessionManager;
  state.sessionFile = sm.getSessionFile() ?? null;
  state.sessionId = sm.getSessionId();
  state.sessionName = sm.getSessionName() ?? null;
  const entries = sm.buildContextEntries();
  state.transcript = buildTranscript(entries);
  state.costTotal = computeCost(entries);
  state.tokensTotal = computeTokens(entries);
  state.contextUsage = ctx.getContextUsage() ?? state.contextUsage;
  state.role = activeRoleFromSession(ctx);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(res: ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      data += c;
      if (data.length > 2_000_000) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function authorized(state: WebUiState, url: URL, req: IncomingMessage): boolean {
  const token = url.searchParams.get("token") ?? req.headers["x-pi-token"];
  return token === state.token;
}

function htmlPath(): string {
  return join(getAgentDir(), "extensions", "web-ui", "index.html");
}

function serveHtml(state: WebUiState, res: ServerResponse) {
  let html: string;
  const p = htmlPath();
  if (existsSync(p)) {
    html = readFileSync(p, "utf8");
  } else {
    html = "<!doctype html><meta charset=utf-8><title>pi web-ui</title><body style='font-family:system-ui;padding:2rem'><h1>pi web-ui</h1><p>index.html not found at <code>" +
      p +
      "</code></p></body>";
  }
  html = html.replace(/__PI_WEBUI_TOKEN__/g, state.token);
  html = html.replace(/__PI_WEBUI_PORT__/g, String(state.port));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function handleSse(state: WebUiState, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  res.write(
    `event: hello\ndata: ${JSON.stringify({ state: buildState(state), transcript: state.transcript })}\n\n`,
  );
  state.clients.add(res);
  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepalive);
    }
  }, 25000);
  req.on("close", () => {
    clearInterval(keepalive);
    state.clients.delete(res);
  });
}

async function listSessions(state: WebUiState) {
  const cwd = state.cwd || state.ctx?.cwd || process.cwd();
  const [local, all] = await Promise.all([SessionManager.list(cwd), SessionManager.listAll()]);
  const seen = new Set<string>();
  const sessions: any[] = [];
  for (const s of local) {
    seen.add(s.path);
    sessions.push({
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created,
      modified: s.modified,
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
      current: s.path === state.sessionFile,
    });
  }
  for (const s of all) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    sessions.push({
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created,
      modified: s.modified,
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
      current: s.path === state.sessionFile,
    });
  }
  return { cwd, sessions };
}

function readSession(path: string) {
  const sm = SessionManager.open(path);
  const entries = sm.buildContextEntries();
  return {
    header: sm.getHeader(),
    name: sm.getSessionName(),
    cwd: sm.getCwd(),
    transcript: buildTranscript(entries),
    costTotal: computeCost(entries),
    tokensTotal: computeTokens(entries),
  };
}

// ---------------------------------------------------------------------------
// Roles (reads the roles extension's config; switching goes through /role)
// ---------------------------------------------------------------------------

interface RoleView {
  name: string;
  description?: string;
  hidden?: boolean;
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function mergeRoleEntries(target: Map<string, RoleView>, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const roles = (raw as any).roles;
  if (!roles || typeof roles !== "object") return;
  for (const [name, role] of Object.entries(roles)) {
    if (!role || typeof role !== "object") continue;
    const prev = target.get(name) ?? { name };
    target.set(name, {
      name,
      description: typeof (role as any).description === "string" ? (role as any).description : prev.description,
      hidden: typeof (role as any).hidden === "boolean" ? (role as any).hidden : prev.hidden,
    });
  }
}

function readRoleDir(dir: string, target: Map<string, RoleView>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "roles.json");
  } catch {
    return;
  }
  for (const file of files.sort()) {
    const raw = readJsonSafe(join(dir, file));
    if (!raw || typeof raw !== "object") continue;
    const name = file.slice(0, -".json".length);
    target.set(name, {
      name,
      description: typeof (raw as any).description === "string" ? (raw as any).description : undefined,
      hidden: typeof (raw as any).hidden === "boolean" ? (raw as any).hidden : undefined,
    });
  }
}

function activeRoleFromSession(ctx: ExtensionContext | null): string | null {
  if (!ctx) return null;
  try {
    let active: string | null = null;
    for (const entry of ctx.sessionManager.getBranch() as any[]) {
      if (entry?.type === "custom" && entry?.customType === "role-switch") {
        const role = entry?.data?.role;
        active = role == null ? null : role;
      }
    }
    return active;
  } catch {
    return null;
  }
}

function loadRoles(ctx: ExtensionContext | null): { roles: RoleView[]; active: string | null } {
  const map = new Map<string, RoleView>();
  const agentDir = getAgentDir();
  mergeRoleEntries(map, readJsonSafe(join(agentDir, "roles.json")));
  readRoleDir(join(agentDir, "roles"), map);
  if (ctx && typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted()) {
    const projectDir = join(ctx.cwd, CONFIG_DIR_NAME);
    mergeRoleEntries(map, readJsonSafe(join(projectDir, "roles.json")));
    readRoleDir(join(projectDir, "roles"), map);
  }
  return { roles: [...map.values()], active: activeRoleFromSession(ctx) };
}

// ---------------------------------------------------------------------------
// Skills (edit SKILL.md files from loaded skills)
// ---------------------------------------------------------------------------

interface SkillView {
  name: string;
  description: string;
  path: string;
  scope: string;
  content: string;
}

function listSkills(state: WebUiState): SkillView[] {
  const cmds = state.pi ? state.pi.getCommands() : [];
  const seen = new Set<string>();
  const skills: SkillView[] = [];
  for (const c of cmds) {
    if (c.source !== "skill") continue;
    const p = c.sourceInfo?.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let content = "";
    try {
      content = existsSync(p) ? readFileSync(p, "utf8") : "";
    } catch {
      content = "";
    }
    skills.push({
      name: c.name.replace(/^skill:/, ""),
      description: c.description ?? "",
      path: p,
      scope: c.sourceInfo?.scope ?? "unknown",
      content,
    });
  }
  return skills;
}

function saveSkill(state: WebUiState, path: string, content: string): { ok: boolean; error?: string } {
  if (typeof content !== "string") return { ok: false, error: "content required" };
  const known = listSkills(state).some((s) => s.path === path);
  if (!known) return { ok: false, error: "unknown skill path" };
  try {
    writeFileSync(path, content, "utf8");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// Slash commands (web-ui side)
// ---------------------------------------------------------------------------

const WEBUI_SLASH_COMMANDS: { name: string; description: string; argumentHint?: string }[] = [
  { name: "new", description: "Start a new session" },
  { name: "model", description: "Select model", argumentHint: "<provider/id>" },
  { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
  { name: "resume", description: "Resume a different session", argumentHint: "<path>" },
  { name: "name", description: "Set session display name", argumentHint: "<name>" },
  { name: "reload", description: "Reload extensions, skills, prompts, themes, and context files" },
  { name: "quit", description: "Quit pi" },
  { name: "help", description: "List available slash commands" },
];

function findModelByRef(state: WebUiState, ref: string): any | undefined {
  const reg = state.ctx?.modelRegistry;
  const available = reg?.getAvailable() ?? [];
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx !== -1) {
    const provider = trimmed.slice(0, slashIdx);
    const id = trimmed.slice(slashIdx + 1);
    const exact = reg?.find(provider, id);
    if (exact) return exact;
  }
  const lower = trimmed.toLowerCase();
  return available.find(
    (m: any) =>
      m.id === trimmed ||
      m.name === trimmed ||
      (m.id && m.id.toLowerCase() === lower) ||
      (m.name && m.name.toLowerCase() === lower),
  );
}

function listCommands(state: WebUiState) {
  const dynamic = state.pi ? state.pi.getCommands() : [];
  return [
    ...WEBUI_SLASH_COMMANDS.map((c) => ({ ...c, source: "webui" })),
    ...dynamic.map((c: any) => ({
      name: c.name,
      description: c.description,
      source: c.source,
      argumentHint: c.argumentHint,
    })),
  ];
}

async function handleSlashCommand(
  state: WebUiState,
  text: string,
): Promise<{ command?: string; message?: string; commands?: any[] } | null> {
  if (!text.startsWith("/")) return null;
  const spaceIdx = text.indexOf(" ");
  const cmd = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "new": {
      if (state.busy) throw new Error("agent busy");
      state.pi!.sendUserMessage("/webui:new", { expandPromptTemplates: true });
      return { command: "new" };
    }
    case "resume": {
      if (!args) return { command: "resume", message: "Usage: /resume <session-path>" };
      if (state.busy) throw new Error("agent busy");
      state.pi!.sendUserMessage(`/webui:resume ${args}`, { expandPromptTemplates: true });
      return { command: "resume" };
    }
    case "model": {
      if (!args) return { command: "model", message: "Usage: /model <provider/id> or <id>. See the model badge (top right) for available models." };
      const model = findModelByRef(state, args);
      if (!model) return { command: "model", message: `Model not found: ${args}` };
      const ok = await state.pi!.setModel(model);
      return {
        command: "model",
        message: ok
          ? `Model set to ${model.provider}/${model.id}`
          : `No API key for model ${model.provider}/${model.id}`,
      };
    }
    case "compact": {
      state.ctx?.compact({ customInstructions: args || undefined });
      return { command: "compact" };
    }
    case "name": {
      if (!args) return { command: "name", message: "Usage: /name <name>" };
      state.pi!.setSessionName(args);
      return { command: "name" };
    }
    case "reload": {
      state.pi!.sendUserMessage("/webui:reload", { expandPromptTemplates: true });
      return { command: "reload" };
    }
    case "quit": {
      state.ctx?.shutdown();
      return { command: "quit" };
    }
    case "help": {
      return { command: "help", commands: listCommands(state) };
    }
    default:
      return null;
  }
}

async function handleApi(state: WebUiState, req: IncomingMessage, res: ServerResponse, url: URL) {
  try {
    if (!authorized(state, url, req)) {
      json(res, 403, { error: "forbidden" });
      return;
    }

    const path = url.pathname;

  if (path === "/api/state" && req.method === "GET") {
    json(res, 200, { state: buildState(state), transcript: state.transcript });
    return;
  }

  if (path === "/api/events" && req.method === "GET") {
    handleSse(state, req, res);
    return;
  }

  if (path === "/api/sessions" && req.method === "GET") {
    try {
      json(res, 200, await listSessions(state));
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/session" && req.method === "GET") {
    const p = url.searchParams.get("path");
    if (!p) {
      json(res, 400, { error: "missing path" });
      return;
    }
    try {
      json(res, 200, readSession(p));
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/models" && req.method === "GET") {
    const available = state.ctx?.modelRegistry?.getAvailable() ?? [];
    const scoped = state.ctx?.scopedModels ?? [];
    const scopedKeys = new Set(scoped.map((s: any) => `${s.model.provider}/${s.model.id}`));
    const models = available.map((m: any) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      cost: m.cost,
      scoped: scoped.length === 0 || scopedKeys.has(`${m.provider}/${m.id}`),
      current: state.model ? state.model.provider === m.provider && state.model.id === m.id : false,
    }));
    json(res, 200, { models });
    return;
  }

  if (path === "/api/commands" && req.method === "GET") {
    json(res, 200, { commands: listCommands(state) });
    return;
  }

  if (path === "/api/roles" && req.method === "GET") {
    json(res, 200, loadRoles(state.ctx));
    return;
  }

  if (path === "/api/skills" && req.method === "GET") {
    json(res, 200, { skills: listSkills(state) });
    return;
  }

  if (path === "/api/skills" && req.method === "POST") {
    const body = await readBody(req);
    const p = typeof body?.path === "string" ? body.path : "";
    const content = typeof body?.content === "string" ? body.content : null;
    if (!p || content === null) {
      json(res, 400, { error: "path and content required" });
      return;
    }
    const result = saveSkill(state, p, content);
    json(res, result.ok ? 200 : 400, result);
    return;
  }

  if (path === "/api/complete" && req.method === "GET") {
    const command = url.searchParams.get("command") ?? "";
    const prefix = (url.searchParams.get("prefix") ?? "").toLowerCase();
    let completions: string[] = [];
    if (command === "role") {
      const { roles } = loadRoles(state.ctx);
      completions = ["none", "reload", "keys", ...roles.map((r) => r.name)].filter((c) =>
        c.toLowerCase().startsWith(prefix),
      );
    }
    json(res, 200, { completions });
    return;
  }

  // --- Mutating routes ---

  if (path === "/api/chat" && req.method === "POST") {
    const body = await readBody(req);
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      json(res, 400, { error: "empty message" });
      return;
    }
    try {
      const cmdResult = await handleSlashCommand(state, text.trim());
      if (cmdResult !== null) {
        json(res, 200, { ok: true, ...cmdResult });
        return;
      }
      // Regular message, prompt template, skill command, or extension command.
      if (state.busy) {
        state.pi!.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: true });
      } else {
        state.pi!.sendUserMessage(text, { expandPromptTemplates: true });
      }
      json(res, 200, { ok: true });
    } catch (e: any) {
      if (e?.message === "agent busy") {
        json(res, 409, { error: "agent busy" });
        return;
      }
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/stop" && req.method === "POST") {
    try {
      state.ctx?.abort();
      json(res, 200, { ok: true });
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/new" && req.method === "POST") {
    if (state.busy) {
      json(res, 409, { error: "agent busy" });
      return;
    }
    state.pi!.sendUserMessage("/webui:new", { expandPromptTemplates: true });
    json(res, 200, { ok: true });
    return;
  }

  if (path === "/api/session/resume" && req.method === "POST") {
    if (state.busy) {
      json(res, 409, { error: "agent busy" });
      return;
    }
    const body = await readBody(req);
    const p = typeof body?.path === "string" ? body.path : "";
    if (!p) {
      json(res, 400, { error: "missing path" });
      return;
    }
    state.pi!.sendUserMessage(`/webui:resume ${p}`, { expandPromptTemplates: true });
    json(res, 200, { ok: true });
    return;
  }

  if (path === "/api/model" && req.method === "POST") {
    const body = await readBody(req);
    const provider = body?.provider;
    const id = body?.id;
    if (!provider || !id) {
      json(res, 400, { error: "provider and id required" });
      return;
    }
    const model = state.ctx?.modelRegistry?.find(provider, id);
    if (!model) {
      json(res, 404, { error: "model not found" });
      return;
    }
    try {
      const ok = await state.pi!.setModel(model);
      json(res, ok ? 200 : 400, { ok, error: ok ? undefined : "no API key for model" });
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/tools" && req.method === "POST") {
    const body = await readBody(req);
    const tools = Array.isArray(body?.tools) ? body.tools.map(String) : undefined;
    if (!tools) {
      json(res, 400, { error: "tools array required" });
      return;
    }
    state.pi!.setActiveTools(tools);
    json(res, 200, { ok: true });
    return;
  }

  if (path === "/api/thinking" && req.method === "POST") {
    const body = await readBody(req);
    const level = body?.level;
    if (typeof level !== "string") {
      json(res, 400, { error: "level required" });
      return;
    }
    state.pi!.setThinkingLevel(level as any);
    json(res, 200, { ok: true });
    return;
  }

  if (path === "/api/role" && req.method === "POST") {
    const body = await readBody(req);
    const name = typeof body?.name === "string" ? body.name.trim() : null;
    if (state.busy) {
      json(res, 409, { error: "agent busy" });
      return;
    }
    if (name) {
      state.pi!.sendUserMessage(`/role ${name}`, { expandPromptTemplates: true });
      state.role = name;
    } else {
      state.pi!.sendUserMessage("/role none", { expandPromptTemplates: true });
      state.role = null;
    }
    pushState(state);
    json(res, 200, { ok: true, role: state.role });
    return;
  }

  if (path === "/api/themes" && req.method === "GET") {
    try {
      const themes = state.ctx?.ui?.getAllThemes?.() ?? [];
      json(res, 200, { themes, current: state.theme });
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/theme" && req.method === "POST") {
    const body = await readBody(req);
    const name = typeof body?.name === "string" ? body.name : "";
    if (!name) {
      json(res, 400, { error: "name required" });
      return;
    }
    try {
      const result = state.ctx?.ui?.setTheme?.(name) ?? { success: false, error: "no UI" };
      if (result.success) {
        state.theme = name;
        pushState(state);
      }
      json(res, result.success ? 200 : 400, result);
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
    return;
  }

  if (path === "/api/session/name" && req.method === "POST") {
    const body = await readBody(req);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    state.pi!.setSessionName(name);
    state.sessionName = name || null;
    pushState(state);
    json(res, 200, { ok: true });
    return;
  }

  if (path === "/api/compact" && req.method === "POST") {
    const body = await readBody(req);
    const instructions = typeof body?.instructions === "string" ? body.instructions : undefined;
    state.ctx?.compact({ customInstructions: instructions || undefined });
    json(res, 200, { ok: true });
    return;
  }

  if (path === "/api/reload" && req.method === "POST") {
    state.pi!.sendUserMessage("/webui:reload", { expandPromptTemplates: true });
    json(res, 200, { ok: true });
    return;
  }

    json(res, 404, { error: "not found" });
  } catch (e: any) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
  }
}

function createHandler(state: WebUiState) {
  return (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        serveHtml(state, res);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        void handleApi(state, req, res, url);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (e: any) {
      try {
        json(res, 500, { error: e?.message ?? String(e) });
      } catch {
        /* ignore */
      }
    }
  };
}

function startServer(state: WebUiState) {
  // Route dispatch goes through state.handler so an extension reload can swap in
  // a fresh handleApi closure without restarting the listening socket.
  const server = createServer((req, res) => {
    const h = state.handler;
    if (h) {
      h(req, res);
    } else {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "starting" }));
    }
  });
  state.server = server;
  server.on("error", (err: any) => {
    if (state.ctx?.hasUI) {
      state.ctx.ui.notify(`web-ui: ${err?.message ?? err}`, "error");
    } else {
      console.error(`[web-ui] ${err?.message ?? err}`);
    }
  });
  server.listen(state.port, HOST, () => {
    const addr = server.address();
    if (addr && typeof addr === "object") state.port = addr.port;
    if (!state.announced) {
      state.announced = true;
      const url = `http://${HOST}:${state.port}`;
      if (state.ctx?.hasUI) {
        state.ctx.ui.notify(`web-ui: ${url}`, "info");
      } else {
        console.error(`[web-ui] ${url}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const state = getState();
  state.pi = pi;
  state.handler = createHandler(state);

  // On extension reload the singleton survives but the transcript was wiped
  // while no session_start re-fired. Reseed from the live session if present.
  if (state.ctx) {
    refreshFromSession(state);
    broadcast(state, "session", { state: buildState(state), transcript: state.transcript });
  }

  // Session control commands (dispatched from the web UI).
  pi.registerCommand("webui:new", {
    description: "Start a new session (web-ui)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("webui:resume", {
    description: "Resume a session file (web-ui)",
    handler: async (args, ctx) => {
      const p = args.trim();
      if (!p) return;
      await ctx.switchSession(p);
    },
  });

  pi.registerCommand("webui:reload", {
    description: "Reload extensions, skills, prompts, themes, and context files (web-ui)",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  // Start the HTTP server once per process, only in interactive/RPC modes.
  // (One-shot print/json runs should not spawn a server or hold a port.)

  pi.on("session_start", (_event, ctx) => {
    state.ctx = ctx;
    if (!state.server && (ctx.mode === "tui" || ctx.mode === "rpc")) {
      startServer(state);
    }
    refreshFromSession(state);
    broadcast(state, "session", { state: buildState(state), transcript: state.transcript });
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit") {
      try {
        state.server?.close();
      } catch {
        /* ignore */
      }
      state.server = null;
      state.clients.clear();
    }
    state.ctx = null;
  });

  pi.on("message_start", (event, ctx) => {
    state.ctx = ctx;
    const m: any = event.message;
    if (m.role === "user") {
      const v = messageToView(m, `m${++state.seq}`);
      state.transcript.push(v);
      broadcast(state, "user", v);
    } else if (m.role === "assistant") {
      const v: MsgView = { id: `m${++state.seq}`, role: "assistant", text: "", thinking: "", toolCalls: [], running: true };
      state.transcript.push(v);
      broadcast(state, "assistant_start", v);
    }
  });

  pi.on("message_update", (event, ctx) => {
    state.ctx = ctx;
    const ev: any = event.assistantMessageEvent;
    const last = lastAssistant(state);
    if (!last) return;
    if (ev.type === "text_delta" && typeof ev.delta === "string") {
      last.text = (last.text ?? "") + ev.delta;
      broadcast(state, "delta", { kind: "text", text: ev.delta });
    } else if (ev.type === "thinking_delta" && typeof ev.delta === "string") {
      last.thinking = (last.thinking ?? "") + ev.delta;
      broadcast(state, "delta", { kind: "thinking", text: ev.delta });
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    state.ctx = ctx;
    const tc = ensureToolCall(state, event.toolCallId, event.toolName, event.args);
    if (tc) broadcast(state, "tool_start", tc);
  });

  pi.on("tool_execution_update", (event, ctx) => {
    state.ctx = ctx;
    const output = extractText(event.partialResult);
    const last = lastAssistant(state);
    const tc = last?.toolCalls?.find((t) => t.id === event.toolCallId);
    if (tc) {
      tc.output = output;
      tc.status = "running";
      broadcast(state, "tool_progress", { id: event.toolCallId, output });
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    state.ctx = ctx;
    const last = lastAssistant(state);
    const tc = last?.toolCalls?.find((t) => t.id === event.toolCallId);
    if (tc) {
      tc.output = extractText(event.result);
      tc.isError = event.isError;
      tc.status = event.isError ? "error" : "done";
      broadcast(state, "tool_end", { id: event.toolCallId, output: tc.output, isError: event.isError });
    }
  });

  pi.on("message_end", (event, ctx) => {
    state.ctx = ctx;
    const m: any = event.message;
    if (m.role === "assistant") {
      const last = lastAssistant(state);
      if (last) {
        const finalCalls = contentToToolCalls(m.content);
        const byId = new Map((last.toolCalls ?? []).map((t) => [t.id, t]));
        last.text = contentToText(m.content);
        last.thinking = contentToThinking(m.content);
        last.toolCalls = finalCalls.map((t) => {
          const existing = byId.get(t.id);
          return {
            ...t,
            output: existing?.output ?? "",
            isError: existing?.isError,
            status: "done" as const,
          };
        });
        last.usage = m.usage;
        last.model = m.provider && m.model ? `${m.provider}/${m.model}` : last.model;
        last.stopReason = m.stopReason;
        last.running = false;
        broadcast(state, "assistant_end", last);
      }
    } else if (m.role === "toolResult") {
      attachToolResult(state.transcript, m.toolCallId, contentToText(m.content), !!m.isError);
      broadcast(state, "tool_end", { id: m.toolCallId, output: contentToText(m.content), isError: !!m.isError });
    }
    updateUsageAndContext(state);
    pushState(state);
  });

  pi.on("agent_start", (_event, ctx) => {
    state.ctx = ctx;
    state.busy = true;
    pushState(state);
  });

  pi.on("agent_end", (_event, ctx) => {
    state.ctx = ctx;
    updateUsageAndContext(state);
  });

  pi.on("agent_settled", (_event, ctx) => {
    state.ctx = ctx;
    state.busy = false;
    state.role = activeRoleFromSession(ctx);
    updateUsageAndContext(state);
    pushState(state);
  });

  pi.on("model_select", (event, ctx) => {
    state.ctx = ctx;
    state.model = event.model;
    pushState(state);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    state.ctx = ctx;
    state.thinkingLevel = event.level;
    pushState(state);
  });
}
