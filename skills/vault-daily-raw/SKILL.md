---
name: vault-daily-raw
description: Process the Obsidian vault's raw backlog. Use when asked to triage/process status/raw daily notes, distill them into the wiki, deduplicate, resolve conflicts, or clear the raw tag from 0-daily notes.
---

# Vault Daily Raw Processor

Distills `status/raw` daily notes from `0-daily/` into the wiki. Two-phase: scan and propose a plan, then apply it only after explicit approval.

Vault root: `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

## Safety gates

- Scan/read/search/list: always allowed.
- Any write (create/update wiki page, update MOC, edit daily note): only after the user approves the plan. Never write mid-scan.
- The only permitted edit to `0-daily/` is removing the `status/raw` tag. All other daily-note content is untouchable. This overrides the obsidian skill's `0-daily/` read-only rule for that one operation.
- `3-journal/` stays read-only, always.

## Phase 1 — Scan & plan

1. Find raw notes: every `0-daily/*.md` whose frontmatter `tags` include `status/raw`.
2. Extract candidate persistent knowledge from each note: facts, decisions, entities, ops learnings, source pointers.
3. Map each candidate to a canonical page: scan `1-wiki/` and its `index.md` MOCs. One entity = one page, stable name, no date prefix. Never create duplicates.
4. Classify each candidate:
   - **New page** — entity has no canonical page yet.
   - **Update** — extends or corrects an existing page.
   - **Conflict** — contradicts an existing page. Newer source wins, but list every conflict explicitly for the user.
   - **Reference** — the daily note becomes a `resource:` frontmatter pointer on the target page (source of truth to re-read).
   - **Not wiki** — personal/log noise; stays in the daily note.
5. Dedupe across notes: merge candidates that target the same page.
6. Identify blind spots: missing info each page needs — unanswered questions, gaps the raw notes expose, sources still to consult. Do not invent facts to fill gaps.
7. Present the plan as a table and ask for approval. No writes before a clear "yes".

Plan table columns: target page | action (new/update/conflict/reference) | source daily note(s) | proposed change | blind spots.

## Phase 2 — Apply (only after approval)

1. Create/update wiki pages per the plan, following the vault OKF (see Reference below): YAML frontmatter, no title heading, standard sections, `[[cross-links]]`.
2. Set `resource:` on every touched page to point back to the source daily note(s).
3. Update the map `index.md` for any new/renamed page. Cross-link with `[[...]]`.
4. Remove `status/raw` from each processed daily note's `tags`. Keep every other tag and all body content untouched.
5. Report: what changed, what remains raw, and which blind spots are still open.

## Blind spots

For every planned page, state what's missing. Keep the list in the phase-1 plan and repeat open items in the phase-2 report. Never fill a gap with invented facts — ask the user or mark it TODO.

## Reference

- Vault architecture, OKF, tag vocab: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/templates.md`
- Companion skill: `/skill:obsidian`
