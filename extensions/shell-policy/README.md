# Shell policy

Command-level allow/deny for `hypa_shell` and the `bash` builtin, layered on top of
the role tool allowlists in `roles.json`.

A role's `tools.allow` decides **whether** the model may run shell commands. This
extension decides **which** commands.

## Config

Rules live in the same files the `roles` extension reads, under a `shellPolicy` key:

```jsonc
// ~/.pi/agent/roles.json
{
  "active": "work",

  // Applies to every role. Also acts as a ceiling (see below).
  "shellPolicy": {
    "allow": ["git *", "npm *", "kubectl get *"],
    "deny": ["git push *"],
    "default": "deny"
  },

  "roles": {
    "work": {
      "shellPolicy": {
        "allow": ["git *", "npm *"],   // narrows within the global allow list
        "deny": ["npm publish *"]      // adds to the global deny list
      }
    }
  }
}
```

Merge order is the same as roles: `~/.pi/agent/roles.json` →
`~/.pi/agent/roles/<name>.json` → `<project>/.pi/roles.json` →
`<project>/.pi/roles/<name>.json`, later wins per rule, trusted projects only.

## Semantics

Each command segment is judged in this order:

1. Matches a `deny` glob → **blocked**. Always.
2. Matches an `allow` glob → **allowed**.
3. Otherwise → the **`default`** verdict.

`default` is `"allow"` or `"deny"`. When omitted it is inferred from the shape of
the rule, so existing configs keep their behavior:

| Rule | Inferred `default` |
| `allow` present (even `[]`) | `deny` — allowlist, fail closed |
| only `deny` globs | `allow` — denylist, fail open |
| `shellPolicy` absent everywhere | no policy; everything runs |

Both lists are additive across global and role. Three asymmetries are deliberate:

- **Global `allow` is a ceiling.** A role's allow globs are intersected with it, so a
  role can only *narrow*. If the intersection is empty, nothing is allowed.
- **Global `deny` is a floor.** A role cannot remove a global deny.
- **The stricter `default` wins.** A role declaring `default: "allow"` cannot relax a
  global `default: "deny"`; a role declaring `default: "deny"` can tighten one.

Clearing the role (`/role none`) does **not** clear the policy — global rules still
apply. "No role" means no role, not no guardrails.

### Example: read-only kubectl plus a few safe commands

```jsonc
"shellPolicy": {
  "allow": ["kubectl get *", "kubectl describe *", "kubectl logs *", "git *"],
  "default": "deny"
}
```

`kubectl get pods` runs, `kubectl delete ns prod` is blocked, and so is anything
else not named. Omit `"default"` and it behaves the same — an `allow` list already
implies `deny`.

### Example: deny destructive verbs, allow everything else

```jsonc
"shellPolicy": {
  "deny": ["kubectl delete *", "kubectl apply *", "kubectl exec *"],
  "default": "allow"
}
```

Fail-open: only the named verbs are blocked. This is the inferred behavior already;
`"default": "allow"` just makes the intent explicit.

## Matching

Commands are split on `;`, `&&`, `||`, `|` and newlines. Each segment is
whitespace-collapsed and matched against an anchored glob (`*` only, regex-escaped
otherwise). Every segment must pass.

```
git status && rm -rf /          → two segments; the second is judged on its own
kubectl get *                   → matches "kubectl get pods -o wide"
kubectl get *                   → does NOT match "kubectl delete pod"
```

The split is **naive** — it is not quote-aware. A `;` inside a quoted string
produces a segment that probably matches nothing and therefore blocks. That is the
safe direction: it over-blocks rather than under-blocks.

When unmatched segments are blocked (`default: "deny"`), any segment containing
`$(`, a backtick, or `<(` is blocked outright, since its expansion cannot be
evaluated before execution. With `default: "allow"` such segments are unremarkable
and are not special-cased.

## What this is not

This is a guardrail against drift and accidents, not a sandbox. It does not defend
against a determined model:

- `eval`, `sh -c`, `xargs`, `find -exec` are only constrained to the extent the
  glob rule happens to constrain them.
- Aliases, shell functions, sourced files, and the contents of any allowed script
  are invisible to it.
- The split is naive, so quoting cannot be reasoned about.
- `hypa_shell` runs through `hypa`, whose rewrite rules are assumed to be
  equivalent-or-safer. The policy sees the command **as the model wrote it**, not
  the rewritten form.

For real isolation use `pi-sandbox` (`sandbox.json`).

Two further limits worth knowing: the `codemode` tool is not a bypass (nested calls
fire `tool_call` with `parentToolCallId`), but `user_bash` (`!!` prefix) is
deliberately **not** gated — that is you typing, not the model.

## Commands

- `/shell-policy` — show the effective merged policy for the active role, and
  whether it is failing closed due to a config error.

## Failure modes

- Malformed `roles.json` → **everything blocked**, with a one-time warning naming
  the parse error. Fail closed when a config file exists at all.
- No config file → nothing blocked (the default).

## Dev

```bash
node --experimental-strip-types --test extensions/shell-policy/index.test.ts
node extensions/shell-policy/_smoke.mjs
```

`policy.ts` holds the pure evaluation logic and imports nothing from pi, so it is
testable in isolation. `index.ts` is the thin extension wrapper.
