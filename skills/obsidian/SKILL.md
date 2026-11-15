---
name: obsidian
description: Maintain the user's Obsidian wiki/knowledge vault via the mysharedbrain MCP. Use when capturing, distilling, organizing, deduplicating, or cross-linking notes in the Open Knowledge Format (OKF), or when finding where knowledge belongs in the 1-wiki/ obsidian vault.
---

# Obsidian Knowledge Base

Librarian/writer for the vault. Integrate, don't just file: update existing pages, cross-link, resolve contradictions, refine summaries.

## Access: mysharedbrain MCP only

The vault is **not on this machine** — there is no local checkout. Every vault operation goes through the `mysharedbrain` MCP server (`mcp__mysharedbrain__*`). Never use `hypa_read` / `hypa_grep` / `hypa_find` / `hypa_ls` / `edit` / `write` for vault content: those touch the local filesystem, not the vault.

Note ids are **vault-relative paths without the `.md` suffix** — e.g. `1-wiki/work/tools/litellm`, `0-daily/2026-11-13`.

| Intent | Function |
| Read one page | `read_note(note_id)` |
| Read several | `read_notes(note_ids)` |
| Browse a folder | `list_directory(prefix)` |
| List ids (paged) | `list_notes(prefix, limit, offset)` |
| Find by name/content | `search_notes(query, limit, offset)` |
| Find by tag | `search_by_tag(tag)` |
| Frontmatter only | `get_frontmatter(note_id)` |
| Inbound links | `get_backlinks(note_id)` |
| Outbound links | `get_outgoing(note_id)` |
| Audit history | `note_history(note_id, kind, limit, offset)` |
| Recent vault changes | `recent_changes(limit, offset)` |
| Create | `create_note(note_id, content)` |
| Replace whole page | `update_note(note_id, content)` |
| Add to end | `append_note(note_id, content)` |
| Edit under a heading | `patch_note(note_id, heading, content, mode)` |
| Merge frontmatter keys | `set_frontmatter(note_id, updates)` |
| Rename/move | `move_note(note_id, new_id)` |
| Soft-delete | `delete_note(note_id)` |
| Restore | `restore_note(note_id)` |

Prefer `patch_note` and `append_note` over `update_note` — surgical edits, no full rewrite. `patch_note` replaces the section under a heading, which is how you update one section of a page.

Link and metadata work is cheaper via the graph tools than by reading whole pages: `get_outgoing` before a `move_note` tells you which `[[links]]` will break; `search_by_tag` finds cohorts without body reads.

If a tool is missing from your role, do not fall back to the filesystem — report that the role lacks it.

### Known issues

None currently open.

(mysharedbrain 4.0.3 had a `search_by_tag` outage: a vault filename with a stray space before `.md` made every tag lookup abort with `note not found`. Fixed 2026-11-13 by renaming the 4 affected files in `0-daily/`. Note for future debugging: the MCP strips trailing whitespace when resolving note ids, so a file whose stem ends in a space is unreachable — it appears in `list_notes` but `read_note`/`move_note` fail on it. Fix such files with a filesystem rename, not `move_note`.)

## Write approval gate (shared)

Applies to every vault write, in this skill and in `vault-daily-raw`, `sync-vault-context`, `vault-maintenance`:

1. **Propose** — scan first (canonical page + map; no duplicates), then list proposals in the format below.
2. **Show** the diff/table of exact changes.
3. **Wait for explicit yes** (numbers/ranges/`all`/`none`). No writes before it, none during scan.
4. **Write only approved items.** Then set `timestamp` (today) on every edited page, add cross-links, report applied/skipped/open.

Also: read/search/list always allowed. Ask when placement/naming/scope unclear — never guess silently. Never invent facts; ask or mark TODO.

`3-journal/`: read-only, always. `0-daily/`: read-only, with one exception: `vault-daily-raw` may remove the `status/raw` tag from a processed note after approval (nothing else).

### Proposal format (all write skills)

Numbered list, one line each:

```
<id>. [<action>] <target note> — <one-line reason>
```

Actions: `create`, `edit`, `frontmatter`, `merge`, `move`, `skip`. Put exact proposed text/diff beneath the item. Maintenance may prefix ids by priority (`A1`, `B2`, `C3`).

## Which vault write skill to use

| Skill | Use for |
| `vault-daily-raw` | Triage `status/raw` daily notes into the wiki |
| `sync-vault-context` | Reconcile current session context with the vault |
| `vault-maintenance` | Deep on-demand audit of `1-wiki/` (user-requested only) |

## Workflow

1. **Capture** raw in `0-daily/` (user-directed only, agent never writes there).
2. **Scan** `1-wiki/` for the canonical page: `search_notes` for titles/terms, `search_by_tag` for the tag vocab, `list_directory` to see a map's contents.
3. **Dedupe**: one entity = one page, stable name, no date prefix. Merge, never duplicate.
4. **Distill** into correct map: `tools/` (managed/local CLIs), `services/` (`owner:` set), `platform/` (architecture/standards/RFCs), `howto/` (cross-tool techniques), `private/` realms (family/learning/projects/dev/career/ai).
5. **Cross-link** `[[related]]` on every integration. Confirm targets exist with `search_notes` before linking.
6. **Resolve contradictions**: newer source wins, keep page internally consistent.
7. **Set `resource`** frontmatter = source-of-truth to re-read (repo/table/daily note). `# Links` = operational URLs for people. Never mix.
8. **Fix links** on rename: `get_backlinks(old_id)` first, then `move_note`, then `patch_note` each referrer.

## Note format (OKF)

Canonical frontmatter, tag vocab, owner values and style live in `references/vault-spec.md` (only place). Page skeletons: `references/templates.md`. Use only tags from the vocab.

## Reference

- Vault architecture, OKF, tag vocab, owner values: `references/vault-spec.md`
- Templates (wiki, tool, service + Changelog, daily, meeting): `references/templates.md`
- In-vault `AGENTS.md` (read via `read_note("AGENTS")`) is canonical when it conflicts with this skill.
