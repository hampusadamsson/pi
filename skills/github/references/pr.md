# Branch, commit and PR conventions + create-PR flow

Verified against `lendo-data-ml/ml-core`; default for other repos on `lendo-group.ghe.com` unless they say otherwise. Always `export GH_HOST=lendo-group.ghe.com` first.

## Protected branches

`main`, `master`, `develop` are long-lived. `main` or `master` (whichever the repo uses) is the core branch. Never commit or push to them directly, and never force-push them. Check with `gh repo view <org>/<repo> --json defaultBranchRef`.

## Branch names

`<type>/<ticket>-<short-description>`, all lowercase, ticket preferred.

```
feat/data-1234-something-done
chore/data-1412-something-cleanup
fix/some-hotfix-with-no-ticket      # only when there is no ticket
```

Types: `feat`, `fix`, `chore` (plus `docs`, `ci`, `refactor`, `test` when they fit). The ticket is the Jira key, lowercased (`DATA-1234` becomes `data-1234`).

## Commit messages and PR title

Always Conventional Commits, all lowercase, imperative, no trailing period, no emojis. Ticket goes right after the colon.

```
<type>[(scope)]: <ticket> <description>

feat: data-1234 add multi highlight
feat(api): data-123 add user registration endpoint
fix(auth): data-233 correct token expiry bug
fix: resolve hotfix with no ticket
chore: data-1412 update dependencies
feat(db)!: data-22 migrate to postgres        # breaking change, explain in a BREAKING CHANGE: footer
```

PRs are **squash-merged**, so the **PR title becomes the commit on `main`**. The PR title MUST follow this format (release-please reads it).

## Pull request body

- Jira ticket URL
- Related PRs
- What the change is and why
- Checklist: tests added or updated, reviewed, feature flag if needed, ticket linked
- DB migration scripts: tell the Data&ML team in #lendo-db-updates-alerts

If the repo has `.github/pull_request_template.md`, use it instead.

## Create-PR flow (write, needs user confirmation)

This is the only write flow in this skill. Show the plan and get an explicit yes before steps 3 to 5.

1. **Check state:** `git status`, `git branch --show-current`, `gh repo view --json defaultBranchRef`. Stop if on a protected branch with uncommitted work.
2. **Branch:** `git switch -c <type>/<ticket>-<desc>` from an up-to-date default branch. Validate the name against the rules above.
3. **Commit:** stage only the intended files. Message follows the format above.
4. **Push:** `git push -u origin <branch>`. If rewriting history on the feature branch, use `--force-with-lease` only. Never use `--force`, and never push to a protected branch.
5. **Open PR as draft:**
   ```bash
   gh pr create --draft --base <main|master> \
     --title "feat(scope): data-1234 something" \
     --body-file /tmp/pr-body.md
   ```
6. **Report** the PR URL. The user marks it ready for review.

## Still out of scope without an explicit request

- Merging (`gh pr merge --squash --delete-branch` only when the user asks), approving, commenting on PRs.
- Editing or deleting repos, labels, teams or branch protection.
- Mutating `gh api` calls (POST, PUT, PATCH, DELETE).

## Read-only PR research

```bash
gh pr list --repo <org>/<repo> --state all --limit 30
gh pr view <n> --repo <org>/<repo> --comments
gh pr diff <n> --repo <org>/<repo>
gh pr checks <n> --repo <org>/<repo>
gh api repos/<org>/<repo>/pulls/<n>/comments --jq '.[].body'
gh pr list --repo <org>/<repo> --search "<sha>" --state merged   # PR that introduced a commit
```
