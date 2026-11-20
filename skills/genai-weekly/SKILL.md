---
name: genai-weekly
description: Generate a weekly summary of Gen AI team work over the last 7 days from Jira (LGAI board 749), Confluence (space LGA), and GitHub (lendo-genai). Use when asked for the Gen AI weekly summary/report.
---

# Gen AI Weekly Summary

Gather Jira, Confluence and GitHub in parallel using the `retriever` role (read-only, has codemode for board tools), then merge. Run the publish step (step 4) in the `researcher` role, which has Confluence create/update tools.

Your task is to summarize the work performed over the last 7 days by the team working on Gen AI initiatives.

Follow these data-gathering steps in order using your available integrations:

1. **Jira (Board: LGAI - 749)**
   - Verify the board contains Gen AI content via JQL `project = LGAI AND updated >= -7d ORDER BY updated DESC`; use board 749 tools only if available.
   - Fetch the changelog only for tickets updated in the window and report status transitions (e.g. 'To Do → In Progress').
   - Identify all ticket progression and updates made over the past 7 days.
   - Briefly summarize the progress in simple, non-technical terms.

2. **Confluence (Space: LGA, homepageId=223576230)**
   - Verify the space contains Gen AI content.
   - Page through results until exhausted (start=0, 50, …).
   - Also fetch homepage 223576230 and its children, and check version.when.
   - For updated pages, compare the last two versions if possible; otherwise say 'content-based summary'.
   - Identify all new pages, updates, or content added over the past 7 days.
   - Briefly summarize the updates in simple terms.

3. **GitHub (Repository/Org: "lendo-genai")**
   - Load the github skill first.
   - Run `export GH_HOST=lendo-group.ghe.com` before any `gh` command.
   - List repos with `gh api --paginate orgs/lendo-genai/repos --jq '.[].name'` (not `gh repo list`).
   - For each project/repository inside "lendo-genai", gather commits from the past 7 days via `gh api repos/lendo-genai/{repo}/commits?since={ISO date}`.
   - Get merged PRs via `gh pr list --state merged --search 'merged:>={date}'`.
   - Repos created in the window with only initial/scaffold commits: scaffold-only new repos get no own row; write 'New repos x, y, z were created, no features yet.' inside the `Platform operations setup` row. Never ask for clarification on relevance; apply this rule.
   - Summarize the progression briefly in simple words.
   - *Constraint:* Focus only on larger impact and user-facing changes. Ignore minor chores, typo fixes, and overly technical refactoring.

4. **Publish to Confluence** (runs last, after the summary has been generated)
   - Target: folder https://lendo-group.atlassian.net/wiki/spaces/LGA/folder/286687286 (space LGA, parent folder id 286687286). Do not guess any other page IDs.
   - The page title must equal the document title: `{YYYY-MM-DD} Gen AI Weekly Summary`. The published body starts at `## Brief` (no H1; the page title is the title). Do not put 'Data limits' in the body.
   - Search the folder's children (use CQL `ancestor = 286687286` first; `confluence_get_page_children` returns 404 on folder IDs) for a page with that exact title.
   - If it exists, merge: update the page, keep existing content, add only new rows/info, no duplicate rows.
   - If not, create it as a child of the folder with the summary as body.
   - Return the page URL.

## Output Formatting

Synthesize the gathered information into a weekly summary using the exact template below. Replace the bracketed placeholders with the generated content. Calculate the current date in YYYY-MM-DD format and the current ISO week number.

The page title is `{YYYY-MM-DD} Gen AI Weekly Summary`. The body has no H1 and starts at `## Brief`. Sections: `## Brief`, `## Week {ISO week}`. 'Data limits' is NOT part of the page body; give it in the chat reply only.

```markdown
## Brief
{2-3 sentences covering overall progress across Jira and Confluence.}

## Week {ISO week}
| Initiative / Project | Impact & Details |
| :--- | :--- |
| {Row name} | {1-3 plain sentences, Jira keys in parentheses at end of sentence} |
```

**Rows.** Use these fixed row names, in this order; omit a row only if there was no activity:
1. `AI gateway selection`
2. `Gateway hosting and infrastructure`
3. `Platform operations setup`
4. `Access and data protection`
5. `Platform planning docs (Confluence)`
6. `{Topic} evaluation` (for a new Confluence evaluation page, e.g. `Claude Enterprise evaluation`)
7. `Rollout and stakeholders`

Evaluation rows (6) go after `Platform planning docs (Confluence)` and before `Rollout and stakeholders`. Extra topics become new rows at the end. Keep this order in the table.

**Details style.** 1-3 plain sentences per row. Put Jira keys in parentheses at the end of the sentence, e.g. `(LGAI-10, 11, 16–20)`. Mention open or blocked items briefly (e.g. waiting on LSRE-xxxx). The Brief is 2-3 sentences covering Jira and Confluence.

**Worked example:**

```markdown
## Brief
The team picked the AI gateway and finished its comparison tests. It then moved to building the platform base: network access, a test deployment, and early monitoring and logging. The Confluence pages for the platform's goals and decisions were updated, and a Claude Enterprise evaluation was added. Work on business users and legal, security and HR input has started.

## Week 46
| Initiative / Project | Impact & Details |
| :--- | :--- |
| AI gateway selection | The team finished the Bifrost, Helicone, Vercel, Obot and MLflow comparison tests, and the technical decisions and API proxy demo are done (LGAI-10, 11, 16–20). The selection epic (LGAI-12) is still in progress. |
| Gateway hosting and infrastructure | Hosting work started (LGAI-21), and the team picked up three tasks: hosting design, secure cloud access (WIF), and Terraform automation (LGAI-22, 34, 30). Network access over VPN is done (LGAI-32). A hello-world test deployment in dev is done (LGAI-40, 41). |
| Platform operations setup | Work began on ArgoCD, secrets management (SOPS), DNS and TLS, alerting, Prometheus and Grafana, and log storage (LGAI-31, 35, 33, 42, 37, 36). Some of it is waiting on the SRE team (LSRE-2103). New repos argocd-config, application-infrastructure and ai-cli were created, no features yet. GitHub repo setup is in review (LGAI-29). |
| Access and data protection | Work started on how personal data (GDPR) is handled by the AI proxy (LGAI-44). The access management epic and the login-options spike are still in the backlog (LGAI-38, 45). |
| Platform planning docs (Confluence) | The v0 and v1 drafts, business requirements, product description, decisions log and engineering vision were updated. This sets what the platform should offer all of Lendo Sweden. |
| Claude Enterprise evaluation | A new Confluence page assesses Claude Enterprise as an option for Gen AI access at Lendo. |
| Rollout and stakeholders | Work started on business user involvement, an all-hands session, and the legal/security/HR material (LGAI-47, 51, 46). Cost tickets for the platform and tokens are still in the backlog (LGAI-49, 50). |
```

Output the result as a markdown document.

## Data limits

List anything you could not check (e.g. board tools unavailable, search caps, no version diffs). Also note if the publish step failed or the folder could not be accessed.
