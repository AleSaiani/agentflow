---
name: inspect
description: |
  Read-only inspector over runs of any framework primitive (enumerate / group / iterate / reduce / pipe). Lists runs, shows a single run's status with primitive-specific extras, draws the child tree of a /pipe run, aggregates budget across a run and its children, prints a timeline of events.

  USE this skill whenever the user wants to debug, inspect, audit, or report on the state of any framework run — "show me", "what happened", "how much did X cost", "why did Y fail", "list active runs". `/inspect` never mutates state.

  DO NOT use this for: actually doing work (the other primitives do that), or for inspecting non-framework state (it only knows about `.enumerate/`, `.group/`, `.iterate/`, `.reduce/`, `.pipe/`).

  Explicit user invocation: `/inspect runs` (list all), `/inspect show <run-id>`, `/inspect tree <pipe-run-id>`, `/inspect budget <run-id>`, `/inspect timeline <run-id>`.
allowed-tools: Bash, Read
argument-hint: runs | show <run-id> | tree <run-id> | budget <run-id> | timeline <run-id>
disable-model-invocation: false
---

# /inspect

You are operating the read-only inspector. There is no state to manage and nothing to write. Your job is to dispatch the right subcommand and surface the output to the user.

## Subcommands

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" runs [--cmd enumerate|group|iterate|reduce|pipe] [--json]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" show <run-id> [--cmd <name>] [--pretty]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" tree <run-id> [--cmd <name>] [--max-depth N]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" budget <run-id> [--json]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" timeline <run-id> [--limit N]
```

### `runs`
List every run across every primitive: cmd, run_id, status, is_done, agents, usd, updated_at. Use `--cmd` to filter by primitive. Use `--json` for structured output.

### `show <run-id>`
Auto-detect which primitive owns the run-id and print a JSON summary with primitive-specific extras:
- /enumerate adds items-by-status counts
- /pipe adds the stages list (index/name/type/status/child_cmd/child_run_id)
- /iterate adds iteration_count, max_iterations, stop_reason
- /group adds items_total, groups_count, method

Use `--cmd` to disambiguate when two primitives have a run with the same id.

### `tree <pipe-run-id>`
For a /pipe run, recursively walk the stage tree and show each child run's status, agent count, and USD estimate. Indented ASCII tree. Useful to see at a glance "stage 1 done, stage 2 in_progress, stage 3 pending".

### `budget <run-id>`
Walk the run and (if /pipe) all its children recursively. Sum `tokens_used`, `agents_dispatched`, `usd_estimate` and break down per-node. Answers "how much did this pipeline cost?"

### `timeline <run-id>`
Print created_at / started_at / updated_at / completed_at plus the last N budget events (`--limit`). Useful for "where did the time go?"

## Pattern: triage a failed pipe

1. `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" runs --cmd pipe` — find the failed pipe.
2. `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" tree <pipe-run-id>` — identify which stage failed.
3. `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" show <failed-child-run-id> --cmd <its-primitive>` — get details on the failure.
4. For /enumerate failures: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" list <run-id> --status failed` for per-item errors.

## Pattern: cost audit

`node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" budget <pipe-run-id>` for cumulative tokens/USD across a whole pipeline (including all primitive children).

## Important rules

- **Read-only**: `/inspect` never modifies state. If you need to fix something (reset stuck items, force a transition), use the primitive's own state CLI (`state/enumerate.js reset`, etc.).
- **No auto-continue interaction**: `/inspect` does not appear in the Stop hook's PRIMITIVES registry — it has no runs to resume.
- **Output is for humans first, JSON second**: most subcommands print a readable table or tree. Pass `--json` (or `--pretty` for `show`) when you need structured output for further processing.
