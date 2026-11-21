---
name: kubectl
description: Read-only access to the home K3s cluster — the one at https://192.168.1.156:6443 (single node `server`), verify before use — and the ArgoCD GitOps repo that owns it (github.com/hampusadamsson/homeserver). Use for checking pods, logs, events, sync status, or when the user asks to change something in the cluster — changes are made by editing the repo, never with kubectl. Never destructive.
---

# Kubernetes — home server (K3s + ArgoCD)

Private single-node cluster. ArgoCD manages everything from one git repo.
`kubectl` is for looking. Git is for changing.

## Step 0 — make sure it's my cluster

The cluster is the one and only: `https://192.168.1.156:6443`, a single K3s node
called `server`. Check it once at the start of a session, before running the
real work:

```bash
kubectl cluster-info
```

Look at the server URL. It must be `192.168.1.156:6443`.

If you want a second opinion (or the URL looks odd):

```bash
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
kubectl get nodes -o wide
```

Expect one node named `server` with IP `192.168.1.156`. `AGE` and `VERSION`
drift — ignore them.

The point is simply: **is this the home server?** If the URL or the node is
anything else, it's not my cluster — stop, say so, and ask which context to use.
Don't run changes against a cluster you can't identify.

## Rule 1 — kubectl is read-only. No destructive commands. Ever.

The cluster is GitOps with `selfHeal: true` and `prune: true`. Anything changed
by hand gets reverted by ArgoCD, or becomes invisible drift that confuses
everyone later. There is no "quick fix" that `kubectl` is allowed to do.

**Forbidden — do not run, even if it looks harmless:**

```
kubectl apply / create / delete / edit / patch / replace / scale
kubectl rollout restart|undo|pause
kubectl annotate / label / set / expose
kubectl exec ... -- <anything that changes something>
kubectl cp / drain / cordon / uncordon / taint / certificate approve
helm install / upgrade / uninstall / rollback
kubectl apply -f -   (piping a dry-run into apply is the classic mistake)
```

Also not allowed: deleting a stuck pod "so it recreates", deleting a finalizer,
creating a secret, scaling to zero to silence a crashloop.

**Allowed — read and diagnose freely:**

```bash
kubectl get / describe / logs / events / top / explain / api-resources
kubectl get <thing> -o yaml
kubectl auth can-i <verb> <resource>
helm template <x> charts/<x> --namespace <ns>     # local render, no cluster
kubectl create ... --dry-run=client -o yaml       # render only, never applied
kubectl diff -f <file>                            # dry run, writes nothing
kubectl port-forward
```

`k9s` is fine to browse. Its edit/delete/scale/restart keys are just as
forbidden.

If a command *might* write: stop and ask the user first.

## Rule 2 — changes go through the repo

Repo: **`github.com/hampusadamsson/homeserver`** (private, `main` branch).
ArgoCD polls it and syncs. Push to `main` = change happens. Nothing else does.

Read `AGENTS.md` in that repo before touching anything — it is the real spec and
it is kept up to date. This skill is only the short version.

**Repo layout:**

| Path | What it is |
|---|---|
| `clusters/home-server/values.yaml` | **the whole cluster state** — app list, routes, homepage tiles |
| `charts/<app>/` | one Helm chart per self-built app (count and list: AGENTS.md "Counts at a glance") |
| `apps/templates/` | root chart: renders Namespaces + child Applications + routes |
| `bootstrap/root-app.yaml` | applied by hand once, ever. Never re-apply |
| `AGENTS.md` | conventions, invariants, known exceptions |

**The change loop:**

1. Edit `clusters/home-server/values.yaml` (usual case) or `charts/<app>/`.
2. Render locally: `helm template <app> charts/<app> --namespace <app>`.
3. Commit and push to `main`.
4. Verify read-only: `kubectl -n argocd get app <app>`, `kubectl get pods -n <ns>`.

If something breaks after the push: fix forward with another commit, or
`git revert`. Never repair it in the cluster.

**Short version of the conventions:**

- New app → entry in `applications:` with a quoted `syncWave`, a chart in
  `charts/<app>/`, a route, and a homepage tile. Missing any of those = not done.
