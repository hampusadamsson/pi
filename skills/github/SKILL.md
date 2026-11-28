---
name: github
description: GitHub Enterprise research using the `gh` CLI and git — repo browsing, code search, PRs, issues, actions, releases, history (read-only), plus branch/commit/PR conventions and a confirmed create-PR flow (references/pr.md). Use for finding or reading code/history on GitHub, or when naming a branch, writing a commit/PR title, or opening a PR.
---

# GitHub research via `gh` CLI

> **ALWAYS `export GH_HOST=lendo-group.ghe.com` before any `gh` command.** The host is `lendo-group.ghe.com`.

Exploration of repos, PRs, issues, CI, history is read-only — no full clone unless needed. The only write flow is create-PR in `references/pr.md`, which needs explicit user confirmation.

## Commands

```bash
gh repo list <org> --limit 200
gh repo view <org>/<repo> --json defaultBranchRef,description,pushedAt,topics

# browse files without cloning
gh api repos/<org>/<repo>/contents/<path> --jq '.[].name'
gh api repos/<org>/<repo>/contents/<path> --jq '.content' | base64 -d

# code search
gh search code "pattern" --repo <org>/<repo>
gh api -X GET search/code -f q='filename:Dockerfile org:<org>'

# clone read-only, scratch dir only, never a tracked project dir
git clone --depth 1 https://lendo-group.ghe.com/<org>/<repo>.git /tmp/gh-explore/<repo>
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

- Never mutate, except the create-PR flow in `references/pr.md` and posting PR review comments per `references/review.md`, each only after explicit user confirmation. Otherwise no `gh pr/issue/repo create|edit|delete`, no `-X POST/PUT/PATCH/DELETE`, no `git push/commit/merge/rebase`, no `gh workflow run`, no comments/approvals/merges/label/team/branch-protection changes.
- Never commit or push to `main`/`master`/`develop`. Never force-push (`--force-with-lease` on own feature branches only).
- If a command could plausibly write, stop and ask first.
- Never print credentials (PATs, tokens, `.netrc`, SSH keys).
- Clones go only in `/tmp/gh-explore/<repo>`.
- Anything beyond create-PR that implies a change: say it's out of scope and hand off.

## Org structure (Lendo)

Host: `lendo-group.ghe.com` (SAML SSO).

- `lendo-data-ml` — DML repos (models, services, IaC, CI).
- `lendo-shared` — cross-team shared IaC/tooling.
- `lendo-se` / `lendo-sre` — SE market / SRE infra repos.
- `lendo-pfm` — Kreddy-PFM repos. Accessible: use `gh repo list lendo-pfm`.
- `hampus-adamsson` — personal, not org-owned.

## Repo inventory (non-exhaustive, confirm via `gh repo list <org>`).

| Repo | Org | What |
|---|---|---|
| `ml-core` | `lendo-data-ml` | DML monorepo (`main`): model packages under `packages/dml-*` (irm, ctm, pcm, soc, mlac, insurance, refinance, serving, mlflow, dal, evaluation, ...), `scripts/`, shared CI, release-please |
| `predictions-api` | `lendo-data-ml` | Core prediction API for ML models (`master`) |
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
| `fit-offer-collection` | `lendo-data-ml` | Offer collection/fitting service |
| `backoffice` | `lendo-data-ml` | Lightweight app hosting analyst scripts |
| `data-core` | `lendo-data-ml` | Monorepo for the D in D&ML team |
| `humio-mcp` | `lendo-data-ml` | Humio MCP for agents |
| `argocd-config` | `lendo-se` | SE market GitOps |
| `application-infrastructure` | `lendo-se` | SE Terraform infra |
| `gcp-infrastructure` | `lendo-sre` | Central GCP IaC |
| `argocd-config-lendo-norway` | `lendo-sre` | NO market GitOps |
| `kreddy-api` | `lendo-pfm` | Kreddy API |
| `kreddy-dev` | `lendo-pfm` | Kreddy docker-compose dev environment |
| `lendo-pfm` | `lendo-pfm` | PFM docker-compose dev environment |
| `argocd-config` | `lendo-pfm` | Kreddy-PFM GitOps (`main`) |
| `application-infrastructure` | `lendo-pfm` | Kreddy-PFM infra (`main`) |
| `chezmoi` | `hampus-adamsson` | Personal dotfiles |

Not ground truth. Confirm with `gh repo view`.

## Workflow

1. Confirm org/repo if ambiguous (short names repeat across orgs).
2. Prefer `gh api`/`gh repo view`/`gh search code`; clone only for heavy local grep.
3. Cite repo/path/lines + link (`gh repo view --web` or `https://lendo-group.ghe.com/<org>/<repo>/blob/<ref>/<path>`).
4. Opening a PR, naming a branch, or writing a commit/PR title → follow `references/pr.md` (conventions + confirmed create-PR flow). Any other change → out of scope, hand off.

## References

- `references/pr.md` — branch/commit/PR conventions (all repos), create-PR steps, read-only PR research commands.
- `references/review.md` — reviewing PRs: workflow, style, checklist; inline comments posted only after user confirmation.
