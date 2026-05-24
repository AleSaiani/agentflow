---
# Default config for /flow:group.
#
# Override priority (high -> low):
#   1. CLI flag (--method, --input-source, --method-config, ...)
#   3. This file
#   4. Hardcoded fallback in the state helper

method: path-prefix         # path-prefix | regex | jsonpath | llm-classify
model: sonnet               # used only for method=llm-classify
auto_continue: true         # if true, the Stop hook resumes a half-done /flow:group in the next turn
max_auto_continues: 5       # safety cap; deterministic methods complete in one shot, > 1 is recovery
min_items: 10               # autonomous-invocation guardrail (Claude triggers /flow:group only if >= min_items)
subagent_type: general-purpose

# method-specific defaults (consumed when the matching method is used):
path_prefix_depth: 2        # for method=path-prefix: number of leading path segments to use as the key
---

# Notes

- /flow:group is the **partition** primitive. Output is items.json-compatible: each "item"
  in the output is a group, ready to be consumed by /flow:foreach as `--items`.
  This is the canonical `/flow:group → /flow:foreach (per group)` composition.

- **Deterministic methods** (path-prefix, regex, jsonpath) complete in one shot, no
  LLM dispatch. Pure Python in the state helper. Cheap and reproducible.

- **llm-classify** dispatches ONE agent that reads all items and emits a classification
  mapping. Use for semantic grouping ("by domain", "by intent") that cannot be expressed
  with a regex. Slower and more expensive — prefer deterministic when possible.

- `min_items: 10` is the autonomous-invocation guardrail. For very small input sets,
  grouping adds noise without value — the orchestrator asks the user to confirm. Bypassed
  when the user types `/flow:group` explicitly.
