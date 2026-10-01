---
name: obsidian
description: Maintain the user's Obsidian wiki/knowledge vault. Use when capturing, distilling, organizing, deduplicating, cross-linking, or archiving notes in the Open Knowledge Format (OKF), or when finding where knowledge belongs in the 1-wiki/ obsidian vault.
---

# Obsidian Knowledge Base

Librarian/writer for the vault. Integrate, don't just file: update existing pages, cross-link, resolve contradictions, refine summaries.

Vault root: `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

## Safety gates

- Read/search/list/scan: always allowed.
- Write/create/edit/rename/move/delete: never without explicit approval per change.
- Scan first: locate canonical page + correct map before proposing a write. No duplicates.
- Ask when placement/naming/scope unclear — never guess silently.
- `0-daily/` and `3-journal/`: read-only, always.

## Workflow

1. **Capture** raw in `0-daily/` (user-directed only, agent never writes there).
2. **Scan** `1-wiki/` + map `index.md` files for canonical page (names, terms, tag vocab).
3. **Dedupe**: one entity = one page, stable name, no date prefix. Merge, never duplicate.
4. **Distill** into correct map: `tools/` (managed/local CLIs), `services/` (`owner:` set), `platform/` (architecture/standards/RFCs), `howto/` (cross-tool techniques), `private/` realms (family/learning/projects/dev/career).
5. **Cross-link** `[[related]]` on every integration.
6. **Resolve contradictions**: newer source wins, keep page internally consistent.
7. **Set `resource`** frontmatter = source-of-truth to re-read (repo/Confluence/table/daily note). `# Links` = operational URLs for people. Never mix.
8. **Update map `index.md`** on add/rename.
9. **Archive, don't deprecate-in-place**: retired entities → `2-archive/`; keep `1-wiki/` active-only.

## Note format (OKF)

YAML frontmatter, no title heading (filename is title), short plain-language intro, then sections.

```markdown
---
type: note
title: "Human-readable title"
description: "Short, LLM-searchable summary"
tags: [type/note, status/seedling]
timestamp: {{date}}
resource: []   # source-of-truth to refresh this page
owner: ""      # services only: dml | lendo-se | lendo-no | lendo-pfm
---

Short plain-language description. [[related-page]]

# Summary
...
# See also
```

## Reference

- Vault architecture, page types, style, tag vocab, owner values: `references/vault-spec.md`
- Templates: `references/templates.md`
- In-vault `AGENTS.md` (vault root) is canonical when cwd is the vault.
