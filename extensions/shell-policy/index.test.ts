import assert from "node:assert/strict";
import { test } from "node:test";
import {
	evaluate,
	globToRegExp,
	levelDefault,
	matchesAny,
	mergeFile,
	mergePolicy,
	normalizeSegment,
	splitSegments,
	type EffectivePolicy,
	type PolicyDefault,
	type ShellPolicyRule,
} from "./policy.ts";

const policy = (
	allow: string[] = [],
	deny: string[] = [],
	fallback: PolicyDefault = "allow",
): EffectivePolicy => ({ allow, deny, default: fallback, configured: true });

// ------------------------------------------------------------------ globbing

test("glob matches whole strings only", () => {
	assert.ok(globToRegExp("kubectl get *").test("kubectl get pods"));
	assert.ok(globToRegExp("kubectl get *").test("kubectl get pods -o wide"));
	assert.ok(!globToRegExp("kubectl get *").test("kubectl delete pod"));
	assert.ok(!globToRegExp("kubectl").test("kubectl get pods"));
});

test("glob escapes regex metacharacters", () => {
	assert.ok(globToRegExp("rm -rf /").test("rm -rf /"));
	assert.ok(!globToRegExp("a.b").test("axb"), "dot is literal");
	assert.ok(globToRegExp("a.b").test("a.b"));
});

test("matchesAny is true when any pattern matches", () => {
	assert.ok(matchesAny("git status", ["npm *", "git *"]));
	assert.ok(!matchesAny("git status", ["npm *", "cargo *"]));
});

// -------------------------------------------------------------- segmentation

test("normalizeSegment collapses whitespace", () => {
	assert.equal(normalizeSegment("  kubectl   get\tpods  "), "kubectl get pods");
});

