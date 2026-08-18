---
name: snowflake
description: Query Snowflake and inspect/query semantic views via the Snowflake MCP server. Use whenever a task needs data from Snowflake or semantic-layer metrics/dimensions.
---

# Snowflake (MCP)

Tools: `run_snowflake_query`, `list_semantic_views`, `describe_semantic_view`, `show_semantic_dimensions`, `show_semantic_metrics`, `get_semantic_view_ddl`, `write_semantic_view_query_tool`, `query_semantic_view`, `read_get_tools_config`.

## Raw SQL

- Real, billed warehouse, not free local DB. Always scope: `LIMIT` on exploratory `SELECT`s, filter by date/partition on large tables. No unfiltered `SELECT *`.
- Mutating DDL/DML (`INSERT`/`UPDATE`/`DELETE`/`CREATE`/`DROP`/`ALTER`) — confirm with user first, state target warehouse/db/schema.
- Check `read_get_tools_config` at session start for enabled scopes/warehouses.

## Semantic layer (prefer over hand-rolled SQL for known metrics)

`list_semantic_views` → `describe_semantic_view` → `show_semantic_dimensions`/`show_semantic_metrics` → `write_semantic_view_query_tool` (build, inspect) → `query_semantic_view` (build+run). `get_semantic_view_ddl` if metrics look off.

## Guardrails

- Confirm context first: `SELECT CURRENT_WAREHOUSE(), CURRENT_DATABASE(), CURRENT_SCHEMA()`.
- Cost awareness: large scans / CTAS burn credits — size down first, ask if scale unclear.
