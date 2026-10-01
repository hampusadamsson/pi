---
name: subagents
description: Rules for spawning subagents via tmux (parallel pi instances or shell jobs). Use whenever launching detached tmux sessions to run work in background — always pair with a watcher loop, never fire-and-forget.
---

# Subagents via tmux

Never spawn detached tmux sessions without watching them. Fire-and-forget risks silent
hangs, stuck sessions, or missed failures.

## Rule

Every subagent spawn MUST be followed by a watcher that polls all jobs until done or
timeout. Never block indefinitely.

## Role gates tool access — pick it deliberately

A subagent's tools are the intersection of two sources, both resolved from the
`--role` flag at spawn time:

- **`roles.json`** (`roles.<name>.tools.allow`) — which tool *families* the role may use.
  Only entries matching `mcp*` unlock any MCP tool at all. The default role (no `--role`
  given) may have an allowlist with **no** `mcp*` entry — then `mcp`, `mcpScript`, and
  every `mcp__<server>` tool are absent, no matter what's in `mcp-adapter.json`.
- **`mcp-adapter.json`** (`mcpServers.*`) — which MCP *servers* are configured/connected
  at all (atlassian, snowflake, humio, mysharedbrain, ...). This only matters if the
  active role's tool allowlist already includes `mcp*`.

Passing `--mcp-config mcp-adapter.json` alone does **not** grant MCP tools — it only
wires up servers *for roles whose allowlist permits `mcp*`*. Confirmed example from this
repo's `roles.json`:

```jsonc
"work":       { "tools": { "allow": ["edit","write","hypa_read", ...] } }   // no mcp*
"researcher": { "tools": { "allow": ["edit","write","hypa_read", ..., "mcp*"] } }
```

A subagent spawned as `pi --mcp-config mcp-adapter.json -p "..."` (no `--role`) runs
under the default role (`work` here) and gets **zero** MCP tools — canary will show only
`edit, write, hypa_shell, hypa_read, hypa_grep, hypa_find, hypa_ls`. The same command
with `--role researcher` added exposes `mcp, mcpScript, mcp__atlassian, mcp__snowflake,
mcp__humio, mcp__mysharedbrain`.

**Rule:** if the subagent's task needs Jira/Confluence/Snowflake/Humio/vault access, the
spawn command MUST include `--role <role-with-mcp*-allow>` in addition to
`--mcp-config <path>`. Verify both are present before the canary run, and confirm the
canary's tool list actually contains the `mcp*` names you expect — don't assume the flag
combination worked.

## Pattern

Always `cd` to a known-good absolute directory inside the spawned command itself —
don't rely on the shell's ambient cwd, it can be invalid (deleted/moved) and crash the
spawned process silently.

Session must self-remove on completion regardless of `remain-on-exit` setting — append
`kill-session` after the signal so nothing lingers. Capture the command's exit status
into the done-file so a crash isn't mistaken for success (a crashed command still
reaches the `tmux wait-for` line, so absence-of-session alone doesn't mean success).

### Keep the pane live — pipe through `tee`, don't redirect it away

`cmd > out.log 2>&1` sends all output straight to the file and leaves the tmux pane
blank. If you (or the user) attach mid-run to see what's happening, there's nothing to
show — same reason `capture-pane` on a timeout comes back empty. Use `tee` instead so
output lands in both places, and capture the real exit code via `PIPESTATUS` (needs
`bash -lc`, not the default `sh`):

```bash
tmux new-session -d -s "job1-$run_id" bash -lc \
  "cd /known/good/dir && cmd1 2>&1 | tee /tmp/job1-$run_id.out; echo \${PIPESTATUS[0]} > /tmp/job1-$run_id.exit; tmux wait-for -S job1-$run_id-done; tmux kill-session -t job1-$run_id"
```

No downside for the watcher loop or log parsing — the file still gets identical content,
free of prompts/ANSI since `pi -p` (print mode) writes plain text/JSON either way.
Attaching (`tmux attach -t job1-$run_id`) now shows live progress; detach with `Ctrl-b d`
without disturbing the job.

### Naming — avoid collisions

Never use plain/predictable names (`job1`, `task-1`, `worker`) — a leftover or
concurrent run can collide with an existing session and hijack/kill the wrong one.
Suffix every session and signal name with something unique per run: PID + random, or
timestamp + random.

```bash
run_id="$$-$RANDOM"   # pid-random, unique per invocation
cd /known/good/dir     # absolute, verified to exist

# spawn, each signals done then kills its own session; exit status recorded; pane stays live
tmux new-session -d -s "job1-$run_id" bash -lc \
  "cd /known/good/dir && cmd1 2>&1 | tee /tmp/job1-$run_id.out; echo \${PIPESTATUS[0]} > /tmp/job1-$run_id.exit; tmux wait-for -S job1-$run_id-done; tmux kill-session -t job1-$run_id"
```

Repeat per job with unique names, all under the same `run_id`.

## Watch loop (poll + timeout)

- Poll interval: short, **2s** default.
- Timeout: **no default** — set per task, based on expected work duration:
  - quick check ≈ 30s
  - light single-tool-call subagent (e.g. read one note + summarize) ≈ 60s
  - build/test ≈ 120s
  - heavy research/codegen ≈ 600s+
  Ask if duration unclear rather than guessing.

```bash
elapsed=0
poll=2
timeout=<set based on task>   # e.g. 120
jobs="job1-$run_id job2-$run_id job3-$run_id"

while [ $elapsed -lt $timeout ]; do
  done=1
  for s in $jobs; do
    tmux has-session -t "$s" 2>/dev/null && done=0
  done
  [ $done -eq 1 ] && break
  sleep $poll
  elapsed=$((elapsed + poll))
done

if [ $done -eq 0 ]; then
  echo "TIMEOUT — jobs still running, inspecting:"
  for s in $jobs; do
    tmux has-session -t "$s" 2>/dev/null && tmux capture-pane -t "$s" -p -S -50
  done
fi
```

`has-session` exit 0 = still alive. Loop exits early once all sessions gone (tmux
auto-removes session when its command exits).

## After the loop — validate output, don't just trust "gone"

Session gone means the command finished, not that it succeeded. For each job:

1. Check the `.exit` file — non-zero means failure, inspect `.out` before reusing results.
2. Check `.out` isn't empty and doesn't contain a crash signature (stack trace, `ENOENT`,
   "Unknown option", etc).
3. Only treat output as usable once both checks pass.

## On timeout — jump in, don't block forever

- Peek without disrupting: `tmux capture-pane -t <session> -p -S -50`
- Only attach interactively if a human is present to detach after: `tmux attach -t <session>`
  (detach: `Ctrl-b d`)
- Decide: extend timeout once, kill stuck session (`tmux kill-session -t <session>`), or
  report failure — don't loop silently forever.

## Checklist

1. Spawn all subagent sessions detached, each self-kills on completion (signal +
   `kill-session`), each recording its exit status to a file.
2. Set timeout from expected task duration — never leave at an arbitrary default.
3. Immediately start watcher loop — poll interval + task-based timeout, no exceptions.
4. On completion: check exit status + output sanity per job before trusting results;
   confirm no sessions remain (`tmux ls` should not list them).
5. On timeout: capture-pane on stragglers, decide extend/kill/report — always
   `tmux kill-session` any straggler before finishing, no leftover sessions ever.
6. Never leave a spawn un-watched, even for "quick" jobs.

If expected task duration isn't clear enough to set a timeout, ask before spawning
rather than guessing.
