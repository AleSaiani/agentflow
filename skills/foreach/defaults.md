---
# Default config for /flow:foreach.
#
# Override priority (high -> low):
#   1. CLI flag (--concurrency, --chunk-size, ...)
#   3. This file
#   4. Hardcoded fallback in the state helper
#
# Edit with care: these values apply to ALL runs launched from this workspace.

concurrency: 4              # parallel Agents per wave
chunk_size: auto            # int or "auto" = min(50, ceil(total / concurrency))
max_retries: 1              # per-item retries before final failed status
auto_continue: true         # if true, the command loops until exhaustion
max_auto_continues: 20      # safety cap for the cross-turn Stop hook
model: sonnet               # inherit | haiku | sonnet | opus — preflight (see task-kinds.md) may suggest a different one based on task_kind
subagent_type: general-purpose
min_items: 15               # autonomous-invocation guardrail: if Claude triggers /flow:foreach but resolves < min_items, ask the user to confirm (avoids orchestration overhead for tiny batches). Bypassed when the user types /flow:foreach explicitly.
---

# Notes

- `chunk_size: auto` is the sane default for nearly every case. Override only when
  there is a concrete reason (e.g. very heavy items → small chunks for granularity;
  trivial high-volume items → large chunks to reduce spawn overhead).

- `model: haiku` is great for mechanical bulk tasks (rename, lint-fix, reformat).
  `sonnet` for ordinary tasks. `opus` only for tasks with real per-item reasoning.

- `max_auto_continues: 20` means the Stop hook can restart the loop at most 20
  times. Beyond that, it stops and lets the user decide — a guard against
  infinite loops on broken runs.

- `min_items: 15` is the threshold below which an *autonomous* /flow:foreach invocation
  triggers a confirmation prompt. Tune up if you find /flow:foreach firing too eagerly
  on small batches; tune down (or set to 0) to disable the guardrail entirely.
