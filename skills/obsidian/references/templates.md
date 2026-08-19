# Note Templates

Source: vault `template/` directory. Use these to create new pages after user approval.

## wiki (canonical)

```markdown
---
type: note
title: ""
description: ""              # one line, LLM-searchable summary
tags: [type/note, status/seedling]
timestamp: {{date}}
resource: []                # source-of-truth the agent re-reads to refresh this page (repo, Confluence, table, daily note). NOT operational links — those go in # Links
---

Short plain-language description of the subject and why it matters.
Structure with headings (#/##/###) — not bold or italic. One subject per page.

# Summary

Context and scope. Overview first, detail below.

# Install

(if applicable) Prerequisites and how to install / provision / set up.

```bash
# what this does
example --setup
```

# Auth

(if applicable) How to get access and what controls it — roles, groups, tokens, VPN.

# How-to

(if applicable) Common tasks with a runnable example.

```bash
# what this does
example --run
```

# Links

| What | Link |
| Code | [repo](url) |
| Service | [console / endpoint](url) |
| Docs | [docs](url) |

```

## tool

```markdown
---
type: tool
title: ""
description: ""              # one line, LLM-searchable summary
tags: [type/tool, tool/managed, system/, status/evergreen]
timestamp: {{date}}
resource: []                # source-of-truth the agent re-reads to refresh this page (vendor docs, repo, Confluence). NOT operational links — those go in # Links
---

Short plain-language description of the tool and why we use it.

# Summary

Context and scope. What it does, who uses it.

# Install

(if applicable) Prerequisites and how to install / provision / set up the CLI or access.

# Auth

(if applicable) How to get access and what controls it — roles, groups, tokens, VPN. Include MCP auth/scope here if applicable.

# How-to

(if applicable) Common tasks with a runnable example. Include MCP usage here if applicable.

# Links

| What | Link |
| Console (stage) | [open](url) |
| Console (prod) | [open](url) |
| Docs | [docs](url) |

# Incidents

Known issues + runbooks. Symptom → cause → fix.

# Depends

[[upstream]] · [[downstream]]

# See also

[[related-page]]
```

## service

```markdown
---
type: service                # use type/model for ML models
title: ""
description: ""
tags: [type/service, market/, system/, status/active]
timestamp: {{date}}
owner: dml                   # dml | lendo-se | lendo-no | lendo-pfm
resource: []                # source-of-truth the agent re-reads to refresh this page (repo, Confluence). NOT operational links — those go in # Links
---

Short plain-language description of the service. Models: include the ML#### id.

# Summary

What it does, who consumes it, high-level behaviour.

# Lives & Runs

- Code: repo (where it lives)
- Runs: cluster · namespace · deployment · env (where it runs)
- ML id: ML####            (models only)

# Auth

Endpoints, auth method, how to call/test. Creds pointer (not the secret itself).

# How-to

Deploy, retrain, debug, call the API — common tasks with a runnable example.

# Links

| What | Link |
| Repo | [github](url) |
| Dashboard | [grafana](url) |
| Confluence | [page](url) |

# Incidents

Known issues + runbooks. Symptom → cause → fix.

# Depends / Surfaces

- Depends: [[snowflake]] [[rabbitmq]]
- Surfaces: [[inbox-se]] [[admin-se]]   (where it renders, if applicable)

# See also

[[related-page]]
```

## daily

```markdown
---
tags: [type/daily, status/raw]
---

## Check in

---

## Check out

---

## Log
```

## meeting

```markdown
---
tags:
  - type/meeting
attendees:
date: "{{date}}"
---

# Meeting Notes - {{date}}

## Background

## Notes

## Actions
```
