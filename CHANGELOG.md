# Changelog

All notable changes to `flow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.1] - 2026-05-23

First public beta. Brand: **Flow** (`/flow:*`), distributed as `flow@flow-cc`.

### Added
- Project scaffold: TypeScript (strict, ESM/NodeNext) build to committed `dist/`,
  Apache-2.0 license, plugin manifest, and self-hosted marketplace catalog.
- Core (`src/common.ts`): typed base state, atomic I/O, workspace-root resolution,
  primitive registry, budget tracking, content-hash cache, knowledge journals.
- A programmatic primitive vocabulary (unfold / map / fold / partition / loop):
  - `enumerate` — **unfold** (1→N): generate an items list from a spec.
  - `foreach` — **map** (N→N): apply an operation per item; the op is a `--prompt`, with
    `--model`/`--subagent-type` optional and `--execution main-thread|subagent`; per-item overrides,
    checkbox source, content-hash cache.
  - `reduce` — **fold** (N→1) · `group` — partition (deterministic + llm-classify).
  - `iterate` engine surfaced as three loop skills: `repeat` (fixed count, `--times`),
    `until` (do…until), `while` (while…do, `--check-first`); hard cap + convergence + kill switch.
  - `pipe` — composer with declarative wiring templates and a `plan` dry-run.
- `run` (execute a workflow-file end to end, `--dry-run`) and `compose` (author a workflow-file
  from the primitives).
- Workflow layer: `Source`/`View` seam (inline | file | run | checkbox), per-stage
  `when` guard (conditional steps), and a declarative JSON workflow-file that compiles
  into `pipe.stages[]` (`pipe init --workflow`). Graph `next` edge carried in schema.
- `inspect` (runs / show / tree / budget / timeline) and `board` dashboard.
- Generalized `Stop` hook for cross-turn auto-continue, wired via `hooks/hooks.json`.
- `audit` recipe re-expressed as the first declarative workflow-file, plus
  the `examples/fake-repo` corpus.
- Test suite (Node's built-in `node:test`) including a simulated cross-turn loop.
- Documentation: branded README, `docs/getting-started.md`, `docs/concepts.md`, and a
  runnable no-LLM demo workflow (`examples/workflows/demo.json`).

[1.0.0-beta.1]: https://github.com/AleSaiani/flow-cc/releases/tag/v1.0.0-beta.1
