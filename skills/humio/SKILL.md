---
name: humio
description: Query Humio (CrowdStrike LogScale) via the humio MCP server for DML/SE/NO application logs — errors, workload health, Airflow pipeline debugging. Use whenever a task needs log data, error investigation, or workload/service activity from Humio.
---

# Humio (LogScale MCP)

Tools: `search` (args: `query`, `repo`, `start`, `end`, `limit`, `fields`, `extract`, `dedupe`), `list_repos`, `get_config`. All are deferred in `mcp.json`, so load them first. They appear as `mcp__humio__<name>`, or via the proxy: `mcp({ tool: "get_config", args: {} })`. Config via `HUMIO_TOKEN`/`HUMIO_ENDPOINT` env vars. Server: humio-mcp, pinned `@1.0.0`.

Example:

```
mcp__humio__search({ repo: "dml_lendo_prod", query: "kubernetes.labels.app=pcm-se-v1 log_processed.levelname=ERROR | groupBy(log_processed.message)", start: "7d" })
```

## Repo/env selection

- Visible repos: `dml_lendo_prod`, `dml_lendo_stage`, `no_lendo_pro`, `no_lendo_dev_pre`, `se_lendo_stage`. Run `list_repos` if unsure — the set can change.
- Defaults: DML model / Airflow → `dml_lendo_prod`; NO → `no_lendo_pro`.
- Before concluding, always state to the user the repo + env + time window used.
- Day-bucketed counts: `timechart(span=1d)` or `bucket(span=1d)` + `groupBy`.
- On timeout: retry with a narrower window and/or smaller `limit`.

## Repos → environment

| Repo | Env | Notes |
|---|---|---|
| `dml_lendo_prod` | **DML prod** | primary repo for DML/ML model + Airflow pipeline logs |
| `dml_lendo_stage` | DML stage | |
| `no_lendo_pro` | **NO prod** | click-ops alerts (not IaC); low volume, mostly infra (`ebs-csi-controller`) |
| `no_lendo_dev_pre` | NO dev/pre | |
| `se_lendo_stage` | SE stage | |

## Query syntax — tested gotchas

- **Field filters: write names unquoted** (`kubernetes.labels.app=pcm-se-v1`) — a quoted string on its own is free-text search. Exception: the Airflow examples below use the quoted form `"log_processed.name" = value` and were verified live; if a quoted filter returns 0 rows unexpectedly, retry unquoted (and vice versa).
- **Free-text + field filter = space (implicit AND), never a pipe.** `"error" | kubernetes.labels.app=airflow` splits into two pipeline stages and returns 0 rows. Correct: `kubernetes.labels.app=airflow ERROR`.
- **"N event(s) matched" is the pre-pipeline scan count**, not the row count after `groupBy`/`timechart`. Verify real counts with `groupBy(field, function=count())`.
- Prefer **one broad query** (wide time window, filters/pipes in the query string) over many narrow calls — each call re-scans server-side.
- `head(n)`/`tail(n)` is the reliable way to eyeball raw events and discover field names before building a filtered query.
- `fields`/`extract` MCP args can drop rows silently on name mismatch — if rows go missing, read full JSON and pick fields from that.
- `end: "now"` is accepted. Omit `end` if a client rejects it.
- Hard cap 500 events/call. Default limit is 100 (output says "truncated at limit=100"). Narrow the query instead of raising `limit`.
- DML services and Airflow scheduler logs are parsed into `log_processed.*`: `log_processed.levelname`, `log_processed.message`, `log_processed.name`, `log_processed.funcName`. `parseJson()`/`kvParse()` are only needed to pull key=value pairs out of the message text (e.g. `dag_id`, `run_duration`).

## Finding ERRORS for a specific workload

```
kubernetes.labels.app=pcm-se-v1 log_processed.levelname=ERROR
| groupBy(log_processed.message)
```

Use the exact app label from the discovery query below. `pcm-se` is not a label; `pcm-se-v1` is. A label that doesn't exist returns 0 matches, which is not the same as "no errors".

For Airflow:

```
kubernetes.labels.app=airflow ERROR
| groupBy("log_processed.message")
```

Re-verified 2026-11-03 (`dml_lendo_prod`, 7d): 18 events, mostly `Marking run <DagRun ...> failed`, `Failed to get task for ti`, scheduler loop exceptions. Counts change; don't rely on them.

General template: `kubernetes.labels.app=<workload> [level filter or free-text ERROR] | groupBy(<message field>)`. Run `head(3)` on the workload first if unsure of the fields.

## Workloads

Full, maintained workload list: see the `humio` wiki page (`1-wiki/work/tools/humio.md`; access via `obsidian` skill). It drifts as services deploy/retire — don't trust a static list. Airflow-related apps: `airflow`, `airflow-worker`, `airflow-flower`, `cloudsql-proxy-airflow` (sidecar, high volume). Discover the current set live:

```
mcp__humio__search({
  repo: "dml_lendo_prod",
  query: "* | groupBy(kubernetes.labels.app, function=count()) | sort(_count, order=desc)",
  start: "1h", limit: 50
})
```

## Airflow pipeline examples (see also [[airflow]] / [[humio]] wiki pages)

```
"log_processed.name" = "airflow.jobs.scheduler_job_runner.SchedulerJobRunner"
| "TaskInstance Finished"
| parseJson()
| kvParse(field=message, separator="=")
| timechart(function=avg(run_duration))
```

```
"log_processed.name" = airflow.models.dagrun.DagRun
| "DagRun"
| "state=failed"
| parseJson()
| kvParse(field=message, separator="=")
| groupBy(dag_id, function=count(as="Total Failures"))
| sort("Total Failures", order=desc)
```

Both re-verified 2026-11-03 against `dml_lendo_prod` (7d). The TaskInstance query matched 169 events but showed only 100, so averages are truncated: add `limit: 500` or narrow the window. Don't hardcode specific `dag_id` values into reusable queries — discover current ones live via `groupBy(dag_id, function=count())` first.

## Discovery

```
mcp__humio__list_repos({})
mcp__humio__get_config({})
```

## Source

MCP server: [humio-mcp](https://lendo-group.ghe.com/lendo-data-ml/humio-mcp) — `search`/`list_repos`/`get_config`. Full wiki page: `1-wiki/work/tools/humio.md` (alert IaC ownership, auth via Okta, Slack alert routing).
