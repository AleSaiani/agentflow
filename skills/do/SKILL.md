---
name: do
description: |
  Do a multi-step DETERMINISTIC operation ONCE, ad-hoc — without saving a workflow file. You describe the
  outcome; `do` designs an inline pipeline (code/bash stages where possible, an LLM step only where real
  judgment is needed — the determinism boundary), names the run, runs it to completion, then offers to
  PROMOTE it to a reusable `workflows/<name>/WORKFLOW.md`. The fast path: throwaway now, keep it later if
  it earned its place.

  USE for "just do X", "i want to <multi-step thing>", a quick one-off pipeline over files/data, a
  transform you will probably run once. Trigger on a multi-step / deterministic-operation intent.

  DON'T use for: a single trivial action (just do it inline, no machinery); a reusable, parameterized
  workflow you will run repeatedly or share (→ /agentflow:create-workflow, which saves a folder); running
  an existing workflow file (→ /agentflow:run-workflow); applying one operation to each item of a list
  (→ /agentflow:foreach). `do` is the *ephemeral* sibling of create-workflow.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: <plain description of the one-off operation> [--name <id>] [--max-usd N]
---

# /agentflow:do — design + run a throwaway deterministic operation

> **Make it visible:** say in one line that you are starting a `do` run (its name/run-id) so it is clear
> an Agent Flow run is happening; `/agentflow:board` then lists it. All paths are relative to the
> workspace root.

You turn an intent into a small **inline `/agentflow:pipe`** — run once, kept on disk as a run (not as a
saved workflow folder) — and optionally promote it afterwards.

## 1. Triage the intent (don't over-build)
- **Atomic** (one obvious action) → just do it directly; no pipe.
- **Multi-step but clear** → design the inline pipe (below) and run it.
- **Big / ambiguous / risky assumptions** → ask 1–2 sharp questions first (AskUserQuestion), then design.

## 2. Design deterministic stages (the determinism boundary)
Express the operation as ordered stages, each writing `$PIPE_OUTPUT_PATH`:
- Prefer **`bash` / `json`** stages (pure code) — gather, transform, filter, render. Reproducible.
- Use an **LLM step** (`{type:"primitive", spec:{cmd:"step"|"foreach"|"reduce", …}}`) ONLY where real
  judgment is needed; constrain its output and let later **code** read it — never branch on free text.
- Wire stages with `{{stages.<name>.result_pointer}}`, `{{run.dir}}`, `{{params.*}}`.

## 3. Name it + run it (inline, no saved file)
Pick a kebab name from the intent (or `--name`). Run as an inline pipe — **no workflow folder is written**:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <name> --stages '<stages-json>' [--max-usd N]
node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" drive <name>
```
Drive exactly like `/agentflow:run-workflow`: handle `needs_agent` (dispatch the child per its SKILL.md),
`needs_approval` (ask the user), and **echo `pipe progress <name>` each turn**. On `done`, surface the
`result_pointer`.

## 4. Offer to promote (throwaway → reusable)
When it worked, offer: *"Keep this as a reusable workflow?"* If yes, hand off to
**/agentflow:create-workflow** to materialize `workflows/<name>/WORKFLOW.md` — lift inline `bash` commands
into sibling scripts called via `{{workflow.dir}}`, and declare `params` for the inputs you hard-coded. If
no, it stays a disposable run under `.agentflow/pipe/<name>/` — delete it anytime.

## Rules
- **Ephemeral by default**: `do` does NOT write a `workflows/` folder unless the user promotes it.
- **Deterministic-first**: the value is reproducibility — push logic into code stages; reserve LLM steps
  for genuine judgment, schema-constrained.
- The run is durable (state on disk) and resumable across turns like any pipe (Stop hook auto-continues).
