/**
 * Vertex AI Anthropic Provider Extension for Pi
 *
 * Provides Claude models through Google Cloud Vertex AI.
 * Authentication via gcloud CLI (/login) or environment variables.
 */

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageContent,
	type Message,
	type Model,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type ExecFileSyncOptions, execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

// Strip unpaired UTF-16 surrogates (keeps valid pairs such as emoji).
function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

const execFileAsync = promisify(execFile);

// Run a gcloud command synchronously (no shell). `path` defaults to the discovered gcloud binary.
function gcloud(args: string[], opts: ExecFileSyncOptions & { path?: string } = {}): string {
	const { path = findGcloud(), ...execOpts } = opts;
	const out = execFileSync(path, args, { encoding: "utf-8", ...execOpts });
	return out ? String(out) : "";
}

// Access tokens from `gcloud auth print-access-token` are valid ~60 minutes.
// Cache them so we don't shell out to gcloud (100ms-2s+, blocks the event
// loop if done via execFileSync) on every single turn.
const TOKEN_TTL_MS = 50 * 60 * 1000;
let cachedToken: { token: string; gcloudPath: string; expiresAt: number } | null = null;

async function getAccessTokenAsync(gcloudPath: string, forceRefresh = false): Promise<string> {
	const cached = forceRefresh ? null : getCachedToken(gcloudPath);
	if (cached) return cached;
	const { stdout } = await execFileAsync(gcloudPath, ["auth", "print-access-token"], {
		timeout: 10000,
	});
	return storeToken(stdout, gcloudPath);
}

function storeToken(raw: string, gcloudPath: string): string {
	const token = raw.trim();
	if (token.length < 20) throw new Error("Invalid token from gcloud");
	cachedToken = { token, gcloudPath, expiresAt: Date.now() + TOKEN_TTL_MS };
	return token;
}

function getCachedToken(gcloudPath: string): string | null {
	return cachedToken && cachedToken.gcloudPath === gcloudPath && Date.now() < cachedToken.expiresAt
		? cachedToken.token
		: null;
}

