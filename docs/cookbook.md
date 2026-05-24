# Cookbook

Real scenarios, from a single command to a full multi-stage workflow.

**How to read these.** You **don't type the flags** — you describe the goal in plain language and
Claude picks the right Flow skill and runs it. Each scenario is laid out as:

- **You say** — what you actually type to Claude (natural language);
- **Claude runs** — the command it translates that into (shown for transparency);
- the **input** file(s) and the **result** you get.

Mental model in one line: **`enumerate` makes a list → `foreach` works each item → `reduce` digests
the results**, with `group` to partition, `repeat`/`until`/`while` to loop, and `pipe`/`compose`/`run`
to wire it all into a reusable workflow. State is on disk, so any of these survives across turns.

---

## Level 1 — one primitive

### 1. Work through a checklist in parallel

**You say:** *"Here's `TODO.md` — do every unchecked task."*

**Input** — `TODO.md`:
```markdown
- [ ] Add a rate limiter to the API {model:opus}
- [ ] Write tests for the billing module
- [x] Update the changelog
```

**Claude runs:**
```text
/flow:foreach --checkbox TODO.md --prompt "Complete this task; report what you changed"
```

Each `- [ ]` line becomes an item (the `[x]` line starts done; inline `{model:opus}` is a per-item
override). Claude works them in parallel subagents and checkpoints progress — reopen mid-run and it
resumes. **Result** — with the checkbox view, finished tasks flip to `[x]` in the file:
```markdown
- [x] Add a rate limiter to the API {model:opus}
- [x] Write tests for the billing module
- [x] Update the changelog
```

### 1b. Track a folder of task files (file kanban)

> "Each file in `tasks/todo/` is a job — work through them."

```text
/flow:foreach --folder tasks --prompt "Do the task described in this file"
```

One file = one item; status comes from the folder (`todo/` / `in-progress/` / `done/`). As each item
is claimed and completed, the engine **moves its file across the folders automatically** — a kanban
you watch live in your file tree, no extra command. A flat folder (no subfolders) is treated as
all-pending. Same engine as the checklist; just a different **Source**.

### 2. Summarize many results into one report

> "Summarize these 20 review files into an executive digest."

```text
/flow:reduce --inputs reviews.json --prompt "Executive digest: severity rollup, top hotspots, recurring patterns" --output-format markdown
```

