# Changelog

All notable changes to `enumerate-skill` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-23

### Added
- Project scaffold: TypeScript (strict, ESM/NodeNext) build to committed `dist/`,
  Apache-2.0 license, plugin manifest, and self-hosted marketplace catalog.
- Core (`src/common.ts`): typed base state, atomic I/O, workspace-root resolution,
  primitive registry, budget tracking, content-hash cache, knowledge journals.
- Five primitives: `enumerate` (per-item overrides + checkbox source + cache),
  `group` (deterministic + llm-classify), `reduce`, `iterate` (predicate stop +
  convergence + kill switch), `pipe` (composer with declarative wiring templates).
- Workflow layer: `Source`/`View` seam (inline | file | run | checkbox), per-stage
  `when` guard (conditional steps), and a declarative JSON workflow-file that compiles
  into `pipe.stages[]` (`pipe init --workflow`). Graph `next` edge carried in schema.
- `inspect` (runs / show / tree / budget / timeline) and `board` dashboard.
- Generalized `Stop` hook for cross-turn auto-continue, wired via `hooks/hooks.json`.
- `code-audit-deep` recipe re-expressed as the first declarative workflow-file, plus
  the `examples/fake-repo` corpus.
- Test suite (Node's built-in `node:test`) including a simulated cross-turn loop.

[0.1.0]: https://github.com/AleSaiani/enumerate-skill/releases/tag/v0.1.0
