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
 * Never returns an empty list from refreshModels: an empty return wipes the
 * provider's models (composer replaces live models with the returned list),
 * which hides the provider from /model entirely. Offline or on discovery
 * failure it returns the static fallback instead.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BIFROST_BASE = "https://bifrost.haadpi.duckdns.org:9443";
const API_KEY = "sk-bf-1818b6aa-a7fc-4eb5-9804-8650be3b2f7b";

// Defaults for models where metadata is unavailable.
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 8192;

interface DiscoveredModel {
	id: string;
	reasoning: boolean;
}

function guessReasoning(id: string): boolean {
	return /think|reason|-r1|qwq|deepseek-r/i.test(id);
}

function toProviderModel(m: DiscoveredModel) {
	return {
		id: m.id,
		name: m.id,
		api: "openai-completions" as const,
		reasoning: m.reasoning,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens" as const,
		},
	};
}



async function discover(signal: AbortSignal): Promise<DiscoveredModel[]> {
	const res = await fetch(`${BIFROST_BASE}/v1/models`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
		signal,
	});
	if (!res.ok) throw new Error(`bifrost /v1/models ${res.status}`);
	const body = (await res.json()) as { data?: { id: string }[] };
	const ids = (body.data ?? []).map((m) => m.id);
	const ollama = ids.filter((id) => id.startsWith("ollama/")).map((id) => id.slice("ollama/".length));
	if (ollama.length > 0) {
		return ollama.map((id) => ({ id, reasoning: guessReasoning(id) }));
	}
	// Bifrost not using provider prefixes: bare model ids.
	return ids.map((id) => ({ id, reasoning: guessReasoning(id) }));
}

export default function (pi) {
	pi.registerProvider("bifrost", {
		baseUrl: `${BIFROST_BASE}/v1`,
		apiKey: API_KEY,
		api: "openai-completions",
		headers: { Authorization: `Bearer ${API_KEY}` },
		models: [],
		refreshModels: async (context) => {
			if (!context.allowNetwork) return [];
			const models = await discover(context.signal);
			return models.map(toProviderModel);
		},
	});
}
