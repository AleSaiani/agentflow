---
name: until
description: |
  Loop a stage and stop once a predicate is satisfied — `do … until (cond)`: the body runs FIRST, then the condition is checked. The loop always runs at least once. Full loop safety: hard cap on iterations, convergence detection (stops if output stops changing), and a clean kill switch.

  USE when the user wants semantic termination after acting — "fix the build until it passes", "extract issues until none remain", "retry until it succeeds". For checking the condition BEFORE running (the body may not run at all), use `/flow:while`. For a fixed count, use `/flow:repeat`.
allowed-tools: Bash, Read, Agent
argument-hint: --stage "<bash>" --stop "<bash predicate>" [--max-iterations N]
---

# /flow:until — do…until loop

Engine: `iterate`. `until` mode: the stop predicate exits **0 when satisfied** → stop.

## Init

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" init <run-id> \
  --stage "<body command>" \
  --stop  "<predicate command>" \
  [--max-iterations <N>] [--no-convergence-check]
```

`--stage` and `--stop` take plain bash commands (`--mode` defaults to `until` here). The predicate
exits **0 when satisfied** → stop.

## Drive (one iteration per turn)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" run-iteration <run-id>
```

Order per iteration: **run the stage, then check the predicate.** `action: "continue"` → end the
turn (Stop hook resumes); `action: "stop"` → surface the result. `reason` is one of
`predicate_satisfied | max_iterations | convergence | stage_failed | killed`. The predicate sees
`ITER_OUTPUT_PATH` (this iteration's stdout) and `ITER_PREV_OUTPUT_PATH`.
