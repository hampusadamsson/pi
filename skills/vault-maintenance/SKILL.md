---
name: vault-maintenance
description: On-demand deep maintenance pass over the Obsidian vault wiki. Finds conflicts, duplicates, stale resource/link references, and new or conflicting source info, then proposes prioritized A/B/C fixes and applies only the ones the user selects.
disable-model-invocation: true
---

# Vault Maintenance

Deep maintenance of `1-wiki/`. Run only when the user explicitly asks. Never on your own initiative.

Vault root, OKF, approval gate and proposal format: `/skill:obsidian` (single source).

## Safety gates

- Follow the obsidian skill's write approval gate; never apply the whole plan automatically. No edits during scan.
- `0-daily/` and `3-journal/`: read-only.

## Tools

File tools only: `hypa_read`, `hypa_grep`, `hypa_find`, `hypa_ls`, `edit`, `write`, `mv`.

## Workflow

### 1. Scan

Index every page in `1-wiki/` (`hypa_find`). Build the entity list: one entity = one page, stable name, no date prefix. Note each page's frontmatter (`type`, `tags` incl. `status/*`, `resource`, `owner`), sections, and links.

### 2. Conflict & dedup check

- Same entity on more than one page → dedup candidate. Merge into one page, keep the stable name.
- Contradictory statements across pages → conflict. Newer source wins, but list every conflict explicitly; do not silently pick a side.
- Same concept under different names/tags → flag as naming/identity drift.

### 3. Reference check

- **`resource:` frontmatter** — re-read each pointer (repo, Confluence page, table, daily note). Diff source against the page. Flag new info, stale info, and changed facts.
- **`# Links` operational URLs** — verify each still resolves. Flag dead or moved links.
- **`[[wikilinks]]`** — verify every target exists. Flag broken links (propose fixing or unlinking) and orphans (pages with no inbound `[[link]]`).

### 4. Improvements & suggestions

- Entities referenced but missing a page.
- Tag-vocab violations (unknown tags).
- Format drift: an H1 in the body that is not a standard section, bold/italic instead of headings, missing `# See also`.
- `type:` vs primary `type/` tag mismatch.
- Stale `status/` tags, missing `owner:` on service pages.

### 5. Proposals — prioritized

Use the obsidian proposal format, ids prefixed by priority:

- **A. High** — conflicts, duplicates, wrong/stale facts, broken links, dead resources.
- **B. Medium** — stale content, missing cross-links.
- **C. Low** — formatting, tag cleanup, missing `# See also`.

Each item: `<id>. [<action>] <target note> — <one-line reason>` with the exact proposed fix beneath (e.g. `A1. [edit] work/tools/foo.md — broken [[bar]]`). User replies with letters, numbers, or ranges (e.g. `A1 A3`, `B2-4`, `C`). Apply only the selected items.

### 6. Apply (selected only)

1. Update content per selection; timestamp and cross-links per the obsidian gate.
2. Report what changed and what was left.

## Reference

- `/skill:obsidian` — gate, proposal format
- Vault spec/tag vocab: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus.adamsson/.pi/agent/skills/obsidian/references/templates.md`
