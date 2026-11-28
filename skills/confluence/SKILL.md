---
name: confluence
description: Read, search, and edit Confluence pages via the Atlassian MCP server (search, page CRUD, comments, labels). Use whenever a task involves Confluence documentation.
---

# Confluence (Atlassian MCP)

Tool prefix `mcp__atlassian__confluence_*` (names below are written without it). MCP only, never REST/CLI.

## Read

`search` (CQL/simple terms) · `get_page` · `get_page_children` / `get_space_page_tree` (hierarchy).

## Write (confirm with user first)

`create_page` · `update_page` (full) / `update_page_section` (targeted, prefer for partial edits) · `move_page` · `add_comment` · `add_label`.

## Gotchas

- `get_page` takes `page_id` (ID, full URL or tiny link) or `title` + `space_key`. Options: `convert_to_markdown` (default true), `include_metadata` (default true). There is no `include_content` on `get_page`; that flag exists only on `get_page_children`, `create_page` and `update_page`. Check `Expected parameters` in tool errors before guessing other args.
- `get_page_children` 404s on folders (e.g. the ML models folder). List children via `search` with query `ancestor = 93094127` and `spaces_filter=LDML`.
- `update_page_section`: params `page_id`, `heading_text` (exact, case-sensitive, no heading markup), `new_content` (body only, without the heading). Inspect headings first with `get_page` and `convert_to_markdown=false`. Fallback: full `update_page` (needs `page_id` + `title`; use `content_file` for large bodies; read the page first, resend whole body).
- `403 Authentication failed ... Token may be expired or invalid` = expired/invalid API token, not a permissions issue on the page. Tell the user to refresh the token; don't retry in a loop.

## Locations (single source of truth)

- Space `LDML` (Lendo Data and Machine Learning).
- "ML models" folder: `93094127` (holds the per-service `dml-*` pages and a few non-service pages); e.g. page `93095526` (dml-refinance-se).

## Workflow

1. Search before creating — dedupe, no duplicate docs for same topic.
2. Prefer `update_page_section` over full `update_page` for partial edits.
3. Draft, then confirm before any create/update/move.
