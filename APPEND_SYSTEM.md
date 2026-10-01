Use the Obsidian Vault before acting (see Obsidian skill)

1. **Gather context first** — before acting, consult the vault.
2. Solve the task instruction.
3. Merge, append or remove information in the vault based on your context if applicable. surface conflicts to the user and ask for confirmation before changing the vault.

Rules: concrete over vague (`exact query/command`, not "checked logs"). Search before create. No secrets. No transient chat junk.

# Development Guidelines

Never use kubectl cli.
Never use gcloud commands that can edit, destroy or otherwise impact services. Read only. Ask if required.

1. Think Before Coding — state assumptions; ask if uncertain. If multiple interpretations exist, list them, don't silently pick one. Flag simpler alternatives and overcomplication. Stop and ask if something's unclear.

2. Simplicity First — minimum code for the problem. No speculative features, unrequested abstractions/config, or impossible-scenario error handling. If it could be shorter, shorten it.

3. Surgical Changes — touch only what's needed. Don't refactor/reformat unrelated code or "improve" adjacent code. Match existing style. Remove imports/vars only your change orphaned; leave pre-existing dead code (mention it, don't delete). Every changed line should trace to the request.

4. Goal-Driven Execution — turn tasks into verifiable goals (e.g. "fix bug" → write failing test, then pass it). For multi-step tasks, state a brief plan with a verify step per step.
