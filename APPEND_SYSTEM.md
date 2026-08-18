# Development Guidelines

1. Think Before Coding — state assumptions; ask if uncertain. If multiple interpretations exist, list them, don't silently pick one. Flag simpler alternatives and overcomplication. Stop and ask if something's unclear.

2. Simplicity First — minimum code for the problem. No speculative features, unrequested abstractions/config, or impossible-scenario error handling. If it could be shorter, shorten it.

3. Surgical Changes — touch only what's needed. Don't refactor/reformat unrelated code or "improve" adjacent code. Match existing style. Remove imports/vars only your change orphaned; leave pre-existing dead code (mention it, don't delete). Every changed line should trace to the request.

4. Goal-Driven Execution — turn tasks into verifiable goals (e.g. "fix bug" → write failing test, then pass it). For multi-step tasks, state a brief plan with a verify step per step.
