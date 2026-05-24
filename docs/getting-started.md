# Getting started

Agent Flow is a Claude Code plugin. This page takes you from install to a real run in a few minutes.

## 1. Install

**From the marketplace** (inside Claude Code):

```shell
/plugin marketplace add AleSaiani/agentflow
/plugin install agentflow@agentflow
```

**From a clone** (development / trying it out):

```shell
git clone https://github.com/AleSaiani/agentflow && cd agentflow
npm install && npm run build
claude --plugin-dir .
```

Requirements: **Node ≥ 22** and **git bash on `PATH`** (shell stages run under bash for POSIX
semantics on every OS).

## 2. See the engine work — no LLM, ~10 seconds

You normally use the `/agentflow:*` skills and let Claude drive things. Under the hood those skills run an
**engine CLI** (`node "$CLAUDE_PLUGIN_ROOT/dist/state/<cmd>.js" …`). Running it directly on a bundled
demo is the fastest way to *see the state machine work* — and because this demo's stages are all
bash/json/deterministic-group, `drive` takes it all the way to `done` with **no LLM calls at all**.
It's the plumbing made visible; you won't type these commands in normal use.

```shell
node dist/state/pipe.js init demo --workflow examples/workflows/demo.json
node dist/state/pipe.js drive demo
```

`drive` prints `{"action":"done","steps_taken":5,...}`. The partition stage produced two groups —
`src` (2 items) and `lib` (1 item). Inspect anything:

```shell
node dist/inspect.js board          # dashboard of all runs
node dist/inspect.js tree demo      # the pipe and its child stages
node dist/inspect.js show demo      # the pipe run's status JSON
```

This is the whole machine: a pipeline of stages, driven to completion, fully inspectable. The only
thing the LLM adds is the *work inside* the stages that need judgment.

## 3. A real run — the `audit` recipe

`audit` is a workflow-file that wires: discover files → review each (LLM) → partition by component →
executive digest. On the bundled corpus:

```shell
/agentflow:audit --target examples/fake-repo
```

Claude drives the pipe, dispatches review agents per file (cached, so re-runs are cheap), partitions
the findings, and writes a markdown digest. `drive` stops at each genuine agent step and resumes
itself across turns via the Stop hook — you can close and reopen the session and it picks up.

## 4. Drive a run from a checklist

Any markdown checklist is a valid item source. Inline `{...}` annotations become per-item overrides:

```markdown
# TODO.md
- [ ] Refactor the auth module {model:opus, subagent:code-reviewer}
- [ ] Add tests for billing
- [x] Update the changelog        ← already done, skipped
```

```shell
/agentflow:foreach --checkbox TODO.md
```

Each unchecked line becomes an item processed in parallel; `[x]` lines start done. The authoritative
state is in `state.json` — the checklist is just a human-friendly source (and an optional write-back
view).

## 5. Inspect, resume, clean up

```shell
node dist/inspect.js runs --json                 # every run across all primitives
node dist/inspect.js budget <run-id>             # cost, aggregated across child runs
node dist/state/foreach.js reset <run-id> --in-progress-to-pending   # unstick a run
```

## Next

- **[cookbook.md](cookbook.md)** — real scenarios from one command to a full workflow (the fastest
  way to see what's possible).
- **[concepts.md](concepts.md)** — the mental model behind all of this.
- **[reference.md](reference.md)** — every skill, flag, and CLI subcommand.
