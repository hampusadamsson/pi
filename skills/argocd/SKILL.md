---
name: argocd
description: Read-only ArgoCD CLI access for the home K3s cluster (https://192.168.1.156:6443, node `server`) via the `argocd` wrapper at ~/.local/bin/argocd. Use when the user asks about ArgoCD sync status, wants to know what differs from git, why an app is degraded, or wants to refresh sync state. Wrapper is read-only by default and refuses sync/rollback/delete. No password is ever stored or passed. Changes go through github.com/hampusadamsson/homeserver, never the CLI.
---

# ArgoCD CLI — home server (read-only)

`argocd` is a **wrapper**, not the stock binary. The real binary is
`argocd-bin` in the same directory. The wrapper exists to enforce one thing:
**this cluster is GitOps, so the CLI may look but not touch.**

Install: `~/.local/bin/argocd` (wrapper) + `~/.local/bin/argocd-bin`
(v2.11.7, checksum-verified against `cli_checksums.txt`).

## Credentials — how this works, and why

The server is **v2.11.7**, so the CLI must be 2.11.x. Homebrew only ships 3.6,
which breaks against a 2.11 server — hence the pinned binary.

**No password is stored anywhere.** Two credential paths, both password-free:

| Mode | Used for | Credential |
| `--core` (default) | `app list/get/history`, `cluster/repo/proj list` | the **existing kubeconfig client cert** — zero ArgoCD credentials |
| API (auto) | `app diff/resources/manifests`, `account`, `login` | session token in `~/.config/argocd/config`, mode 0600 |

The wrapper picks the mode automatically. You never pass `--core`, `--insecure`,
or `--grpc-web` yourself — it adds them.

Endpoints are **LAN-only** behind the `internal-lan-only` middleware
(`argocd.haadpi.duckdns.org:9443`, self-signed cert, expires Jan 2027).
Off-LAN, use `--port-forward -n argocd svc/argocd-server`.

### Never do this

```bash
argocd login ... --password '<pw>'   # password lands in argv + shell history
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

If the session token expires (24h), the user logs in **themselves** and types
the password at the prompt:

```bash
argocd login argocd.haadpi.duckdns.org:9443 --username admin
```

The wrapper injects `--insecure --grpc-web` for that call.

## Rule — read-only. Changes go through git.

The wrapper refuses these with exit code 3 and a pointer to git:

`app sync|rollback|delete|create|set|unset|patch|edit|terminate-op|actions run`,
`cluster add|rm|set`, `repo add|rm|set`, `proj add|rm|set`, `account
update-password|generate-token|delete-token`, `cert/gpg *`, `admin *`.

Two `app` subcommands write **ArgoCD status** even without changing the cluster:
`app sync --dry-run` and `app get --refresh` write an `operationState` and bump
`reconciledAt` on the Application object. They do **not** change the cluster,
so they are allowed — but they are not free. Prefer plain `app get` (cached
status) and use `--refresh` only when the user is asking about stale data.

`ARGOCD_ALLOW_WRITE=1 argocd ...` overrides. Only with explicit user approval.

## How to investigate

Start with the cheapest read, and only escalate if the answer is unclear.

```bash
# 1. what exists, is it happy  (core mode, cached — instant)
argocd app list

# 2. one app in detail (no --refresh: use the cached status first)
argocd app get argocd/<app>

# 3. only if status looks stale or wrong: ask ArgoCD to re-read live state
argocd app get argocd/<app> --refresh

# 4. git vs live: the real question. This is API mode, ~2-5s per app.
argocd app diff argocd/<app>

# 5. which resources does the app own
argocd app resources argocd/<app>
```

For "is ArgoCD right?", trust `app diff` over `status` — see the trap below.

**Reading status in bulk** — do not loop `app get` per app if you can avoid it;
`--core` reads are cheap but N calls still cost N round trips:

```bash
argocd app list -o json | python3 -c '
import json,sys
for a in json.load(sys.stdin):
    s=a.get("status",{})
    print(a["metadata"]["name"], s.get("sync",{}).get("status"), s.get("health",{}).get("status"))'
```

## Trap — "Synced" does not mean the cluster matches git

`uipi` was reported `Synced Healthy` while the live Deployment was missing an
initContainer that git rendered. Cause: **the ArgoCD repo-server manifest cache
was populated from an earlier commit and never keyed per-commit for that path**,
so the controller compared git-HEAD's manifests against live and called it
Synced, while the actual rendered Deployment differed.

Sequence that surfaced it (2026-11-11):

1. commit `e75dc92` bumped the image, synced fine (app history id 2)
2. commit `2246183` added `initContainers` to `charts/uipi`
3. the controller recorded `syncStatus=Synced`, `revision=2246183`, but
   `status.history` never gained an entry for `2246183` — no sync ever ran for it
4. `app diff` correctly showed the missing initContainer

**So**: when the user says "is everything okay?", `app list` saying Synced is not
proof. `argocd app diff <app>` is. If diff is non-empty while status says
Synced, that's a genuine ArgoCD/selfHeal defect worth reporting — not something
to fix with the CLI.

## Reporting drift

Diff shows `>` lines that git has and live lacks, or `<` for the reverse:

```bash
argocd app diff argocd/<app> | grep -E "^[<>]" | head -40
```

Report it as: app, resource, what differs, which side is right. Then stop —
the fix is a commit to `github.com/hampusadamsson/homeserver` (read `AGENTS.md`
there first). Never `sync --force`, never `--prune`, never "just this once".

## Cluster sanity check

The cluster is `https://192.168.1.156:6443`, single node `server`. If the
wrapper errors with `configmap "argocd-cm" not found`, the kubeconfig context
lost its `namespace: argocd`. Rebuild:

```bash
kubectl config set-context argocd --cluster=default --user=default --namespace=argocd
# then regenerate ~/.config/argocd/kubeconfig-argocd with current-context: argocd
```

## Restrictions (recommended, not yet applied)

These are suggestions for the user — this skill does not apply them.

1. **ArgoCD RBAC** — `argocd-rbac-cm` is currently empty, so `admin` is
   unrestricted and *any* CLI token can sync/delete. A read-only role would make
   the wrapper's refusal a convenience rather than the only defence:
   ```yaml
   # clusters/home-server/values.yaml, under applications[argocd].values.configs
   rbac:
     policy.default: role:readonly
     policy.csv: |
       p, role:readonly, applications, get, */*, allow
       p, role:readonly, applications, list, */*, allow
       p, role:readonly, logs, get, */*, allow
       g, agent, role:readonly
   ```
   Then mint an `agent` account token instead of using `admin`. This is the
   real fix; the wrapper is defence-in-depth.

2. **Per-account token, not admin** — `argocd account generate-token` is
   currently blocked by the wrapper *and* returns 500 (needs an
   `accounts.<name>` entry in `argocd-cm`). Worth adding a dedicated account.

3. **Rotate the initial admin password** — `argocd-initial-admin-secret` is
   still present and its 16-char password is unchanged since bootstrap
   (2026-08-22). ArgoCD keeps it valid until someone changes the password.
   Rotating it retires the one credential that this whole setup avoids.

4. **`exec.enabled: false`** is already set — good, leave it.

5. **Do not expose the CLI port publicly.** The route is LAN-only; keep it that
   way. A public ArgoCD API with a `Synced`-blinded UI is worse than no notes.
