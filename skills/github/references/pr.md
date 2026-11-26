# Branch, commit and PR conventions + create-PR flow

Conventions for repos under `github.com/hampusadamsson`. Host is `github.com` — never set `GH_HOST`.

## Protected branches

`main`, `master`, `develop` are long-lived. `main` or `master` (whichever the repo uses) is the core branch. Never force-push them.

Before committing, check how the repo actually takes changes:

```bash
gh repo view hampusadamsson/<repo> --json defaultBranchRef
git log --oneline --merges -5
```

- **Merge/squash commits from PRs, or branch protection on:** branch `<type>/<desc>` + draft PR, the flow below.
- **Every change lands directly on the default branch, no merge commits:** committing to the default branch matches the repo's practice. `homeserver` is this case. Say so in one line when you report it — do not choose silently.
- **Genuinely unclear:** ask. Do not pick for the user.
- **Repo with a non-default live branch:** go to that branch. The `pi` config repo uses `home`, not `main` — check `git branch -vv` and the repo's deploy config first.

## Branch names

`<type>/<short-description>`, all lowercase, hyphens between words.

```
feat/add-multi-highlight
chore/update-dependencies
fix/token-expiry-bug
```

Types: `feat`, `fix`, `chore` (plus `docs`, `ci`, `refactor`, `test` when they fit).

## Commit messages and PR title

Always Conventional Commits, all lowercase, imperative, no trailing period, no emojis.

```
<type>[(scope)]: <description>

feat: add multi highlight
feat(api): add user registration endpoint
fix(auth): correct token expiry bug
chore: update dependencies
feat(db)!: migrate to postgres        # breaking change, explain in a BREAKING CHANGE: footer
```

PRs are **squash-merged**, so the **PR title becomes the commit on `main`**. The PR title MUST follow this format.

## Pull request body

- What the change is and why
- Related PRs / issues
- Checklist: tests added or updated, reviewed, docs updated

If the repo has `.github/pull_request_template.md`, use it instead.

## Create-PR flow (write, needs user confirmation)

This is the only write flow in this skill. Used when the decision above says branch + PR. Show the plan and get an explicit yes before steps 3 to 5.

1. **Check state:** `git status`, `git branch --show-current`, `gh repo view --json defaultBranchRef`. Stop if on a protected branch with uncommitted work that the decision above did not clear for a direct commit.
2. **Branch:** `git switch -c <type>/<desc>` from an up-to-date default branch. Validate the name against the rules above.
3. **Commit:** stage only the intended files. Message follows the format above.
4. **Push:** `git push -u origin <branch>`. If rewriting history on the feature branch, use `--force-with-lease` only. Never use `--force`, and in this flow push `<branch>` only — never a long-lived branch.
5. **Open PR as draft:**
   ```bash
   gh pr create --draft --base <main|master> \
     --title "feat(scope): something" \
     --body-file /tmp/pr-body.md
   ```
6. **Report** the PR URL. The user marks it ready for review.

## Still out of scope without an explicit request

- Merging (`gh pr merge --squash --delete-branch` only when the user asks), approving, commenting on PRs.
- Editing or deleting repos, labels, teams or branch protection.
- Mutating `gh api` calls (POST, PUT, PATCH, DELETE).

## Read-only PR research

```bash
gh pr list --repo hampusadamsson/<repo> --state all --limit 30
gh pr view <n> --repo hampusadamsson/<repo> --comments
gh pr diff <n> --repo hampusadamsson/<repo>
gh pr checks <n> --repo hampusadamsson/<repo>
gh api repos/hampusadamsson/<repo>/pulls/<n>/comments --jq '.[].body'
gh pr list --repo hampusadamsson/<repo> --search "<sha>" --state merged   # PR that introduced a commit
```
