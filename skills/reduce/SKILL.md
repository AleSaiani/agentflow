---
name: reduce
description: |
  Collapse N results into 1 digest (markdown or JSON) via a single agent — the **fold** (N→1).

  USE when finished work needs synthesizing into one artifact — a /flow:foreach run, several result
  files, or inline data: "summarize all these", "roll this up", "give me one report / top-N / hotspot
  list from these". Best with a persisted source and many inputs.

  DON'T use for a handful of results (summarize inline), a one-off question about results, or when
  there's no persisted source to read. Explicit invocation (`/flow:reduce …`) skips these checks.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --inputs <descriptors.json> --prompt "<synthesis>" [--output-format markdown|json] [--model haiku|sonnet|opus]
---

# /flow:reduce

> **Make it visible:** the moment you start, say so in one line (skill + run-id) so it's clear a Flow
> run is happening; `/flow:board` then lists every run on disk — the audit trail.

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/reduce/` (this folder: SKILL.md + defaults.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/reduce.js`) — shared framework
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)

You are the **orchestrator** of a `/flow:reduce` run. Job:
1. resolve N inputs (from another run, a file, or inline),
2. materialize them into a single JSON file the digest agent can read,
3. dispatch ONE agent that produces 1 digest output,
4. persist the output pointer in state.

**Single-step primitive**: no fan-out, no per-item parallelism. /flow:reduce is the "fold" of the toolkit — N in, 1 out.

## Invocation

```
/flow:reduce --inputs <descriptors.json> --prompt "<digest instructions>" \
        [--output-format markdown|json] [--model haiku|sonnet|opus] [--run-id NAME] [--no-auto-continue]
```

`--inputs` is a JSON array of input descriptors:
```json
[
  {"source": "run", "cmd": "foreach", "run_id": "…"},
  {"source": "file", "path": "./extra-data.json"},
  {"source": "inline", "data": {"note": "…"}}
]
```

`--prompt` (alias `--task-prompt`) is the synthesis instruction; `--output-format` defaults to
`markdown`. If neither `--inputs` nor `--prompt` is given → stop with a clear message.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/reduce/defaults.md` (YAML frontmatter). Use defaults when CLI/spec do not provide a value.

**Override priority** (high → low): CLI flag > defaults.md > the state helper's built-in fallback.

## Step 1 — Parse and validate

- Confirm `--inputs` (a descriptors file) and `--prompt` are present.
- Resolve config by priority.
- If `run-id` is missing: derive `reduce-<8 char hash>` from the inputs descriptor + prompt.

**Validate inputs**:
- Every entry has `source` in {`run`, `file`, `inline`}, with the right field (`run_id`, `path`, `data`).
- For `run` inputs: verify the referenced state exists (run `node "${CLAUDE_PLUGIN_ROOT}/dist/state/<cmd>.js" status <run-id>`). Warn if the upstream run has `failed` items but proceed (the digest agent will see them as `result: null`).

**Threshold guardrail** (autonomous invocation only): after resolving inputs, count the total result objects (sum of `done` items across run inputs + length of file inputs + length of inline inputs). If total < `min_inputs` (default 5) AND this is an autonomous invocation, STOP and use `AskUserQuestion`:
> "Only <N> total inputs to reduce. For this size, summarizing inline in chat is usually faster than running /flow:reduce (which dispatches an agent and writes a file). Proceed with /flow:reduce?"
> Options: **inline** (cancel /flow:reduce, summarize directly in chat) | **proceed** (continue with /flow:reduce)

If the user typed `/flow:reduce` explicitly → skip the guardrail.

## Step 2 — Init state

Write the inputs descriptor to `.flow/reduce/<run-id>/inputs-spec.json` (the parsed list). Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" init <run-id> \
  --inputs .flow/reduce/<run-id>/inputs-spec.json \
  --task-prompt "<task-prompt>" \
  --model <model> --output-format <markdown|json> \
  --max-auto-continues <N> \
  [--auto-continue|--no-auto-continue] \
  [--force]
```

