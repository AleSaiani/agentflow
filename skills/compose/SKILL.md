---
name: compose
description: |
  Author a reusable workflow-file by composing the Flow primitives (enumerate, foreach, group, reduce, iterate) and bash/json stages into a declarative JSON `WorkflowSpec`, then validate it — ready to run with `/flow:run`. The builder counterpart to `/flow:run`.

  USE when the user wants to design / create / scaffold a multi-step workflow ("build a workflow that…", "create a pipeline for…", "compose a flow that does X then Y"), especially one to save and reuse.

  DO NOT use for a one-off single step — call the primitive directly. `compose` is for durable, reusable multi-stage flows.
allowed-tools: Bash, Read, Write
argument-hint: "<describe the workflow>" [--name NAME]
---

# /flow:compose — author a workflow-file

> **Make it visible:** tell the user in one line when you start authoring (and the target file path),
> so it's clear this skill is running.

You design a `WorkflowSpec` JSON that wires the primitives, save it to `workflows/<name>.json`,
validate it, and hand it to `/flow:run`. Compiles 1:1 into a `/flow:pipe` — no new engine.

## WorkflowSpec shape

```jsonc
{
  "name": "my-flow",
  "description": "...",
  "config": { "context_policy": "summary", "max_auto_continues": 50, "stop_on_failure": true },
  "stages": [ /* Stage[] */ ]
}
```

A **Stage**:

```jsonc
{
  "name": "unique-name",                                  // required to wire references
  "type": "bash" | "json" | "primitive",
  "when": { "type": "bash", "command": "<predicate>" },   // optional guard: exit 0 runs, non-zero skips
  "spec": { /* type-specific, below */ }
}
```

- **bash** → `{ "command": "<shell; write to $PIPE_OUTPUT_PATH>", "output_path"?: "..." }`
- **json** → `{ "value": <any JSON; string leaves resolve templates>, "output_path"?: "..." }`
- **primitive** → `{ "cmd": "enumerate|foreach|group|reduce|iterate", "init_args": [ ... ] }`

## Wiring templates (resolved by /flow:pipe at run time)

`{{run.id}}` · `{{run.dir}}` · `{{stages.<name>.result_pointer}}` · `{{stages.<name>.run_id}}`
— optional filters: `|json` `|shell` `|raw`. Forward references stay literal until they resolve.

## The primitives as stages

| cmd | role | key init_args |
|---|---|---|
| `enumerate` | unfold 1→N (generate a list) | `--prompt "<gen instructions>" [--input <path>]` → produces items.json |
| `foreach` | map N→N (op per item) | `--items {{stages.X.result_pointer}} --prompt "<op>" [--kind ...] [--execution main-thread\|subagent]` |
| `group` | partition | `--method path-prefix\|regex\|jsonpath\|llm-classify --input-source <descriptor> [--method-config '{...}']` |
| `reduce` | fold N→1 | `--inputs <descriptor> --prompt "<synthesis>" --output-format markdown\|json` |
| `iterate` | loop (or use a bash stage that calls iterate.js) | `--stage '{...}' --stop '{...}'` |

Bridge primitives with small **json** stages that build input descriptors, e.g.
`{ "source": "run", "cmd": "foreach", "run_id": "{{stages.review.run_id}}" }`.

## Determinism boundary

A stage's `when` guard is **deterministic bash over data the previous steps produced**. If a decision
is fuzzy, make it a step whose **structured output** a later guard reads — never branch on free text.

## Process

1. Clarify the goal and the steps (ask if ambiguous — what's the input, what's processed per item,
   what's the final artifact).
2. Draft `stages`: typically *produce a list* (bash discover or `enumerate`) → *process it*
   (`foreach` / `group`) → *synthesize* (`reduce`), bridged by `json` stages and wired with `{{…}}`.
3. `Write` it to `workflows/<name>.json`.
4. Validate + preview (no execution):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <name>-check --workflow workflows/<name>.json --force
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" plan <name>-check
   ```
5. Surface the plan, then tell the user to run it: `/flow:run workflows/<name>.json`.

See `workflows/audit.json` for a complete worked example (discover → foreach review → group → reduce digest).
