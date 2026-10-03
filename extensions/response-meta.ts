/**
 * response-meta — tiny non-intrusive per-response metadata line.
 *
 * Appends a `custom` session entry (never sent to LLM) after each assistant
 * message: local time · duration · tok/s · in/out (+cached) · cost · model.
 * Rendered as one muted line via entry renderer. No commands, no config.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const TYPE = "response-meta";

interface Meta {
	time: string;
	durationMs: number | null;
	tps: number | null;
	input: number;
	output: number;
	cached: number;
	cost: number;
	model: string;
	note: string | null;
	tools: number;
}

function clock(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtN(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

function fmtDur(ms: number | null): string {
	if (ms == null || ms < 0 || ms > 3600_000) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTps(tps: number | null): string {
	if (tps == null || !isFinite(tps)) return "— t/s";
	return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} t/s`;
}

function fmtCost(c: number): string {
	if (!c || c <= 0) return "$0";
	if (c < 0.01) return `$${c.toFixed(4)}`;
	return `$${c.toFixed(3)}`;
}

function shortModel(m: string): string {
	const i = m.lastIndexOf("/");
	return i >= 0 ? m.slice(i + 1) : m;
}

function line(m: Meta): string {
	const parts = [
		m.time,
		fmtDur(m.durationMs),
		fmtTps(m.tps),
		`${fmtN(m.input)} in / ${fmtN(m.output)} out${m.cached > 0 ? ` (+${fmtN(m.cached)} cached)` : ""}`,
		fmtCost(m.cost),
		shortModel(m.model),
	];
	if (m.tools > 0) parts.push(`${m.tools} tool${m.tools === 1 ? "" : "s"}`);
	if (m.note) parts.push(m.note);
	return parts.join(" · ");
}

export default function (pi: ExtensionAPI) {
	// Timestamp of the previous message (user, assistant or tool result).
	let lastTs = 0;

	pi.on("session_start", (_e, ctx) => {
		lastTs = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const ts = (entry.message as { timestamp?: number }).timestamp;
				if (typeof ts === "number") lastTs = ts;
			}
		}
	});

	pi.on("message_end", (e) => {
		const msg = e.message;
		const endTs = Date.now();
		const prev = lastTs;
		lastTs = endTs;
		if (msg.role !== "assistant") return;
		const durationMs = prev > 0 && endTs >= prev && endTs - prev <= 3600_000 ? endTs - prev : null;
		const asst = msg as {
				timestamp?: number;
			usage?: { input: number; output: number; cacheRead: number; cost: { total: number } };
			stopReason: string;
			content: { type: string }[];
			responseModel?: string;
			model: string;
		};
		const secs = durationMs != null ? durationMs / 1000 : null;
		const out = asst.usage?.output ?? 0;
		pi.appendEntry<Meta>(TYPE, {
			time: clock(endTs),
			durationMs,
			tps: secs && secs > 0 ? out / secs : null,
			input: asst.usage?.input ?? 0,
			output: out,
			cached: asst.usage?.cacheRead ?? 0,
			cost: asst.usage?.cost?.total ?? 0,
			model: asst.responseModel ?? asst.model ?? "?",
			note:
				asst.stopReason === "stop" || asst.stopReason === "toolUse" || asst.stopReason === "pending"
					? null
					: asst.stopReason,
			tools: Array.isArray(asst.content)
				? asst.content.filter((b) => b.type === "toolCall").length
				: 0,
		});
	});

	pi.registerEntryRenderer<Meta>(TYPE, (entry, _options, theme) => {
		const data = entry.data as Meta | undefined;
		if (!data) return undefined;
		const text = line(data);
		return {
			render: (width: number) => {
					try {
						return [theme.fg("muted", truncateToWidth(text, width))];
					} catch {
						return [text];
					}
				},
			invalidate: () => {},
		};
	});
}
