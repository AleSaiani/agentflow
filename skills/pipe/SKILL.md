---
name: pipe
user-invocable: false
description: |
  Run an ordered pipeline of stages — each a bash command, a json write, or another primitive
  (/agentflow:enumerate, /agentflow:foreach, /agentflow:group, /agentflow:reduce, or a loop). The composer: it holds no
  map/fold/loop of its own; it sequences the primitives that do, with declarative wiring and per-stage
  `when` guards.

  USE for a multi-step workflow with ≥ 2 ordered steps where one feeds the next — "fetch issues, triage
  each, then summarize", "review files, group findings, then report". To run a SAVED workflow-file use
  /agentflow:run-workflow; to AUTHOR one use /agentflow:create-workflow.

  DON'T use for a single step (call the primitive directly) or independent parallel work over a list
  (that's /agentflow:foreach). Explicit invocation (`/agentflow:pipe …`) skips these checks.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: (--stages <json> | --workflow <json>) [--context-policy summary|none|last-only|full] [--no-stop-on-failure]
---

# /agentflow:pipe

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/pipe/` (this folder: SKILL.md + defaults.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/pipe.js`, plus all child primitives' state.py)
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)

You are the **orchestrator** of a `/agentflow:pipe` run. The pipe itself is a state machine: each turn you call `state/pipe.js tick <run-id>` and act on the JSON it returns. The composer never mutates child state; it only reads it to decide when to advance.

## Stage types (v1)

### bash
```json
{
  "type": "bash",
  "name": "fetch-issues",          // optional, human-readable label
  "spec": {
    "command": "gh issue list --json number,title,body --limit 500 > \"$PIPE_OUTPUT_PATH\"",
    "output_path": ".agentflow/pipe/<run-id>/issues.json"     // optional; defaults to stage-N.out
  }
}
```
Bash stages run synchronously inside a turn. Env vars exposed:
- `PIPE_RUN_ID`, `STAGE_INDEX`, `PIPE_OUTPUT_PATH`, `PIPE_PREV_RESULT_POINTER`.

### json
```json
{
  "type": "json",
  "name": "build-config",
  "spec": {
    "value": {"source": "run", "run_id": "{{stages.review.run_id}}", "path": "{{stages.partition.result_pointer}}"},
    "output_path": ".agentflow/pipe/<run-id>/config.json"
  }
}
```
JSON stages write a JSON document directly to `output_path`, with template substitution applied to every string leaf inside `value`. They run synchronously and are fully auto-drivable. **Use this instead of bash+printf** to construct small JSON files between primitive stages: it handles Windows path escaping correctly, doesn't depend on shell quoting, and the result always parses as valid JSON.

