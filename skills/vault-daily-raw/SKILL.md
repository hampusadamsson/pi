---
name: vault-daily-raw
description: Process the Obsidian vault's raw backlog. Use when asked to triage/process status/raw daily notes, distill them into the wiki, deduplicate, resolve conflicts, or clear the raw tag from 0-daily notes.
---

# Vault Daily Raw Processor

Distills `status/raw` daily notes from `0-daily/` into the wiki. Two-phase: scan and propose a plan, then apply it only after explicit approval.

OKF, approval gate, proposal format and the MCP tool table: `/skill:obsidian` (single source). The vault is reachable only through the `mysharedbrain` MCP — no local files.

## Safety gates

- Follow the obsidian skill's write approval gate. Never write mid-scan.
- The only permitted edit to `0-daily/` is removing the `status/raw` tag (the exception documented in `obsidian`). All other daily-note content is untouchable.
- `3-journal/` stays read-only.

## Phase 1 — Scan & plan

1. Find raw notes. Use `search_by_tag("status/raw")` as the primary lookup. Fallback if it ever returns an error again: `list_notes(prefix="0-daily")`, paging with `offset` until exhausted, then `get_frontmatter` each id and keep those whose `tags` contain `status/raw`. Read the survivors with `read_notes`.
2. Extract candidate persistent knowledge from each note: facts, decisions, entities, ops learnings, source pointers.
3. Map each candidate to a canonical page: `search_notes` on titles/terms, `list_directory` per map, and `get_frontmatter` to check `resource:`. One entity = one page, stable name, no date prefix. Never create duplicates.
4. Classify each candidate:
   - **New page** — entity has no canonical page yet.
   - **Update** — extends or corrects an existing page.
   - **Conflict** — contradicts an existing page. Newer source wins, but list every conflict explicitly for the user.
   - **Reference** — the daily note becomes a `resource:` frontmatter pointer on the target page (source of truth to re-read).
   - **Not wiki** — personal/log noise; stays in the daily note.
5. Dedupe across notes: merge candidates that target the same page.
6. Identify blind spots: missing info each page needs — unanswered questions, gaps the raw notes expose, sources still to consult. Do not invent facts to fill gaps.
7. Present the plan in the obsidian proposal format (numbered: action, target note, one-line reason), with source daily note(s) and blind spots under each item. Actions: `create`, `edit`, `edit` (conflict, flagged), `frontmatter` (reference), `merge` (duplicates), `skip` (not wiki).

## Phase 2 — Apply (only after approval)

1. Create/update wiki pages per the plan, following the vault OKF (`obsidian` skill): approved items only. Use `create_note` for new pages, `patch_note` for section updates, `append_note` to extend.
2. On every touched page set `resource:` to the source daily note(s) and `timestamp:` to today (`YYYY-MM-DD`) via `set_frontmatter`.
3. Cross-link with `[[...]]`, confirming each target with `search_notes`.
4. Remove `status/raw` from each processed daily note's `tags` (also for notes whose candidates were all `skip`, once approved) with `set_frontmatter(note_id, {"tags": [...]})` — read the current tags with `get_frontmatter` first and write back the list minus `status/raw`. Keep every other tag and all body content untouched; never `update_note` a daily note.
5. Report: what changed, what remains raw, and which blind spots are still open.

## Blind spots

For every planned page, state what's missing. Keep the list in the phase-1 plan and repeat open items in the phase-2 report. Never fill a gap with invented facts — ask the user or mark it TODO.

## Reference

- `/skill:obsidian` — gate, proposal format
- Vault spec/tag vocab: `/Users/hampus/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus/.pi/agent/skills/obsidian/references/templates.md`
