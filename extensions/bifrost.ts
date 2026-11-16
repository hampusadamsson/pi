/**
 * Bifrost provider with automatic model discovery.
 *
 * Routes the local model cluster through Bifrost's OpenAI-compatible `/v1`
 * endpoint. Models are fetched from `/v1/models`; ids arrive as
 * `ollama/<model>` (Bifrost unified routing) and the prefix is stripped.
 *
 * TLS: Bifrost serves a self-signed cert. Rather than disabling verification
 * process-wide (the old NODE_TLS_REJECT_UNAUTHORIZED=0 leaked into Vertex, MCP,
 * web fetches and every child process), only the Bifrost certificate itself is
 * pinned into Node's default CA store. Host and CA verification stay on for
 * every host: nothing except a server presenting this exact cert is trusted.
 *
 * Do not return an empty list from refreshModels: an empty return wipes the
 * provider's models and hides the provider from /model entirely. Startup
 * latency also matters: the last successful discovery is cached to disk and
 * returned immediately; live discovery then refreshes on a bounded budget.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import tls from "node:tls";

const BIFROST_BASE = (process.env.BIFROST_BASE ?? "https://bifrost.haadpi.duckdns.org:9443").replace(/\/+$/, "");
const API_KEY = process.env.BIFROST_API_KEY ?? "sk-bf-1818b6aa-a7fc-4eb5-9804-8650be3b2f7b";

// ------------------------------------------------------------- TLS trust pin

const BIFROST_URL = new URL(BIFROST_BASE);
const EXT_DIR = dirname(new URL(import.meta.url).pathname);
const CA_PATH = process.env.BIFROST_CA_PATH ?? join(EXT_DIR, "bifrost-ca.pem");

/** PEM body without armor/whitespace, so a re-pin can be deduped. */
const pemBody = (pem: string) => pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

/** Add `pem` to the trusted roots, keeping the platform CA store intact. */
function pinCert(pem: string): boolean {
	try {
		const store = tls.getCACertificates("default");
		if (!store.some((c) => pemBody(c) === pemBody(pem))) {
			tls.setDefaultCACertificates([...store, pem]);
		}
		return true;
	} catch (err) {
		console.warn(`[bifrost] could not pin TLS certificate: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/**
 * Read the server leaf cert with verification off (one handshake) so it can be
 * pinned. This is the same trust decision the old blanket rejectUnauthorized
 * made, but scoped to this host and this one certificate.
 */
function fetchServerCert(): Promise<string> {
	const host = BIFROST_URL.hostname;
	const port = Number(BIFROST_URL.port || 443);
	return new Promise((resolve, reject) => {
		const socket = tls.connect(
			// servername matters: without SNI Traefik answers with its own default
			// cert, and the wrong certificate would get pinned.
			{ host, port, servername: host, rejectUnauthorized: false },
			() => {
				const cert = socket.getPeerCertificate(false);
				socket.end();
				if (!cert?.raw) return reject(new Error("no peer certificate"));
				const b64 = cert.raw.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
				resolve(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`);
			},
		);
		socket.once("error", reject);
	});
}

function isCertError(err: unknown): boolean {
	const e = err as { code?: string; cause?: { code?: string } } | undefined;
	const code = e?.code ?? e?.cause?.code ?? "";
	return /CERT|SSL|TLS|SELF_SIGNED/i.test(code);
}

