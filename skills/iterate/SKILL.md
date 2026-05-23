---
name: iterate
description: |
  Repeat a stage until a predicate is satisfied (or `while` it stays true), with full loop safety: hard cap on iterations, convergence detection, clean kill switch.

  USE this skill autonomously when:
  - the user wants a loop with semantic termination — "fix the build until it passes", "extract issues until none remain", "refine the digest until the assistant agrees", "run X until convergence";
  - the loop body is a deterministic shell command (or a wrapper around another primitive's CLI), and the stop signal is also a shell predicate;
  - the user explicitly mentions "iterate", "loop", "repeat until", "while X", or describes a feedback cycle.

  DO NOT use this skill autonomously when:
  - the work is bounded by a finite list — use `/enumerate` instead;
  - there is no clear stop signal — refusing a loop without termination is correct, do not invent one;
  - one pass is enough — do not wrap a single-shot operation in /iterate "just in case".

  Explicit user invocation (`/iterate ...`) bypasses these checks.

  V1 stage and stop predicate are bash commands (you can wrap any primitive: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/<cmd>.js" ...`). One iteration runs per turn by default; the Stop hook resumes the next iteration cross-turn. Each iter gets env vars `ITER_RUN_ID`, `ITER_INDEX`, `ITER_OUTPUT_PATH`, `ITER_PREV_OUTPUT_PATH`.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --file <spec.md> | --stage '<json>' --stop '<json>' [--max-iterations N] [--run-id NAME] [--no-convergence-check]
---

# /iterate

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/iterate/` (this folder: SKILL.md + defaults.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/iterate.js`)
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)

You are the **orchestrator** of a `/iterate` run. Job per turn:
1. (init only — first invocation) parse args, validate stage + stop, init state.
2. Run **exactly one** iteration via `run-iteration`.
3. Inspect the JSON result: `{"action": "continue"|"stop", "reason": ..., "iter": ...}`.
4. If `continue`: print a one-line status, then **exit the turn** (the Stop hook will resume next turn).
5. If `stop`: print the final report (status, iteration_count, stop_reason, result_pointer, last iter preview).

**Why one iter per turn**: iterations may take seconds to minutes; bundling them inside one turn bloats context. Cross-turn auto-continue keeps each iteration's context isolated. (For very fast iterations, you MAY loop ~3 times within a turn — never more.)

## Input forms

### Form A — structured markdown file
```
/iterate --file path/to/spec.md
```
With YAML frontmatter (config + stage + stop):
```markdown
---
run-id: fix-build
max-iterations: 10
convergence-check: true
stage:
  type: bash
  command: |
    cd repo && make fix-and-build 2>&1 | tee "$ITER_OUTPUT_PATH"
stop:
  type: bash
  mode: until
  command: |
    grep -q "BUILD SUCCESSFUL" "$ITER_OUTPUT_PATH"
---
```

### Form B — inline flags
```
/iterate --stage '{"type":"bash","command":"..."}' \
         --stop  '{"type":"bash","command":"...","mode":"until"}' \
         [--max-iterations N] [--run-id NAME] [--no-convergence-check]
```

If stage or stop is missing → stop with a clear message.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/iterate/defaults.md`. Use defaults when CLI/spec do not supply a value.

## Step 1 — Parse and validate (init turn only)

- Determine form A or B.
- Resolve final config by priority (CLI > spec frontmatter > defaults > hardcoded).
- If `run-id` missing: generate `iter-<8 char hash>` from a hash of stage.command + stop.command.
- Validate:
  - `stage.type == "bash"` and `stage.command` non-empty
  - `stop.type == "bash"`, `stop.command` non-empty, `stop.mode in {"until", "while"}`
  - `max_iterations >= 1`
  - `max_auto_continues >= max_iterations` (otherwise warn — the loop will be cut short by the hook before its semantic cap).

**Stop predicate semantics**:
- `mode: until` — exit 0 = stop (predicate satisfied); non-zero = continue.
- `mode: while` — exit 0 = continue (predicate still true); non-zero = stop.

**Available env vars in stage and stop commands**:
- `ITER_RUN_ID`, `ITER_INDEX`, `ITER_OUTPUT_PATH` (where stage stdout is captured), `ITER_PREV_OUTPUT_PATH`.

## Step 2 — Init state (first turn only)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" init <run-id> \
  --stage '<stage-json>' --stop '<stop-json>' \
  --max-iterations <N> --max-auto-continues <N> \
  [--no-convergence-check] \
  [--auto-continue|--no-auto-continue] \
  [--force]
```

