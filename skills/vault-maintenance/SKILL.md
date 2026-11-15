---
name: vault-maintenance
description: On-demand deep maintenance pass over the Obsidian vault wiki. Finds conflicts, duplicates, stale resource/link references, and new or conflicting source info, then proposes prioritized A/B/C fixes and applies only the ones the user selects.
disable-model-invocation: true
---

# Vault Maintenance

Deep maintenance of `1-wiki/`. Run only when the user explicitly asks. Never on your own initiative.

OKF, approval gate, proposal format and the MCP tool table: `/skill:obsidian` (single source). The vault is reachable only through the `mysharedbrain` MCP — no local files.

## Safety gates

- Follow the obsidian skill's write approval gate; never apply the whole plan automatically. No edits during scan.
- `0-daily/` and `3-journal/`: read-only.

## Tools

mysharedbrain MCP only — see the tool table in `/skill:obsidian`. Scan with `list_notes`, `search_notes`, `get_frontmatter`, `search_by_tag`; link checks with `get_backlinks` / `get_outgoing`; apply with `patch_note`, `append_note`, `set_frontmatter`, `move_note`.

## Workflow

### 1. Scan

Index every page in `1-wiki/` (`list_notes(prefix="1-wiki", limit=...)`, paging until exhausted). Build the entity list: one entity = one page, stable name, no date prefix. Note each page's frontmatter (`get_frontmatter`: `type`, `tags` incl. `status/*`, `resource`, `owner`) and its links (`get_outgoing`), then read bodies only for pages that need a content diff.

### 2. Conflict & dedup check

- Same entity on more than one page → dedup candidate. Merge into one page, keep the stable name.
- Contradictory statements across pages → conflict. Newer source wins, but list every conflict explicitly; do not silently pick a side.
- Same concept under different names/tags → flag as naming/identity drift.

### 3. Reference check

- **`resource:` frontmatter** — re-read each pointer (repo, table, daily note; daily notes via `read_note`). Diff source against the page. Flag new info, stale info, and changed facts.
- **`# Links` operational URLs** — verify each still resolves. Flag dead or moved links.
- **`[[wikilinks]]`** — verify every target exists (resolve each with `search_notes`; `get_backlinks` gives the reverse direction). Flag broken links (propose fixing or unlinking) and orphans (pages with no inbound `[[link]]`).

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

1. Update content per selection with `patch_note` / `append_note` / `create_note` / `move_note`; timestamp via `set_frontmatter`, plus cross-links per the obsidian gate.
2. Report what changed and what was left.

## Reference

- `/skill:obsidian` — gate, proposal format
- Vault spec/tag vocab: `/Users/hampus/.pi/agent/skills/obsidian/references/vault-spec.md`
- Templates: `/Users/hampus/.pi/agent/skills/obsidian/references/templates.md`
