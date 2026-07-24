# Agent Flow — working agreements

Project-level instructions for any agent/session working in this repo. Keep it short; the machine
enforces what it can, this file covers only what it can't.

## Principles (locked — see `docs/concepts.md`)

- **Determinism boundary** — the LLM produces *structured data*; branching is always **code** over that
  data, never a judgment on free text.
- **State on disk = durability** — every run is a `state.json`; the Stop hook resumes across turns and
  compaction. This is the project's moat: native Claude Code Workflows resume only *within* a session.
- **Zero runtime dependencies** — TypeScript → committed `dist/`, Node builtins only. Never add a
  runtime dep; dev/CI deps only.
- **Prefer a gate to a rule.** A convention that lives only in prose is an open loop. If a mistake can
  be caught by a test, write the test instead of writing the rule.

## Releasing

The release is a **tagged GitHub Release** (`release.yml` on a `v*.*.*` tag) that the Claude Code
marketplace pulls. There is no npm package.

**Four files must agree on the version.** Three are enforced by `test/manifest.test.ts`; the fourth
(the git tag) is on you:

| File | Why it matters |
|---|---|
| `package.json` | the build/test entry point |
| `.claude-plugin/plugin.json` | **what the marketplace actually reads** — miss this and the release ships invisible |
| `CHANGELOG.md` | newest entry must be the version being released |
| `README.md` badge | what a visitor sees |

### Checklist

1. **Bump the version in `package.json` AND `.claude-plugin/plugin.json`.** Never only one.
2. **Add the `CHANGELOG.md` entry** — newest first, under `## [Unreleased]`.
   **Date it with today's real date** (`date +%F`). Do *not* copy the previous entry's date.
3. **Update the README badge** + the test count in the Status section.
4. **`npm test` must be green** — it is the release gate (`release.yml` runs it before publishing) and
   it enforces items 1-3.
5. **Commit, then tag** `v<version>` (annotated), then push **main first, then the tag**.
6. **Verify the manifest landed**: `git cat-file -p origin/main:.claude-plugin/plugin.json | grep version`.

### Rules that burned us before

- **Never release a version lower than the current one.** Check `package.json` *before* choosing the
  next number — don't assume the last tag is the current version (tags have been skipped before:
  beta.3 and beta.4 were released without one).
- **Don't move a published tag.** If a tagged release is wrong, ship the next patch version — a
  GitHub Release object already points at the old commit.
- **`--validate-only` paths must never touch the filesystem.** Pipe's preflight validates primitives
  with *dummy-resolved* templates, so any `existsSync`/`readFileSync` on a `{{template}}` path fails.
  Short-circuit on `--validate-only` **before** any fs access (see `src/state/step.ts`).
- **Hooks run in EVERY project** when the plugin is installed globally. Never create files in `cwd`
  unless `.agentflow/` already exists there (see `src/hook/preserve_chat.ts`), and cap anything that
  grows per-session.

## Scope hygiene

- Stage release commits **explicitly** (`git add <files>`), never `git add -A` — this repo carries
  untracked local docs and scratch dirs that must not ship.
- `.claude/STATUS.md` is gitignored on purpose. Keep it current: it is the cross-session bridge.
