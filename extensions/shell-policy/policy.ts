/**
 * Pure shell-policy evaluation. No pi imports, so it is unit-testable in isolation.
 *
 * Matching model, per command segment:
 *   1. matches a `deny` glob  → blocked
 *   2. matches an `allow` glob → allowed
 *   3. otherwise               → `default` ("allow" or "deny")
 *
 * `default` is inferred when absent, so existing configs keep their behavior:
 *   - an `allow` list is present  → default "deny"  (allowlist, fail closed)
 *   - only `deny` is present      → default "allow" (denylist, fail open)
 */

export type PolicyDefault = "allow" | "deny";

export interface ShellPolicyRule {
	allow?: string[];
	deny?: string[];
	/** Fallback verdict for a segment matching no glob. Inferred when absent. */
	default?: PolicyDefault;
}

export interface EffectivePolicy {
	/** Allow globs. Empty means none are configured. */
	allow: string[];
	deny: string[];
	/** Fallback verdict for a segment that matches no glob. */
	default: PolicyDefault;
	/** True when any rule came from config; false means "no policy, allow all". */
	configured: boolean;
}

export interface Verdict {
	allowed: boolean;
	reason?: string;
	/** The segment that decided the verdict, when blocked. */
	segment?: string;
}

// ------------------------------------------------------------------ globbing

export function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`);
}

export function matchesAny(value: string, patterns: string[]): boolean {
	return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

// -------------------------------------------------------------- segmentation

/** Shell metacharacters that separate one command from the next. */
const SEPARATORS = /\s*(?:&&|\|\||;|\n|\|)\s*/;

/** Expansions whose result cannot be known before execution. */
const OPAQUE = [/\$\(/, /`/, /<\(/];

export function normalizeSegment(segment: string): string {
	return segment.trim().replace(/\s+/g, " ");
}

export function splitSegments(command: string): string[] {
	return command
		.split(SEPARATORS)
		.map(normalizeSegment)
		.filter((segment) => segment.length > 0);
}

// ------------------------------------------------------------------ evaluate

/**
 * The default a single config level implies.
 *
 * An explicit `default` always wins. Otherwise an `allow` list (even an empty one)
 * means fail-closed, because the author has expressed an intent to enumerate what
 * may run; a rule with only `deny` globs means fail-open.
 */
export function levelDefault(rule: ShellPolicyRule | undefined): PolicyDefault | undefined {
	if (!rule) return undefined;
	if (rule.default !== undefined) return rule.default;
	return rule.allow !== undefined ? "deny" : "allow";
}

/**
 * Merge global and per-role rules into the policy that actually applies.
 *
 * `undefined` and `[]` are distinct: absent means "no allow list", an empty array
 * means "an allow list that names nothing".
 *
 * Two asymmetries are deliberate:
 *   - The global `allow` is a ceiling. A role's globs are intersected with it, so a
 *     role can narrow but never grant something the global list does not permit.
 *   - The stricter `default` wins, so a role cannot relax a global fail-closed
 *     policy by declaring `default: "allow"`.
 */
export function mergePolicy(
	global: ShellPolicyRule | undefined,
	role: ShellPolicyRule | undefined,
): EffectivePolicy {
	const globalAllow = global?.allow;
	const roleAllow = role?.allow;

	let allow: string[];
	if (globalAllow === undefined) {
		// No global ceiling: the role's list stands alone.
		allow = roleAllow === undefined ? [] : [...roleAllow];
	} else if (roleAllow === undefined) {
		allow = [...globalAllow];
	} else {
		// Role narrows within the global ceiling: each role glob must itself be
		// covered by a global glob, otherwise it grants outside the ceiling.
		allow = roleAllow.filter((pattern) => matchesAny(pattern, globalAllow));
	}

	const globalDefault = levelDefault(global);
	const roleDefault = levelDefault(role);
	const fallback: PolicyDefault =
		globalDefault === "deny" || roleDefault === "deny" ? "deny" : "allow";

	return {
		allow,
		deny: [...(global?.deny ?? []), ...(role?.deny ?? [])],
		default: fallback,
		configured: global !== undefined || role !== undefined,
	};
}

