---
name: reduce
description: |
  Collapse N results into 1 digest (markdown or JSON) via a single agent.

  USE this skill autonomously when:
  - a finished /enumerate run exists and the user asks for a summary, rollup, top-N, hotspot list, or grouped report;
  - inputs are MANY (typically >= 5 result objects) so a structured digest beats inline summarization;
  - the user wants a persisted artifact (a file at `.reduce/<run-id>/digest.<md|json>`) rather than a chat reply.

  DO NOT use this skill autonomously when:
  - inputs are few (< 5) — summarize inline in chat;
  - the user is asking a one-off question about results, not requesting a structured digest;
  - there is no persisted source: /reduce needs a /enumerate run, a result file, or inline data, NOT a free-form question.

  Explicit user invocation (`/reduce ...`) bypasses these rules.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
argument-hint: --file <spec.md> | --from-run <enum-run-id> --task "<prompt>" [--model haiku|sonnet|opus] [--format markdown|json] [--run-id NAME]
---

# /reduce

> **Portable bundle**. To use this skill in another project, copy:
> - `${CLAUDE_PLUGIN_ROOT}/skills/reduce/` (this folder: SKILL.md + defaults.md)
> - `${CLAUDE_PLUGIN_ROOT}/dist/` (`common.js`, `state/reduce.js`) — shared framework
> - `${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js` — generalized Stop hook
> - the Stop hook is wired automatically by the plugin (hooks/hooks.json)

You are the **orchestrator** of a `/reduce` run. Job:
1. resolve N inputs (from another run, a file, or inline),
2. materialize them into a single JSON file the digest agent can read,
3. dispatch ONE agent that produces 1 digest output,
4. persist the output pointer in state.

**Single-step primitive**: no fan-out, no per-item parallelism. /reduce is the "fold" of the toolkit — N in, 1 out.

## Input forms

### Form A — structured markdown file
```
/reduce --file path/to/spec.md
```
With YAML frontmatter (config + inputs) and a `## Task` section:
```markdown
---
run-id: audit-digest
model: opus
format: markdown
inputs:
  - run: enum-abc123          # pull results from this /enumerate run
  - run: enum-def456
  - file: ./extra-data.json   # raw JSON file
  - inline: {"note": "..."}   # inline data
---

## Task
<digest prompt — what synthesis to produce, output schema if json>
```

### Form B — inline flags
```
/reduce --from-run <enum-run-id> --task "<digest-prompt>" \
        [--from-file <path>]... [--from-run <id>]... \
        [--run-id NAME] [--model haiku|sonnet|opus] \
        [--format markdown|json] [--no-auto-continue]
```

If neither inputs nor task-prompt are provided → stop with a clear message.

## Step 0 — Load defaults

Read `${CLAUDE_PLUGIN_ROOT}/skills/reduce/defaults.md` (YAML frontmatter). Use defaults when CLI/spec do not provide a value.

**Override priority** (high → low):
1. CLI flag
2. Spec frontmatter (Form A)
3. defaults.md
4. Hardcoded fallback in the state helper

## Step 1 — Parse and validate

- Determine form A or B.
- If A: `Read` the spec, parse frontmatter (`inputs` list + config) and the `## Task` section.
- Resolve final config by priority.
- If `run-id` is missing: generate `red-<8 char hash>` from the hash of the task-prompt + inputs descriptor.

**Validate inputs**:
- Every entry has `source` in {`run`, `file`, `inline`}, with the right field (`run_id`, `path`, `data`).
- For `run` inputs: verify the referenced state exists (run `node "${CLAUDE_PLUGIN_ROOT}/dist/state/<cmd>.js" status <run-id>`). Warn if the upstream run has `failed` items but proceed (the digest agent will see them as `result: null`).

**Threshold guardrail** (autonomous invocation only): after resolving inputs, count the total result objects (sum of `done` items across run inputs + length of file inputs + length of inline inputs). If total < `min_inputs` (default 5) AND this is an autonomous invocation, STOP and use `AskUserQuestion`:
> "Only <N> total inputs to reduce. For this size, summarizing inline in chat is usually faster than running /reduce (which dispatches an agent and writes a file). Proceed with /reduce?"
> Options: **inline** (cancel /reduce, summarize directly in chat) | **proceed** (continue with /reduce)

If the user typed `/reduce` explicitly → skip the guardrail.

## Step 2 — Init state

Write the inputs descriptor to `.reduce/<run-id>/inputs-spec.json` (the parsed list). Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" init <run-id> \
  --inputs .reduce/<run-id>/inputs-spec.json \
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
  --out .reduce/<run-id>/inputs.json
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
  - inputs file path: `.reduce/<run-id>/inputs.json` (read this with the `Read` tool)
  - output file path: `.reduce/<run-id>/digest.<md|json>` (extension matches `output_format`)
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
  --output-path .reduce/<run-id>/digest.<md|json>
```

Otherwise:
```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/reduce.js" fail <run-id> --error "<short reason>"
```

If `auto_continue == true` and we failed mid-way (no output file), the Stop hook will re-trigger the next turn — re-dispatch from Step 4. The `auto_continues` cap (default 5) bounds the retry budget.

## Step 7 — Final report

Print a one-liner: `run-id`, `status`, `output_pointer`, byte size of the digest, `model` used. If `format: markdown`, optionally `Read` the first 30 lines and show them inline so the user does not have to open the file.

## Cross-turn auto-continue

A **Stop hook** (`${CLAUDE_PLUGIN_ROOT}/dist/hook/continue.js`) scans `.reduce/` (alongside other primitives). For /reduce, "residual work" = `status in {"pending", "in_progress"}` AND `auto_continues < max_auto_continues`. If you are re-activated by the hook with a /reduce run-id:
- DO NOT re-init.
- Read the state. If `status == in_progress` and the output file is absent → re-dispatch (Step 5).
- If the output file IS present → call `complete` (Step 6).

## Important rules

- **Single-writer**: only you (orchestrator) call `start`/`complete`/`fail`. The agent only writes the output file.
- **Materialize once per run**: `inputs.json` is built at init; if upstream runs change, the user must call `--force` to rebuild.
- **No partial digests**: either the file is fully written and `complete` is called, or it stays `failed`. Half-written outputs are discarded by `complete` (it requires the file to exist).
- **Idempotence**: re-running `/reduce` with the same run-id without `--force` resumes (re-dispatches if needed).

## Quick example

```
/reduce --from-run enum-a0b460e3 \
        --task "Group findings by severity. Top-5 hotspot files. Recurring patterns." \
        --model opus --format markdown
```

```
/reduce --file examples/audit-digest-spec.md
```
