---
name: ml-model-docs-sync
description: Audit dml ML models across internal Obsidian wiki, Confluence ML space, ml-core code, and argocd-config deployments; find discrepancies; propose per-model doc fixes. Use when asked to reconcile/sync model documentation with source of truth.
---

# ML Model Docs Sync

Cross-check model docs (wiki + Confluence) against code (source of truth for behavior)
and deployment config (source of truth for infra/env). Propose corrections, don't
auto-write.

## Sources of truth (priority order)

1. Code: `lendo-data-ml/ml-core` `packages/dml-*` (github skill). Model list = actual
   model/service packages only — don't hardcode names; exclude shared-lib/infra
   packages by inspection (e.g. `dml-base`, `dml-dal`, `dml-logger`, `dml-serving`,
   `dml-http-client`, `dml-graphql-client`, `dml-cli`, `dml-ci`, `dml-service-adapters`,
   `dml-model-registry-v1`, `dml-mlflow` — these support models, aren't models).
2. Deployment: `lendo-data-ml/argocd-config` (github skill). Outliers: some models
   deploy via `lendo-se/argocd-config` or `lendo-sre/argocd-config-lendo-norway` — check
   both if a model isn't found in lendo-data-ml, or if it's NO/SE market-specific and
   docs mention a separate adapter/cluster. Also check adapter repos (e.g.
   `lendo-se/prediction-model-adapters`) when docs reference a fronting adapter.
3. Confluence ML space (secondary doc, may lag):
   https://schibstedio.atlassian.net/wiki/spaces/LDML/folder/2475622432/ML+models
4. Obsidian wiki (secondary doc, may lag): `1-wiki/` vault, `services/` map (owner: dml)

## Workflow (per model)

1. **List models**: enumerate `packages/dml-*` in ml-core (github skill), then filter
   to actual models/services by reading each package (shared libs vs. deployable
   model/service — check for `serve.py`/API entrypoint or a training/scoring job).
2. **Wiki context**: obsidian skill — find model's page under `1-wiki/services/`
   (grep by package/model name). Read `resource:`, owner, description, links.
3. **Confluence context**: confluence skill — list all children of the ML models
   folder (`atlassian_confluence_search` with `query: 'ancestor=2475622432'`, since
   `get_page_children` 404s on this folder), then match the model's page by title.
   Read full page (`get_page` with `page_id`, `convert_to_markdown: true`).
4. **Code check**: github skill, ml-core — confirm package exists, read README +
   actual source tree (routers, entrypoints, referenced modules like `train.py`).
   Verify docs' claims (e.g. "no retraining") against what's actually in the tree.
5. **Deployment check**: github skill, argocd-config (lendo-data-ml primary; lendo-se /
   lendo-sre argocd-config-lendo-norway for outliers) — confirm envs, resource config,
   image, cronjobs/retrain jobs, envoy routes/auth, and that referenced entrypoints
   (e.g. `-m dml.<pkg>.train`) actually exist in code. Check adapter repos if docs
   mention one.
6. **Diff**: list concrete discrepancies (wrong owner, stale env, dead link, missing
   model, wrong package path, outdated description, mismatched deployment name/market,
   deployment referencing a nonexistent code module, doc claim contradicted by infra).
7. **Cross-direction check**: flag models present in wiki/Confluence but not in
   current ml-core packages (deprecated/renamed/removed), and models present in code
   but missing from wiki and/or Confluence entirely.
8. **Propose**: short recommendation per model — what to change in wiki, what to
   change in Confluence, cite source (code path / argocd path) backing the correction.
   No edits without explicit confirm (both obsidian and confluence skills are
   read-then-confirm). If a discrepancy implies a real infra bug (e.g. broken cronjob),
   flag it as an infra issue for the team, not just a doc fix.

## Output format (per model)

```
### <model name>
- Code: <ml-core path> — <one-line status>
- Deployment: <argocd repo/path> — <one-line status>
- Wiki: <page> — discrepancies: ...
- Confluence: <page> — discrepancies: ...
- Recommendation: <short, actionable>
```

Plus a final section listing any models found only in docs (not in code) or only in
code (not in docs).

## Rules

- Read-only pass first across all 4 sources; do not edit anything until the full
  discrepancy list is reviewed by the user.
- Don't hardcode the model list — derive it from ml-core each run (packages get
  added/renamed/split).
- If a model isn't in ml-core packages, flag as "not in code source of truth" rather
  than guessing.
- If a model's argocd config isn't in lendo-data-ml/argocd-config, check lendo-se and
  lendo-sre orgs before declaring missing.
- Batch by model, not by source, in the final report.
