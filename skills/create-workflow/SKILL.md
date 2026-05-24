---
name: create-workflow
description: |
  Author a reusable workflow-file by composing the Agent Flow primitives (enumerate, foreach, group, reduce, iterate) and bash/json stages into a declarative JSON `WorkflowSpec`, then validate it — ready to run with `/agentflow:run-workflow`. The builder counterpart to `/agentflow:run-workflow`.

  USE when the user wants to design / create / scaffold a multi-step workflow ("build a workflow that…", "create a pipeline for…", "compose a flow that does X then Y"), especially one to save and reuse.

  DO NOT use for a one-off single step — call the primitive directly. `create-workflow` is for durable, reusable multi-stage flows.
allowed-tools: Bash, Read, Write
argument-hint: "<describe the workflow>" [--name NAME]
---

# /agentflow:create-workflow — author a workflow-file

> **Make it visible:** tell the user in one line when you start authoring (and the target file path),
> so it's clear this skill is running.

You design a `WorkflowSpec` JSON that wires the primitives, save it as a **self-contained folder**
`workflows/<name>/workflow.json` (with any helper scripts alongside it), validate it, and hand it to
`/agentflow:run-workflow`. Compiles 1:1 into a `/agentflow:pipe` — no new engine.

**Self-contained & movable.** A workflow lives in its own folder; any script a `bash` stage needs
(e.g. a discover/fetch helper) is written **into that same folder** and referenced via the
`{{workflow.dir}}` template — never an absolute path or a shared `workflows/` script. Move the folder
anywhere (another repo, another machine) and it still runs.

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

## Wiring templates (resolved by /agentflow:pipe at run time)

`{{run.id}}` · `{{run.dir}}` · `{{workflow.dir}}` (the folder this workflow-file lives in — use it to
call sibling scripts: `node "{{workflow.dir}}/discover.mjs"`) · `{{stages.<name>.result_pointer}}` ·
`{{stages.<name>.run_id}}` — optional filters: `|json` `|shell` `|raw`. Forward references stay
literal until they resolve.

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
2. **Confirm the name** — the folder name matters (it's how the workflow is run and reused). Propose a
   default derived from the goal (or `--name` if given) and offer a custom one via `AskUserQuestion`:
   *"Save this workflow as `<deduced>`? (or pick a name)"* — options: the deduced name (recommended),
   "let me type one". Slugify the final choice to `<name>` (lowercase, kebab-case).
3. Draft `stages`: typically *produce a list* (bash discover or `enumerate`) → *process it*
   (`foreach` / `group`) → *synthesize* (`reduce`), bridged by `json` stages and wired with `{{…}}`.
   If a `bash` stage needs a helper script, plan to `Write` it into `workflows/<name>/` and call it via
   `{{workflow.dir}}/<script>`.
4. `Write` the spec to `workflows/<name>/workflow.json`, and `Write` each helper script into the same
   `workflows/<name>/` folder. Use only `{{workflow.dir}}`-relative references to those scripts.
5. Validate + preview (no execution):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <name>-check --workflow workflows/<name>/workflow.json --force
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" plan <name>-check
   ```
   The `plan` output shows `{{workflow.dir}}` already resolved to the folder's absolute path — confirm
   the script references look right.
6. Surface the plan, then tell the user to run it: `/agentflow:run-workflow workflows/<name>/workflow.json`.

See `workflows/audit/workflow.json` for a complete worked example (discover via `{{workflow.dir}}/discover.mjs`
→ foreach review → group → reduce digest).