export function evaluate(
	command: string,
	policy: EffectivePolicy,
	roleName?: string,
): Verdict {
	if (!policy.configured) return { allowed: true };

	const role = roleName ?? "(none)";
	const segments = splitSegments(command);
	if (segments.length === 0) return { allowed: true };

	for (const segment of segments) {
		// Only meaningful when unmatched segments are blocked: if everything runs by
		// default, an opaque expansion is no worse than the rest of the shell.
		if (policy.default === "deny") {
			const opaque = OPAQUE.find((pattern) => pattern.test(segment));
			if (opaque) {
				return {
					allowed: false,
					segment,
					reason:
						`blocked by shell-policy: segment "${segment}" contains an unexpanded ` +
						`substitution ($(...), backticks or <(...)); it cannot be matched against ` +
						`the allow rules for role ${role}`,
				};
			}
		}

		const denied = policy.deny.find((pattern) => globToRegExp(pattern).test(segment));
		if (denied) {
			return {
				allowed: false,
				segment,
				reason:
					`blocked by shell-policy: segment "${segment}" matches deny rule "${denied}" ` +
					`(role: ${role})`,
			};
		}

		if (matchesAny(segment, policy.allow)) continue;

		if (policy.default === "allow") continue;

		// default is "deny" and nothing allowed this segment.
		if (policy.allow.length === 0) {
			return {
				allowed: false,
				segment,
				reason:
					`blocked by shell-policy: no command is permitted for role ${role} ` +
					`(default is deny and no allow rules are configured)`,
			};
		}
		return {
			allowed: false,
			segment,
			reason:
				`blocked by shell-policy: segment "${segment}" matches no allow rule and the ` +
				`policy default is deny (role: ${role}). Allowed: ${policy.allow.join(", ")}`,
		};
	}

	return { allowed: true };
}

// ---------------------------------------------------------------- file merge

export interface ShellPolicyFile {
	shellPolicy?: ShellPolicyRule;
	roles?: Record<string, { shellPolicy?: ShellPolicyRule }>;
}

/** Coerce a raw JSON value into a rule, dropping anything that is not a string array. */
export function normalizeRule(raw: unknown): ShellPolicyRule | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rule = raw as Record<string, unknown>;
	const list = (value: unknown): string[] | undefined => {
		if (!Array.isArray(value)) return undefined;
		return value.filter(
			(item): item is string => typeof item === "string" && item.trim().length > 0,
		);
	};
	const allow = list(rule.allow);
	const deny = list(rule.deny);
	const fallback =
		rule.default === "allow" || rule.default === "deny" ? rule.default : undefined;

	if (allow === undefined && deny === undefined && fallback === undefined) return undefined;
	return {
		...(allow !== undefined ? { allow } : {}),
		...(deny !== undefined ? { deny } : {}),
		...(fallback !== undefined ? { default: fallback } : {}),
	};
}

export interface LoadedPolicy {
	global?: ShellPolicyRule;
	roles: Record<string, ShellPolicyRule>;
	diagnostics: string[];
}

/** Merge one parsed roles file into the accumulated policy. Later sources win per rule. */
export function mergeFile(target: LoadedPolicy, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const file = raw as ShellPolicyFile;

	const globalRule = normalizeRule(file.shellPolicy);
	if (globalRule) target.global = { ...target.global, ...globalRule };

	for (const [name, role] of Object.entries(file.roles ?? {})) {
		if (!role || typeof role !== "object") continue;
		const rule = normalizeRule((role as { shellPolicy?: unknown }).shellPolicy);
		if (rule) target.roles[name] = { ...target.roles[name], ...rule };
	}
}
