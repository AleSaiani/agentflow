---
run-id: example-md-stats
concurrency: 3
max-retries: 1
auto-continue: true
---

## List

Find every `.md` file under `./docs\` (excluding this file itself).
Output: a JSON array of `{id: <path>, data: {path: <path>}}`. No prose, no fence.

## Task

For the file at `data.path`:
1. Read the contents.
2. Count total words.
3. Determine whether it has YAML frontmatter (starts with `---`).
4. Determine the number of top-level `## ` sections.

Report as JSON on the last line:
`{"ok": true, "result": {"words": <int>, "has_frontmatter": <bool>, "sections": <int>}, "error": null}`

Nothing else after this line.

## Config

Minimal example to test the `/enumerate` end-to-end flow without destructive
side effects (read-only). A good dry-run when modifying the command or the
state helper.
