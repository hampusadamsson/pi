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

## Workflow

1. Search before creating — dedupe, no duplicate docs for same topic.
2. Prefer `update_page_section` over full `update_page` for partial edits.
3. Check restrictions/permissions before writing to a page you don't own.
4. Draft, then confirm before any create/update/delete/move.
