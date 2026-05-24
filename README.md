<div align="center">

# Flow

**Deterministic, composable iteration & workflows for Claude Code — durable across turns.**

[![version](https://img.shields.io/badge/version-1.0.0--beta.1-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://code.claude.com/docs/en/plugins)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)

`flow-cc` · a Claude Code plugin · invoke as `/flow:enumerate` · `/flow:pipe` · `/flow:audit`

</div>

---

**Flow** gives an LLM the control-flow you'd reach for in code — `for each`, `reduce`, `group by`,
`while`, and pipelines — as **durable, resumable operations**. State lives on disk, a Stop hook
carries loops across turns and context compaction, and a declarative workflow-file wires the
primitives into reusable pipelines.

Think of it as a **structured, durable "Ralph loop"**: not a blind while-loop over a task list, but
an engine where the *worker* is an LLM and the *control flow* is deterministic code. The rule that
keeps "deterministic" honest: **the LLM produces structured data; branching is always evaluated by
code — never on free text.**

## See it work — no LLM, ~10 seconds

A fully deterministic pipeline (emit items → build a descriptor → partition by path). `drive`
auto-runs every stage to completion with **zero agent dispatches**:

```console
$ node dist/state/pipe.js init demo --workflow examples/workflows/demo.json
{"run_id":"demo","stages":3,...}

$ node dist/state/pipe.js drive demo
{"action":"done","steps_taken":5,...}

$ node dist/inspect.js show demo --cmd group   # the partition child
# → groups: lib (1 item), src (2 items)
```

That's the engine. Swap the deterministic stages for `/flow:foreach` (per-file LLM review) and
`/flow:reduce` (digest) and you have the `audit` recipe — same machinery, agents only where needed.

## Highlights

- **A programmatic vocabulary** — `enumerate` (unfold 1→N), `foreach` (map N→N), `reduce` (fold N→1),
  `group` (partition), `repeat` / `until` / `while` (loop) — each a persisted, resumable run.
- **Durable across turns** — a Stop hook auto-resumes in-flight runs; state survives compaction
  because it lives in `state.json`, not the conversation.
- **Composable** — `/flow:pipe` chains stages with declarative wiring and per-stage **conditional
  guards** (`when`); `/flow:compose` authors reusable workflow-files, `/flow:run` executes them.
- **Human-readable sources** — drive a run from a markdown checklist (`- [ ] task {model:opus}`).
- **Operation = a prompt** — the per-item op is instructions; model and subagent are optional, and
  work can run inline in the main thread instead of fanning out.
- **Zero runtime dependencies** — Node builtins only; ships compiled, runs anywhere Node ≥ 22 runs.

## Primitives

| Command | Like | What it does |
|---|---|---|
| `/flow:enumerate` | `unfold` (1→N) | Generate a list of items from a spec (outline → chapters); produces an items.json |
| `/flow:foreach` | `map` (N→N) | Apply one operation to each item — inline or parallel subagents; per-item overrides + content-hash cache |
| `/flow:reduce` | `fold` (N→1) | Collapse N inputs into 1 digest (markdown or JSON) |
| `/flow:group` | `group by` | Partition N items into K groups — path-prefix / regex / jsonpath, or LLM-classify |
| `/flow:repeat` · `until` · `while` | `for` · `do…until` · `while…do` | Loop a stage a fixed count, until a predicate, or while one holds (one engine) |
| `/flow:pipe` | pipeline | Compose stages; declarative wiring + `when` guards; `plan` for a dry-run |
| `/flow:run` · `compose` | — | Run a workflow-file end to end (`--dry-run` to preview) · author one from the primitives |
| `/flow:inspect` · `board` | — | Read-only: inspect a run / session-start dashboard |
| `/flow:audit` | recipe | discover → review → partition → executive digest, as a declarative workflow-file |

## The workflow layer

- **Source / View** — items come from an inline list, a JSON file, another run's output, or a
  **markdown checklist**; a View can reflect state back onto the checklist (`[ ]` ↔ `[x]`).
- **Conditional steps** — a pipe stage's `when` guard (a bash predicate) decides run-vs-skip.
- **Workflow-files** — a declarative JSON `WorkflowSpec` compiles 1:1 into the pipe's stages, so you
  version and reuse pipelines (see [`workflows/audit.json`](workflows/audit.json)).

## Install

```shell
# inside Claude Code
/plugin marketplace add AleSaiani/flow-cc
/plugin install flow@flow-cc
```

Local development (point Claude Code at a clone):

```shell
git clone https://github.com/AleSaiani/flow-cc && cd flow-cc
npm install && npm run build
claude --plugin-dir .
```

> Requires Node ≥ 22 and `git bash` on `PATH` (pipe/iterate run shell stages under bash for POSIX
> semantics on every OS).

## Cookbook

```text
# Review every C# file under a folder, then produce an executive digest (a shipped recipe):
/flow:audit --target src --file-glob "**/*.cs"

# Process a markdown checklist in parallel (each line becomes an item):
/flow:foreach --checkbox TODO.md

# Generate a list, then act on it (unfold → map):
/flow:enumerate --prompt "Break this outline into chapters"   # → items.json
/flow:foreach --items <items.json> --prompt "Draft each chapter"

# Loop until the build passes (do…until); or while a queue stays non-empty (while…do):
/flow:until    # stage "npm run build", stop "exit 0"

# Author a reusable workflow, then run it:
/flow:compose "discover files → review each → digest"
/flow:run workflows/<name>.json    # add --dry-run to preview the plan first

# See what's in flight after reopening the workspace:
/flow:board
```

**📚 Full docs in [`docs/`](docs/):** [Getting started](docs/getting-started.md) ·
[Concepts](docs/concepts.md) · [Cookbook](docs/cookbook.md) (real scenarios, simple → complex) ·
[Reference](docs/reference.md) (every skill, flag, and subcommand).

## How it works

Each run is a `state.json` under `.<cmd>/<run-id>/` at the workspace root; the orchestrator (Claude)
is the only writer. A `Stop` hook scans every run and, if one has `auto_continue` and residual work
(under its cap), blocks the turn and tells Claude how to resume — purely from disk, so runs survive
compaction. `/flow:pipe` reads its children's state to decide when to advance and never mutates them;
`pipe drive` auto-runs every bash, json, and deterministic stage, stopping only when an agent
dispatch is genuinely needed.

## Architecture

TypeScript (strict, ESM/NodeNext) compiled to a committed `dist/`, run with `node`. **Zero runtime
dependencies** — Node builtins only (`fs`, `path`, `crypto`, `child_process`, `util.parseArgs`). The
registry in `src/common.ts` is the composition contract every primitive registers into: add one and
the Stop hook and `/flow:pipe` pick it up automatically.

```shell
npm install      # dev deps only (typescript, @types/node)
npm run build    # tsc → dist/
npm test         # node:test (builds first)
```

## Status

`1.0.0-beta.1`. Primitives, the workflow layer, inspect/board, and the Stop hook are implemented and
covered by an automated suite, including a simulated cross-turn resumption loop (each turn a fresh
process reading only disk state). The Stop hook output contract is verified against current docs; a
**live multi-turn Claude Code session smoke test** is the recommended final check before relying on
it in production. Roadmap and deferred items (YAML front-end, folder-kanban source, branch/back-edge
runtime, Codex adapter) live in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) © 2026 Alessandro Saiani
