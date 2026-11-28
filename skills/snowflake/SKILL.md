---
name: snowflake
description: Run SQL against Snowflake via the Snowflake MCP server (`run_snowflake_query`). Use whenever a task needs data from Snowflake.
---

# Snowflake (MCP)

Tool: `mcp__snowflake__run_snowflake_query`.

Server: stage POC MCP (`snowflake-agentic-poc-mcp.data.stage.lendo.dev`), role `AGENTIC_POC_ROLE`, warehouse `LENDO_WH`. No default database/schema: use fully qualified names (`DB.SCHEMA.TABLE`).

## SQL

- Real, billed warehouse, not free local DB. Always scope: `LIMIT` on exploratory `SELECT`s, filter by date/partition on large tables. No unfiltered `SELECT *`.
- Mutating DDL/DML (`INSERT`/`UPDATE`/`DELETE`/`CREATE`/`DROP`/`ALTER`) — confirm with user first, state target warehouse/db/schema.
- The server rejects some statement types (e.g. `SHOW ...` returns "Statement type of Command is not allowed"). Use `SELECT` on `INFORMATION_SCHEMA` to discover objects. The server may also reject DDL/DML.

## Guardrails

- Confirm context first: `SELECT CURRENT_WAREHOUSE(), CURRENT_DATABASE(), CURRENT_SCHEMA()`.
- PII: don't select PII columns (names, personal IDs, contact details) unless asked.
- Cost awareness: large scans / CTAS burn credits — size down first, ask if scale unclear.
