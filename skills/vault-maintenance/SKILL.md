---
name: vault-maintenance
description: On-demand deep maintenance pass over the Obsidian vault wiki. Finds conflicts, duplicates, stale resource/link references, and new or conflicting source info, then proposes prioritized A/B/C fixes and applies only the ones the user selects.
disable-model-invocation: true
---

# Vault Maintenance

Deep maintenance of `1-wiki/`. Run only when the user explicitly asks. Never on your own initiative.

Vault root: `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

## Safety gates

- Read/scan/search/list: always allowed.
- Writes: only for items the user explicitly selected. Never apply the whole plan automatically.
- `0-daily/` and `3-journal/`: read-only, always.
- Report before writing. No edits during the scan phase.

## Workflow

### 1. Scan

Index every page in `1-wiki/` plus its `index.md` MOCs. Build the entity list: one entity = one page, stable name, no date prefix. Note each page's frontmatter (`tags`, `status`, `resource`, `owner`), sections, and links.

### 2. Conflict & dedup check

- Same entity on more than one page → dedup candidate. Merge into one page, keep the stable name.
- Contradictory statements across pages → conflict. Newer source wins, but list every conflict explicitly; do not silently pick a side.
- Same concept under different names/tags → flag as naming/identity drift.

### 3. Reference check

- **`resource:` frontmatter** — re-read each pointer (repo, Confluence page, table, daily note). Diff source against the page. Flag new info, stale info, and changed facts.
- **`# Links` operational URLs** — verify each still resolves. Flag dead or moved links.
- **`[[wikilinks]]`** — verify every target exists. Flag broken links and orphans (pages no MOC links to).

### 4. Improvements & suggestions

- Entities referenced but missing a page.
- MOC `index.md` gaps (page not listed, renamed page not updated).
- Tag-vocab violations (unknown tags).
- Format drift: title headings in body, bold/italic instead of headings, missing `# See also`.
- Stale `status/` values, missing `owner:` on service pages.

### 5. Summary — numbered, prioritized

Report as numbered bullets, split by priority:

- **A. High** — conflicts, duplicates, wrong/stale facts, broken links, dead resources.
- **B. Medium** — stale content, missing cross-links, MOC gaps.
- **C. Low** — formatting, tag cleanup, missing `# See also`.

Each bullet: `A1` etc. — page, problem, proposed fix. User replies with letters, numbers, or ranges (e.g. `A1 A3`, `B2-4`, `C`). Apply only the selected items.

### 6. Apply (selected only)

1. Update content per selection.
2. Bump metadata: set `timestamp: YYYY-MM-DD` (today's date) in frontmatter on every changed page. One timestamp field only — no second date field.
3. If merged/renamed: update the map `index.md` and cross-links.
4. Report what changed and what was left.

## Reference

- Vault architecture, OKF, tag vocab: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/templates.md`
- Companion skill: `/skill:obsidian`
