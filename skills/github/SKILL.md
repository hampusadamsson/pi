---
name: github
description: Read-only GitHub/GitHub Enterprise research using the `gh` CLI (GitHub's command-line tool) and git — repo browsing, code search, PRs, issues, actions, releases, history. Use whenever a task needs finding or reading code/history on GitHub without modifying anything.
---

# GitHub research via `gh` CLI

Read-only exploration of repos, PRs, issues, CI, history — no full clone unless needed.

## Commands

```bash
gh repo list <org> --limit 200 --no-archived
gh repo view <org>/<repo> --json defaultBranchRef,description,pushedAt,topics

# browse files without cloning
gh api repos/<org>/<repo>/contents/<path> --jq '.[].name'
gh api repos/<org>/<repo>/contents/<path> --jq '.content' | base64 -d

# code search
gh search code "pattern" --repo <org>/<repo>
gh api -X GET search/code -f q='filename:Dockerfile org:<org>'

# clone read-only, scratch dir only, never a tracked project dir
git clone --depth 1 https://<host>/<org>/<repo>.git /tmp/gh-explore/<repo>
git -C /tmp/gh-explore/<repo> log --oneline -20 -- <path>
git -C /tmp/gh-explore/<repo> blame <path>
git -C /tmp/gh-explore/<repo> diff <ref1>..<ref2>

# PRs/issues/actions/releases, view only
gh pr list --repo <org>/<repo> --state all --limit 30
gh pr view <n> --repo <org>/<repo>
gh issue list --repo <org>/<repo>
gh run list --repo <org>/<repo> --limit 20
gh workflow list --repo <org>/<repo>
gh release list --repo <org>/<repo>

# org/team membership
gh api orgs/<org>/teams --jq '.[].slug'
gh api orgs/<org>/teams/<slug>/members --jq '.[].login'
```

## Hard rules

- Never mutate: no `gh pr/issue/repo create|edit|delete`, no `-X POST/PUT/PATCH/DELETE`, no `git push/commit/merge/rebase`, no `gh workflow run`, no comments/approvals/merges/label/team/branch-protection changes.
- If a command could plausibly write, stop and ask first.
- Never print credentials (PATs, tokens, `.netrc`, SSH keys).
- Clones go only in `/tmp/gh-explore/<repo>`.
- If request implies a change, say read-only and hand off.

## Org structure (Lendo)

Host: `lendo-group.ghe.com` (Okta-gated). Legacy: `github.schibsted.io` (archived, mostly gone).

- `lendo-data-ml` — DML repos (models, services, IaC, CI).
- `lendo-shared` — cross-team shared IaC/tooling.
- `lendo-se` / `lendo-sre` / `lendo-pfm` — SE market / SRE infra / Kreddy-PFM repos.
- `hampus-adamsson` — personal, not org-owned.

## Repo inventory (non-exhaustive, confirm via `gh repo list <org>`)

| Repo | Org | What |
| `ml-core` | `lendo-data-ml` | Monorepo, DML model packages (`packages/dml-*`: irm/ctm/pcm/soc/dta/mlac-se/no, enhanced-conversion, martech-monitoring, compliance-dml, dal, mlflow, filter-evaluation) + scripts + shared CI |
| `predictions-api` | `lendo-data-ml` | AMQP + business filters + prediction endpoints, NO/SE |
| `argocd-config` | `lendo-data-ml` | Canonical DML GitOps (Helm + per-env ArgoCD), branch `master` |
| `bi-airflow` | `lendo-data-ml` | Airflow DAGs / BI orchestration |
| `lendo-data-application-infrastructure` | `lendo-data-ml` | Terraform, DML app infra |
| `github-terraform-management` | `lendo-shared` | GitHub org/team access as Terraform |
| `renovate-config` | `lendo-data-ml` | Shared Renovate config |
| `compliance-data-deletion` | `lendo-data-ml` | GDPR/PII deletion Streamlit app, standalone |
| `ads-customer-match` | `lendo-data-ml` | Ads/customer-match model/job |
| `tf-snowflake` | `lendo-data-ml` | Terraform, Snowflake IaC |
| `ds-lab` | `lendo-data-ml` | DS sandbox |
| `bi-dbt` | `lendo-data-ml` | dbt, BI/Snowflake transforms |
| `mlflow` | `lendo-data-ml` | Archived — superseded by `ml-core/packages/dml-mlflow` |
| `ml-021-max-loan-calculator-no` | `lendo-data-ml` | ML021, NO max loan calculator |
| `fit-offer-collection` | `lendo-data-ml` | Offer collection/fitting service |
| `agents` | `lendo-data-ml` | Coding-agent/automation |
| `backoffice` | `lendo-data-ml` | Internal backoffice UI |
| `argocd-config` | `lendo-se` | SE market GitOps |
| `application-infrastructure` | `lendo-se` | SE Terraform infra |
| `gcp-infrastructure` | `lendo-sre` | Central GCP IaC |
| `argocd-config-lendo-norway` | `lendo-sre` | NO market GitOps |
| `chezmoi` | `hampus-adamsson` | Personal dotfiles |

Not ground truth — repos get renamed/archived/moved. Confirm with `gh repo view`.

**Resolved (2026-08, don't re-flag)**: `lendo-data-ml/argocd-config` is canonical (older `lendo-core/*`, `*/lendo-data-argocd-config` names are stale/gone). `lendo-shared/lendo-data-application-infrastructure` doesn't exist — canonical is under `lendo-data-ml`. `lendo-data-ml/mlflow` archived/dead, use `ml-core/packages/dml-mlflow`. `compliance-data-deletion` is standalone, no `ml-core/packages/compliance-dml`. `lendo-se/argocd-config` confirmed real.

## Workflow

1. Confirm org/repo if ambiguous (short names repeat across orgs).
2. Prefer `gh api`/`gh repo view`/`gh search code`; clone only for heavy local grep.
3. Cite repo/path/lines + link (`gh repo view --web` or `https://lendo-group.ghe.com/<org>/<repo>/blob/<ref>/<path>`).
4. Change requested → say read-only, hand off.
