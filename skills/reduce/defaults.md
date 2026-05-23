---
# Default config for /reduce.
#
# Override priority (high -> low):
#   1. CLI flag (--model, --format, ...)
#   2. Spec frontmatter (when using --file spec.md)
#   3. This file
#   4. Hardcoded fallback in the state helper

model: sonnet               # inherit | haiku | sonnet | opus
output_format: markdown     # markdown | json
auto_continue: true         # if true, the Stop hook resumes a half-done /reduce in the next turn
max_auto_continues: 5       # safety cap; /reduce is a single-shot primitive, anything > 1 is recovery
subagent_type: general-purpose
min_inputs: 5               # autonomous-invocation guardrail: if Claude triggers /reduce but total inputs < min_inputs, ask the user to confirm (avoids dispatching an agent for what could be an inline summary). Bypassed when the user types /reduce explicitly.
---

# Notes

- /reduce is a *single-step* primitive: 1 digest agent, no fan-out. Keep `max_auto_continues`
  low (default 5) — anything beyond 1 means the digest agent failed and we are retrying.

- `model: opus` for high-stakes synthesis (executive reports, security findings rollup).
  `sonnet` for ordinary digests. `haiku` only for trivial aggregation (counts, top-N lists).

- `output_format: markdown` is the human-friendly default. Use `json` when the digest is
  itself an input to another /reduce or to a /pipe stage that needs structured handoff.

- `min_inputs: 5` is the threshold below which an *autonomous* /reduce invocation triggers
  a confirmation. For a handful of results, an inline summary in chat is usually better
  than a persisted digest file. Tune as needed; set to 0 to disable the guardrail.
