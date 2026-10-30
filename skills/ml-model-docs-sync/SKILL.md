---
name: ml-model-docs-sync
description: Audit dml ML models across internal Obsidian wiki, Confluence ML space, ml-core code, and argocd-config deployments; find discrepancies; propose per-model doc fixes. Use when asked to reconcile/sync model documentation with source of truth.
---

# ML Model Docs Sync

Cross-check model docs (wiki + Confluence) against code (source of truth for behavior)
and deployment config (source of truth for infra/env). Propose corrections, don't
auto-write.

## Sources of truth

Precedence: see `dml-service-documentation` (code/deployment > Obsidian wiki > Confluence).
Confluence IDs/gotchas: `confluence` skill. Hosts/orgs/repos: `github` skill.

1. Code: `lendo-data-ml/ml-core` `packages/dml-*`. Model list = actual model/service
   packages only — don't hardcode names; exclude shared-lib/infra packages by
   inspection (e.g. `dml-base`, `dml-dal`, `dml-logger`, `dml-serving`,
   `dml-http-client`, `dml-graphql-client`, `dml-cli`, `dml-ci`, `dml-service-adapters`,
   `dml-model-registry-v1`, `dml-mlflow` — these support models, aren't models).
2. Deployment: `lendo-data-ml/argocd-config`. Outliers: `lendo-se/argocd-config`,
   `lendo-sre/argocd-config-lendo-norway` — check if a model isn't in lendo-data-ml or
   is NO/SE-specific. Also check adapter repos (e.g. `lendo-se/prediction-model-adapters`)
   when docs reference a fronting adapter.
3. Obsidian wiki (may lag): `1-wiki/services/` (owner: dml).
4. Confluence ML models folder (published mirror, may lag): see `confluence` skill.

## Workflow (per model)

1. **List models**: enumerate `packages/dml-*` in ml-core (github skill), then filter
   to actual models/services by reading each package (shared libs vs. deployable
   model/service — check for `serve.py`/API entrypoint or a training/scoring job).
2. **Wiki context**: obsidian skill — find model's page under `1-wiki/services/`
   (grep by package/model name). Read `resource:`, owner, description, links.
3. **Confluence context**: `confluence` skill — list the ML models folder's pages
   (see skill for the `get_page_children` workaround), match the model's page by title,
   read the full page.
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
   No edits without explicit confirm (approval gate: `obsidian` skill). If a discrepancy implies a real infra bug (e.g. broken cronjob),
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
