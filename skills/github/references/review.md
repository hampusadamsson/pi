# PR review (Hampus style)

Read-only until the user confirms. Host is `github.com`, user `hampusadamsson` — never set `GH_HOST`.

## Workflow

1. Get the PR: `gh pr view <n> --repo hampusadamsson/<repo> --json title,body,baseRefName,headRefName,headRefOid` and `gh pr diff <n> --repo hampusadamsson/<repo>`. Local branch review: `git diff <default-branch>...HEAD` (check `defaultBranchRef`).
2. If a ticket key is in the title/branch, ask the user for the acceptance criteria (there is no ticket tool) and check the diff against them.
3. Read the diff, plus nearby code when needed (sibling modules, callers, tests).
4. Draft inline comments. Show them as a numbered list: `n. path:line — comment`. Plain text. No edits, no posting yet.
5. Wait. User answers per item: yes / skip / reword ("add 1 and 2", "skip 10, 11"). Post only the approved ones.
6. Post, one comment per item, on the exact line (use the PR head SHA):
   `gh api repos/hampusadamsson/<repo>/pulls/<n>/comments -f body='...' -f commit_id=<headRefOid> -f path=<path> -F line=<line> -f side=RIGHT`
   Or batch as one pending review (omit `event`): `gh api repos/hampusadamsson/<repo>/pulls/<n>/reviews --input review.json` (commit_id, comments[]).
7. Never submit, approve or request changes unless the user says so. Default: leave comments/pending, the user submits in the browser. If asked to submit a summary: `gh pr review <n> --comment -b '...'`.
8. Removing comments you posted: only when the user asks.

Each posting needs fresh confirmation for that review. No confirmation, no write.

## Style

- Brief, simple words, no markdown headers/bullets/bold. Backticks for code names only.
- Phrase as questions: "Could we...", "Is there a reason...", "Does this...", "Should we...".
- Reference the code directly on the line. One item per comment.
- Soften when unsure: "Fine to leave it if...", "Maybe there is a reason I'm missing", "Could be a follow-up".
- Give a concrete suggestion and a doc link when it helps (e.g. force-with-lease, tempfile docs).
- Summary body: only "LGTM" or one short line. Praise is brief ("Nice cleanup.").
- Small PRs (infra bumps, alerts, retries): just LGTM. Big PRs: 10-15 inline questions.

## Checklist

- Duplication: constants or logic copied across files/packages; ask for one shared module/helper.
- Resources: requests/limits vs real usage, scheduling, rollout settings, timeouts vs worst case.
- Retries: only transient errors? backoff length? idempotent?
- Logging/observability: structured logs, request ids, no secrets/PII in logs, log noise.
- CI/workflows: pin actions by hash, `--force-with-lease`, `cancel-in-progress`/`timeout-minutes`, `continue-on-error`, triggers for changed paths.
- Docker: use defaults over chown/chmod, `.dockerignore` (e.g. `.pem`), redundant steps.
- Data/DB: upsert cost per row, overwrite vs history, null `updated_at`, ingest/downstream tables, migration.
- API shape: bare list vs object, validation edge cases (0.0), batch limits vs tests.
- Infra/IAM: permission scope, removed resources still referenced, plan output.
- Tests live in `tests/`, not `src/`. Deps in groups (dev/prod). Tmp files via context managers.
- Acceptance criteria met? Docs/README updated?

## Examples (anonymised)

- "This constant is also in `ingestion.py`. Both must stay equal. Could we move it, with the other settings, into one shared module?"
- "Is there a reason not to cancel the run in progress? With `false`, one hung run holds the group and every later run waits behind it. Could we set it to `true`, or add `timeout-minutes`?"
- "Should we only retry on transient errors, like OperationalError? Right now I think a data error would also wait about 7 seconds of backoff before failing. Maybe there is a reason I'm missing."
- "This is a bit excessive I think. It averages about 60 MB in prod. Can we have memory request 128 and limit 256? It would improve scheduling."
- "Does this log enough to debug a failure in prod, without logging request bodies or PII?"
