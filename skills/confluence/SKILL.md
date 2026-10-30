---
name: confluence
description: Read, search, and edit Confluence pages via the Atlassian MCP server (search, page CRUD, comments, attachments, templates, restrictions). Use whenever a task involves Confluence documentation.
---

# Confluence (Atlassian MCP)

Tool prefix `atlassian_confluence_*`. MCP only, never REST/CLI.

## Read

`search` (CQL/simple terms) · `get_page` · `get_page_children` / `get_space_page_tree` (hierarchy) · `get_comments` / `get_inline_comments` · `get_labels` · `get_page_history` / `get_page_diff` · `get_attachments` / `download_attachment` / `get_page_images` · `search_user`.

## Write (confirm with user first)

`create_page` / `create_page_from_template` (list via `list_page_templates`/`get_page_template`) · `update_page` (full) / `update_page_section` (targeted, prefer for partial edits) · `move_page` / `copy_page` · `add_comment` / `reply_to_comment` / `add_inline_comment` · `add_label` · `upload_attachment(s)` · `delete_page` / `delete_attachment` (destructive) · `set_page_restrictions` (check `get_page_restrictions`/`check_content_permissions` first).

## Gotchas

- `get_page` takes `page_id` (not `id`/`pageId`); `convert_to_markdown: true` for readable output. `include_content` does exist on `get_page` (boolean, default false per tool schema) — set it true if the body comes back empty. Check `Expected parameters` in tool errors before guessing other args.
- `get_page_children` 404s on the ML models folder. List children via `search` with CQL `ancestor=2475622432`.
- `update_page_section`: heading must match EXACTLY. Backticks, punctuation, or markdown formatting in the heading break matching → use the raw heading text, else fall back to full `update_page` (read the page first, resend whole body).
- `403 Authentication failed ... Token may be expired or invalid` = expired/invalid API token, not a permissions issue on the page. Tell the user to refresh the token; don't retry in a loop.

## Locations (single source of truth)

- Space `LDML`. DML service pages: folder `93094127` (`spaces/LDML/folder/93094127`).
- ML models folder: `2475622432` (<https://lendo-group.atlassian.net/wiki/spaces/LDML/folder/2475622432/ML+models>); e.g. page `93095526` (dml-refinance-se).

## Workflow

1. Search before creating — dedupe, no duplicate docs for same topic.
2. Prefer `update_page_section` over full `update_page` for partial edits.
3. Check restrictions/permissions before writing to a page you don't own.
4. Draft, then confirm before any create/update/delete/move.
