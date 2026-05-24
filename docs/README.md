# Agent Flow documentation

Start here.

| Page | What it covers |
|---|---|
| **[Getting started](getting-started.md)** | Install, see the engine work in ~10s (no LLM), your first real run. |
| **[Concepts](concepts.md)** | The mental model: runs as state on disk, the Stop hook, the determinism boundary, the workflow layer, preserve-chat. |
| **[Cookbook](cookbook.md)** | Real scenarios — one command → compose two → full workflow → operating at scale → composing operators. The fastest way to learn what's possible. |
| **[Reference](reference.md)** | Every command, flag, and CLI subcommand; the WORKFLOW.md schema; sources & views; conventions. |
| **[Beta testing](beta-test.md)** | A graded protocol to verify the promises live — including how automatic cross-turn resume works and how to confirm it. |

New here? Read **Getting started**, skim **Concepts**, then keep the **Cookbook** open and copy from it.
The headline idea: **`enumerate` makes a list → `foreach` works each item → `reduce` digests** — with
`group`, the loop trio (`repeat`/`until`/`while`), and `step` as a single unit, all composed by `pipe`
and authored as a reusable **`WORKFLOW.md`** via `create-workflow`/`run-workflow`.

## Command index

Jump to a command's full entry in the [Reference](reference.md).

**Author & run workflows** — [`create-workflow`](reference.md#create-workflow--author-a-workflow-file) ·
[`run-workflow`](reference.md#run-workflow--execute-a-workflow-file) ·
[`workflows`](reference.md#quick-map) · [`audit`](reference.md#quick-map)

**Primitives** — [`enumerate`](reference.md#enumerate--unfold-1--n) ·
[`foreach`](reference.md#foreach--map-n--n) · [`reduce`](reference.md#reduce--fold-n--1) ·
[`group`](reference.md#group--partition) · [`repeat`/`until`/`while`](reference.md#loops--repeat--until--while-engine-iterate) ·
[`step`](reference.md#step--one-llmwork-unit-any-runtime) · [`pipe`](reference.md#pipe--compose)

**Scale, coordinate & observe** — [`queue`](reference.md#queue--shared-work-queue-many-workers-no-locks) ·
[`mailbox`](reference.md#quick-map) · [`inspect` / `board` / `history`](reference.md#inspecting) ·
[`notify`](reference.md#quick-map)

## Key capabilities (and where they're documented)

- **Durable, cross-turn runs** + **preserve-chat** → [Concepts](concepts.md)
- **WORKFLOW.md format**, **params** (`--param`), **fork** routing, **output_schema** → [Reference: Workflow-file schema](reference.md#workflow-file-schema) · authored via [`create-workflow`](reference.md#create-workflow--author-a-workflow-file)
- **Step runtimes** (`main`/`subagent`/`claude-cli`/`codex-cli`) & cross-model → [Reference: `step`](reference.md#step--one-llmwork-unit-any-runtime) · [Cookbook §19](cookbook.md)
- **Sharding, the shared queue, mailboxes** → [Cookbook §12c–12d](cookbook.md) · [Reference: `queue`](reference.md#queue--shared-work-queue-many-workers-no-locks)
- **Cost caps, pause (`--stop-file`), notifications** → [Cookbook §14](cookbook.md) · [Reference: conventions](reference.md#conventions)