test("splitSegments splits on shell separators", () => {
	assert.deepEqual(splitSegments("cd /tmp && ls"), ["cd /tmp", "ls"]);
	assert.deepEqual(splitSegments("a ; b ; c"), ["a", "b", "c"]);
	assert.deepEqual(splitSegments("a || b"), ["a", "b"]);
	assert.deepEqual(splitSegments("a | b"), ["a", "b"]);
	assert.deepEqual(splitSegments("a\nb"), ["a", "b"]);
	assert.deepEqual(splitSegments("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
});

test("splitSegments drops empty segments", () => {
	assert.deepEqual(splitSegments("  "), []);
	assert.deepEqual(splitSegments("a && "), ["a"]);
});

// ------------------------------------------------------------ levelDefault

test("levelDefault infers from the shape of the rule", () => {
	assert.equal(levelDefault(undefined), undefined);
	assert.equal(levelDefault({ deny: ["x"] }), "allow", "denylist is fail-open");
	assert.equal(levelDefault({ allow: ["x"] }), "deny", "allowlist is fail-closed");
	assert.equal(levelDefault({ allow: [] }), "deny", "even an empty allowlist");
	assert.equal(levelDefault({ allow: ["x"], deny: ["y"] }), "deny");
});

test("an explicit default beats the inferred one", () => {
	assert.equal(levelDefault({ deny: ["x"], default: "deny" }), "deny");
	assert.equal(levelDefault({ allow: ["x"], default: "allow" }), "allow");
	assert.equal(levelDefault({ default: "allow" }), "allow");
	assert.equal(levelDefault({ default: "deny" }), "deny");
});

// ------------------------------------------------------------------ evaluate

test("unconfigured policy allows everything", () => {
	const none: EffectivePolicy = {
		allow: [],
		deny: [],
		default: "allow",
		configured: false,
	};
	assert.equal(evaluate("rm -rf /", none).allowed, true);
});

test("deny-list mode allows anything not denied", () => {
	const p = policy([], ["git push *", "sudo *"]);
	assert.equal(evaluate("git status", p).allowed, true);
	assert.equal(evaluate("git push origin main", p).allowed, false);
	assert.equal(evaluate("sudo rm -rf /", p).allowed, false);
});

test("allow-list mode blocks unmatched segments", () => {
	const p = policy(["git *"], [], "deny");
	assert.equal(evaluate("git status", p).allowed, true);
	assert.equal(evaluate("npm install", p).allowed, false);
});

test("deny wins over allow", () => {
	const p = policy(["git *"], ["git push *"]);
	assert.equal(evaluate("git status", p).allowed, true);
	assert.equal(evaluate("git push origin main", p).allowed, false);
});

test("allow wins over a deny-by-default fallback", () => {
	const p = policy(["kubectl get *"], [], "deny");
	assert.equal(evaluate("kubectl get pods", p).allowed, true);
	assert.equal(evaluate("kubectl delete ns prod", p).allowed, false);
});

test("default allow with an allow list permits unmatched segments", () => {
	const p = policy(["git *"], [], "allow");
	assert.equal(evaluate("git status", p).allowed, true);
	assert.equal(evaluate("rm -rf /", p).allowed, true, "unmatched falls through to default");
});

test("default deny with only deny globs blocks everything unmatched", () => {
	const p = policy([], ["git push *"], "deny");
	assert.equal(evaluate("git push origin main", p).allowed, false);
	assert.equal(evaluate("git status", p).allowed, false, "no allow rules, default deny");
});

test("chained commands are checked segment by segment", () => {
	const p = policy(["git *", "npm *"], [], "deny");
	assert.equal(evaluate("git status && npm test", p).allowed, true);
	assert.equal(evaluate("git status && rm -rf /", p).allowed, false);
	assert.equal(evaluate("git status; rm -rf /", p).allowed, false);
	assert.equal(evaluate("git status | sh", p).allowed, false);
	assert.equal(evaluate("git status\nrm -rf /", p).allowed, false);
});

test("blocking reports the offending segment", () => {
	const p = policy(["git *"], [], "deny");
	const verdict = evaluate("git status && rm -rf /", p, "work");
	assert.equal(verdict.allowed, false);
	assert.equal(verdict.segment, "rm -rf /");
	assert.match(verdict.reason ?? "", /rm -rf \//);
	assert.match(verdict.reason ?? "", /work/);
});

test("deny reason names the matched rule", () => {
	const p = policy([], ["git push *"]);
	const verdict = evaluate("git push origin main", p, "work");
	assert.match(verdict.reason ?? "", /deny rule "git push \*"/);
});

test("opaque expansions are blocked when unmatched segments are blocked", () => {
	const p = policy(["echo *"], [], "deny");
	assert.equal(evaluate("echo $(whoami)", p).allowed, false);
	assert.equal(evaluate("echo `whoami`", p).allowed, false);
	assert.equal(evaluate("cat <(whoami)", p).allowed, false);
	assert.match(evaluate("echo $(whoami)", p).reason ?? "", /substitution/);
});

test("opaque expansions are not blocked when default is allow", () => {
	const p = policy([], ["sudo *"], "allow");
	assert.equal(evaluate("echo $(whoami)", p).allowed, true);
});

test("empty allow list with default deny blocks everything", () => {
	const verdict = evaluate("ls", policy([], [], "deny"), "work");
	assert.equal(verdict.allowed, false);
	assert.match(verdict.reason ?? "", /no command is permitted/);
});

test("empty command is allowed", () => {
	assert.equal(evaluate("   ", policy(["git *"], [], "deny")).allowed, true);
});

// ------------------------------------------------------------- mergePolicy

test("mergePolicy with no rules is unconfigured", () => {
	const p = mergePolicy(undefined, undefined);
	assert.equal(p.configured, false);
	assert.deepEqual(p.allow, []);
	assert.equal(p.default, "allow");
});

test("mergePolicy infers defaults from rule shape", () => {
	assert.equal(mergePolicy({ deny: ["x"] }, undefined).default, "allow");
	assert.equal(mergePolicy({ allow: ["x"] }, undefined).default, "deny");
});

test("role allow list narrows within the global ceiling", () => {
	const p = mergePolicy({ allow: ["git *", "npm *"] }, { allow: ["git *"] });
	assert.deepEqual(p.allow, ["git *"]);
	assert.equal(evaluate("git status", p, "work").allowed, true);
	assert.equal(evaluate("npm test", p, "work").allowed, false);
});

test("a role cannot grant beyond the global ceiling", () => {
	const p = mergePolicy({ allow: ["git *"] }, { allow: ["rm -rf *"] });
	assert.deepEqual(p.allow, []);
	assert.equal(evaluate("rm -rf /", p, "work").allowed, false);
});

test("global '*' lets a role name anything", () => {
	const p = mergePolicy({ allow: ["*"] }, { allow: ["git *"] });
	assert.deepEqual(p.allow, ["git *"]);
	assert.equal(evaluate("git status", p, "work").allowed, true);
});

test("a role alone can set an allow list when there is no global one", () => {
	const p = mergePolicy(undefined, { allow: ["kb *"] });
	assert.deepEqual(p.allow, ["kb *"]);
	assert.equal(p.default, "deny");
	assert.equal(evaluate("kb list", p, "ticketor").allowed, true);
	assert.equal(evaluate("rm -rf /", p, "ticketor").allowed, false);
});

test("deny rules are additive across global and role", () => {
	const p = mergePolicy({ deny: ["sudo *"] }, { deny: ["git push *"] });
	assert.deepEqual(p.deny, ["sudo *", "git push *"]);
});

test("a role cannot remove a global deny", () => {
	const p = mergePolicy({ allow: ["*"], deny: ["sudo *"] }, { allow: ["sudo *"] });
	assert.equal(evaluate("sudo ls", p, "work").allowed, false);
});

test("the stricter default wins across global and role", () => {
	const strict = mergePolicy({ default: "deny" }, { default: "allow" });
	assert.equal(strict.default, "deny", "a role cannot relax a fail-closed global");

	const loose = mergePolicy({ default: "allow" }, { default: "deny" });
	assert.equal(loose.default, "deny", "a role can tighten");

	const inherited = mergePolicy({ allow: ["git *"] }, undefined);
	assert.equal(inherited.default, "deny");

	const roleAllowlist = mergePolicy({ default: "allow" }, { allow: ["git *"] });
	assert.equal(roleAllowlist.default, "deny", "role allow list implies fail-closed");
});

test("a role cannot widen a global default:deny policy", () => {
	const p = mergePolicy({ default: "deny", allow: ["git *"] }, { default: "allow" });
	assert.equal(p.default, "deny");
	assert.equal(evaluate("rm -rf /", p, "work").allowed, false);
	assert.equal(evaluate("git status", p, "work").allowed, true);
});

// ---------------------------------------------------------------- mergeFile

test("mergeFile reads global and per-role rules", () => {
	const target = { roles: {} as Record<string, ShellPolicyRule>, diagnostics: [] as string[] };
	mergeFile(target, {
		shellPolicy: { allow: ["git *"] },
		roles: { work: { shellPolicy: { deny: ["git push *"] } }, architect: {} },
	});
	assert.deepEqual(target.global, { allow: ["git *"] });
	assert.deepEqual(target.roles.work, { deny: ["git push *"] });
	assert.equal(target.roles.architect, undefined, "role without shellPolicy is ignored");
});

test("mergeFile reads default", () => {
	const target = { roles: {} as Record<string, ShellPolicyRule>, diagnostics: [] as string[] };
	mergeFile(target, {
		shellPolicy: { default: "deny", allow: ["git *"] },
		roles: { work: { shellPolicy: { default: "allow" } } },
	});
	assert.deepEqual(target.global, { default: "deny", allow: ["git *"] });
	assert.deepEqual(target.roles.work, { default: "allow" });
});

test("mergeFile drops an invalid default", () => {
	const target = { roles: {} as Record<string, ShellPolicyRule>, diagnostics: [] as string[] };
	mergeFile(target, { shellPolicy: { default: "maybe", allow: ["git *"] } });
	assert.deepEqual(target.global, { allow: ["git *"] }, "invalid default is ignored");
});

test("mergeFile ignores malformed rules", () => {
	const target = { roles: {} as Record<string, ShellPolicyRule>, diagnostics: [] as string[] };
	mergeFile(target, { shellPolicy: "nope", roles: { work: { shellPolicy: { allow: "nope" } } } });
	assert.equal(target.global, undefined);
	assert.equal(target.roles.work, undefined);
});

test("mergeFile filters non-string entries", () => {
	const target = { roles: {} as Record<string, ShellPolicyRule>, diagnostics: [] as string[] };
	mergeFile(target, { shellPolicy: { allow: ["git *", 42, ""] } });
	assert.deepEqual(target.global, { allow: ["git *"] });
});

test("mergeFile ignores non-objects", () => {
	const target = { roles: {} as Record<string, ShellPolicyRule>, diagnostics: [] as string[] };
	mergeFile(target, null);
	mergeFile(target, []);
	mergeFile(target, "string");
	assert.equal(target.global, undefined);
	assert.deepEqual(target.roles, {});
});
