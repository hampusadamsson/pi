# Vault Specification

Vault root: `/Users/hampus.adamsson/syncthing/default/obsidian/work/`

Top level. Each map has an `index.md` (MOC) — keep current on add/rename. Max depth 2 under a realm.

## Architecture

| Dir | Purpose |
| --- | --- |
| `0-daily/` | Capture zone. `YYYY-MM-DD[ context].md`. Read-only for the agent. |
| `1-wiki/` | Distilled knowledge. Two realms: `work/`, `private/`. |
| `2-archive/` | Soft delete. |
| `3-journal/` | Private journaling (vomit). NOT wiki. Filled manually. |
| `attachment/` · `Excalidraw/` · `template/` | Assets, diagrams, templates. |

### `1-wiki/work/`

| Map | Holds |
| --- | --- |
| `tools/` | Platforms & CLIs you USE. Managed SaaS (`tool/managed`: argocd, snowflake) or local CLI (`tool/local`: k9s, uv, gh). Ref manual per page. |
| `services/` | Things WE deploy or integrate: coded services, models, market frontends. `owner:` set. `index.md` doubles as ML#### inventory (id │ page │ market │ owner │ status). |
| `platform/` | Architecture, standards, roadmap, RFCs, gitops concept, `.canvas` diagrams. |
| `howto/` | Cross-tool techniques only. Tool-specific steps go in that tool's page. |

### `1-wiki/private/`

| Map | Holds |
| --- | --- |
| `family/` | Family, relationships. |
| `learning/` | Notekeeping, typing, keyboards, languages. |
| `projects/` | Personal builds (homelab, agent-harness, bookmaker). |
| `dev/` | Personal machine setup CLIs (`tool/local`: nvim, shell, nix-dotfiles, brew, ollama). |
| `career/` | CV, external engagements. |

### Layout

```
0-daily/                      capture, read-only
1-wiki/
  index.md                    root MOC
  work/
    index.md
    tools/      index.md + one page per platform/CLI (tool/managed | tool/local)
    services/   index.md (ML#### inventory) + coded svcs, models, frontends
    platform/   architecture, planning, standardization, roadmap, gitops,
                rfc-*.md, *.canvas
    howto/      cross-tool techniques only
  private/
    index.md
    family/  learning/  dev/  projects/  career/
3-journal/                    vomit, NOT wiki, manual
2-archive/                    soft delete (retired ML models, legacy)
attachment/  Excalidraw/  template/
```

## Page types

All variants of `[[wiki]]`. Sections use if applicable; drop what doesn't apply.

### tool (`tools/`)

Sections: Summary · Install · Auth · How-to · Links · Incidents · Depends · See also.

- CLI + MCP: install in **Install**, credentials/scope/VPN in **Auth**, usage in **How-to**. MCP config via Ruler (`ruler.toml` → `.claude/.mcp.json`); prod MCP fronted by `[[bifrost]]`.

### service (`services/`)

Sections: Summary · Lives&Runs · Auth · How-to · Links · Incidents · Depends/Surfaces · See also.

- `owner` in frontmatter. Models add `type/model` + `ML####` id.

### General rules

- One entity = one page, stable name (no date prefix in wiki). Fold ops/incidents/queries into the owning tool or service page.
- Cluster (subfolder) only at >4 related pages; else keep flat in the map.

## Note Format & Metadata (OKF)

Canonical wiki reference: `[[wiki]]`. Base every wiki page on it; `tool.md` and `service.md` are specialised variants. Every wiki note starts with YAML frontmatter following the Open Knowledge Format:

```markdown
---
type: note
title: "Human-readable title"
description: "Short, LLM-searchable summary"
tags: [type/note, status/seedling]
timestamp: {{date}}
resource: []   # authoritative source(s) the agent re-reads to update this page
owner: ""      # services only: dml | lendo-se | lendo-no | lendo-pfm (Kreddy)
---

Short plain-language description of the subject. [[related-page]]

# Summary
...
```

No title heading in the body — the filename is the title.