function getAccessTokenSync(gcloudPath: string): string {
	const cached = getCachedToken(gcloudPath);
	if (cached) return cached;
	try {
		return storeToken(
			gcloud(["auth", "print-access-token"], {
				path: gcloudPath,
				timeout: 5000,
				stdio: ["ignore", "pipe", "pipe"],
			}),
			gcloudPath,
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : "Unknown error";
		throw new Error(`Failed to get gcloud access token: ${msg}\n\nRun: gcloud auth login`);
	}
}

function invalidateTokenCache(): void {
	cachedToken = null;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration can be set via:
 * 1. Environment variables (highest priority)
 * 2. Persisted credentials from /login (stored in ~/.pi/agent/auth.json)
 * 3. Hardcoded defaults (fallback)
 */

function getPersistedCredentials(): { project?: string; region?: string; modelRegions?: Record<string, string> } {
	try {
		const authPath = `${homedir()}/.pi/agent/auth.json`;
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data["vertex-anthropic"];
		if (cred?.type === "oauth") {
			return {
				project: cred.project,
				region: cred.region,
				modelRegions: cred.modelRegions,
			};
		}
	} catch {}
	return {};
}

function getConfig() {
	const persisted = getPersistedCredentials();
	return {
		project: process.env.VERTEX_PROJECT_ID || persisted.project || "your-gcp-project-id",
		region: process.env.VERTEX_REGION || persisted.region || "us-east5",
		gcloudPath: process.env.VERTEX_GCLOUD_PATH || findGcloud(),
	};
}

/**
 * Per-model region overrides. A key matches if it is a substring of the model
 * id (e.g. "haiku" or "claude-haiku-5-5"); the longest match wins.
 * Sources (env takes priority over auth.json `modelRegions`):
 *   VERTEX_MODEL_REGIONS="haiku=eu,opus=global"
 */
function getRegionForModel(modelId: string, defaultRegion: string): string {
	const overrides: Record<string, string> = { ...getPersistedCredentials().modelRegions };
	for (const pair of (process.env.VERTEX_MODEL_REGIONS || "").split(",")) {
		const [key, value] = pair.split("=").map((s) => s.trim());
		if (key && value) overrides[key] = value;
	}
	const key = Object.keys(overrides)
		.filter((k) => modelId.includes(k))
		.sort((a, b) => b.length - a.length)[0];
	return key ? overrides[key] : defaultRegion;
}

// Multi-region endpoints (eu, us) use the "rep" domain, global has no prefix,
// everything else uses the <region>-aiplatform domain.
function getEndpoint(region: string): string {
	if (region === "global") return "aiplatform.googleapis.com";
	if (region === "eu" || region === "us") return `aiplatform.${region}.rep.googleapis.com`;
	return `${region}-aiplatform.googleapis.com`;
}

// =============================================================================
// Static Model Catalog
// =============================================================================

/**
 * Static catalog of supported models (id -> pricing/limits/reasoning). This
 * table IS the model list (see refreshModels); update it by hand when new
 * Claude models ship on Vertex. Ids are keyed without any `@version` suffix.
 */
interface ModelMetadata {
	name: string;
	reasoning: boolean;
	useAdaptiveThinking?: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

const MODEL_METADATA: Record<string, ModelMetadata> = {
	"claude-opus-5-5": {
		name: "Claude Opus 5.5 (Vertex)",
		reasoning: true,
		useAdaptiveThinking: true,
		cost: { input: 4.4, output: 22, cacheRead: 0.22, cacheWrite: 5.5 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"claude-sonnet-5-5": {
		name: "Claude Sonnet 5.5 (Vertex)",
		reasoning: true,
		useAdaptiveThinking: true,
		cost: { input: 2.2, output: 11, cacheRead: 0.11, cacheWrite: 2.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"claude-fable-5": {
		name: "Claude Fable 5 (Vertex)",
		reasoning: true,
		useAdaptiveThinking: true,
		cost: { input: 11, output: 55, cacheRead: 1.1, cacheWrite: 13.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
	"claude-haiku-5-5": {
		name: "Claude Haiku 5.5 (Vertex)",
		reasoning: true,
		useAdaptiveThinking: true,
		cost: { input: 0.11, output: 0.55, cacheRead: 0.011, cacheWrite: 0.1375 },
		contextWindow: 200000,
		maxTokens: 64000,
	},
};

// Fallback used by metadataForModelId for ids not in MODEL_METADATA (not
// reachable via refreshModels today). Costs are zeroed since they're unknown.
const DEFAULT_MODEL_METADATA: ModelMetadata = {
	name: "(Vertex)",
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
};

function metadataForModelId(id: string): ModelMetadata {
	// Strip Vertex's `@YYYYMMDD` version suffix (e.g. "claude-opus-4-5@20251101").
	const baseId = id.split("@")[0];
	const known = MODEL_METADATA[baseId];
	if (known) return known;
	return { ...DEFAULT_MODEL_METADATA, name: `${id} (Vertex)` };
}

function toProviderModelConfig(id: string): ProviderModelConfig {
	const meta = metadataForModelId(id);
	return {
		id,
		name: meta.name,
		reasoning: meta.reasoning,
		...(meta.useAdaptiveThinking ? { useAdaptiveThinking: true } : {}),
		input: ["text", "image"],
		cost: meta.cost,
		contextWindow: meta.contextWindow,
		maxTokens: meta.maxTokens,
	};
}

// Static model list: Vertex AI has no public REST endpoint to list
// publisher models (publishers/{publisher}/models only supports predict /
// rawPredict / streamRawPredict, not a list method). The catalog is
// therefore just the ids we have metadata for in MODEL_METADATA above -
// update that table by hand when Anthropic ships new Vertex model ids.

// findGcloud() shells out (execFileSync) to probe candidate paths — expensive and
// blocks the event loop. getConfig() is called on every turn, so memoize the
// result once found; only VERTEX_GCLOUD_PATH env var bypasses this.
let cachedGcloudPath: string | undefined;

function findGcloud(): string {
	if (cachedGcloudPath) return cachedGcloudPath;

	// Try common locations
	const paths = [
		"/usr/local/bin/gcloud",
		"/usr/bin/gcloud",
		`${process.env.HOME}/google-cloud-sdk/bin/gcloud`,
		"gcloud", // Let OS find it
	];

	for (const path of paths) {
		try {
			gcloud(["version"], { path, stdio: "ignore", timeout: 1000 });
			cachedGcloudPath = path;
			return path;
		} catch {}
	}

	cachedGcloudPath = "gcloud"; // Fallback
	return cachedGcloudPath;
}

// =============================================================================
// Message Transformation (handles incomplete tool calls)
// =============================================================================

/**
 * Transform messages to handle incomplete tool calls and cross-provider compatibility.
 * This removes errored/aborted assistant messages and inserts synthetic tool results
 * for orphaned tool calls to prevent API errors.
 */
function transformMessages(
	messages: Message[],
	model: Model<Api>,
	normalizeToolCallId?: (id: string) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();

	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const transformed = messages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					const thinkingBlock = block as ThinkingContent;
					// For same model: keep thinking blocks with signatures (needed for replay)
					if (isSameModel && thinkingBlock.thinkingSignature) return block;

					// Skip empty thinking blocks, convert others to plain text
					if (!thinkingBlock.thinking || thinkingBlock.thinking.trim() === "") return [];
					if (isSameModel) return block;

					return {
						type: "text" as const,
						text: thinkingBlock.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall = toolCall;

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}

		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add((msg as ToolResultMessage).toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			if (pendingToolCalls.length > 0) {
				for (const tc of pendingToolCalls) {
					if (!existingToolResultIds.has(tc.id)) {
						result.push({
							role: "toolResult",
							toolCallId: tc.id,
							toolName: tc.name,
							content: [{ type: "text", text: "No result provided" }],
							isError: true,
							timestamp: Date.now(),
						} as ToolResultMessage);
					}
				}
				pendingToolCalls = [];
				existingToolResultIds = new Set();
			}
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	return result;
}

// =============================================================================
// Message conversion (from custom-provider-anthropic example)
// =============================================================================

function convertContentBlocks(
	content: string | (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string } | { type: "image"; source: any }> {
	if (typeof content === "string") return sanitizeSurrogates(content);
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType,
				data: block.data,
			},
		};
	});

	if (!blocks.some((b) => b.type === "text")) {
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}

	return blocks;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(messages: Message[], model: Model<Api>): any[] {
	const params: any[] = [];

	// Transform messages for cross-provider compatibility - this removes errored/aborted
	// assistant messages and inserts synthetic tool results for orphaned tool calls
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			const hasContent = typeof msg.content === "string" ? msg.content.trim() : msg.content.length > 0;
			if (hasContent) {
				// Always use a block array so cache_control can be attached to the last block.
				const converted = convertContentBlocks(msg.content);
				params.push({
					role: "user",
					content: typeof converted === "string" ? [{ type: "text", text: converted }] : converted,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: any[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking" && block.thinking.trim()) {
					if ((block as ThinkingContent).thinkingSignature) {
						blocks.push({
							type: "thinking" as any,
							thinking: sanitizeSurrogates(block.thinking),
							signature: (block as ThinkingContent).thinkingSignature!,
						});
					} else {
						blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments,
					});
				}
			}
			if (blocks.length > 0) {
				params.push({ role: "assistant", content: blocks });
			}
		} else if (msg.role === "toolResult") {
			const toolResults: any[] = [];
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}
			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}

	// Add cache control to last user message
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user" && Array.isArray(last.content)) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock) {
				lastBlock.cache_control = { type: "ephemeral" };
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[]): any[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			properties: (tool.parameters as any).properties || {},
			required: (tool.parameters as any).required || [],
		},
	}));
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

// =============================================================================
// SSE Parser for Vertex AI streamRawPredict
// =============================================================================

async function* parseSSE(response: Response): AsyncGenerator<any> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop()!; // Keep incomplete line in buffer

		let eventType = "";
		let data = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				eventType = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				data = line.slice(6).trim();
			} else if (line === "" && data) {
				try {
					const parsed = JSON.parse(data);
					parsed._eventType = eventType;
					yield parsed;
				} catch {}
				eventType = "";
				data = "";
			}
		}
	}
}

