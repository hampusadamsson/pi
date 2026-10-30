---
name: humio
description: Query Humio (CrowdStrike LogScale) via the humio MCP server for DML/SE/NO/Kreddy application logs — errors, workload health, Airflow pipeline debugging. Use whenever a task needs log data, error investigation, or workload/service activity from Humio.
---

# Humio (LogScale MCP)

Tools (as seen in sessions): `mcp__humio__search` and `mcp__humio__list_repos` are exposed directly (args: `query`, `repo`, `start`, `end`, `limit`). Others (`humio_get_config`) go via the proxy: `mcp({ tool: "humio_get_config", args: {} })`. Config via `HUMIO_TOKEN`/`HUMIO_ENDPOINT` env vars.

Example:

```
mcp__humio__search({ repo: "dml_lendo_prod", query: "kubernetes.labels.app=pcm-se log_processed.levelname=ERROR | groupBy(log_processed.message)", start: "7d", limit: 25 })
```

## Repo/env selection

- Defaults: DML model / Airflow → `dml_lendo_prod` (stage: `dml_lendo_stage`; the `lendo_dml_*` naming is the same set — use the table below). SE app → `se_lendo_month`. Kreddy → `kreddy_lendo_month`; NO → `no_lendo_pro`.
- Don't re-ask which repo if the default fits; run `list_repos` only if unsure.
- Before concluding, always state to the user the repo + env + time window used.
- Day-bucketed counts: `timechart(span=1d)` or `bucket(span=1d)` + `groupBy`.
- On timeout: retry with a narrower window and/or smaller `limit`.

## Repos → environment

| Repo | Env | Notes |
| --- | --- | --- |
| `dml_lendo_prod` | **DML prod** | primary repo for DML/ML model + Airflow pipeline logs |
| `dml_lendo_stage` | DML stage | |
| `se_lendo_month` | **SE prod** | Lendo SE app services (loan/insurance/etc, not DML models) |
| `se_lendo_week`, `se_lendo_stage_week`, `se_lendo_dev_week` | SE stage/dev | |
| `se_lendo_app`, `se_lendo_travis_24hours`, `se_lendo_year` | SE misc/longer retention | |
| `kreddy_lendo_month` | **Kreddy prod** | `kreddy-api`, `bankid-service-v6`, etc. |
| `kreddy_lendo_week`/`year` | Kreddy other windows | |
| `no_lendo_pro` | **NO prod** | click-ops alerts (not IaC); low volume, mostly infra (`ebs-csi-controller`) |
| `no_lendo_month`/`week`/`dev_pre` | NO other envs | `no_lendo_month` was empty in recent test — check window/repo before assuming no data |

Always `humio_list_repos` first if unsure — repo set can change.

## Query syntax — tested gotchas

- **Field filters: write names unquoted** (`kubernetes.labels.app=pcm-se`) — a quoted string on its own is free-text search. Exception: the Airflow examples below use the quoted form `"log_processed.name" = value` and were verified live; if a quoted filter returns 0 rows unexpectedly, retry unquoted (and vice versa).
- **Free-text + field filter = space (implicit AND), never a pipe.** `"error" | kubernetes.labels.app=airflow` splits into two pipeline stages and returns 0 rows. Correct: `kubernetes.labels.app=airflow ERROR`.
- **"N event(s) matched" is the pre-pipeline scan count**, not the row count after `groupBy`/`timechart`. Verify real counts with `groupBy(field, function=count())`.
- Prefer **one broad query** (wide time window, filters/pipes in the query string) over many narrow calls — each call re-scans server-side.
- `head(n)`/`tail(n)` is the reliable way to eyeball raw events and discover field names before building a filtered query.
- `fields`/`extract` MCP args are unreliable (drop rows silently on name mismatch) — safer to read full JSON and pick fields from that.
- `end` rejects `"now"` — use `start` only, or ISO8601/epoch ms.
- Hard cap 500 events/call, MCP default limit 25.
- Most DML services log structured JSON with a `log_processed.*` prefix (parsed from the raw JSON payload): `log_processed.levelname`, `log_processed.message`, `log_processed.name`, `log_processed.funcName`. Airflow's own container logs (webserver/scheduler) are **not** pre-parsed this way — they're plain text/JSON needing `parseJson()`/`kvParse()` (see Airflow example below) or free-text `ERROR` matching.

## Finding ERRORS for a specific workload

For services with parsed `log_processed.*` fields (models, APIs — most non-Airflow DML workloads):

```
kubernetes.labels.app=pcm-se log_processed.levelname=ERROR
| groupBy(log_processed.message)
```

Tested live (undated; `dml_lendo_prod`, `pcm-se`, 30d): 0 matches — confirms the pattern runs clean even with no errors present. Swap `pcm-se` for any workload from the table below.

For Airflow (container logs, no `log_processed.levelname` field) — free-text ERROR + groupBy on the raw message:

```
kubernetes.labels.app=airflow ERROR
| groupBy("log_processed.message")
```

Tested live (undated; `dml_lendo_prod`, 7d): 28 matching events, 15 distinct grouped messages — real errors surfaced included zombie task detection, scheduler exceptions, otel-collector connection timeouts, and specific DAG run failures (`Marking run <DagRun ...> failed`).

General template: `kubernetes.labels.app=<workload> [level filter or free-text ERROR] | groupBy(<message field>)`. Always run `head(3)` on the workload first if unsure whether it's a `log_processed.*`-parsed service or raw container logs.

## Workloads

Full, maintained workload list: see the `humio` wiki page (`1-wiki/work/tools/humio.md`; access via `obsidian` skill). It drifts as services deploy/retire — don't trust a static list. Airflow apps: `airflow`, `airflow-worker`. Discover the current set live:

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

Both verified against `dml_lendo_prod` (undated). Don't hardcode specific `dag_id` values into reusable queries — discover current ones live via `groupBy(dag_id, function=count())` first, they change over time.

## Discovery

```
mcp__humio__list_repos({})
mcp({ tool: "humio_get_config", args: {} })
```

## Source

CLI/MCP server: [humio-mcp](https://lendo-group.ghe.com/lendo-data-ml/humio-mcp) — shared core, `search`/`list_repos`/`get_config`. Full wiki page: `1-wiki/work/tools/humio.md` (alert IaC ownership, auth via Okta, Slack alert routing).
