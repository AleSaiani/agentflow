---
name: while
description: |
  Loop a stage WHILE a predicate holds, checking the condition BEFORE each run — `while (cond) { body }`. If the condition is already false up front, the body never runs. Full loop safety: hard cap, convergence detection, kill switch.

  USE when the guard must be checked first — "while there are pending PRs, process the next", "keep refining while the reviewer disagrees", "process the queue while it's non-empty". For running the body first and then checking (at least one run), use `/flow:until`. For a fixed count, use `/flow:repeat`.
allowed-tools: Bash, Read, Agent
argument-hint: --stage "<bash>" --stop "<bash predicate>" --mode while [--max-iterations N]
---

# /flow:while — while…do loop (check-first)

Engine: `iterate` with `--check-first`. `while` mode: the predicate exits **0 while still true** →
keep running; non-zero → stop. Because the check runs first, the stage may execute zero times.

## Init

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" init <run-id> \
  --stage "<body command>" \
  --stop  "<predicate command>" \
  --mode while --check-first \
  [--max-iterations <N>] [--no-convergence-check]
```

`--stage` and `--stop` take plain bash commands. The predicate exits **0 while still true** →
keep running; non-zero → stop.

## Drive (one iteration per turn)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" run-iteration <run-id>
```

Order per iteration: **check the predicate, then (if still true) run the stage.** `action: "stop"`
with `reason: "predicate_satisfied"` and `checked: "before"` means the guard turned false (loop
done). `action: "continue"` → end the turn; the Stop hook resumes. The predicate sees
`ITER_PREV_OUTPUT_PATH` (the previous iteration's stdout; empty on the first check).
