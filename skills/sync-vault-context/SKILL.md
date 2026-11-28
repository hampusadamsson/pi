---
name: sync-vault-context
description: Reconcile the current conversation context (what was just discussed, learned, decided, fixed) against the Obsidian vault. Finds discrepancies between what the session now knows and what the vault says, proposes per-item actions (edit, create, frontmatter, skip), and applies only what the user picks. Use when asked to sync/reconcile/update the vault with what just happened, or at the end of a task to check the vault reflects it.
---

# Sync Vault Context

Takes the current session's context — facts learned, decisions made, problems fixed, commands run, entities touched — and checks it against the vault's canonical pages. Surfaces discrepancies as a numbered list of proposed actions; the user picks which to run.

Vault root, OKF, approval gate and proposal format: `/skill:obsidian` (single source).

## Safety gates

- Follow the obsidian skill's write approval gate; never batch-apply.
- `3-journal/`: read-only. `0-daily/`: read-only (the `status/raw` removal belongs to `vault-daily-raw`).
- Never invent facts — if context is ambiguous, ask.

## Workflow

### 1. Extract context

Pull what the current session actually established: entities discussed (tools, services, projects, people), facts learned or corrected, decisions made, commands/configs that changed, problems solved and their root cause/fix. Ignore pure back-and-forth with no durable content.

### 2. Find relevant vault state

For each extracted entity/fact, locate its canonical page: `hypa_grep` on titles/tags/body, or `hypa_find`/`hypa_ls` if no obvious hit. One entity = one page — if none exists, note that as a candidate new page, don't assume.

### 3. Diff

Compare session context against each found page's content, frontmatter (`type`, `title`, `description`, `resource`, `owner`, `tags`, `timestamp`), and links:

- **Contradiction** — page says X, session established Y. Newer (session) wins by default, but always list it, never silently overwrite.
- **Missing** — session has a fact/decision the page doesn't mention.
- **Stale `resource:`** — session touched the resource behind a page and found it changed.
- **New entity** — session surfaced something with no page at all.
- **Unclear** — session context doesn't map cleanly to one page, or overlaps two candidate pages.

### 4. Propose actions

One item per discrepancy, in the obsidian proposal format. Action types:

- `edit` — exact proposed text/diff.
- `create` — new page: proposed id, OKF frontmatter, and content.
- `frontmatter` — `resource`/`owner`/`tags`/`timestamp` fixes alone.
- `merge` / `move` — duplicate or misplaced pages.
- `skip` — noted but no action needed (e.g. already consistent).

Example:

```
1. [edit] 1-wiki/work/tools/foo — session found `foo` now supports X; page says it doesn't. Proposed: patch "# Summary" to add X.
2. [create] 1-wiki/work/tools/bar — new tool used this session, no page exists. Proposed: OKF stub with description + resource link.
3. [frontmatter] 1-wiki/work/services/qux — session confirmed a new owner. Proposed: set `owner: dml`.
```

Ask for clarification before proposing anything where placement, naming, or which page owns the fact is ambiguous — don't guess and don't silently skip it either.

### 5. User picks

User replies with numbers/ranges (e.g. `1 3`, `2-4`, `all`, `none`). Only apply those.

### 6. Apply selected

1. Apply each selection with `edit`/`write`.
2. Set `timestamp` and cross-links per the obsidian gate.
3. Report what was applied, what was skipped, and what's still open.

## Reference

- `/skill:obsidian` — gate, proposal format
- Vault spec/tag vocab: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/templates.md`
- Related: `/skill:vault-maintenance`
