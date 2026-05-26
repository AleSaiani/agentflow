---
name: runs
description: |
  Observe and CONTROL the engine's in-flight jobs: list every top-level run in the order the Stop hook
  will advance them (the queue), pause/resume a single job, pause/resume the WHOLE engine, delete a run,
  set a job's priority, and garbage-collect finished runs so `.agentflow/` doesn't grow forever.

  USE this skill when the user wants to ACT on runs (not just look):
  - "pause everything", "stop the engine", "freeze the runs", "resume" → global pause/resume;
  - "pause/stop this run", "hold <id>", "resume <id>" → single-job pause/resume;
  - "which run goes first", "what's the queue/order", "bump <id> up" → ordering / priority;
  - "delete this run", "remove <id>", "clean up old/finished runs", "the runs folder is huge" → rm / clean.

  DON'T use this for a read-only overview with suggestions (→ /agentflow:board) or to inspect one run in
  depth (→ /agentflow:inspect show|tree <id>). `runs` is the *control panel*; board/inspect are read-only.
allowed-tools: Bash, Read
argument-hint: '[list|stop|resume|pause|rm|clean|priority] [<run-id>] [flags]'
disable-model-invocation: false
---

# /agentflow:runs — the run control panel

A **job** is a run launched directly (a workflow/`pipe`, a `do`, or a standalone primitive). A `pipe`'s
sub-runs (its stages) belong to their parent and are managed with it — `runs` lists and controls jobs,
not internal sub-runs. All commands go through one CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" <subcommand> [args]
```

## See what's running and in what order

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" list            # active jobs, with queue position (#1 next)
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" list --all       # include finished/failed jobs
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" list --json      # machine-readable
```

The `POS` column is the scheduling order the Stop hook follows each turn: **higher priority first, then
oldest job first (FIFO)**. One run-step advances per turn; the oldest job runs to completion before the
next one starts (round-robin fairness is intentionally not implemented yet).

## Two independent pause levels

| Scope | Pause | Resume | What it does |
|---|---|---|---|
| **Whole engine** | `runs pause` | `runs resume` | Creates/removes `.agentflow/PAUSED`. The Stop hook stops auto-resuming **anything**. The global "stop button". |
| **One job** | `runs stop <id>` | `runs resume <id>` | Sets a `paused` flag on that job (and its subtree). Other jobs keep advancing. |

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" pause            # freeze everything
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" resume           # unfreeze (no id == global)
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" stop  my-run     # pause just this job
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" resume my-run    # resume just this job
```

Pausing is **non-destructive** — state is preserved; the run resumes exactly where it left off. Prefer
`stop`/`pause` over `rm` whenever the user just wants something to *stop happening*.

## Reorder the queue

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" priority my-run 10   # higher number = scheduled sooner (default 0)
```

## Delete and garbage-collect (destructive — confirm first)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" rm my-run            # delete this run + its subtree
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" clean                # remove COMPLETED runs (default)
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" clean --failed       # also remove failed
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" clean --all          # done + failed + aborted
node "${CLAUDE_PLUGIN_ROOT}/dist/runs.js" clean --older-than 7d --dry-run   # preview first (30m|24h|7d|2w)
```

- **`rm`** refuses to delete a still-active job, or a child of a running pipe, **unless `--force`** — those
  are the cases that would break an in-flight pipeline.
- **`clean`** only ever touches **finished** top-level jobs (and their subtrees), so it can never remove a
  running job's children. Always offer `--dry-run` first when the user is unsure.

## Rules

- **Destructive ops need explicit intent.** `rm` and `clean` delete state on disk and cannot be undone.
  Confirm the target with the user (show `runs list --all` or a `--dry-run`) before deleting. Never `rm`
  an active run with `--force` unless the user explicitly asked to discard it.
- **Reach for pause, not delete**, when the goal is "stop it for now".
- **Read-only siblings**: `/agentflow:board` for the session-start dashboard with suggestions;
  `/agentflow:inspect tree <id>` to see a job's full child tree before removing it.
- Resolve an ambiguous id (same id under two primitives) with `<cmd>/<id>`, e.g. `pipe/my-run`.
