---
name: github
description: GitHub research using the `gh` CLI and git — repo browsing, code search, PRs, issues, actions, releases, history (read-only), plus branch/commit/PR conventions and a confirmed create-PR flow (references/pr.md). Use for finding or reading code/history on GitHub, or when naming a branch, writing a commit/PR title, or opening a PR.
---

# GitHub research via `gh` CLI

> **Host is `github.com`, user `hampusadamsson`.** `gh` is already authenticated for it — do **not** set `GH_HOST`, it would point `gh` at the wrong host and fail auth. Only set it if a command explicitly targets another host.

Exploration of repos, PRs, issues, CI, history is read-only — no full clone unless needed. The only write flow is create-PR in `references/pr.md`, which needs explicit user confirmation.

## Commands

```bash
gh repo list hampusadamsson --limit 200
gh repo view hampusadamsson/<repo> --json defaultBranchRef,description,pushedAt,topics

# browse files without cloning
gh api repos/hampusadamsson/<repo>/contents/<path> --jq '.[].name'
gh api repos/hampusadamsson/<repo>/contents/<path> --jq '.content' | base64 -d

# code search
gh search code "pattern" --repo hampusadamsson/<repo>
gh api -X GET search/code -f q='filename:Dockerfile user:hampusadamsson'

# clone read-only, scratch dir only, never a tracked project dir
git clone --depth 1 https://github.com/hampusadamsson/<repo>.git /tmp/gh-explore/<repo>
git -C /tmp/gh-explore/<repo> log --oneline -20 -- <path>
git -C /tmp/gh-explore/<repo> blame <path>
git -C /tmp/gh-explore/<repo> diff <ref1>..<ref2>

# PRs/issues/actions/releases, view only
gh pr list --repo hampusadamsson/<repo> --state all --limit 30
gh pr view <n> --repo hampusadamsson/<repo>
gh issue list --repo hampusadamsson/<repo>
gh run list --repo hampusadamsson/<repo> --limit 20
gh workflow list --repo hampusadamsson/<repo>
gh release list --repo hampusadamsson/<repo>
```

## Hard rules

- Never mutate, except the create-PR flow in `references/pr.md` and posting PR review comments per `references/review.md`, each only after explicit user confirmation. Otherwise no `gh pr/issue/repo create|edit|delete`, no `-X POST/PUT/PATCH/DELETE`, no `git push/commit/merge/rebase`, no `gh workflow run`, no comments/approvals/merges/label/branch-protection changes.
- Never commit or push to `main`/`master`/`develop`. Never force-push (`--force-with-lease` on own feature branches only).
- If a command could plausibly write, stop and ask first.
- Never print credentials (PATs, tokens, `.netrc`, SSH keys).
- Clones go only in `/tmp/gh-explore/<repo>`.
- Anything beyond create-PR that implies a change: say it's out of scope and hand off.

## Account

Host `github.com`, single user `hampusadamsson` — personal account, no orgs setup. Everything lives under `hampusadamsson/<repo>`. Confirm with `gh repo list hampusadamsson`.

## Repo inventory (non-exhaustive, confirm via `gh repo list hampusadamsson`).

| Repo | What |
| `automaton` | Config-first YAML automation daemon in Go: cron/interval/webhook/file triggers, bash + parallel + cross-automation steps, Unix-socket CLI, read-only web UI (`main`) |
| `kb` | Simple kanban automation system meant for agents |
| `uipi` | Web UI harness over the pi coding agent SDK — multi-session, pi-parity config/extensions |
| `homeserver` | GitOps repo for the home K3s cluster (ArgoCD app-of-apps, private) |
| `mysharedbrain` | AI-native markdown wiki vault with librarian agent, MCP server, feedback queue, audit log |
| `pi` | Pi agent harness configuration |
| `chezmoi` | Personal dotfiles (private) |
| `modai` | Simple LLM for Obsidian.md |
| `myportfolio` | Personal stock portfolio tracker — Go + Svelte, Nasdaq Nordic data (private) |
| `golfkompis` | Unofficial MinGolf API |
| `nasdaq-stock-retriever` | Retrieves stocks from Nasdaq Nordic |
| `mdblogger` | Lightweight markdown-to-blog framework written in Go |
| `ticketor` | Small standalone Kanban application |

Not ground truth. Confirm with `gh repo view`.

## Workflow

1. Confirm repo if ambiguous.
2. Prefer `gh api`/`gh repo view`/`gh search code`; clone only for heavy local grep.
3. Cite repo/path/lines + link (`gh repo view --web` or `https://github.com/hampusadamsson/<repo>/blob/<ref>/<path>`).
4. Opening a PR, naming a branch, or writing a commit/PR title → follow `references/pr.md` (conventions + confirmed create-PR flow). Any other change → out of scope, hand off.

## References

- `references/pr.md` — branch/commit/PR conventions (all repos), create-PR steps, read-only PR research commands.
- `references/review.md` — reviewing PRs: workflow, style, checklist; inline comments posted only after user confirmation.
