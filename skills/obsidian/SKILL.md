---
name: obsidian
description: Maintain the user's Obsidian wiki/knowledge vault. Use when capturing, distilling, organizing, deduplicating, cross-linking, or archiving notes in the Open Knowledge Format (OKF), or when finding where knowledge belongs in the 1-wiki/ obsidian vault.
---

# Obsidian Knowledge Base

Librarian/writer for the vault. Integrate, don't just file: update existing pages, cross-link, resolve contradictions, refine summaries.

Vault root (single source): `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

## Write approval gate (shared)

Applies to every vault write, in this skill and in `vault-daily-raw`, `sync-vault-context`, `vault-maintenance`:

1. **Propose** — scan first (canonical page + map; no duplicates), then list proposals in the format below.
2. **Show** the diff/table of exact changes.
3. **Wait for explicit yes** (numbers/ranges/`all`/`none`). No writes before it, none during scan.
4. **Write only approved items.** Then set `timestamp` (today) on every edited page, update map `index.md` + cross-links on add/rename, report applied/skipped/open.

Also: read/search/list always allowed. Ask when placement/naming/scope unclear — never guess silently. Never invent facts; ask or mark TODO.

Exempt (not vault writes, no approval to queue; still list them as proposals): `give_feedback`, `ask_question`.

`3-journal/`: read-only, always. `0-daily/`: read-only, with one exception: `vault-daily-raw` may remove the `status/raw` tag from a processed note after approval (nothing else).

### Proposal format (all write skills)

Numbered list, one line each:

```
<id>. [<action>] <target note> — <one-line reason>
```

Actions: `create`, `edit`, `frontmatter`, `merge`, `move`, `archive`, `feedback`, `question`, `skip`. Put exact proposed text/diff beneath the item. Maintenance may prefix ids by priority (`A1`, `B2`, `C3`).

## Which vault write skill to use

| Skill | Use for |
| --- | --- |
| `vault-daily-raw` | Triage `status/raw` daily notes into the wiki |
| `sync-vault-context` | Reconcile current session context with the vault |
| `vault-maintenance` | Deep on-demand audit of `1-wiki/` (user-requested only) |

## Obsidian MCP tools

Skills depend on the Obsidian write-tool MCP server. Tools used:

- Read: `read_note`, `read_notes`, `read_vault_index`, `list_directory`, `search_notes`, `search_by_tag`, `get_frontmatter`, `get_backlinks`, `get_outgoing`, `recent_changes`, `note_history`
- Write (approval required): `create_note`, `update_note`, `append_note`, `patch_note`, `move_note`, `set_frontmatter`, `delete_note`
- Queue (no approval): `give_feedback`, `ask_question`

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

Canonical frontmatter, tag vocab, owner values and style live in `references/vault-spec.md` (only place). Page skeletons: `references/templates.md`. Use only tags from the vocab.

## Reference

- Vault architecture, OKF, tag vocab, owner values: `references/vault-spec.md`
- Templates (wiki, tool, service + Changelog, daily, meeting): `references/templates.md`
- In-vault `AGENTS.md` (vault root) is canonical when cwd is the vault.