- New routes default to **internal** (`<app>.haadpi.duckdns.org`, port 9443,
  LAN allowlist). Public needs explicit user approval.
- Anything that stores data gets a PVC. No `emptyDir`, no `hostPath`.
- No secrets in git. SealedSecrets or an `existingSecret` reference.
- Pin image tags. No `:latest`.
- Don't add `CreateNamespace=true` — the root chart owns namespaces.

## Image policy — the registry allowlist

The root chart renders a `ValidatingAdmissionPolicy` named
`image-registry-allowlist` (`apps/templates/image-policy.yaml`). Its allowlist is
`imagePolicy.allowedRegistries` in `clusters/home-server/values.yaml`: ghcr.io,
docker.io, docker.all-hands.dev, quay.io, registry.k8s.io, public.ecr.aws,
mcr.microsoft.com.

It runs in **Warn + Audit** mode today — nothing is blocked yet. An image from an
unlisted registry gets flagged in API warnings and audit annotations, and starts
failing the moment the policy moves to Deny. Adding a registry is a separate
reviewed change, not a drive-by edit.

## Reading the cluster (cheat sheet)

```bash
# what's deployed and is it happy
kubectl -n argocd get applications
kubectl -n argocd get app <app> -o jsonpath='{.status.sync.status} {.status.health.status}'

# why is it broken
kubectl -n <ns> get pods
kubectl -n <ns> describe pod <pod>
kubectl -n <ns> logs <pod> --tail=100
kubectl -n <ns> logs <pod> --previous          # crashed container
kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -20

# resource use
kubectl top nodes
kubectl top pods -A --sort-by=memory

# what actually differs from git
kubectl -n argocd get app <app> -o jsonpath='{.status.resources}'   # or use the UI

# who serves which host
kubectl get ingressroute -A
kubectl get certificate -A
```

Namespaces you'll see: `argocd`, `traefik`, `cert-manager`, `sealed-secrets`,
`monitoring`, `syncthing` (vault + 5 apps), `homepage`, plus one per app.

The Homepage UI (`homepage.haadpi.duckdns.org:9443`) is the service directory —
every exposed service has a tile. If something is reachable but has no tile,
that's an incomplete change, not a cosmetic one.

## Trap — counting config from `kubectl get cm -o yaml`

Asked how many services a ConfigMap described,
`kubectl -n <ns> get cm <name> -o yaml | grep -c 'href: https://'` returned 22.
The true number was 21.

Cause: `-o yaml` also echoes the `kubectl.kubernetes.io/last-applied-configuration`
annotation, which holds a serialized copy of the whole `data` block. Every match
is counted twice, plus one extra for the annotation itself.

Read the one data key you care about instead:

```bash
kubectl -n <ns> get cm <name> -o jsonpath='{.data.services\.yaml}' | grep -c 'href: https://'
```

Generalised: for any "how many X are in this config" question, read the single
data key with jsonpath — never `-o yaml`.

## Found drift? Live cluster ≠ git

Don't fix the cluster. Pick one:

- **git is right** → wait for `selfHeal`, or the user can click Sync in ArgoCD.
- **the live state is what you want** → make the same change in the repo,
  commit, push.

If ArgoCD is stuck, report it and fix it forward in the chart. Deleting the
stuck object or removing finalizers is not an option.

## Secrets

Agent never creates secrets. No `kubectl create secret`, no sealing on the
user's behalf unless they explicitly ask. If a secret is missing: say which one,
which namespace, and what key it needs — let the user create or seal it.

## Reading the repo

It's a private repo on **github.com**, user `hampusadamsson`. `gh` is already
authenticated for that host — no `GH_HOST` needed (never set it to an enterprise
host). Use:

```bash
gh api repos/hampusadamsson/homeserver/contents/AGENTS.md --jq '.content' | base64 -d
gh api repos/hampusadamsson/homeserver/contents --jq '.[].name'
```

Prefer reading from GitHub over cloning. If you must clone, use
`/tmp/hs-explore/homeserver`, never a tracked project dir.

## When in doubt

Say what's wrong and what you would change, then let the user approve. A
correct diagnosis plus a proposed commit is a finished task. A sneaky
`kubectl edit` is not.