If the run-id exists **without `--force`**: ask the user `resume` (re-dispatch the agent if not done) or `reset` (start over). DO NOT overwrite without confirmation.

## Step 3 — Materialize inputs

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" materialize <run-id> \
  --out .flow/reduce/<run-id>/inputs.json
```

This walks every input descriptor and produces a single JSON the agent will read. Run-typed inputs only include items with `status == done` (others appear with `result: null`).

## Step 4 — Mark in_progress

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" start <run-id>
```

## Step 5 — Dispatch the digest agent

Launch ONE Agent (no fan-out). The prompt is **self-contained**:
- `subagent_type`: from config (default `general-purpose`)
- `model`: from config if not `inherit`, otherwise omitted
- `description`: `reduce:<run-id>`
- `prompt`:
  - the user's task-prompt verbatim
  - inputs file path: `.flow/reduce/<run-id>/inputs.json` (read this with the `Read` tool)
  - output file path: `./<run-id>.<md|json>` — a **visible file in the workspace root** (extension
    matches `output_format`), so the digest is easy to find and commit instead of being buried under
    `.flow/`. Only the *internal* materialized inputs live under `.flow/reduce/<run-id>/`. Pick a
    descriptive `--run-id` (Step 2) so the filename reads well — e.g. `audit-digest` → `audit-digest.md`.
  - **strict I/O rules**:
    - "Read the inputs file. Synthesize the requested digest. Do NOT comment while working."
    - "Write the digest to the output path via the `Write` tool. The file MUST be ONLY the digest — no preamble, no markdown fence around the whole thing (markdown content inside is fine for `format: markdown`)."
    - "If `format: json`: the file MUST be valid JSON, no prose, no fence."
    - "Your final response to the orchestrator must be a single line: `OK <bytes-written>`. Nothing else."

## Step 6 — Record budget + commit

**6a. Budget**: the Agent return includes a `<usage>total_tokens: N ...</usage>` block. Record it:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" budget-add <run-id> \
  --tokens <total_tokens_from_agent_usage> \
  --model <model_from_config> \
  --event-type agent_dispatch
```

**6b. Commit**

If the agent returned `OK` and the output file exists:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" complete <run-id> \
  --output-path ./<run-id>.<md|json>
```

Otherwise:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" fail <run-id> --error "<short reason>"
```

If `auto_continue == true` and we failed mid-way (no output file), the Stop hook will re-trigger the next turn — re-dispatch from Step 4. The `auto_continues` cap (default 5) bounds the retry budget.

## Step 7 — Final report

Print a one-liner: `run-id`, `status`, `output_pointer` (the visible `./<run-id>.<ext>` file), byte size of the digest, `model` used. If `format: markdown`, optionally `Read` the first 30 lines and show them inline so the user does not have to open the file.

## Cross-turn auto-continue

A **Stop hook** (`${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js`) scans `.flow/reduce/` (alongside other primitives). For /flow:reduce, "residual work" = `status in {"pending", "in_progress"}` AND `auto_continues < max_auto_continues`. If you are re-activated by the hook with a /flow:reduce run-id:
- DO NOT re-init.
- Read the state. If `status == in_progress` and the output file is absent → re-dispatch (Step 5).
- If the output file IS present → call `complete` (Step 6).

## Important rules

- **Single-writer**: only you (orchestrator) call `start`/`complete`/`fail`. The agent only writes the output file.
- **Materialize once per run**: `inputs.json` is built at init; if upstream runs change, the user must call `--force` to rebuild.
- **No partial digests**: either the file is fully written and `complete` is called, or it stays `failed`. Half-written outputs are discarded by `complete` (it requires the file to exist).
- **Idempotence**: re-running `/flow:reduce` with the same run-id without `--force` resumes (re-dispatches if needed).

## Quick example

```bash
# inputs.json: [{"source":"run","cmd":"foreach","run_id":"review-cs"}]
/flow:reduce --inputs inputs.json --model opus --output-format markdown \
        --prompt "Group findings by severity. Top-5 hotspot files. Recurring patterns."
```
