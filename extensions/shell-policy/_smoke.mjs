/**
 * Smoke test for the shell-policy extension.
 *
 * Runs the real default export against a mock ExtensionAPI and a throwaway
 * PI_CODING_AGENT_DIR, then drives the `tool_call` handler to print verdicts.
 * Mirrors extensions/roles/_smoke.mjs.
 *
 *   node extensions/shell-policy/_smoke.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PKG = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": `${PKG}/dist/index.js`,
		"@earendil-works/pi-tui": `${PKG}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
});

const agentDir = mkdtempSync(join(tmpdir(), "shell-policy-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const mod = await jiti.import("./index.ts", { default: true });

const handlers = {};
const cmds = {};

const pi = {
	on: (event, handler) => ((handlers[event] ||= []).push(handler)),
	registerCommand: (name, options) => (cmds[name] = options),
	registerShortcut: () => {},
	registerTool: () => {},
	registerFlag: () => {},
	getFlag: () => undefined,
	appendEntry: () => {},
	getAllTools: () => [],
	getActiveTools: () => [],
	setActiveTools: () => {},
};

mod(pi);

const theme = { fg: (_color, text) => text };

function makeCtx({ role, trusted = false } = {}) {
	const branch =
		role === undefined
			? []
			: [{ type: "custom", customType: "role-switch", data: { role } }];
	return {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => trusted,
		isIdle: () => true,
		signal: undefined,
		ui: {
			notify: (message) => console.log(`  notify: ${message.replace(/\n/g, "\n  ")}`),
			setStatus: () => {},
			confirm: async () => true,
			select: async () => undefined,
			theme,
		},
		sessionManager: { getBranch: () => branch },
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
	};
}

async function check(label, toolName, command, ctx) {
	const event = { type: "tool_call", toolCallId: "t1", toolName, input: { command } };
	const result = await handlers.tool_call[0](event, ctx);
	const verdict = result?.block ? `BLOCK  ${result.reason}` : "ALLOW";
	console.log(`  ${label.padEnd(40)} ${verdict}`);
}

function writeRoles(content) {
	writeFileSync(join(agentDir, "roles.json"), typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

const none = makeCtx();

console.log("\n=== 1. no config: current behavior, everything runs ===");
await check("rm -rf /", "hypa_shell", "rm -rf /", none);
await check("kubectl delete ns prod", "hypa_shell", "kubectl delete ns prod", none);
await check("bash builtin", "bash", "rm -rf /", none);
await check("hypa_read (not gated)", "hypa_read", "rm -rf /", none);

console.log("\n=== 2. global allowlist (default inferred as deny) ===");
writeRoles({
	shellPolicy: { allow: ["git *", "kubectl get *", "npm test", "cd *", "ls *"] },
	roles: {
		work: { shellPolicy: { deny: ["git push *"] } },
		ticketor: { shellPolicy: { allow: ["kubectl get pods"] } },
	},
});

const work = makeCtx({ role: "work" });
await check("git status", "hypa_shell", "git status", work);
await check("kubectl get pods -n prod", "hypa_shell", "kubectl get pods -n prod", work);
await check("kubectl delete ns prod", "hypa_shell", "kubectl delete ns prod", work);
await check("git push origin main (role deny)", "hypa_shell", "git push origin main", work);
await check("git status && rm -rf /", "hypa_shell", "git status && rm -rf /", work);
await check("git status; kubectl delete pod x", "hypa_shell", "git status; kubectl delete pod x", work);
await check("echo $(whoami)", "hypa_shell", "echo $(whoami)", work);

console.log("\n=== 3. a role can only narrow within the ceiling ===");
const ticketor = makeCtx({ role: "ticketor" });
await check("kubectl get pods (role allows)", "hypa_shell", "kubectl get pods", ticketor);
await check("kubectl get pods -n x (narrowed out)", "hypa_shell", "kubectl get pods -n x", ticketor);
await check("git status (not in role list)", "hypa_shell", "git status", ticketor);

console.log("\n=== 4. role with no shellPolicy inherits global ===");
const researcher = makeCtx({ role: "researcher" });
await check("git status", "hypa_shell", "git status", researcher);
await check("kubectl delete ns prod", "hypa_shell", "kubectl delete ns prod", researcher);

console.log("\n=== 5. no role: global rules still apply ===");
await check("git status", "hypa_shell", "git status", none);
await check("kubectl delete ns prod", "hypa_shell", "kubectl delete ns prod", none);

console.log("\n=== 6. /shell-policy for role work ===");
await cmds["shell-policy"].handler("", work);

console.log("\n=== 7. malformed config fails closed ===");
writeRoles("{ this is not json");
await check("git status (config broken)", "hypa_shell", "git status", work);

console.log("\n=== 8. back to no config ===");
rmSync(join(agentDir, "roles.json"));
await check("rm -rf /", "hypa_shell", "rm -rf /", work);

console.log("\n=== 9. kubectl deny (global, deny-list mode) ===");
writeRoles({ shellPolicy: { deny: ["kubectl*", "*/kubectl*", "sudo kubectl*"] } });
await check("kubectl get pods", "hypa_shell", "kubectl get pods", work);
await check("kubectl delete ns prod", "hypa_shell", "kubectl delete ns prod", work);
await check("/usr/local/bin/kubectl get pods", "hypa_shell", "/usr/local/bin/kubectl get pods", work);
await check("git status (unaffected)", "hypa_shell", "git status", work);
await check("rm -rf /tmp/x (unaffected)", "hypa_shell", "rm -rf /tmp/x", work);

