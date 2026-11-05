/**
 * Bifrost provider with automatic model discovery.
 *
 * Routes the local model cluster through Bifrost's OpenAI-compatible `/v1`
 * endpoint. Models are fetched from `/v1/models`; ids arrive as
 * `ollama/<model>` (Bifrost unified routing) and the prefix is stripped.
 *
 * Bifrost uses a self-signed cert (user-approved insecure). Pi's fetch
 * (undici, used by both discovery here and the OpenAI SDK for chat) only
 * trusts it with TLS verification off, so this extension sets
 * NODE_TLS_REJECT_UNAUTHORIZED=0 at load. Runtime-set works (verified);
 * NODE_EXTRA_CA_CERTS at runtime does not.
 *
 * Do not return an empty list from refreshModels: an empty return wipes the
 * provider's models and hides the provider from /model entirely. Startup
 * latency also matters: the last successful discovery is cached to disk and
 * returned immediately; live discovery then refreshes on a bounded budget.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BIFROST_BASE = (process.env.BIFROST_BASE ?? "https://bifrost.haadpi.duckdns.org:9443").replace(/\/+$/, "");
const API_KEY = process.env.BIFROST_API_KEY ?? "sk-bf-1818b6aa-a7fc-4eb5-9804-8650be3b2f7b";
// Upstream prefixes stripped from ids (bare ids keep existing selections/roles
// working). Comma-separated; everything else keeps its `provider/` prefix.
const STRIP_PREFIXES = (process.env.BIFROST_STRIP_PREFIXES ?? "ollama")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
// Optional comma-separated regexes; only ids matching one are exposed.
const INCLUDE = (process.env.BIFROST_INCLUDE ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
	.map((s) => new RegExp(s));
// Cache of last successful discovery, written next to this file. Returned
// instantly at startup so Pi never blocks waiting on the network.
const CACHE_PATH = join(dirname(new URL(import.meta.url).pathname), "bifrost-models.json");

// Fallbacks for models where metadata is unavailable.
// These must leave headroom for output: undersized maxTokens truncates
// responses with a `length` finish reason (seen at 8.2k out).
// Context default set very high (1M) so local models are never squeezed.
const DEFAULT_CONTEXT_WINDOW = 1000000;
const DEFAULT_MAX_TOKENS = 32768;

interface DiscoveredModel {
	id: string;
	reasoning: boolean;
}

// Discovery result caps parsed from provider metadata (all optional).
interface ModelInfo extends DiscoveredModel {
	name?: string;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

// Best-effort metadata extraction from a raw /v1/models entry; schema varies
// by upstream (Bifrost/Ollama/OpenAI), so probe the common fields.
function parseInfo(raw: unknown, id: string): ModelInfo {
	const r = (raw ?? {}) as Record<string, unknown>;
	const ctx =
		num(r.context_length) ??
		num(r.context_window) ??
		num(r.max_input_tokens) ??
		num(r.max_model_len) ??
		num(r.context_length_tokens);
	// Ollama nests details under ollama.<...>
	const o = (r.ollama ?? {}) as Record<string, unknown>;
	const ctx2 =
		ctx ??
		num(o.context_length) ??
		num((r as { max_model_length?: number }).max_model_length);
	const out =
		num(r.max_output_tokens) ??
		num(r.max_tokens) ??
		num(r.max_completion_tokens) ??
		num(o.max_output_tokens);
	// Pricing is USD per token; pi expects USD per million tokens.
	const p = (r.pricing ?? undefined) as Record<string, unknown> | undefined;
	const perM = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) * 1e6 : 0);
	return {
		id,
		name: typeof r.normalized_name === "string" ? r.normalized_name : undefined,
		cost: p
			? {
					input: perM(p.prompt),
					output: perM(p.completion),
					cacheRead: perM(p.input_cache_read),
					cacheWrite: perM(p.input_cache_write),
				}
			: undefined,
		reasoning: guessReasoning(id),
		contextWindow: ctx2,
		maxTokens: out,
	};
}

function guessReasoning(id: string): boolean {
	return /think|reason|-r1|qwq|deepseek-r/i.test(id);
}

function toProviderModel(m: ModelInfo) {
	return {
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions" as const,
		reasoning: m.reasoning,
		input: ["text" as const],
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens" as const,
		},
	};
}



function loadCache(): ModelInfo[] {
	try {
		const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as unknown;
		if (!Array.isArray(cached)) return [];
		// contextWindow/maxTokens are optional; toProviderModel applies defaults.
		return cached.filter((m): m is ModelInfo => typeof (m as ModelInfo).id === "string");
	} catch {
		return [];
	}
}

function saveCache(models: ModelInfo[]) {
	try {
		writeFileSync(CACHE_PATH, JSON.stringify(models, null, "\t"));
	} catch {
		// Cache write failure is harmless; discovery will just run again.
	}
}

async function discover(signal: AbortSignal): Promise<ModelInfo[]> {
	const res = await fetch(`${BIFROST_BASE}/v1/models`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
		signal,
	});
	if (!res.ok) throw new Error(`bifrost /v1/models ${res.status}`);
	const body = (await res.json()) as { data?: Record<string, unknown>[] };
	const raw = body.data ?? [];
	const entries = raw.map((m, i) => parseInfo(m, (typeof m.id === "string" ? m.id : `model-${i}`)));
	const seen = new Set<string>();
	return entries
		.filter((m) => INCLUDE.length === 0 || INCLUDE.some((re) => re.test(m.id)))
		.map((m) => {
			const prefix = STRIP_PREFIXES.find((p) => m.id.startsWith(`${p}/`));
			if (!prefix) return m;
			const id = m.id.slice(prefix.length + 1);
			return { ...m, id, reasoning: guessReasoning(id) };
		})
		.filter((m) => !seen.has(m.id) && (seen.add(m.id), true));
}

export default function (pi) {
	pi.registerProvider("bifrost", {
		baseUrl: `${BIFROST_BASE}/v1`,
		apiKey: API_KEY,
		api: "openai-completions",
		headers: { Authorization: `Bearer ${API_KEY}` },
		refreshModels: async (context) => {
			// Startup must never block: serve the disk cache of the last
			// successful discovery immediately if network isn't ready yet.
			const cachedModels = loadCache();
			if (!context.allowNetwork) return cachedModels.map(toProviderModel);
			// Refresh on a bounded budget (15 attempts x ~1s + request time);
			// if live discovery never succeeds, fall back to the disk cache so
			// the provider always shows up with models.
			for (let attempt = 0; attempt < 15; attempt++) {
				let liveInfo: ModelInfo[] = [];
				try {
					liveInfo = await discover(context.signal);
				} catch (err) {
					if (context.signal.aborted) throw err;
				}
				if (liveInfo.length > 0) {
					saveCache(liveInfo);
					return liveInfo.map(toProviderModel);
				}
				if (context.signal.aborted) throw new Error("bifrost discovery aborted");
				await new Promise((r) => setTimeout(r, 1000));
			}
			return cachedModels.map(toProviderModel);
		},
	});
}
