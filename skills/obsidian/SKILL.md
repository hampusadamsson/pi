---
name: obsidian
description: Maintain the user's Obsidian wiki/knowledge vault. Use when capturing, distilling, organizing, deduplicating, or cross-linking notes in the Open Knowledge Format (OKF), or when finding where knowledge belongs in the 1-wiki/ obsidian vault.
---

# Obsidian Knowledge Base

Librarian/writer for the vault. Integrate, don't just file: update existing pages, cross-link, resolve contradictions, refine summaries.

Vault root (single source): `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

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
| --- | --- |
| `vault-daily-raw` | Triage `status/raw` daily notes into the wiki |
| `sync-vault-context` | Reconcile current session context with the vault |
| `vault-maintenance` | Deep on-demand audit of `1-wiki/` (user-requested only) |

## Tools

File tools only: `hypa_read`, `hypa_grep`, `hypa_find`, `hypa_ls`, `edit`, `write`, `mv`. Reads are free; writes follow the approval gate.

## Workflow

1. **Capture** raw in `0-daily/` (user-directed only, agent never writes there).
2. **Scan** `1-wiki/` (grep titles/tags/body) for the canonical page (names, terms, tag vocab).
3. **Dedupe**: one entity = one page, stable name, no date prefix. Merge, never duplicate.
4. **Distill** into correct map: `tools/` (managed/local CLIs), `services/` (`owner:` set), `platform/` (architecture/standards/RFCs), `howto/` (cross-tool techniques), `private/` realms (family/learning/projects/dev/career/ai).
5. **Cross-link** `[[related]]` on every integration.
6. **Resolve contradictions**: newer source wins, keep page internally consistent.
7. **Set `resource`** frontmatter = source-of-truth to re-read (repo/Confluence/table/daily note). `# Links` = operational URLs for people. Never mix.
8. **Fix links** on rename: update `[[links]]` pointing to the old name.

## Note format (OKF)

Canonical frontmatter, tag vocab, owner values and style live in `references/vault-spec.md` (only place). Page skeletons: `references/templates.md`. Use only tags from the vocab.

## Reference

- Vault architecture, OKF, tag vocab, owner values: `references/vault-spec.md`
- Templates (wiki, tool, service + Changelog, daily, meeting): `references/templates.md`
- In-vault `AGENTS.md` (vault root) is canonical when cwd is the vault.