One agent reads all inputs (files, inline data, or another run's output) and writes a single digest.
The artifact lands at `.flow/reduce/<run-id>/` and is returned to you.

### 3. Turn an outline into a structured list

> "Break this book outline into a list of chapters I can draft."

```text
/flow:enumerate --prompt "Expand this outline into chapters: id, title, one-line brief" --input outline.md
```

The **unfold**: a spec in, a list out. Produces an `items.json` you can inspect, tweak, and then feed
to `foreach`. (If the list already exists — a glob, a file — skip this and point `foreach` at it.)

### 4. Loop until something passes

> "Keep fixing the build until it's green (max 8 tries)."

```text
/flow:until --stage "npm run build" --stop "npm run build" --max-iterations 8
```

`--stage` and `--stop` are plain bash commands (pass JSON only for extra fields). `do…until` runs the
body, then checks the predicate — exit 0 = satisfied = stop. One iteration per turn; the Stop hook
fires the next. Stops on `predicate_satisfied`, `max_iterations`, `convergence` (output stopped
changing), or a `kill`.

### 5. Repeat a fixed number of times

> "Run the flaky test 10 times and collect the failures."

```text
/flow:repeat --stage "pytest tests/flaky_test.py" --times 10
```

A bounded count loop — no predicate, just N runs.

---

## Level 2 — compose two primitives

### 6. Generate, then act (unfold → map)

> "Draft every chapter of this outline."

```text
/flow:enumerate --prompt "Outline → chapters (id, title, brief)" --input outline.md   # → chapters.json
/flow:foreach --items chapters.json --prompt "Draft this chapter from data.brief; ~800 words"
```

Inspect `chapters.json` between the two steps to edit the plan before committing compute to drafting.

### 7. Review every file, then digest (map → fold)

> "Review all the C# files under `src/` and give me a report."

```text
# 1. discover (a quick bash list with per-file content hashes for caching)
# 2. /flow:foreach --items files.json --kind code-review --cache --prompt "Review this file"
# 3. /flow:reduce --inputs <foreach run> --prompt "Digest: hotspots + recurring patterns"
```

This is exactly what the shipped `audit` recipe automates (Level 3, scenario 9).

### 8. Partition, then process per group (group → map)

> "Group these migrations by table, then validate each group."

```text
/flow:group --method regex --input-source migrations.json --method-config '{"pattern":"_(\\w+)_table","field":"id"}'
# groups.json is items.json-compatible:
/flow:foreach --items <groups.json> --prompt "Validate this group of migrations together"
```

`group` output drops straight into `foreach`. Use `path-prefix` / `jsonpath` for deterministic keys,
or `llm-classify` when the key needs judgment (one agent returns the mapping; the branch stays code).

---

## Level 3 — full workflows

### 9. The `audit` recipe (discover → review → group → digest)

**You say:** *"Audit `examples/fake-repo` for bugs."*

**Claude runs:**
```text
/flow:audit --target examples/fake-repo
```

A layer-3 recipe: a shipped workflow-file ([`workflows/audit.json`](../workflows/audit.json)) wires
discover (bash) → review (`foreach`, cached) → partition (`group`) → digest (`reduce`). `pipe drive`
auto-runs the deterministic stages and stops only for the two LLM stages.

**Result** — a markdown digest (excerpt):
```markdown
# Code audit — examples/fake-repo (8 files, 4 components)

## Severity rollup
🔴 2 critical · 🟠 3 major · 🟡 4 minor

## Hotspots
1. auth/TokenIssuer.cs — token signed with a hardcoded secret (critical)
2. billing/RefundProcessor.cs — refund amount not validated against the charge (critical)

## Recurring patterns
- Missing null-checks on external input (5 files)
- Catch-all `catch (Exception)` swallowing errors (3 files)
```

Re-run after changing one file: only that file's review re-dispatches — cache hits skip the rest, so
it's cheap.

### 10. Author and run your own workflow

> "Build me a reusable workflow: pull open issues, triage each, then summarize."

```text
/flow:compose "fetch open issues → triage each by severity → summarize the triage" --name triage
```

`compose` designs the `WorkflowSpec`, writes `workflows/triage.json`, then validates + previews:

```text
/flow:run workflows/triage.json --dry-run    # shows the resolved stage plan, runs nothing
/flow:run workflows/triage.json              # init + drive to completion
```

The file is yours to version, edit (swap models, depth, prompts), and re-run.

### 11. Conditional steps — do only if

> "Run the test suite; only deploy if it passed; always post a summary."

In the workflow-file, a stage's `when` guard is a bash predicate (exit 0 = run, non-zero = skip):

```jsonc
{ "name": "test",   "type": "bash", "spec": { "command": "npm test > $PIPE_OUTPUT_PATH 2>&1; echo $? > {{run.dir}}/test.rc" } },
{ "name": "deploy", "type": "bash",
  "when": { "type": "bash", "command": "[ \"$(cat {{run.dir}}/test.rc)\" = 0 ]" },
  "spec": { "command": "./deploy.sh" } },
{ "name": "report", "type": "bash", "spec": { "command": "./post-summary.sh" } }
```

The LLM may *produce* the data a guard reads (e.g. a review step writes `{"blocking": true}`), but the
branch itself is always deterministic code — never a judgment on free text.

### 12. Choose where the work runs

> "These are tiny edits — don't spin up 20 subagents."

```text
/flow:foreach --items items.json --prompt "Apply this one-line fix" --execution main-thread
```

`main-thread` processes each item inline in the orchestrator (no fan-out) — cheaper and simpler for
short ops. Switch to `--execution subagent` (default) when items are heavy and independent. The state
mechanics are identical; only who does the work changes.

### 12b. Process one at a time — serial, or a running accumulation

> "Apply these migrations one by one, in order — never two at once." / "Translate each chapter,
> keeping the glossary the previous chapter established."

```text
/flow:foreach --items migrations.json --serial --prompt "Apply this migration"
/flow:foreach --items chapters.json   --carry  --prompt "Translate; reuse terms from the previous chapter's output"
```

`--serial` runs items strictly one at a time in list order (no parallel subagents) — for shared
resources, rate limits, or order-sensitive work. `--carry` goes further: it implies serial **and**
feeds each item the previous item's result, so the operation accumulates (a sequential scan). Both
checkpoint per item, so they resume mid-list across turns. Long operation? Keep it in a file with
`--prompt-file ops/translate.md` instead of a giant inline `--prompt`.

---

## Level 4 — operating at scale

### 13. Cheap re-runs with caching

Add `--cache` to `foreach` (the `audit` recipe does). Items carry a `data.content_hash`; on re-run,
unchanged items hit the cache (`.flow/cache/`) and skip dispatch entirely. Change one file → only that item
re-runs.

### 14. Watch cost and progress

```text
/flow:board                        # active runs, blockers, cumulative cost, suggested next actions
/flow:inspect tree <pipe-run-id>   # the full child tree of a pipeline
/flow:inspect budget <run-id>      # tokens / agents / USD, aggregated across children
```

Record usage as you go with `budget-add` so the totals are real.

### 15. Resume a long run across turns (and after compaction)

Nothing special to do: any run with `auto_continue` (default) is picked up by the Stop hook each turn
until it's done or hits `max_auto_continues`. Because state is on disk, a long `foreach` or a deep
`pipe` resumes correctly even after the conversation is compacted. Stuck items from an interrupted
session: `… foreach reset <run-id> --in-progress-to-pending`, then send any message to resume.

---

## Where to go next

- [reference.md](reference.md) — every skill, flag, and subcommand.
- [concepts.md](concepts.md) — the model: state on disk, the Stop hook, the determinism boundary.
- [`workflows/audit.json`](../workflows/audit.json) — a complete, real workflow-file to learn from.
