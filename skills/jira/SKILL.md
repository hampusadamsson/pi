---
name: jira
description: Jira via the Atlassian MCP (search, read, create, update, transition, sprints). Load for any ticket work - drafting, proposing or echoing a ticket, 'create a ticket', 'write a ticket', epics, task type/area/horizon, DATA project conventions - and before any Jira write. No slash command needed.
---

# Jira (Atlassian MCP)

MCP only, never REST/CLI.

## When to use

- Always load this skill before any ticket draft or Jira write, even if the user only says "create a ticket" or "ticket for X". No slash command is needed.
- Follow "Ticket format" and "DATA project conventions" below.
- Map user phrases to custom fields (see Custom fields table):
  - "platform" → Area `["Platform"]`
  - "feature" → Task type `["new-development"]`
  - "epic horizon now" → Epic Horizon `"Now"`
- Draft first, confirm before create.
- If the user says "read ticket skill and re-propose", redo the draft from this skill.

## Invocation

- Directly exposed tools (per `mcp.json`): `jira_search`, `jira_get_issue`, `jira_create_issue`, `jira_update_issue`, `jira_add_comment` — call as `mcp__atlassian__<tool>`.
- Every other Jira tool goes through the `mcp` proxy as `atlassian_<tool>`. Roles without the `mcp` tool (e.g. `researcher`) cannot call them:

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

- `customfield_10014` (epic link) fails ("not on the appropriate screen"). Don't use it.
- **Parent/epic link: pass `parent` as a plain string in `additional_fields`: `{"parent": "DATA-1816"}`.** The object form `{"parent": {"key": "..."}}` fails with `expected 'key' property to be a string`. The string form worked for Tasks under an Epic.
- Subtasks: `issue_type` must be `"Subtask"` (not `"Sub-task"`), and `parent` goes in `additional_fields` as a plain string. The type name `Subtask` is confirmed on existing issues; the create call itself is untested.

### Notes

- Schema lookup tools (`jira_get_project_issue_types`, `jira_get_create_fields`, `jira_search_fields`) may be unavailable in some roles (e.g. `researcher` only has search, get, create, update, comments). Fallback: read a sample issue of the same type with `jira_get_issue` (`fields: "*all"`, once with display names and once without) to get real field IDs and value shapes.

### Observed behaviour

- `jira_search` text queries (`text ~ ...`) are loose and `total` can be -1, so dedupe may be incomplete.
- New tickets default to Medium priority, status Backlog, no assignee.
- Parallel creates interleave key numbers (not duplicates).
- `# Background` / `# Acceptance Criteria` markdown headings work; Jira adds blank lines around them.

### Guardrails

- Never set `Rank`, `Development`, `Design`, `Vulnerability` fields.
- Always confirm with the user before create/update/transition/delete. `jira_delete_issue`/`jira_move_issue` are destructive — extra confirmation.

## Ticket format (user preferences)

- Use simple words. Be brief and to the point.
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

Project: DATA (DML Data & Machine Learning Team). Issue types: Task (id 10478), Epic (10476), Bug, Subtask.
Statuses seen: Backlog, Ready for prio, prioritized, In Progress, in review, Done, Closed, blocked, wont fix (names as shown). Not strictly linear: check transitions per issue.
Board: <https://lendo-group.atlassian.net/jira/software/projects/DATA/boards/347>.

### Custom fields

Verified by reading back issues: Area, Business unit, Epic Horizon, Task type, Rank, Start date. Flagged, Issue color and the integration fields are unverified.

| Field ID | Name | Type | Notes |
| --- | --- | --- | --- |
| `customfield_11271` | Area | multicheckbox | `Platform`, `DS`, `DE`, `AE` (sampled) |
| `customfield_11274` | Task type | multicheckbox | `new-development`, `maintenance`, `tech-debt`, `ad-hoc` (lowercase-kebab; `onboarding` unverified) |
| `customfield_11272` | Business unit | multicheckbox | `Sweden`, `Norway`, `Global`, `Internal` (sampled) |
| `customfield_11273` | Epic Horizon | single-select | `Now`, `Next` (trailing space!) — sampled |
| `customfield_10021` | Flagged | multi-checkbox | blockers |
| `customfield_10019` | Rank | system | never set |
| `customfield_10015` | Start date | date | Epic only |
| `customfield_10017` | Issue color | string | Epic only, unverified |
| `customfield_10000`/`10668`/`10749` | Development/Design/Vulnerability | integration | never set |

`jira_get_field_options` returns `[]` for the multicheckbox fields. Enumerate values from existing issues (run several orderings; sampled, not exhaustive):

```
jira_search({ jql: 'project=DATA AND "Task type" is not EMPTY ORDER BY created DESC',
  limit: 20, fields: 'customfield_11274' })
```

Task type is lowercase-kebab-case; Area/Business unit/Epic Horizon are Capitalised. Subtasks usually have none set.

Value shapes: Area, Business unit and Task type are arrays of plain strings, e.g. `["Platform"]`. Epic Horizon is a plain string, e.g. `"Now"` (no trailing space; `"Next "` has one). `tech-debt` and `Now` were accepted on create.

Create example:

```
jira_create_issue({ project_key: "DATA", issue_type: "Task", summary, description,
  additional_fields: JSON.stringify({ priority: {name:"Medium"}, parent: "<OPEN_EPIC_KEY>",
    customfield_11271: ["Platform"], customfield_11274: ["new-development"] }) })
```
