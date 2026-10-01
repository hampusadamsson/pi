---
name: sync-vault-context
description: Reconcile the current conversation context (what was just discussed, learned, decided, fixed) against the Obsidian vault. Finds discrepancies between what the session now knows and what the vault says, proposes per-item actions (edit, create, feedback, question), and applies only what the user picks. Use when asked to sync/reconcile/update the vault with what just happened, or at the end of a task to check the vault reflects it.
---

# Sync Vault Context

Takes the current session's context — facts learned, decisions made, problems fixed, commands run, entities touched — and checks it against the vault's canonical pages. Surfaces discrepancies as a numbered list of proposed actions; the user picks which to run.

Vault root: `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

## Safety gates

- Read/scan/search (`read_note`, `read_notes`, `read_vault_index`, `list_directory`, `search_notes`, `search_by_tag`, `get_frontmatter`, `get_backlinks`, `get_outgoing`, `recent_changes`, `note_history`): always allowed.
- Writes (`create_note`, `update_note`, `append_note`, `patch_note`, `move_note`, `set_frontmatter`, `delete_note`): only for items the user explicitly selected. Never batch-apply.
- `give_feedback` and `ask_question`: no approval needed to file — they queue for review / log a question, they don't write the vault. Still list them as proposed actions so the user sees what will be filed.
- `0-daily/` and `3-journal/`: read-only, always.
- Never invent facts to fill a gap — if context is ambiguous, ask instead of guessing which page/action.

## Workflow

### 1. Extract context

Pull what the current session actually established: entities discussed (tools, services, projects, people), facts learned or corrected, decisions made, commands/configs that changed, problems solved and their root cause/fix. Ignore pure back-and-forth with no durable content.

### 2. Find relevant vault state

For each extracted entity/fact, locate its canonical page: `search_notes`, `search_by_tag`, or `read_vault_index`/`list_directory` if no obvious hit. One entity = one page — if none exists, note that as a candidate new page, don't assume.

### 3. Diff

Compare session context against each found page's content, frontmatter (`resource`, `owner`, `tags`, `timestamp`), and links:

- **Contradiction** — page says X, session established Y. Newer (session) wins by default, but always list it, never silently overwrite.
- **Missing** — session has a fact/decision the page doesn't mention.
- **Stale `resource:`** — session touched the resource behind a page and found it changed.
- **New entity** — session surfaced something with no page at all.
- **Unclear** — session context doesn't map cleanly to one page, or overlaps two candidate pages.

### 4. Propose actions

One numbered item per discrepancy, each with a concrete action type:

- `edit` — `patch_note`/`append_note` (small) or `update_note` (rewrite), with the exact proposed text.
- `create` — new page: proposed id, OKF frontmatter, and content.
- `feedback` — `give_feedback` when unsure the change is right, or it's someone else's call.
- `question` — `ask_question` when the vault should record an open question rather than a guess.
- `frontmatter` — `set_frontmatter` for `resource`/`owner`/`tags`/`timestamp` fixes alone.
- `skip` — noted but no action needed (e.g. already consistent).

Format:

```
1. [edit] 1-wiki/work/tools/foo — session found `foo` now supports X; page says it doesn't. Proposed: patch "# Summary" to add X.
2. [create] 1-wiki/work/tools/bar — new tool used this session, no page exists. Proposed: OKF stub with description + resource link.
3. [feedback] 1-wiki/private/projects/baz — unsure if this session's workaround is the right long-term fix; queue for librarian review.
4. [question] 1-wiki/services/qux — session couldn't confirm the current owner; file as open question.
```

Ask for clarification before proposing anything where placement, naming, or which page owns the fact is ambiguous — don't guess and don't silently skip it either.

### 5. User picks

User replies with numbers/ranges (e.g. `1 3`, `2-4`, `all`, `none`). Only apply those.

### 6. Apply selected

1. Run the corresponding MCP tool per selection.
2. `set_frontmatter` `timestamp: YYYY-MM-DD` (today) on every page actually edited — one timestamp field.
3. New/renamed pages: update the map `index.md` (`patch_note`) and add `[[cross-links]]`.
4. Report what was applied, what was skipped, and what's still open (questions filed, feedback queued).

## Reference

- Vault architecture, OKF, tag vocab: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/templates.md`
- Companion skills: `/skill:obsidian`, `/skill:vault-maintenance`
