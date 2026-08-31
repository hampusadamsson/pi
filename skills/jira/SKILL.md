---
name: jira
description: Use Jira via the Atlassian MCP server (search, read, create, update, transition issues, sprints, worklogs). Use whenever a task involves looking up, filing, or modifying Jira tickets.
---

# Jira (Atlassian MCP)

Tool prefix `atlassian_jira_*`. MCP only, never REST/CLI.

## Workflow

1. **Dedupe first**: `atlassian_jira_search({ jql, limit, fields })`.
2. **Read**: `get_issue({ issue_key, fields: "*all", include: "transitions,comments" })`.
3. **Discover schema before creating**: `get_project_issue_types` (get `issue_type_id`, e.g. Task=12197), `get_create_fields({ issue_type_id })` (schema only, no `allowedValues`), `get_field_options` (returns `[]` for DATA multicheckbox custom fields — unreliable), `search_fields` (fuzzy field-ID lookup).
4. **Create**: `create_issue` / `batch_create_issues`. Custom fields via `additional_fields` JSON.
5. **Update**: `update_issue({ issue_key, fields: JSON })`.
6. **Transition**: check valid transitions (`get_issue` w/ `include: "transitions"` or `get_transitions`) then `transition_issue`.
7. **Links/hierarchy**: `create_issue_link`, `link_to_epic`, `get_project_epic_hierarchy`, `get_cross_project_dependencies`.
8. **People**: `search_assignable_users` → accountId for `assignee`.
9. **Sprints/boards**: `get_agile_boards`, `get_sprints_from_board`, `get_sprint_issues`, `add_issues_to_sprint`, `move_issues_to_backlog`.
10. **Service desk**: `get_service_desk_for_project`, `get_service_desk_queues`, `get_request_types`, `create_customer_request`.

## Guardrails

- Never manually set integration/system fields: `Rank`, `Development`, `Design`, `Vulnerability`.
- Confirm with user before final create/update/transition/delete.
- `delete_issue`/`move_issue` are destructive — extra confirmation.

## DATA project (team dml)

- Search existing `DATA` tickets before drafting new one; ask one focused question if input unclear.
- **Title**: imperative verb phrase (`[Verb] [object] [qualifier]`).
- **Background**: 1 paragraph, 3–5 sentences, prose. Current state → problem/opportunity → why now.
- **Acceptance criteria**: 1–5 bullets, declarative present tense ("X is Y"), verifiable, MECE.

```text
{{IMPERATIVE_TITLE}}
# Background
{{current state → problem/opportunity → why now}}
# Acceptance Criteria
- {{COMPONENT}} is {{OBSERVABLE_STATE}}
```

Project: DATA (DML Data & Machine Learning). Issue types: Task, Epic, Bug, Subtask.
Status flow: Backlog → Ready for prio → prioritized → In Progress → Done.

Custom fields (DATA-specific — confirm before reuse elsewhere):

| Field ID | Name | Type | Notes |
| `customfield_12670` | Area | multicheckbox | verified: `platform` seen — re-sample before use, unverified full list |
| `customfield_12671` | Task type | multicheckbox | `new-development, maintenance, tech-debt, ad-hoc, onboarding` (lowercase-kebab-case, sampled not guaranteed complete) |
| `customfield_12704` | Business unit | multi-select | Product/Engineering/Data Science/Finance |
| `customfield_12873` | Epic Horizon | single-select | Q1/Q2/H2 2025, Future, On-Demand |
| `customfield_10021` | Flagged | multi-checkbox | blockers/needs-attention |
| `customfield_10019` | Rank | system | lexo-rank, never set manually |
| `customfield_10015` | Start date | date | Epic only |
| `customfield_10017` | Issue color | string | Epic only |
| `customfield_10000`/`10668`/`10749` | Development/Design/Vulnerability | integration | auto-populated, never set manually |

Fetch valid select values via `get_field_options` first (works for some fields — see below for DATA multicheckbox exceptions).

## Custom field values (DATA multicheckbox fields)

`get_field_options` returns `[]` for these. `get_create_fields` needs `issue_type_id`
(not `project_key`+`issue_type`) and returns schema without `allowedValues` anyway.
Enumerate from existing issues instead — single ordering is incomplete, run several:

```
jira_search({ jql: 'project=DATA AND "Task type" is not EMPTY ORDER BY created DESC',
  limit: 20, fields: 'customfield_12671' })
```

Values are lowercase-kebab-case. Treat as sampled, not exhaustive — verify before reuse.

## mcpScript result shape

Result unwraps as `JSON.parse(r.data.content[0].text)`, not `r.data` directly (FastMCP wrapping).
Keep `limit <= 20` — larger results silently omitted by output size guard.

```
create_issue({ project_key: "DATA", issue_type: "Task", summary, description,
  additional_fields: JSON.stringify({ priority: {name:"Medium"}, parent: {key:"DATA-1127"},
    customfield_12670: [{value:"Platform"}], customfield_12671: [{value:"Feature"}] }) })
```