- `type` — matches the primary `type/` tag.
- `description` — one line, optimised for LLM search.
- `tags` — hierarchical, from the vocabulary below.
- `timestamp` — the template shows `{{date}}` as a placeholder for Obsidian's own template-insertion syntax. When the agent creates/edits a page by writing the file directly, substitute the actual current date (`YYYY-MM-DD`) — never leave the literal string `{{date}}` in a saved file.
- `resource` — machine-readable pointer(s) to the source of truth the agent reads to refresh this page (repo path, Confluence URL, Snowflake table, source daily note). For the LLM, not humans. String or list. Human/operational URLs (console stage/prod, dashboards) go in the `# Links` section, not here.
- `# Links` — in-body table of operational URLs for people: console (stage/prod), docs, dashboards.
- `owner` — services only: who owns the code (`dml` = ours; `lendo-se`/`lendo-no`/`lendo-pfm` = integrate). Kreddy = `lendo-pfm`.

`owner:` values: `dml`, `lendo-se`, `lendo-no`, `lendo-pfm` (= Kreddy).

## Writing style

- **No title heading** — the filename is the title. Open with a short plain-language description, then sections.
- **Headings, not emphasis** — structure with `#`/`##`/`###`. Avoid `**bold**` / `_italic_`; use a heading or list instead.
- **Standard sections (if applicable):** Summary · Install · Auth · How-to (with example) · Links · See also. Drop sections that don't apply; don't reorder.
- **Links in one section** — a table of code / service / docs URLs. Descriptive text, never a bare URL.
- **Progressive disclosure:** overview first, detail below. One subject per page; never skip heading levels.
- **Scannable:** prefer tables/lists over prose. Fence code with a language and a labelling comment.
- **No orphans:** every page is linked from its map `index.md` and ends with `# See also`.
- **Evergreen:** update in place; bump `timestamp` = last reviewed. State (status, owner) lives in frontmatter, not in the body.
- **KISS:** Simple. Flat where possible. Never overcomplicate.
- **Short & technical:** Fewest words. No adjectives. One subject per note.
- **Tag:** vocabulary below only. No new tag without approval.
- **Link:** heavy Obsidian `[[links]]`.
- **Formatting:** fix spelling/format only when certain.

## Tag Vocabulary

Use these only. Request approval before adding a new tag. Folders carry domain; tags carry everything cross-cutting (market, system, status).

### type/

`type/daily`, `type/howto`, `type/reference`, `type/incident`, `type/tool`, `type/service`, `type/model`, `type/planning`, `type/rfc`, `type/credentials`

### status/

`status/raw`, `status/seedling`, `status/active`, `status/idea`, `status/deprecated`

`status/raw` = not yet processed by the agent. `status/deprecated` = legacy (e.g. travis, spinnaker).

### market/ (market / business unit)

`market/se`, `market/no`, `market/dk`, `market/kreddy` (Kreddy = `lendo-pfm` org/cluster)

### tool/ (nature of a tool page)

`tool/managed` (SaaS/platform), `tool/local` (CLI on your machine)

### system/ (one per tool/service, matches page name)

e.g. `system/argocd`, `system/gke`, `system/snowflake`, `system/humio`, `system/airflow`, `system/rabbitmq`, `system/confluence`, `system/jira`, `system/github`, `system/pcm`, `system/soc`, `system/irm`, `system/prediction-api`, `system/inbox`, `system/admin`

### project/ (hierarchical: parent + country/variant)

`project/pcm` (`/no`, `/se`, `/dk`), `project/irm` (`/no`, `/kreddy`), `project/soc` (`/no`, `/se`), `project/ec`

## Agent profile

You are the **librarian and writer**, the user is the **curator**. Do not just file information — integrate it. Update existing pages, cross-link, resolve contradictions, refine summaries. The wiki gets denser with every source.

You DO NOT edit, remove or change files in `0-daily/` or `3-journal/`.

When you make changes that conflict with these instructions: confirm with user and update the instruction.
