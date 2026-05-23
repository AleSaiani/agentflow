---
# Default config for /iterate.
#
# Override priority (high -> low):
#   1. CLI flag
#   2. Spec frontmatter
#   3. This file
#   4. Hardcoded fallback in the state helper

max_iterations: 10          # hard cap on iterations (semantic loop budget)
convergence_check: true     # stop early if iter N's stage output equals iter N-1's (hash compare)
model: sonnet               # for future stages that delegate to LLM (v1: bash only)
auto_continue: true         # if true, the Stop hook resumes the loop across turns (1 iter / turn by default)
max_auto_continues: 15      # safety cap for the Stop hook (must be >= max_iterations + a few for recovery)
subagent_type: general-purpose
---

# Notes

- /iterate is the **unbounded loop** primitive. Where /enumerate has structural termination
  (the list runs out), /iterate has semantic termination (a predicate decides). Therefore
  it owns the whole loop-safety stack — anything else that wants a loop should compose
  /iterate as a stage.

- **Defaults are conservative.** `max_iterations: 10` is a small cap on purpose: most loops
  converge fast and a runaway costs real tokens. Bump to 50 only when you have a budget
  to spend and you understand the cost of each iteration.

- **`max_auto_continues` must be >= `max_iterations`** (plus a small margin for recovery).
  Otherwise the Stop hook will give up before the loop hits its semantic cap. The
  default 15 covers max_iterations 10 with 5 retries / recovery turns.

- **`convergence_check`** uses sha256 of the stage's stdout. Cheap and deterministic.
  Disable only when stage output is intentionally noisy (timestamps, random IDs) and a
  semantic stop predicate is the only correct termination signal.

- **One iteration per turn (default).** The orchestrator runs `run-iteration` once,
  surfaces the result, and exits. The Stop hook fires again next turn. This keeps each
  iteration's context clean. For very fast iterations (< 1s, no agent dispatch) the
  orchestrator MAY loop a few times within a turn; never beyond ~3 to avoid context bloat.

- **Kill switch.** `node "${CLAUDE_PLUGIN_ROOT}/dist/state/iterate.js" kill <run-id>` writes a kill file.
  The NEXT `run-iteration` call detects it and aborts cleanly (stop_reason=killed). Mid-iter
  termination is NOT supported in v1 — kills are clean, not preemptive.
