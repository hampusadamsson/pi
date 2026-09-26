---
name: obsidian
description: Maintain the user's Obsidian wiki/knowledge vault via the mysharedbrain MCP. Use when capturing, distilling, organizing, deduplicating, cross-linking, or archiving notes in the Open Knowledge Format (OKF), or when finding where knowledge belongs in the 1-wiki/ vault.
---

# Obsidian Knowledge Base (via mysharedbrain)

Librarian/writer for the vault. Integrate, don't just file: update existing pages, cross-link, resolve contradictions, refine summaries.

## Vault access — mysharedbrain MCP

All vault operations go through the **mysharedbrain** MCP server (configured in `~/.pi/agent/mcp.json`). Do NOT read or write vault files with local filesystem tools (read/edit/write/grep/find on the syncthing path) — the MCP is the tool layer. The local Obsidian app is for the human only; MCP notes sync to it.

- Note ids are paths without `.md`: `1-wiki/work/tools/snowflake`, `1-wiki/private/projects/homelab`.
- Folders are implicit — `create_note` creates intermediate folders.
- `0-daily/` and `3-journal/` may not appear in `read_vault_index`; do not create them via MCP.

## Safety gates

- Read/search/list/scan (read_note, read_notes, read_vault_index, list_directory, search_notes, search_by_tag, get_frontmatter, get_backlinks, get_outgoing, recent_changes, note_history, ask_question): always allowed.
- Write (create_note, update_note, append_note, patch_note, move_note, delete_note, restore_note, set_frontmatter): never without explicit approval per change.
- Scan first: locate canonical page + correct map before proposing a write. No duplicates.
- Ask when placement/naming/scope unclear — never guess silently. `ask_question` also files a retrievable question.
- `give_feedback` needs no approval — it only queues for librarian review, never writes directly. Use it freely and proactively for any uncertain or suggested change. No secrets in any write.
- `0-daily/` and `3-journal/`: read-only, always.

## Tool mapping

| Task | Tools |
| Scan vault | `read_vault_index`, `list_directory` |
| Find page / dedupe | `search_notes` (ripgrep), `search_by_tag` |
| Read | `read_note`, `read_notes` (batch) |
| Freshness/history | `recent_changes`, `note_history` |
| Frontmatter | `get_frontmatter`, `set_frontmatter` (null deletes key) |
| Cross-links | `get_backlinks`, `get_outgoing` |
| Small add | `append_note` (end) or `patch_note` (under a heading) — prefer over full rewrite |
| Full rewrite | `update_note` (replaces whole content) |
| New page | `create_note` |
| Rename/move | `move_note` |
| Retire | `delete_note` (to trash) → `restore_note` if wrong |

## Workflow

1. **Capture** raw in `0-daily/` (user-directed only, agent never writes there).
2. **Scan** `1-wiki/` via `read_vault_index` / `list_directory` for canonical page (names, terms, tag vocab).
3. **Dedupe**: one entity = one page, stable name, no date prefix. `search_notes` before creating. Merge, never duplicate.
4. **Distill** into correct map: `tools/` (managed/local CLIs), `services/` (`owner:` set), `platform/` (architecture/standards/RFCs), `howto/` (cross-tool techniques), `private/` realms (family/learning/projects/dev/career).
5. **Cross-link** `[[related]]`; verify with `get_backlinks`/`get_outgoing` after.
6. **Resolve contradictions**: newer source wins, keep page internally consistent.
7. **Set `resource`** frontmatter = source-of-truth to re-read (repo/Confluence/table/daily note). `# Links` = operational URLs for people. Never mix.
8. **Update map `index.md`** via `patch_note`/`append_note` on add/rename.
9. **Archive, don't deprecate-in-place**: retired entities → `move_note` to `2-archive/`; keep `1-wiki/` active-only.
10. **Close the loop after the task** — feed learnings back per APPEND_SYSTEM.md: suggested/uncertain changes → `give_feedback`; obvious updates → `append_note`/`patch_note` directly via MCP. Extend context what future tasks need: commands, fixes, decisions, tool/service facts.

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

`{{date}}` → actual date (`YYYY-MM-DD`) when writing via MCP (`create_note` / `update_note`). Never save the literal string.

## Reference

- Vault architecture, page types, style, tag vocab, owner values: `references/vault-spec.md`
- Templates: `references/templates.md`
