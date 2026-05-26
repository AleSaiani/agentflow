# pr-review — adaptive, diff-scoped code review

Reviews **only what a PR/branch changes**, plus the files that reference those changes, applying the
right lenses per file and gating on severity. Run it:

```bash
/agentflow:run-workflow pr-review --param repo=. --param base=origin/main
# or point at the file: /agentflow:run-workflow workflows/pr-review/WORKFLOW.md --param base=main
```

## How it works (4 stages)
1. **discover** (`discover.mjs`) — `git diff <base>...<head>` for changed files; grep for importers/
   call-sites to add the **related** set. Each item carries a `content_hash` (for the review cache).
2. **classify** (`classify.mjs` + `lenses.mjs`) — detect each file's stack, resolve its lenses through the
   **cascade**, always add `security` + team rules, attach the merged rule set. This is the written census.
3. **review** (`foreach`) — one LLM pass per file against *its* `data.rules`, emitting structured findings.
4. **report** (`report.mjs`) — flatten findings, roll up by severity, decide the **gate** (block at/above
   `--param gate`, default `major`), write a PR-comment-ready `pr-review-report.md`.

The enumeration is deterministic (git + grep); the LLM only *judges* each file against explicit rules;
the gate is **code over the findings' severities** — never a judgment on free text.

## Lenses & customization (the cascade)
A *lens* is a structured rule set (`{ id, severity, guidance }[]`). Resolution is layered, lowest→highest
precedence — **additive by `id`**, with a later layer overriding a rule by `id`, or replacing the whole
lens with `"override": true`:

1. **shipped** — `lenses/<key>.json` here (`csharp`, `typescript-react`, `security`; more over time).
2. **org** — `$AGENTFLOW_LENSES/<key>.json` (a shared team dir, optional).
3. **project** — `<repo>/.agentflow/lenses/<key>.json`.

**Team rules** (always applied): `<repo>/.agentflow/review-rules.json` (or `--param rules=<path>`). See
[`review-rules.sample.json`](review-rules.sample.json) for the shape. Example — soften a shipped C# rule
and add your own, in `<repo>/.agentflow/lenses/csharp.json`:

```json
{ "lens": "csharp", "rules": [
  { "id": "cs-configureawait", "severity": "info", "guidance": "We don't require ConfigureAwait in app code." },
  { "id": "cs-our-logging", "severity": "major", "guidance": "Use ILogger, never Console.WriteLine." }
] }
```

Stack detection is by extension; a file with no shipped lens still gets `security` + team rules.