**Template syntax** (resolved by /agentflow:pipe at tick time, in `bash.command`, `bash.output_path`, `json.value` (recursively), `json.output_path`, and in primitive stages' `init_args`):
- `{{run.id}}`, `{{run.dir}}` — this pipe run's id / working dir
- `{{stages.<name>.run_id}}` — a named primitive stage's child run-id
- `{{stages.<name>.result_pointer}}` — a named stage's result_pointer
- `{{stages.<name>.cmd}}` — a named primitive stage's child cmd

Filters can be appended with `|`:
- `{{X|json}}` — JSON-encode the resolved value (wraps strings in quotes, escapes backslashes). USE THIS when splicing into JSON contexts (especially for Windows paths whose backslashes would otherwise produce invalid JSON).
- `{{X|shell}}` — POSIX shell-quote.
- `{{X}}` or `{{X|raw}}` — raw substitution (default).

Stage names MUST be unique; that's the lookup key for `{{stages.<name>...}}`.

### primitive
```json
{
  "type": "primitive",
  "name": "triage",
  "spec": {
    "cmd": "foreach",
    "init_args": [
      "--items", ".agentflow/pipe/<run-id>/items.json",
      "--task-prompt", "...",
      "--model", "haiku",
      "--concurrency", "4"
    ]
  }
}
```
The orchestrator generates the child run-id (the `tick` output suggests one), runs the child's `init` CLI, then calls `state/pipe.js start-primitive-child` to record it. The Stop hook resumes the CHILD on subsequent turns. When the child is done, the next pipe `tick` returns `advance_after_child` and the orchestrator calls `state/pipe.js advance`.

## Invocation

```
/agentflow:pipe (--stages <stages.json> | --workflow <workflow.json>) \
       [--run-id NAME] [--context-policy summary|none|last-only|full] [--no-stop-on-failure]
```

`--stages` is a JSON array of stage descriptors (see Stage types below); `--workflow` is a declarative
`WorkflowSpec` (`{name, config, stages}`) that compiles into the same stages. If neither is given →
stop with a clear message. To AUTHOR a workflow-file use /agentflow:create-workflow; to RUN one in a single step
use /agentflow:run-workflow.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/pipe/defaults.md`. Use defaults when CLI/spec do not supply a value.

## Step 1 — Parse and validate (init turn only)

- `--stages`: read/parse the JSON array. `--workflow`: pass the file straight to `init --workflow`
  (it reads `stages` + optional `config`). Either way the canonical state lands under `.agentflow/pipe/<run-id>/`.
- Resolve config by priority (CLI > workflow `config` > defaults).
- If `run-id` is missing: generate `pipe-<8 char hash>` from the stages/workflow JSON.
- `init` validates every primitive stage's flags; a clear early failure beats a mid-run one.

## Step 2 — Init state (first turn only)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <run-id> \
  --stages .agentflow/pipe/<run-id>/stages.json \
  --context-policy <policy> --max-auto-continues <N> \
  [--no-stop-on-failure] [--auto-continue|--no-auto-continue] [--force]
```

If the run-id exists **without `--force`**: ask the user `resume` or `reset`.

## Step 3 — Tick loop

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" tick <run-id>
```

Output is JSON; the `action` field tells you what to do next.

### action = `done`
Print the final report:
- total stages, all status=done
- `result_pointer` (the last completed stage's pointer)
- a 30-line preview of `result_pointer` if it is a readable text/markdown file
- exit

### action = `failed`
Print the failure:
- which stage failed (index, name)
- `error` string
- `result_pointer` of any earlier successful stage if useful
- exit

### action = `run_bash`
Execute the command. The command receives env vars: `PIPE_RUN_ID`, `STAGE_INDEX`, `PIPE_OUTPUT_PATH`, `PIPE_PREV_RESULT_POINTER`.

Run via Bash tool, capture stdout to `output_path`. Then record:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" complete-bash-stage <run-id> \
  --exit-code <code> --output-path <output_path> [--error "<short reason>"]
```

After this, **loop back to `tick`** within the same turn (bash stages are fast; chaining them is fine). Continue until you hit `spawn_primitive` or `done`.

### action = `spawn_primitive`
The output includes `cmd`, `suggested_child_run_id`, and `init_args`. Steps:

1. Build the child init command. Use the `suggested_child_run_id` (you may override only if there is a real reason).
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/<cmd>.js" init <suggested_child_run_id> <init_args...>
   ```
2. Record the child in the pipe state:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" start-primitive-child <run-id> \
     --child-cmd <cmd> --child-run-id <suggested_child_run_id>
   ```
3. **Exit the turn** — the Stop hook will resume the child primitive on subsequent turns. The child has its own SKILL.md flow (e.g. /agentflow:foreach dispatch loop). When the child is done, the hook resumes /agentflow:pipe.

DO NOT also run the child's dispatch loop yourself here. Let the child's own SKILL.md handle it via cross-turn auto-continue.

### action = `await_primitive`
This means a primitive child is still working. **Exit the turn** — you should not normally see this directly because the hook prefers the child's checker, but if you do, just exit and the next Stop firing will resume the child.

### action = `advance_after_child`
The current primitive stage's child is done (or failed). Call:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" advance <run-id>
```
Then `tick` again within the same turn to see the next action.

## Step 4 — Final report

When `tick` returns `done`, print:
- `run_id`, `stage_count`, total turns used (from `auto_continues`)
- per-stage one-liner: name, type, status, result_pointer
- 30-line preview of the final `result_pointer` if textual

## Cross-turn auto-continue

The Stop hook detects `/agentflow:pipe` runs with `auto_continue=true` and residual work. /agentflow:pipe's predicate **yields to running primitive children** — while a child is running, /agentflow:pipe returns no residual and the hook resumes the child instead. /agentflow:pipe is re-entered only when the orchestrator needs to act (start a stage, advance after a child, finalize).

`max_auto_continues: 50` is the pipe-level cap (on top of each child's own cap).

## Important rules

- **/agentflow:pipe never mutates child state**. It only reads child state (via `is_done`) to decide when to advance. Children manage their own state per the single-writer rule.
- **Use the suggested_child_run_id** unless you have a reason to override. The default scheme (`<pipe-run-id>-s<N>-<cmd>`) makes provenance obvious.
- **Pre-existing items file (`/agentflow:group → /agentflow:foreach`)**: when a primitive stage's input is the output file of a prior stage, pass it via the appropriate flag of the child primitive — e.g. `/agentflow:foreach` init expects `--items <path>`. The orchestrator constructs `init_args` accordingly when building the stages.json.
- **Idempotence**: re-running `/agentflow:pipe` with the same run-id without `--force` resumes from where it left off.

## Quick example: audit pipeline

stages.json:
```json
[
  {
    "type": "primitive", "name": "triage",
    "spec": {
      "cmd": "foreach",
      "init_args": [
        "--items", ".agentflow/pipe/audit-001/files.json",
        "--task-prompt", "Quick severity triage. Output: {has_issues, severity_hint}",
        "--model", "haiku", "--concurrency", "8"
      ]
    }
  },
  {
    "type": "primitive", "name": "group-by-domain",
    "spec": {
      "cmd": "group",
      "init_args": [
        "--method", "jsonpath",
        "--input-source", ".agentflow/pipe/audit-001/group-input.json",
        "--method-config", "{\"path\":\"data.domain\"}"
      ]
    }
  },
  {
    "type": "primitive", "name": "deep-review",
    "spec": {
      "cmd": "foreach",
      "init_args": [
        "--items", ".agentflow/pipe/audit-001/groups-as-items.json",
        "--task-prompt", "Deep code-review of every file in this group, cross-referenced.",
        "--model", "opus", "--concurrency", "3"
      ]
    }
  },
  {
    "type": "primitive", "name": "digest",
    "spec": {
      "cmd": "reduce",
      "init_args": [
        "--inputs", ".agentflow/pipe/audit-001/digest-inputs.json",
        "--task-prompt", "Executive summary by severity, top hotspots, recurring patterns.",
        "--model", "opus", "--output-format", "markdown"
      ]
    }
  }
]
```

The orchestrator's job is to prepare those input files between stages (e.g. take the previous stage's `result_pointer` and shape it into the next stage's `--items` / `--inputs`). For v2, /agentflow:pipe will gain helpers to declare these wiring transformations declaratively. For v1, prep is the orchestrator's responsibility — keep it explicit.
