---
name: queue
user-invocable: false
description: |
  A lock-free shared work queue that MANY workers (terminals/sessions) can drain at the same time
  without double-processing. Each item is a file claimed by an atomic rename, so concurrent claims are
  safe with no locks. Supports dynamic enqueue (`add`), a `--stop-file`/budget pause, and `reclaim` of a
  dead worker's stale claims.

  USE when work should be pulled by **multiple concurrent workers from one queue** ("process this queue
  from 3 terminals", "a shared work queue", "let several agents drain these in parallel safely"), or
  when items arrive over time. For a single orchestrator processing a fixed list, use /agentflow:foreach
  (its `--shard k/N` splits a list across terminals by static partition — queue is the dynamic, pull
  model instead).
allowed-tools: Bash, Read, Write, Edit, Agent
argument-hint: (--items <json> | --checkbox <md> | --folder <dir> | --source <spec>) --prompt "<operation>" [--stop-file <path>] [--max-usd N] [--max-retries N]
---

# /agentflow:queue

> **Make it visible:** say in one line that you're draining a queue (id + how many pending).

A queue lives at `.agentflow/queue/<id>/` as files moving through `pending/ → claimed/ → done|failed/`.
A **claim is an atomic rename**, so any number of workers can pull from the same queue concurrently and
never get the same item twice. You are **one worker**; the user may launch several (each its own
terminal/session running this skill on the same `<id>`).

## 1. Create the queue (once)

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/queue.js" init <id> \
  (--items <file> | --checkbox <md> | --folder <dir> | --source '<json>') --prompt "<operation>" \
  [--stop-file <path>] [--max-usd N] [--max-retries N] [--force]
```

If the queue already exists (another worker created it), **skip init** and go straight to the drain loop.

## 2. Drain loop (each worker repeats until empty)

1. **Claim** the next item atomically:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/queue.js" claim <id> [--worker <name>]
   ```
   - `{item: null}` → the queue is empty (or `paused: true` via stop-file/budget) → **stop**, report.
   - `{item: {...}, task_prompt}` → you claimed it; no other worker can.
2. **Process** the item (dispatch one `Agent`, or do it inline) using `task_prompt` + the item's `data`.
3. **Commit**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/queue.js" complete <id> <item-id> [--result '<json>']
   # or, on failure:
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/queue.js" fail <id> <item-id> --error "…" [--retry]
   ```
   Record agent token usage with `budget-add` so a `--max-usd` cap is real.
4. Loop to step 1. When `claim` returns `{item:null}`, the queue is drained (the run is marked `done`
   once `pending` and `claimed` both reach 0).

The Stop hook auto-resumes this loop across turns (per worker) until the queue is empty.

## Operating notes

- **Many terminals**: launch `/agentflow:queue …` (same `<id>`) in each — the rename-claim makes it
  safe. `/agentflow:board` shows the queue; `queue status <id>` shows `pending/claimed/done/failed`.
- **Dynamic work**: `queue add <id> --items <file>` (or `--source`) enqueues more at any time; a drained
  queue reopens.
- **Pause**: `touch <stop-file>` → every worker's next `claim` returns nothing and the Stop hook won't
  resume; remove it to continue. A budget cap (`--max-usd`) pauses the same way.
- **Dead worker**: `queue reclaim <id> --older-than <seconds>` returns items stuck in `claimed/` (older
  than N seconds) back to `pending/` so another worker can pick them up.
