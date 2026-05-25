# Contributing to Agent Flow

Thanks for your interest in improving Agent Flow! Issues and pull requests are welcome.

## Development setup

Requirements: **Node ≥ 22** and **Git Bash** (shell stages run under bash for POSIX semantics on every
OS).

```shell
git clone https://github.com/AleSaiani/agentflow && cd agentflow
npm install
npm run build      # compile src/ → dist/
npm test           # tsc + node --test over test/**
npm run validate   # claude plugin validate .
```

To try it live, point Claude Code at your clone:

```shell
claude --plugin-dir .
```

## Project layout

| Path | What lives there |
|---|---|
| `src/` | TypeScript engine — one CLI per primitive in `src/state/`, plus `common.ts`, hooks, inspect |
| `dist/` | **Committed** compiled JS (the plugin runs this via `node`) |
| `skills/` | The `/agentflow:*` skills (`SKILL.md` per command) |
| `workflows/` | Shipped `WORKFLOW.md` recipes |
| `hooks/` | Stop / PreCompact / SessionEnd hook wiring |
| `test/` | `node --test` suites |
| `docs/` | Documentation |

## The `dist/` rule (important)

`dist/` is committed on purpose — the plugin ships zero runtime dependencies and runs the compiled JS
directly. **If you change anything under `src/`, run `npm run build` and commit the regenerated `dist/`
in the same PR.** CI enforces this with a dist-freshness check; a PR with stale `dist/` will fail.

## Conventions

- **Zero runtime dependencies.** Node builtins only (`fs`, `path`, `crypto`, `child_process`,
  `util.parseArgs`). Dev-only dependencies are fine.
- **TypeScript**: strict, ESM/NodeNext, `erasableSyntaxOnly`.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Add or update tests for behavior changes; keep the suite green.

## Pull requests

1. Branch off `main`.
2. Make the change; add tests; run `npm test` and `npm run validate`.
3. Rebuild `dist/` if you touched `src/`.
4. Open a PR using the template; describe what and why, and link any related issue.

## Reporting bugs & ideas

Use the issue templates (bug report / feature request). For **security** problems, follow
[SECURITY.md](SECURITY.md) — do not open a public issue.

By contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.
