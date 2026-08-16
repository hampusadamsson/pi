---
name: obsidian-knowledge
description: Maintain the user's Obsidian knowledge vault. Use when capturing, distilling, organizing, deduplicating, cross-linking, or archiving notes in the Open Knowledge Format (OKF), or when finding where knowledge belongs in 1-wiki/.
---

# Obsidian Knowledge Base

Librarian and writer for the user's personal knowledge vault. Integrate knowledge, don't just file it: update existing pages, cross-link, resolve contradictions, refine summaries. The wiki gets denser with every source.

Vault root: `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

## Safety gates (always)

- **Reading, searching, listing, scanning:** always allowed. Do it freely.
- **Writing, creating, editing, renaming, moving, deleting:** NEVER without explicit user approval for that specific change.
- **Scan first:** locate the canonical page and correct map before proposing any write. Never create a duplicate.
- **Ask questions, offer suggestions:** when placement, naming, or scope is unclear, ask a focused question and propose options. Never guess silently.
- **`0-daily/` and `3-journal/` are read-only, always** — never edit them, even with approval.

## Knowledge persistence workflow

When new information arrives (article, transcript, note):

1. **Capture** raw in `0-daily/` (user-directed only — the agent never writes there itself).
2. **Scan** `1-wiki/` and map `index.md` files for an existing canonical page. Search names, similar terms, and the tag vocabulary.
3. **Dedupe:** one entity = one page, stable name, no date prefix. Never create a second page for an existing entity — merge into the canonical page.
4. **Distill** into the correct map:
   - `tools/` — platforms & CLIs you use (`tool/managed` or `tool/local`)
   - `services/` — things deployed/integrated (`owner:` set)
   - `platform/` — architecture, standards, roadmap, RFCs
   - `howto/` — cross-tool techniques only
   - `private/` realms — family, learning, projects, dev, career
5. **Cross-link** `[[related]]` on every integration (Zettelkasten web).
6. **Resolve contradictions:** newer source wins; keep the page internally consistent.
7. **Set/maintain `resource`** frontmatter = source-of-truth the agent re-reads to refresh the page (repo, Confluence, table, daily note). `# Links` = operational URLs for people. Never mix them.
8. **Update the map `index.md`** when adding or renaming a page in a wiki map.
9. **Archive, don't deprecate-in-place:** move inactive/retired entities to `2-archive/`. Keep only active entities in `1-wiki/`.

## Note format (OKF)

Every wiki note starts with YAML frontmatter. No title heading — the filename is the title. Open with a short plain-language description, then sections.

```markdown
---
type: note
title: "Human-readable title"
description: "Short, LLM-searchable summary"
tags: [type/note, status/seedling]
timestamp: {{date}}
resource: []   # source-of-truth the agent re-reads to refresh this page
owner: ""      # services only: dml | lendo-se | lendo-no | lendo-pfm
---

Short plain-language description. [[related-page]]

# Summary
...
# See also
```

## Reference

- Full vault architecture, page types, writing style, tag vocabulary, owner values: `references/vault-spec.md`
- Note/tool/service/daily/meeting templates: `references/templates.md`
- In-vault `AGENTS.md` (at vault root) is canonical when cwd is the vault.
