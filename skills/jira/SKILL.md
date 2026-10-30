---
name: jira
description: Use Jira via the Atlassian MCP server (search, read, create, update, transition issues, sprints, worklogs). Use whenever a task involves looking up, filing, or modifying Jira tickets.
---

# Jira (Atlassian MCP)

MCP only, never REST/CLI.

## Invocation

- Directly exposed tools (per `mcp.json`): `jira_search`, `jira_get_issue`, `jira_create_issue`, `jira_update_issue` — call as `mcp__atlassian__<tool>`.
- Every other Jira tool goes through the `mcp` proxy as `atlassian_<tool>`:

```
mcp({ tool: "atlassian_jira_get_project_issue_types", args: { project_key: "DATA" } })
```

Tool names below are written without prefix. Result text is JSON in `content[0].text`. Keep `limit <= 20` — larger results are silently omitted by the output size guard.

## Generic usage

1. **Dedupe first**: `jira_search({ jql, limit, fields })`.
2. **Read**: `jira_get_issue({ issue_key, fields: "*all", include: "transitions,comments" })`.
3. **Discover schema before creating**: `jira_get_project_issue_types` (get `issue_type_id`), `jira_get_create_fields({ issue_type_id })` (schema only, no `allowedValues`; takes `issue_type_id`, not `project_key`+`issue_type`), `jira_search_fields` (fuzzy field-ID lookup), `jira_get_field_options` (returns `[]` for DATA multicheckbox fields — unreliable).
4. **Create**: `jira_create_issue` / `jira_batch_create_issues`. Custom fields via `additional_fields` JSON string.
5. **Update**: `jira_update_issue({ issue_key, fields: JSON })`.
6. **Transition**: check transitions (`jira_get_issue` w/ `include: "transitions"`) then `jira_transition_issue`.
7. **Links/hierarchy**: `jira_create_issue_link`, `jira_link_to_epic`, `jira_get_project_epic_hierarchy`.
8. **People**: `jira_search_assignable_users` → accountId for `assignee`.
9. **Sprints/boards**: `jira_get_agile_boards`, `jira_get_sprints_from_board`, `jira_get_sprint_issues`, `jira_add_issues_to_sprint`.

### Known failures

- `jira_create_issue` with `customfield_10014` (epic link) fails ("cannot be set. It is not on the appropriate screen, or unknown") — seen 12+ times. No working approach found in sessions: check createmeta (`jira_get_create_fields`) first; for epics try `parent: {key}` in `additional_fields` or `jira_link_to_epic` after creation (untested).
- Subtasks: `issue_type` must be `"Subtask"` (not `"Sub-task"`) and `parent` goes in `additional_fields`. Verify with createmeta if it still errors.

### Guardrails

- Never set `Rank`, `Development`, `Design`, `Vulnerability` fields.
- Always confirm with the user before create/update/transition/delete. `jira_delete_issue`/`jira_move_issue` are destructive — extra confirmation.

## Ticket format (user preferences)

- **Background** + **Acceptance criteria**. Criteria are declarative state-after-implementation ("X is Y"), not tasks.
- When asked for plain text: no markdown/formatting.
- When asked to "echo the ticket only": output just the ticket, no commentary, and don't create it.
- Show the draft and get confirmation before writing to Jira.

## DATA project conventions (team dml)

- Search existing `DATA` tickets before drafting; ask one focused question if input unclear.
- **Title**: imperative verb phrase (`[Verb] [object] [qualifier]`).
- **Background**: 1 paragraph, 3–5 sentences, prose. Current state → problem/opportunity → why now.
- **Acceptance criteria**: 1–5 bullets, declarative present tense, verifiable, MECE.

```text
{{IMPERATIVE_TITLE}}
# Background
{{current state → problem/opportunity → why now}}
# Acceptance Criteria
- {{COMPONENT}} is {{OBSERVABLE_STATE}}
```

Project: DATA (DML Data & Machine Learning), project id 10320. Issue types: Task, Epic, Bug, Subtask (Task id seen: 12197).
Status flow: Backlog → Ready for prio → prioritized → In Progress → Done.
Board: <https://lendo-group.atlassian.net/jira/software/projects/DATA/boards/347>.

### Custom fields

**UNVERIFIED since Sep 2026 migration — IDs changed in the migration; fetch via `jira_search_fields` / `jira_get_create_fields` before use.** (Not re-verified: no read access available when editing.)

| Field ID | Name | Type | Notes |
| --- | --- | --- | --- |
| `customfield_11271` | Area | multicheckbox | `Platform`, `DS`, `AE` (sampled) |
| `customfield_11274` | Task type | multicheckbox | `new-development`, `maintenance`, `tech-debt` (lowercase-kebab; `ad-hoc`, `onboarding` unverified) |
| `customfield_11272` | Business unit | multicheckbox | `Sweden, Norway, Denmark, Internal` (sampled) |
| `customfield_11273` | Epic Horizon | single-select | `Now`, `Next ` (trailing space!) — sampled |
| `customfield_10021` | Flagged | multi-checkbox | blockers |
| `customfield_10019` | Rank | system | never set |
| `customfield_10015` | Start date | date | Epic only |
| `customfield_10013` | Epic Color | string | Epic only |
| `customfield_10000`/`10668`/`10749` | Development/Design/Vulnerability | integration | never set |

`jira_get_field_options` returns `[]` for the multicheckbox fields. Enumerate values from existing issues (run several orderings; sampled, not exhaustive):

```
jira_search({ jql: 'project=DATA AND "Task type" is not EMPTY ORDER BY created DESC',
  limit: 20, fields: 'customfield_11274' })
```

Task type is lowercase-kebab-case; Area/Business unit/Epic Horizon are Capitalised. Subtasks usually have none set.

Create example:

```
jira_create_issue({ project_key: "DATA", issue_type: "Task", summary, description,
  additional_fields: JSON.stringify({ priority: {name:"Medium"}, parent: {key:"DATA-1127"},
    customfield_11271: [{value:"Platform"}], customfield_11274: [{value:"new-development"}] }) })
```

API tokens: <https://id.atlassian.com/manage-profile/security/api-tokens>
