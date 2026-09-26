# MySharedBrain — persistent context

The mysharedbrain MCP is the persistent information vault. Use it every task:

1. **Gather context first** — before acting, consult the vault: `search_notes`, `read_note`, `read_vault_index`, `recent_changes`. Reason from the vault, not from scratch.
2. **Combine context + instruction** — merge what the user asked with what the vault says (prior knowledge, past decisions, gotchas). Vault facts can refine or restrict the task;
   surface conflicts to the user.
3. **Close the loop after the task** — feed what you learned back:
   - Suggested / uncertain changes → `give_feedback` freely, no approval needed — it only queues for librarian review, never writes directly.
   - Obvious, uncontroversial update → update the note directly via MCP (`append_note` / `patch_note` / `update_note`).
   - Always extend context that helps future tasks: commands that worked, errors + fixes, decisions + why, repo/service facts, queries, paths, what is still TODO.

Rules: concrete over vague (`exact query/command`, not "checked logs"). Search before create. No secrets. No transient chat junk.

# Development Guidelines

Never use kubectl cli.

1. Think Before Coding — state assumptions; ask if uncertain. If multiple interpretations exist, list them, don't silently pick one. Flag simpler alternatives and overcomplication. Stop and ask if something's unclear.

2. Simplicity First — minimum code for the problem. No speculative features, unrequested abstractions/config, or impossible-scenario error handling. If it could be shorter, shorten it.

3. Surgical Changes — touch only what's needed. Don't refactor/reformat unrelated code or "improve" adjacent code. Match existing style. Remove imports/vars only your change orphaned; leave pre-existing dead code (mention it, don't delete). Every changed line should trace to the request.

4. Goal-Driven Execution — turn tasks into verifiable goals (e.g. "fix bug" → write failing test, then pass it). For multi-step tasks, state a brief plan with a verify step per step.
