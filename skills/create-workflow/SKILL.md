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

You author a **`WORKFLOW.md`** — a human-readable markdown file (frontmatter + one heading per stage,
coherent with `SKILL.md`) — save it as a **self-contained folder** `workflows/<name>/WORKFLOW.md`
(with any helper scripts alongside it), validate it, and hand it to `/agentflow:run-workflow`. A
deterministic parser compiles it 1:1 into a `/agentflow:pipe` — no new engine, no LLM at run time.
(A `.json` WorkflowSpec is still accepted by the engine, but `WORKFLOW.md` is the format to author.)

**Self-contained & movable.** A workflow lives in its own folder; any script a `bash` stage needs
(e.g. a discover/fetch helper) is written **into that same folder** and referenced via the
`{{workflow.dir}}` template — never an absolute path or a shared `workflows/` script. Move the folder
anywhere (another repo, another machine) and it still runs.

**Input** — you can author from a plain description **or from a file**: if the user passes a path (e.g.
`/agentflow:create-workflow ./notes.md`), read that file with `Read` and treat its contents as the
description. (Since `WORKFLOW.md` *is* the readable source, "editing" a workflow is just editing its
md, or re-running this skill on it; a re-derivation may differ slightly — that's expected.)

## WORKFLOW.md format

```markdown
---
name: my-flow
description: One line on what this does.
params:                                    # optional: per-invocation inputs
  target: { required: true, description: ... }   # required → must be passed with --param
  glob:   { default: "**/*" }                    # default used when --param omitted
  exclude: ""                                    # bare value = its default
config: { stop_on_failure: true, max_auto_continues: 50 }
---

## 1. <stage-name> · bash            # heading: "## [n.] <name> · <type>"  (or "<name> (<type>)")
Prose here is ignored — use it for human notes.
```sh
<shell that writes to "$PIPE_OUTPUT_PATH">
```
- output_path: {{run.dir}}/out.json

## 2. <stage-name> · foreach          # a primitive: each bullet → an init_arg
- items: {{stages.1-stage-name.result_pointer}}
- prompt: <the per-item operation>
- cache: true                         # bare `true` → the flag alone (--cache)

## 3. <stage-name> · json
- value: { "source": "run", "cmd": "foreach", "run_id": "{{stages.2-stage-name.run_id}}" }
- output_path: {{run.dir}}/bundle.json
```

**Stage types** (`## name · <type>`): `bash` (a ```sh fence is the command), `json` (a `- value:`
bullet or a ```json fence), or a primitive — `enumerate` | `foreach` | `group` | `reduce` | `iterate` |
`step` (each `- key: value` bullet becomes `--key value`; a bare `true` becomes the flag alone). Any
stage may carry `- when: <bash predicate>` (a guard: exit 0 runs, non-zero skips). A `· step` stage runs
one prompt with a chosen `- runtime:` (`main`/`subagent`/`claude-cli`/`codex-cli`) — the way to invoke
an arbitrary skill, an MCP-using agent, `claude -p`, or a different model as a step.

**Params** make a workflow reusable without editing it: declare them in frontmatter, reference them as
`{{params.<name>}}` in any stage (use `|shell` when injecting into a `bash` command), and the user
supplies values at run time with `--param name=value`. Prefer params over hardcoded paths/globs. A
param may declare a **`type`** (`string`/`number`/`integer`/`boolean`) and/or an **`enum`**
(`{ enum: [prod, staging] }`) — validated + coerced at run start, so a bad input fails fast.

## Wiring templates (resolved by /agentflow:pipe at run time)

`{{run.id}}` · `{{run.dir}}` · `{{workflow.dir}}` (the folder this workflow-file lives in — use it to
call sibling scripts: `node "{{workflow.dir}}/discover.mjs"`) · `{{params.<name>}}` (a declared
parameter) · `{{stages.<name>.result_pointer}}` · `{{stages.<name>.run_id}}` — optional filters:
`|json` `|shell` `|raw`. Forward references stay literal until they resolve.

## The primitives as stages

Each `## name · <cmd>` stage's bullets become that primitive's flags (`- key: value` → `--key value`):

| cmd | role | key bullets |
|---|---|---|
| `enumerate` | unfold 1→N (generate a list) | `- prompt: <gen instructions>` · `- input: <path>` → produces items.json |
| `foreach` | map N→N (op per item) | `- items: {{stages.X.result_pointer}}` · `- prompt: <op>` · `- kind: …` · `- serial: true` |
| `group` | partition | `- method: path-prefix\|regex\|jsonpath\|llm-classify` · `- input-source: <descriptor>` · `- method-config: {…}` |
| `reduce` | fold N→1 | `- inputs: <descriptor>` · `- prompt: <synthesis>` · `- output-format: markdown\|json` |
| `iterate` | loop | `- stage: <cmd>` · `- stop: <predicate>` (or use a `bash` stage that calls iterate.js) |
| `step` | one unit | `- runtime: main\|subagent\|claude-cli\|codex-cli` · `- prompt: <text>` · `- model: …` |

Bridge primitives with small **json** stages that build input descriptors, e.g. a `- value:`
of `{ "source": "run", "cmd": "foreach", "run_id": "{{stages.review.run_id}}" }`.

## Determinism boundary

A stage's `when` guard is **deterministic bash over data the previous steps produced**. If a decision
is fuzzy, make it a step whose **structured output** a later guard reads — never branch on free text.

To harden that, a `bash` or `json` stage may declare **`- output-schema: { … }`** (a restricted
JSON-schema: `type`, `required`, `properties`, `items`, `enum`). The engine validates the stage's JSON
output before advancing; on mismatch the stage fails with a precise path (e.g. `$.severity: not in
enum`). Use it on the step that produces the data a later guard branches on.

**Resilience (bash stages).** A stage may declare `- retries: N` (re-run on non-zero exit, up to N
extra attempts) and `- timeout: <seconds>` (each attempt is killed past the limit → fails with exit
124). Use them on stages that call flaky networks/CLIs so a transient failure doesn't sink the run.

**Branching (fork).** A stage's `- next:` routes the flow: a stage name jumps there; a `- route:` array
of `{ when: <bash predicate>, goto: <stage> }` rules takes the first whose `when` exits 0 (a rule with
no `when` is the default/else). Forward jumps skip the not-taken branch's stages. For loops/back-edges,
use `/agentflow:until` (the loop engine), not a backward `goto`.

```markdown
## judge · step
- runtime: claude-cli
- prompt: Output JSON {"blocking": <bool>} for the diff at {{stages.diff.result_pointer}}.
- output-schema: { type: object, required: [blocking] }
- route: [ { "when": "[ \"$(jq -r .blocking {{stages.judge.result_pointer}})\" = true ]", "goto": "fix" }, { "goto": "ship" } ]
```

## Process

1. Clarify the goal and the steps (ask if ambiguous — what's the input, what's processed per item,
   what's the final artifact).
2. **Confirm the name** — the folder name matters (it's how the workflow is run and reused). Propose a
   default derived from the goal (or `--name` if given) and offer a custom one via `AskUserQuestion`:
   *"Save this workflow as `<deduced>`? (or pick a name)"* — options: the deduced name (recommended),
   "let me type one". Slugify the final choice to `<name>` (lowercase, kebab-case).
3. Draft the stages: typically *produce a list* (bash discover or `enumerate`) → *process it*
   (`foreach` / `group`) → *synthesize* (`reduce`), bridged by `json` stages and wired with `{{…}}`.
   If a `bash` stage needs a helper script, plan to `Write` it into `workflows/<name>/` and call it via
   `{{workflow.dir}}/<script>`.
4. `Write` the `WORKFLOW.md` to `workflows/<name>/WORKFLOW.md`, and `Write` each helper script into the
   same `workflows/<name>/` folder. Use only `{{workflow.dir}}`-relative references to those scripts.
5. Validate + preview (no execution):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" init <name>-check --workflow workflows/<name>/WORKFLOW.md --force
   node "${CLAUDE_PLUGIN_ROOT}/dist/state/pipe.js" plan <name>-check
   ```
   The `plan` output shows the parsed stages with `{{workflow.dir}}` resolved to the folder's absolute
   path — confirm the stage types, init_args, and script references look right.
6. Surface the plan, then tell the user to run it: `/agentflow:run-workflow workflows/<name>/WORKFLOW.md`.

See `workflows/audit/WORKFLOW.md` for a complete worked example (discover via `{{workflow.dir}}/discover.mjs`
→ foreach review → group → reduce digest).

## Readable by design — no separate export

`WORKFLOW.md` *is* the human-readable artifact, so there's nothing to export: read it, diff it in PRs,
edit it by hand, or feed it back to this skill to re-derive. The engine compiles it deterministically
at run time; you don't keep a separate `.json`. (If a `.json` WorkflowSpec turns up, it still runs —
the engine accepts either — but author in `WORKFLOW.md`.)
