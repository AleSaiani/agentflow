---
name: enumerate
description: |
  Generate a list of items from a higher-level spec — the **unfold** (1→N) primitive. Turn an outline into chapters, a feature into tasks, a goal into a checklist. Output is an items.json array that `/flow:foreach` (map) or `/flow:group` (partition) consume. The complement of `/flow:reduce` (N→1).

  USE this skill when:
  - the user wants to expand/break down a spec into a structured list to process next ("break this outline into chapters", "list the tasks for this feature", "turn this goal into a checklist");
  - producing the list itself needs judgment (not a deterministic glob/file listing — that is a plain Source, not /enumerate);
  - the natural next step is to process each generated item (`/flow:foreach`) or partition them (`/flow:group`).

  DO NOT use when:
  - the list already exists (a file, a glob, a markdown checklist) — feed that Source directly to `/flow:foreach`;
  - you only need a single synthesized output, not a list — use `/flow:reduce`.

  Explicit user invocation: `/flow:enumerate --prompt "<generation instructions>" [--input <source material>]`.
allowed-tools: Bash, Read, Write, Agent
argument-hint: --prompt "<instructions>" [--input <path>] [--model haiku|sonnet|opus] [--execution main-thread|subagent]
---

# /flow:enumerate — unfold (1 → N)

Produce a JSON array of items from a spec. You are the single writer of run state; the generator
agent only writes the items file.

## Step 1 — init

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" init <run-id> \
  --prompt "<generation instructions>" \
  [--input <path-to-source-material>] \
  [--model haiku|sonnet|opus|inherit] \
  [--execution main-thread|subagent]
```

`--prompt` is the core config (the instructions for what list to produce). `--input` optionally
points at source material to expand (an outline, a spec, a transcript). Model and subagent are
optional.

## Step 2 — generate the list

Mark the run started, then produce the items:

- **execution = subagent** (default): dispatch ONE `Agent` that reads the run's `task_prompt`
  (and `--input` content if set) and **writes a JSON array** to a file.
- **execution = main-thread**: produce the array yourself inline and `Write` it to the file — no
  subagent. Use this for cheap/short generations.

Each element is `{"id": "<stable-id>", "data": { ... }}`. Give items **human-stable ids** (e.g. a
slug) so re-runs and downstream views line up.

## Step 3 — complete

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/state/enumerate.js" complete <run-id> --items-path <file>
```

Validates the file is a JSON array and records it as the run's `result_pointer`.

## Step 4 — hand off

The items.json is now consumable:
- `/flow:foreach --items <file>` to apply an operation to each item;
- `/flow:group --input-source <descriptor>` to partition them;
- inside a `/flow:pipe`, wire `{{stages.<this-stage>.result_pointer}}` into the next stage's input.

## Output schema

A JSON array. Minimal item: `{"id": "ch-1", "data": {"title": "Introduction", "brief": "..."}}`.
`data` carries whatever the downstream operation needs (a prompt, a path, a spec).