/** Re-pin from the live server; used when the cert rotated under us. */
async function repinCert(): Promise<boolean> {
	try {
		const pem = await fetchServerCert();
		if (!pinCert(pem)) return false;
		try {
			writeFileSync(CA_PATH, pem, { mode: 0o644 });
		} catch {
			// Cache write failure is harmless; next session re-fetches.
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * The pinned copy on disk is trusted synchronously so the first request works;
 * a live fetch then re-pins and refreshes the copy if the cert changed.
 */
function installBifrostTlsTrust(): void {
	let cached: string | undefined;
	try {
		cached = readFileSync(CA_PATH, "utf8");
	} catch {
		cached = undefined;
	}
	if (cached) pinCert(cached);

	fetchServerCert()
		.then((pem) => {
			if (!pinCert(pem)) return;
			if (cached && pemBody(cached) === pemBody(pem)) return;
			try {
				writeFileSync(CA_PATH, pem, { mode: 0o644 });
			} catch {
				// Cache write failure is harmless; next session re-fetches.
			}
		})
		.catch(() => {
			// Offline or unreachable: keep whatever was pinned from disk.
		});
}

installBifrostTlsTrust();

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

// ------------------------------------------- tunables (env-overridable args)
//
// These apply only to models whose upstream returned no metadata. Bifrost's
// /v1/models answers for a local upstream with just {id, owned_by}, so every
// LM Studio model lands here and these values decide its context and budget.
//
// They must be sized for the *serving* context, not the model's maximum: an
// oversized maxTokens starves the input side of the same window and truncates
// output with a `length` finish reason (seen at 8.2k out on a 32k model).
//
// Override any of them without editing this file:
//   BIFROST_DEFAULT_CONTEXT_WINDOW   32768
//   BIFROST_DEFAULT_MAX_TOKENS       8192
//   BIFROST_REASONING_PATTERN        think|reason|-r1|qwq|deepseek-r|qwen3
//   BIFROST_SAMPLING                 {"temperature":0.7,"top_p":0.8,...}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		console.warn(`[bifrost] ignoring invalid ${name}=${raw}; using ${fallback}`);
		return fallback;
	}
	return Math.floor(n);
}

function envJson<T>(name: string, fallback: T): T {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		console.warn(`[bifrost] ignoring invalid JSON in ${name}; using defaults`);
		return fallback;
	}
}

const DEFAULT_CONTEXT_WINDOW = envInt("BIFROST_DEFAULT_CONTEXT_WINDOW", 32768);
const DEFAULT_MAX_TOKENS = envInt("BIFROST_DEFAULT_MAX_TOKENS", 8192);

// Ids matching this are flagged as reasoning models. The thinking families
// carry no `think`/`reason` in their id, so they must be named explicitly or
// Pi treats a thinking model as plain and budgets output as if it never
// reasons — the model then thinks anyway and gets cut off mid-<think>.
const REASONING_PATTERN = new RegExp(
	process.env.BIFROST_REASONING_PATTERN ?? "think|reason|-r1|qwq|deepseek-r|qwen3",
	"i",
);

// Sampled values from the Qwen3.x model card for instruct/non-thinking mode.
// Qwen3.x runs thinking ON by default; for the thinking-mode spec use
// BIFROST_SAMPLING='{"temperature":1.0,"top_p":0.95,"top_k":20,"min_p":0}'.
const DEFAULT_SAMPLING = envJson<Record<string, number>>("BIFROST_SAMPLING", {
	temperature: 0.7,
	top_p: 0.8,
	presence_penalty: 1.5,
});

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
	return REASONING_PATTERN.test(id);
}

function toProviderModel(m: ModelInfo) {
	// An upstream that reports nothing but an id is a local server behind
	// Bifrost. Those get the conservative defaults and our sampling profile;
	// cloud models that publish metadata keep their own values and are left
	// alone so their provider-side defaults still apply.
	const bare = m.cost === undefined && m.contextWindow === undefined && m.maxTokens === undefined;
	return {
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions" as const,
		// Re-derive from the id instead of trusting the field: the on-disk
		// discovery cache may predate a REASONING_PATTERN change and would
		// otherwise keep a thinking model pinned to reasoning:false.
		reasoning: guessReasoning(m.id) || m.reasoning,
		input: ["text" as const],
		cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(bare ? { samplingParams: DEFAULT_SAMPLING } : {}),
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
					// Cert rotated or never pinned: re-pin once, then retry.
					if (isCertError(err) && (await repinCert())) continue;
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
