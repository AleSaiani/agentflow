---
name: inspect
description: |
  Read-only inspector over runs of any primitive (enumerate / foreach / group / reduce / iterate /
  pipe). Lists runs, shows a run's status, draws a /agentflow:pipe child tree, aggregates budget across a
  run and its children, prints a timeline. Never mutates state.

  USE whenever the user wants to debug, inspect, or report on a run — "show me", "what happened", "how
  much did X cost", "why did Y fail", "list active runs".

  DON'T use to do work (the other skills do that) or for non-Agent Flow state (it only knows `.agentflow/enumerate/`,
  `.agentflow/foreach/`, `.agentflow/group/`, `.agentflow/iterate/`, `.agentflow/reduce/`, `.agentflow/pipe/`).
  Also turns a finished run's outputs into reusable data WITHOUT re-running it ("turn that review into a
  checklist", "give me all results as JSON"): `results <id> --json | --checklist`.
  Explicit: `/agentflow:inspect runs | show <id> | results <id> | tree <id> | budget <id> | timeline <id>`.
allowed-tools: Bash, Read
argument-hint: runs | show <run-id> | results <run-id> [--checklist|--json] | tree <run-id> | budget <run-id> | timeline <run-id>
disable-model-invocation: false
---

# /agentflow:inspect

You are operating the read-only inspector. There is no state to manage and nothing to write. Your job is to dispatch the right subcommand and surface the output to the user.

## Subcommands

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" runs [--cmd foreach|group|iterate|reduce|pipe] [--json]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" show <run-id> [--cmd <name>] [--pretty]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" results <run-id> [--cmd <name>] [--json | --checklist] [--field a.b] [--status <s>] [--limit N]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" tree <run-id> [--cmd <name>] [--max-depth N]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" budget <run-id> [--json]
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" timeline <run-id> [--limit N]
```

### `runs`
List every run across every primitive: cmd, run_id, status, is_done, agents, usd, updated_at. Use `--cmd` to filter by primitive. Use `--json` for structured output.

### `show <run-id>`
Auto-detect which primitive owns the run-id and print a JSON summary with primitive-specific extras:
- /agentflow:foreach adds items-by-status counts
- /agentflow:pipe adds the stages list (index/name/type/status/child_cmd/child_run_id)
- iterate (loop) runs add iteration_count, max_iterations, stop_reason
- /agentflow:group adds items_total, groups_count, method

Use `--cmd` to disambiguate when two primitives have a run with the same id.

### `results <run-id>` — reuse a finished run WITHOUT re-running it
Every result is persisted in the run's `state.json`, so you can transform an expensive run's output
deterministically (code over the saved items — nothing is dropped, count == total). Auto-detects the
primitive (use `--cmd` to disambiguate, e.g. `--cmd foreach`).
- `--json` — every output at full fidelity: `foreach` → one row per item `{id, status, result}`;
  `step`/`reduce`/`pipe` → the produced output (inline or read from its result_pointer file).
- `--checklist` — a markdown `- [ ]` line per item (one per item, so a 2,000-item run yields 2,000
  lines, none lost). Append a result field as the task text with `--field <key>` (or `--field a.b` for a
  nested field); if the item's result is a plain string it is appended automatically.
- `--status <s>` filters foreach items (e.g. `failed`); `--limit N` caps rows (use `1` to peek at the shape first).

**Turn a review run into an actionable checklist** (no re-run):
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" results <run-id> --cmd foreach --json --limit 1     # see the result shape → pick --field
node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" results <run-id> --cmd foreach --checklist --field summary > CHECKLIST.md
```
Then action it with `/agentflow:checklist CHECKLIST.md`. (Writing the output file via a redirect is
fine — `results` only READS run state.)

### `tree <pipe-run-id>`
For a /agentflow:pipe run, recursively walk the stage tree and show each child run's status, agent count, and USD estimate. Indented ASCII tree. Useful to see at a glance "stage 1 done, stage 2 in_progress, stage 3 pending".

### `budget <run-id>`
Walk the run and (if /agentflow:pipe) all its children recursively. Sum `tokens_used`, `agents_dispatched`, `usd_estimate` and break down per-node. Answers "how much did this pipeline cost?"

### `timeline <run-id>`
Print created_at / started_at / updated_at / completed_at plus the last N budget events (`--limit`). Useful for "where did the time go?"

## Pattern: triage a failed pipe

1. `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" runs --cmd pipe` — find the failed pipe.
2. `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" tree <pipe-run-id>` — identify which stage failed.
3. `node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" show <failed-child-run-id> --cmd <its-primitive>` — get details on the failure.
4. For /agentflow:foreach failures: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/foreach.js" list <run-id> --status failed` for per-item errors.

## Pattern: cost audit

`node "${CLAUDE_PLUGIN_ROOT}/dist/inspect.js" budget <pipe-run-id>` for cumulative tokens/USD across a whole pipeline (including all primitive children).

## Important rules

- **Read-only**: `/agentflow:inspect` never modifies state. If you need to fix something (reset stuck items, force a transition), use the primitive's own state CLI (`state/foreach.js reset`, etc.).
- **No auto-continue interaction**: `/agentflow:inspect` does not appear in the Stop hook's PRIMITIVES registry — it has no runs to resume.
- **Output is for humans first, JSON second**: most subcommands print a readable table or tree. Pass `--json` (or `--pretty` for `show`) when you need structured output for further processing.