If the run-id exists **without `--force`**: ask the user `resume` (continue from current state) or `reset` (start over). DO NOT overwrite without confirmation.

## Step 3 — Run one iteration

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" run-iteration <run-id>
```

Output is JSON, one of:
- `{"action": "continue", "iter": N, "next_iter": N+1, "iterations_remaining": K}` — loop continues.
- `{"action": "stop", "reason": "...", "iter": N, ...}` — loop terminated.

`reason` values:
- `predicate_satisfied` — happy path, the stop predicate decided.
- `max_iterations` — hit the hard cap.
- `convergence` — stage output equal to previous iter (hash match).
- `stage_failed` — stage exited non-zero. State = failed.
- `killed` — kill file detected. State = aborted.
- `stage_spawn_error` / `predicate_spawn_error` — couldn't run the command. State = failed.

## Step 4 — Decide

- **action=continue**: print one line — `[iter N done] continuing... ({iterations_remaining} remaining)`. Optionally show first 200 chars of `iter-N.out`. **Exit the turn** — the Stop hook will fire again and re-enter you here on the next turn.
- **action=stop**: print final report:
  - status (done | failed | aborted)
  - iteration_count, max_iterations, stop_reason
  - result_pointer (path to the final iter's output, if any)
  - if failed/aborted: error or kill timestamp
  - last iter's output preview (first 30 lines of `result_pointer`)

## Cross-turn auto-continue

The Stop hook detects `/iterate` runs with `auto_continue=true` and `status in {pending, in_progress}` and re-invokes you with the run-id. You go straight to **Step 3** (no re-init).

`auto_continues` cap (default 15) protects against runaway. If reached: hook stops, run stays `in_progress`, user must intervene (kill or fail explicitly).

## Kill switch

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" kill <run-id>
```
Writes `.iterate/<run-id>/kill`. The next `run-iteration` aborts cleanly (status=aborted, stop_reason=killed). **Not preemptive** — a running iter completes first.

## Important rules

- **One iter per turn (default)**. Bundling iterations within a turn bloats context and hides progress. Cross-turn keeps each iter's context isolated. Override only for trivially fast iterations.
- **Single-writer**: only `state/iterate.js` mutates state. Stage and predicate commands read but never write state files.
- **Predicate exit codes are the contract**. Document them in your stop command. A bug in the predicate produces an infinite loop bounded only by `max_iterations` — that's why convergence detection and the hard cap exist.
- **Idempotence**: re-running `/iterate` with the same run-id without `--force` resumes from where it left off.

## Quick examples

**Fix the build until it passes** (≤ 10 attempts):
```
/iterate \
  --stage '{"type":"bash","command":"cd repo && claude-fix-build 2>&1 | tee \"$ITER_OUTPUT_PATH\""}' \
  --stop  '{"type":"bash","mode":"until","command":"grep -q \"BUILD SUCCESSFUL\" \"$ITER_OUTPUT_PATH\""}' \
  --max-iterations 10
```

**Drain a queue until empty** (compose with another primitive):
```
/iterate \
  --stage '{"type":"bash","command":"node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" status my-queue > \"$ITER_OUTPUT_PATH\""}' \
  --stop  '{"type":"bash","mode":"until","command":"jq -e \".pending == 0 and .in_progress == 0\" \"$ITER_OUTPUT_PATH\""}' \
  --max-iterations 50
```

**Refine a digest until convergence** (no explicit predicate — rely on convergence_check):
```
/iterate \
  --stage '{"type":"bash","command":"node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" ... > \"$ITER_OUTPUT_PATH\""}' \
  --stop  '{"type":"bash","mode":"until","command":"false"}' \
  --max-iterations 5
```
(`false` always returns non-zero so `until` predicate is never satisfied; the loop terminates only via convergence or max_iterations.)