console.log("\n=== 10. allow cannot override a deny ===");
writeRoles({
	shellPolicy: { allow: ["kubectl get *"], deny: ["kubectl*"] },
});
await check("kubectl get pods (allow + deny)", "hypa_shell", "kubectl get pods", work);

console.log("\n=== 11. role re-granting kubectl under a global deny ===");
writeRoles({
	shellPolicy: { deny: ["kubectl*"] },
	roles: { work: { shellPolicy: { allow: ["kubectl get *"] } } },
});
await check("kubectl get pods (role allow)", "hypa_shell", "kubectl get pods", work);

console.log("\n=== 12. read-only kubectl via allowlist + default deny ===");
writeRoles({
	shellPolicy: {
		allow: ["kubectl get *", "kubectl describe *", "kubectl logs *", "git *"],
		default: "deny",
	},
});
await check("kubectl get pods", "hypa_shell", "kubectl get pods", work);
await check("kubectl describe pod x", "hypa_shell", "kubectl describe pod x", work);
await check("kubectl delete ns prod", "hypa_shell", "kubectl delete ns prod", work);
await check("git status", "hypa_shell", "git status", work);
await check("rm -rf /tmp/x", "hypa_shell", "rm -rf /tmp/x", work);

console.log("\n=== 13. default allow with an allow list ===");
writeRoles({ shellPolicy: { allow: ["git *"], default: "allow" } });
await check("git status", "hypa_shell", "git status", work);
await check("rm -rf /tmp/x (falls to default)", "hypa_shell", "rm -rf /tmp/x", work);

console.log("\n=== 14. explicit default deny with only deny globs ===");
writeRoles({ shellPolicy: { deny: ["git push *"], default: "deny" } });
await check("git push origin main", "hypa_shell", "git push origin main", work);
await check("git status (blocked by default)", "hypa_shell", "git status", work);

console.log("\n=== 15. a role cannot relax a global default:deny ===");
writeRoles({
	shellPolicy: { allow: ["git *"], default: "deny" },
	roles: { work: { shellPolicy: { default: "allow" } } },
});
await check("git status", "hypa_shell", "git status", work);
await check("rm -rf / (role tried default allow)", "hypa_shell", "rm -rf /", work);

console.log("\n=== 16. a role can tighten a global default:allow ===");
writeRoles({
	shellPolicy: { default: "allow", deny: ["sudo *"] },
	roles: { ticketor: { shellPolicy: { allow: ["kubectl get *"], default: "deny" } } },
});
const ticketorTight = makeCtx({ role: "ticketor" });
await check("kubectl get pods (role)", "hypa_shell", "kubectl get pods", ticketorTight);
await check("git status (role blocks)", "hypa_shell", "git status", ticketorTight);
await check("git status (work: global default allow)", "hypa_shell", "git status", work);

rmSync(join(agentDir, "roles.json"));
console.log("\ndone.");
