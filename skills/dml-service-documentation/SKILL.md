---
name: dml-service-documentation
description: DML Service documentation. Document sync across internal Obsidian wiki, Confluence, Code, and deployment; find discrepancies; propose doc fixes. Use when asked to reconcile/sync service documentation.
---

This skill ensures service documentation is kept in sync.

## Inputs

- `{service}`: a deployable or otherwise usable service provided by DML.
- `{time}`: how far back to consider code changes. Examples: `14d`, `2026-01-01`. Default: `14d`. If the user gives none, use the default and state it.

## Precedence (when sources conflict)

code > deployment config > wiki > Confluence.

Prose-only content (ownership, intent, SLAs, runbooks, context) cannot be verified by code. Do not delete or rewrite it because the code is silent. Flag it as "unverifiable" instead.

## Safety rules

- Never include secrets, credentials, tokens, or anything sensitive in the documentation. This covers internal hostnames, account IDs, and private URLs. Use placeholders or omit them.
- Do not document env vars, secrets, config parameters, or their values or names (including SSM/Secrets Manager/parameter store keys, feature flags, and tuning settings). Omit them from the body and changelog. If found in existing docs, flag for removal in the report. Describe behavior instead, not the setting.
- Do not write to the wiki or Confluence before the approval gate in Step 4.

## Step 1: Retrieve data

1. Wiki docs for {service}: check `1-wiki/services/` in the vault first (use wiki/obsidian/vault skill).
2. Confluence docs for {service}: list pages under `spaces/LDML/folder/93094127` in Confluence and find the {service} page (use Confluence/Atlassian skill).
3. Code for {service}: use gh skill, default branch unless the deployment config shows another. Consult the wiki if the repo is uncertain.
4. Deployment config for {service}: use gh skill. Consult the wiki if the repo is uncertain.

5. Follow links and uses:
   - Follow links in wiki and Confluence docs (wikilinks, linked Confluence pages, repo, dashboard, runbook, and ADR links). Read linked docs that describe {service}. Flag broken, stale, or missing links.
   - Follow uses in both directions. Upstream: what {service} depends on (services, APIs, queues, databases, libraries). Downstream: what consumes {service}. Check code and deployment config for these (clients, endpoints, manifests, and a code search of other repos for references to {service}).
   - Check that the docs list those dependencies and consumers, and that each links to the other service's doc. Flag any that are missing or wrong.
   - Stay one hop deep. Do not rewrite other services' docs. Note discrepancies in the report instead.

Expect the docs to exist. If a doc is missing, say so in the report. Do not create a page unless the user approves. Do not invent content. If the repo is still uncertain, ask the user.

## Step 2: Compare sources

1. Compare wiki against Confluence. Identify discrepancies and missing information.
2. Compare both against code and deployment config, using the precedence above.
3. Verify links and dependency/consumer lists from Step 1.5 against code and deployment config. Fix them in the docs by the same precedence.
4. For un-synced state: prepare changes to wiki and Confluence based on the precedence. Wiki and Confluence need not be identical, but must be in sync (factually consistent).
5. Ensure both docs follow the template (`/template/service` in the wiki). Deviate only when necessary, and note why.

## Step 3: Consider latest changes

1. Consider commits/PRs going back {time}.
2. Go through each in detail so the docs body reflects the latest changes. Body docs may cover any factual change (API, infra, behavior, dependencies; never env vars, secrets, or params).
3. Changelog is stricter. Keep it sparse. Add only business-impacting, larger changes (for example new/removed capability, breaking API change, major infra or dependency migration, notable behavior change for users or consumers). Skip bot bumps, refactors, retraining/routine model refreshes, minor fixes, config/env/param changes, and anything with no business impact. When unsure, leave it out.
4. Group changelog entries by date: one row/heading per date, with brief bullets for that date's changes. Do not add many rows per date or one row per commit/PR. Use merge/PR date, or the release date if one exists.
5. Read the existing changelog in each doc before adding. If an item is already present, take no action. Otherwise add to the existing date's entry, or create a new date entry if none exists.
6. Changelog section is defined in the template. Each doc (wiki and Confluence) has its own, and both must be updated.

## Step 4: Report, approve, edit

1. Present a summary of the proposed edits per doc (wiki, Confluence). Include discrepancies found, broken or missing links, dependency/consumer gaps, unverifiable prose, and the changelog entries (grouped by date, business-impacting only).
2. End the proposal with an explicit confirmation question, for example: "Apply these edits to wiki and Confluence? (yes / no / changes)". Then stop and wait for the answer.
3. Treat only a clear "yes" as approval. Silence, ambiguity, or partial feedback is not approval. If the user requests changes, revise the proposal and ask again. If no, make no edits.
4. After approval, edit the documents (wiki and Confluence). Edit only what was approved.
5. Re-read both after editing to confirm they are in sync.
