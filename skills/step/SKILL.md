---
name: step
description: |
  Run ONE prompt once and capture its structured output — the single LLM/work unit between
  /agentflow:reduce (one agent over N inputs) and /agentflow:foreach (one agent per item). Pick where it
  runs with `--runtime`: `main` (inline), `subagent` (one Agent), or sessionless CLIs `claude-cli`
  (`claude -p`) / `codex-cli` (`codex exec`) that the engine executes itself. This is how a workflow step
  can be an arbitrary skill, an MCP-using agent, `claude -p`, or a different model (e.g. cross-model).

  USE for a single ad-hoc step: "run this one prompt", "ask codex to …", "have a second model review
  this", "do this one thing and capture the result". For per-item work use /agentflow:foreach; to
  synthesize many inputs use /agentflow:reduce.
allowed-tools: Bash, Read, Write, Edit, Agent
argument-hint: --prompt "<text>" [--prompt-file <path>] --runtime main|subagent|claude-cli|codex-cli [--model …] [--subagent-type <name>] [--input <file>]
---

# /agentflow:step

> **Make it visible:** say in one line that you're running a step (id + runtime).

## 1. Init

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/step.js" init <id> \
  (--prompt "<text>" | --prompt-file <path>) --runtime <main|subagent|claude-cli|codex-cli> \
  [--model <…>] [--subagent-type <name>] [--input <file>] [--force]
```

## 2. Execute — branch on `config.runtime`

- **`claude-cli` / `codex-cli`** — the **engine runs it** sessionlessly; you don't dispatch anything:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/dist/state/step.js" run <id>
  ```
  It spawns `claude -p <prompt> --output-format json` (or `codex exec <prompt> --json`), captures the
  result, and marks the run done/failed. Binaries must be installed + logged in; override with
  `$STEP_CLAUDE_BIN` / `$STEP_CODEX_BIN`. (Validate the exact flags against your installed CLIs.)
- **`subagent`** — dispatch **one** `Agent` (`subagent_type` + `model` from config) with the step's
  prompt (and `--input` file if any); tell it to return the result. Then record it:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/dist/state/step.js" complete <id> --output "<agent result>"
  # or, if the agent wrote a file: ... complete <id> --output-path <file>
  ```
- **`main`** — do the work inline in this thread, then `complete <id> --output "<result>"`.

On failure: `node "${CLAUDE_PLUGIN_ROOT}/dist/state/step.js" fail <id> --error "…"`.

## 3. Result

`status <id>` reports `output_pointer` — a file holding the step's output, consumable by a later stage
(`{{stages.<name>.result_pointer}}` in a workflow) or a `/agentflow:reduce`.

## In a workflow (WORKFLOW.md)

A `## name · step` stage runs a step; bullets become flags:

```markdown
## critique · step
- runtime: claude-cli
- model: opus
- prompt: Critique the draft at {{stages.draft.result_pointer}}; list concrete weaknesses.
```

Two `step` stages with different `--model` inside a `repeat`/`until` loop give you a **cross-model
conversation** (model A proposes, model B critiques) — adversarial or cooperative — with the loop
predicate as the deterministic convergence check.