// =============================================================================
// Streaming Implementation
// =============================================================================

function streamVertexAnthropic(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// Pi 0.87 passes a normalized TranscriptContext: the system prompt and tool
	// declarations live in transcript system messages, not on the context itself.
	// Vertex has no mid-conversation system messages, so fold them into the lead.
	const transcript = collapseSystemMessages(context);
	const systemPrompt = getCurrentSystemPrompt(transcript.messages);
	const tools = getCurrentTools(transcript.messages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const config = getConfig();
			const project = config.project;
			const region = getRegionForModel(model.id, config.region);
			const gcloudPath = config.gcloudPath;

			// Build Anthropic Messages API request body
			let body: any = {
				anthropic_version: "vertex-2023-10-16",
				messages: convertMessages(transcript.messages, model),
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};

			if (systemPrompt) {
				body.system = [
					{
						type: "text",
						text: sanitizeSurrogates(systemPrompt),
						cache_control: { type: "ephemeral" },
					},
				];
			}

			if (tools.length > 0) {
				body.tools = convertTools(tools);
			}

			// Handle thinking/reasoning
			if (options?.reasoning && model.reasoning) {
				if ((model as any).useAdaptiveThinking) {
					// Newer models use adaptive thinking with effort levels
					const effortMap: Record<string, string> = {
						minimal: "low",
						low: "low",
						medium: "medium",
						high: "high",
					};
					body.thinking = { type: "adaptive" };
					body.output_config = {
						effort: effortMap[options.reasoning as string] ?? "medium",
					};
				} else {
					const defaultBudgets: Record<string, number> = {
						minimal: 1024,
						low: 4096,
						medium: 10240,
						high: 20480,
					};
					const customBudget = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
					body.thinking = {
						type: "enabled",
						budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
					};
				}
			}

			// Make request to Vertex AI streamRawPredict endpoint
			const endpoint = getEndpoint(region);

			const url = `https://${endpoint}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${model.id}:streamRawPredict`;

			// Retry transparently on transient auth/server hiccups before we've
			// started streaming content (safe to retry, nothing pushed yet).
			// - 401 ACCESS_TOKEN_TYPE_UNSUPPORTED / invalid_grant etc: gcloud
			//   handed back a stale/bad token (can happen right after our cache
			//   TTL, after `gcloud auth login` elsewhere, or ADC refresh races).
			//   Force a fresh token and retry.
			// - 429 / 5xx: transient, retry with short backoff.
			// Let extensions inspect/replace the payload, like built-in providers do.
			const nextPayload = await options?.onPayload?.(body, model);
			if (nextPayload !== undefined) body = { ...(nextPayload as object), stream: true };

			const MAX_ATTEMPTS = 4;
			let response: Response | undefined;
			let lastErrorText = "";
			let lastStatus = 0;
			let token = await getAccessTokenAsync(gcloudPath);

			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				response = await fetch(url, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: options?.signal,
				});

				if (response.ok) break;

				lastStatus = response.status;
				lastErrorText = await response.text();

				const isAuthError =
					response.status === 401 ||
					(response.status === 403 && /ACCESS_TOKEN|UNAUTHENTICATED/i.test(lastErrorText));
				const isTransient = response.status === 429 || response.status >= 500;

				if (attempt === MAX_ATTEMPTS || options?.signal?.aborted || (!isAuthError && !isTransient)) {
					throw new Error(`Vertex AI error (${lastStatus}): ${lastErrorText}`);
				}

				if (isAuthError) {
					invalidateTokenCache();
					token = await getAccessTokenAsync(gcloudPath, true);
				} else {
					// exponential-ish backoff for transient/rate-limit errors
					await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
				}
			}

			if (!response || !response.ok) {
				throw new Error(`Vertex AI error (${lastStatus}): ${lastErrorText}`);
			}

			await options?.onResponse?.(
				{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
				model,
			);

			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of parseSSE(response)) {
				if (event.type === "message_start") {
					output.usage.input = event.message?.usage?.input_tokens || 0;
					output.usage.output = event.message?.usage?.output_tokens || 0;
					output.usage.cacheRead = event.message?.usage?.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message?.usage?.cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: "", index: event.index } as any);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						output.content.push({
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						} as any);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: event.content_block.name,
							arguments: {},
							partialJson: "",
							index: event.index,
						} as any);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta.thinking,
							partial: output,
						});
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
						(block as any).partialJson += event.delta.partial_json;
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta.partial_json,
							partial: output,
						});
					} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + (event.delta as any).signature;
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					delete (block as any).index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						delete (block as any).partialJson;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if (event.delta?.stop_reason) {
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					if (event.usage) {
						output.usage.output = event.usage.output_tokens || output.usage.output;
						output.usage.totalTokens =
							output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						calculateCost(model, output.usage);
					}
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// Clean up any remaining index properties
			for (const block of output.content) delete (block as any).index;

			if (output.stopReason === "pending") {
				throw new Error("Vertex stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as any).index;
				delete (block as any).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	const config = getConfig();

	const endpoint = getEndpoint(config.region);

	// Register provider with OAuth-style /login support
	pi.registerProvider("vertex-anthropic", {
		baseUrl: `https://${endpoint}`,
		api: "vertex-anthropic-api",

		// OAuth configuration for /login command
		oauth: {
			name: "Google Cloud Vertex AI (gcloud)",
			async login(callbacks) {
				const progress = (message: string) => callbacks.onProgress?.(message);
				progress("Setting up Google Cloud Vertex AI...");

				// Step 1: Check if gcloud is installed
				let gcloudPath = config.gcloudPath;
				try {
					gcloud(["version"], { path: gcloudPath, stdio: "ignore", timeout: 2000 });
				} catch {
					const install = await callbacks.onPrompt({
						message: "gcloud CLI not found. Install Google Cloud SDK?\n\n" +
							"This will download and install gcloud from:\n" +
							"https://cloud.google.com/sdk/docs/install\n\n" +
							"(y/n)",
					});

					if (install?.toLowerCase() === "y") {
						progress("Opening installation guide in browser...");
						callbacks.onAuth({
							url: "https://cloud.google.com/sdk/docs/install",
						});
						throw new Error("Please install gcloud CLI and run /login again");
					} else {
						throw new Error("gcloud CLI required. Install from: https://cloud.google.com/sdk/docs/install");
					}
				}

				// Step 2: Check authentication
				progress("Checking gcloud authentication...");
				let needsAuth = false;
				try {
					const token = gcloud(["auth", "print-access-token"], {
						path: gcloudPath,
						timeout: 5000,
						stdio: ["ignore", "pipe", "ignore"],
					}).trim();
					needsAuth = !token || token.includes("ERROR") || token.length < 20;
				} catch {
					needsAuth = true;
				}

				if (needsAuth) {
					const doAuth = await callbacks.onPrompt({
						message: "Not authenticated with gcloud. Run 'gcloud auth login' now? (y/n)",
					});

					if (doAuth?.toLowerCase() === "y") {
						progress("Running gcloud auth login...");
						progress("A browser window will open for authentication");

						try {
							gcloud(["auth", "login"], { path: gcloudPath, stdio: "inherit" });
						} catch (error) {
							throw new Error("Authentication failed. Please try: gcloud auth login");
						}
					} else {
						throw new Error("Authentication required. Run: gcloud auth login");
					}
				}

				// Step 3: Get/Set project
				progress("Configuring project...");
				let project = process.env.VERTEX_PROJECT_ID;

				if (!project || project === "your-gcp-project-id") {
					// Try to get current project
					try {
						const currentProject = gcloud(["config", "get-value", "project"], {
							path: gcloudPath,
							stdio: ["ignore", "pipe", "ignore"],
						}).trim();

						if (currentProject && currentProject !== "(unset)") {
							const use = await callbacks.onPrompt({
								message: `Use current project '${currentProject}'? (y/n)`,
							});
							if (use?.toLowerCase() === "y") {
								project = currentProject;
							}
						}
					} catch {}

					if (!project) {
						// List available projects
						let projectPrompt = "Enter GCP project ID:";
						try {
							const projects = gcloud(["projects", "list", "--format=value(projectId)"], {
								path: gcloudPath,
								stdio: ["ignore", "pipe", "ignore"],
								timeout: 10000,
							}).trim().split("\n").filter(p => p && p !== "(unset)");

							if (projects.length > 0 && projects.length < 20) {
								projectPrompt = `Available projects:\n${projects.map(p => `  - ${p}`).join("\n")}\n\nEnter project ID:`;
							}
						} catch {}

						const projectInput = await callbacks.onPrompt({
							message: projectPrompt,
						});

						if (!projectInput || projectInput.trim() === "") {
							throw new Error("Project ID required");
						}
						project = projectInput.trim();

						// Set as default
						try {
							gcloud(["config", "set", "project", project], { path: gcloudPath, stdio: "ignore" });
						} catch {}
					}
				}

				// Save to environment (user will need to add to their shell config)
				process.env.VERTEX_PROJECT_ID = project;

				// Step 4: Select region
				progress("Configuring region...");
				let region = process.env.VERTEX_REGION;

				if (!region) {
					const regionChoice = await callbacks.onPrompt({
						message: "Select region:\n\n" +
							"  1. global (recommended for latest models)\n" +
							"  2. eu (EU multi-region)\n" +
							"  3. us-east5\n" +
							"  4. us-central1\n" +
							"  5. europe-west1\n" +
							"  6. asia-southeast1\n\n" +
							"Enter 1-6 or custom region name:",
					});

					if (regionChoice === "1") {
						region = "global";
					} else if (regionChoice === "2") {
						region = "eu";
					} else if (regionChoice === "3") {
						region = "us-east5";
					} else if (regionChoice === "4") {
						region = "us-central1";
					} else if (regionChoice === "5") {
						region = "europe-west1";
					} else if (regionChoice === "6") {
						region = "asia-southeast1";
					} else if (regionChoice && regionChoice.trim()) {
						region = regionChoice.trim();
					} else {
						region = "global"; // Default to global
					}

					process.env.VERTEX_REGION = region;
				}

				// Step 5: Enable Vertex AI API
				progress("Checking Vertex AI API...");
				try {
					const enabled = gcloud(
						["services", "list", "--enabled", "--filter=name:aiplatform.googleapis.com", "--format=value(name)"],
						{ path: gcloudPath, stdio: ["ignore", "pipe", "ignore"] },
					).trim();

					if (!enabled) {
						const enable = await callbacks.onPrompt({
							message: "Vertex AI API not enabled. Enable it now? (y/n)",
						});

						if (enable?.toLowerCase() === "y") {
							progress("Enabling Vertex AI API (this may take a minute)...");
							gcloud(["services", "enable", "aiplatform.googleapis.com"], { path: gcloudPath, stdio: "inherit" });
							progress("Vertex AI API enabled!");
						} else {
							progress("API not enabled. You'll need to enable it manually:\n" +
								`  gcloud services enable aiplatform.googleapis.com --project=${project}`);
						}
					}
				} catch (error) {
					progress("Could not check API status. If requests fail, enable it manually:\n" +
						`  gcloud services enable aiplatform.googleapis.com --project=${project}`);
				}

				// Step 6: Test authentication
				progress("Testing authentication...");
				try {
					const token = gcloud(["auth", "print-access-token"], { path: gcloudPath, timeout: 5000 }).trim();

					if (!token || token.length < 20) {
						throw new Error("Invalid token");
					}
				} catch (error) {
					throw new Error("Authentication test failed. Please run: gcloud auth login");
				}

				// Success! Show next steps
				progress(`✓ Configured successfully!\n\n` +
					`Project: ${project}\n` +
					`Region: ${region}\n\n` +
					`Settings persisted to ~/.pi/agent/auth.json.\n` +
					`If authentication fails later, run: gcloud auth login`);

				// Return credentials with project/region persisted in auth.json
				return {
					refresh: Date.now().toString(),
					access: "gcloud",
					expires: Date.now() + 1000 * 60 * 60 * 24 * 365, // 1 year
					project,
					region,
				};
			},
			async refreshToken(credentials) {
				// Tokens are always fresh from gcloud, preserve project/region
				return {
					...credentials,
					refresh: Date.now().toString(),
				};
			},
			getApiKey(_credentials) {
				// Sync-only interface: uses the cache filled by the async stream path,
				// falling back to a blocking call only when cold/expired.
				return getAccessTokenSync(config.gcloudPath);
			},
		},

		// No inline model list: the catalog comes from `refreshModels` below,
		// which returns the static MODEL_METADATA table (no network lookup).
		streamSimple: streamVertexAnthropic,

		/**
		 * Vertex has no public REST endpoint to list Anthropic publisher
		 * models, so the catalog is just the static MODEL_METADATA table above.
		 */
		async refreshModels(_context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
			return Object.keys(MODEL_METADATA).map(toProviderModelConfig);
		},
	});

	// Provide helpful status when extension loads
	pi.on("session_start", async (_event, ctx) => {
		if (config.project === "your-gcp-project-id") {
			ctx.ui?.notify(
				"Vertex AI: Run /login to configure project and region",
				"warning",
			);
		}
	});
}
