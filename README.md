<div align="center">

# Agent Flow

**Describe a workflow in plain language — Agent Flow builds it, runs it, and keeps it running across turns.**

[![version](https://img.shields.io/badge/version-1.0.0--beta.1-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://code.claude.com/docs/en/plugins)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)

`agentflow` · a Claude Code plugin · `/agentflow:create-workflow` · `/agentflow:run-workflow`

</div>

---

## What it is

You tell Claude what you want done across many things — *"review every file in `src/`, group the
findings, write me one digest"* — and **Agent Flow turns it into a durable, resumable workflow**. Each
step is an LLM doing the work, but the **control flow is deterministic** and **every run is a state
file on disk** — so a long job survives parallelism, interruptions, and even context compaction.

> **You don't type the flags.** You describe the goal; the skill writes the exact commands. The
> `/agentflow:…` lines below show *what runs under the hood*, for transparency.

## The main way: describe → build → run

You say:

> *"Review every `.cs` file under `src/`, group the findings by area, and give me one digest."*

```text
/agentflow:create-workflow "review every .cs file in src → group findings by area → one digest"
```

Agent Flow designs the workflow, confirms a name with you, and writes a **self-contained, movable
folder** — the steps plus any helper script it needs, referenced relatively:

```text
workflows/code-review/
  workflow.json     ← the steps, wired together
  discover.mjs      ← a helper script (called via {{workflow.dir}}, so the folder is portable)
```

Then run it — now, or any time, on any machine:

```text
/agentflow:run-workflow workflows/code-review/workflow.json     # add --dry-run to preview first
```

It drives itself: deterministic steps run automatically, LLM steps dispatch agents, and the whole
thing **resumes across turns** if interrupted. The digest lands as a plain file in your workspace,
not buried in a hidden folder.

## Or: run a shipped recipe

`audit` is a ready-made workflow — discover files → review each → group by area → executive digest:

```text
/agentflow:audit --target src --file-glob "**/*.cs"
```

## Or: reach for a single primitive

When you just want **one operation over a list**, call the primitive directly — no workflow needed:

```text
/agentflow:foreach --folder tasks --prompt "Do the task described in this file"
```

Point `foreach` at a folder of task files and it works each one, **moving the file across
`todo/ → in-progress/ → done/`** automatically — a board you watch in your own file tree:

```text
   before                 …mid-run                 done
   tasks/                 tasks/                   tasks/
     todo/                  todo/                     done/
       refactor-auth.md       write-docs.md             refactor-auth.md
       add-tests.md         in-progress/                add-tests.md
       write-docs.md          add-tests.md              write-docs.md
                            done/
                              refactor-auth.md
```

Check progress any time — `/agentflow:board` shows what's in flight, with cost:

```text
=== Workspace board (1 active, 0 done, 0 failed) ===
ACTIVE (1):
  [foreach   ] tasks-run    2/3 done    updated 2026-05-24T10:42:07Z
```

## Under the hood — the primitives

`create-workflow` wires these together for you, but you can call any of them directly. They're the
functional vocabulary (`map` / `fold` / `group by` / `loop`), each a **persisted, resumable run**:

| Command | Like | What it does |
|---|---|---|
| `/agentflow:enumerate` | `unfold` (1→N) | Generate a list of items from a spec (outline → chapters) |
| `/agentflow:foreach` | `map` (N→N) | Apply a **prompt** to each item — inline or in parallel; `--serial`/`--carry`, `--shard`, per-item overrides, content-hash cache |
| `/agentflow:reduce` | `fold` (N→1) | Collapse N inputs into one digest (markdown or JSON) |
| `/agentflow:group` | `group by` | Partition N items into K groups — path-prefix / regex / jsonpath, or LLM-classify |
| `/agentflow:repeat` · `until` · `while` | `for` · `do…until` · `while…do` | Loop a stage by count, until a predicate, or while one holds |
| `/agentflow:pipe` | pipeline | Compose stages with declarative wiring + per-stage `when` guards |
| `/agentflow:create-workflow` · `run-workflow` | author · execute | Build a reusable workflow-folder · run one end to end (`--dry-run` to preview) |
| `/agentflow:inspect` · `board` · `history` | observe | Inspect a run · session dashboard · chronological run log |
| `/agentflow:audit` | recipe | A shipped workflow: discover → review → group → digest |

Sources are pluggable: a folder, a markdown checklist (`- [ ] task {model:opus}`), a JSON list, or
another run's output — same engine underneath.

## Install

```shell
# inside Claude Code
/plugin marketplace add AleSaiani/agentflow
/plugin install agentflow@agentflow
```

Local development (point Claude Code at a clone):

```shell
git clone https://github.com/AleSaiani/agentflow && cd agentflow
npm install && npm run build
claude --plugin-dir .
```

> Requires Node ≥ 22 and `git bash` on `PATH` (shell stages run under bash for POSIX semantics on every OS).

## Docs

**📚 Full docs in [`docs/`](docs/):** [Getting started](docs/getting-started.md) ·
[Concepts](docs/concepts.md) · [Cookbook](docs/cookbook.md) (real scenarios, simple → complex) ·
[Reference](docs/reference.md) (every skill, flag, and subcommand) ·
[Beta testing](docs/beta-test.md) (try it live).

## How it works (the short version)

Every run is a `state.json` under `.agentflow/<cmd>/<run-id>/`; Claude is the only writer. A `Stop` hook
finds any in-flight run and resumes it across turns — purely from disk, so runs survive compaction.
The control flow is deterministic; only the work *inside* each step is the LLM (**it produces
structured data; branching is always code over that data, never a judgment on free text**). The
engine is TypeScript compiled to a committed `dist/`, **zero runtime dependencies** (Node builtins
only). See [docs/concepts.md](docs/concepts.md) for the full model.

## Status

`1.0.0-beta.1`. Primitives, the workflow layer, inspect/board, and the Stop hook are implemented and
covered by an automated suite (including a simulated cross-turn resumption loop). A **live multi-turn
Claude Code session smoke test** is the recommended final check before relying on it in production.
Roadmap and deferred items live in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) © 2026 Alessandro Saiani
