---
name: repeat
description: |
  Run a stage a FIXED number of times — a bounded count loop (`for i in 1..N`). One iteration per turn; the Stop hook resumes the next across turns. For a loop with a semantic stop condition, use `/agentflow:until` (do…until) or `/agentflow:while` (while…do) instead.

  USE when the user says "do X N times", "run the suite 5 times", "retry 3 times", "regenerate twice".
allowed-tools: Bash, Read, Agent
argument-hint: --times N --stage "<bash command>"
---

# /agentflow:repeat — fixed-count loop

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear an Agent Flow
> run is happening; `/agentflow:board` then lists every run on disk — the audit trail.

Engine: `iterate` (runs show as `cmd: iterate` in `/agentflow:inspect`). A repeat is an iterate with a
never-satisfied predicate, so it terminates only at `--times`.

## Init

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" init <run-id> \
  --stage "<command to run each time>" \
  --times <N>
```

(`--stage` takes a plain bash command; pass a JSON object only if you need extra fields.)

## Drive (one iteration per turn)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" run-iteration <run-id>
```

Inspect the JSON: `action: "continue"` → end the turn (the Stop hook fires again next turn);
`action: "stop"` with `reason: "max_iterations"` → the N runs are done, surface the result. Each
iteration's stdout is captured; `ITER_INDEX` (0-based) and `ITER_PREV_OUTPUT_PATH` are in the env.
Stop early any time with `iterate.js kill <run-id>`.
