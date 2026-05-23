# Task kinds — preflight enrichment for /enumerate

Table of "task kinds" with prompt template + suggested model. The `/enumerate` orchestrator (Step 1.5):

1. Classifies the user task-prompt into one of the kinds below.
2. If classification is **certain**: enriches the task-prompt with the kind template, suggests the model, proceeds.
3. If **ambiguous** (no clear match): uses `AskUserQuestion` to let the user pick.

**Override**: the user can force the kind with `--kind <name>` (CLI) or `kind: <name>` in the spec.md frontmatter.

---

## Classification

Keyword match in the task-prompt (case-insensitive):

| Kind | Trigger keywords | Suggested model |
|---|---|---|
| `code-review` | "review", "validate bugs", "find bugs", "audit code", "analyze for issues", "find issues" | sonnet |
| `transformation` | "rename", "refactor", "convert", "transform", "format", "lint-fix", "rewrite as" | haiku |
| `extraction` | "extract", "list all", "find all", "summarize each" | haiku |
| `validation` | "verify", "check", "validate", "assert", "ensure" (without "bug") | sonnet |
| `audit` | "security audit", "vulnerability", "pentest", "penetration", "performance audit", "benchmark each" | opus |
| `unknown` | no match | sonnet (fallback) |

If multiple kinds match: priority `audit > code-review > validation > transformation > extraction`.

If the task-prompt is < 80 chars OR contains only generic verbs ("check", "look", "see if"): treat as `unknown` and run `AskUserQuestion`.

---

## Templates

Each template is a string the orchestrator **prepends** to the user's task-prompt before passing it to the subagent. The user task-prompt stays verbatim, but is wrapped in kind-specific context.

### code-review
```
You are a code reviewer for REAL bugs. Look for:
- null deref / NRE
- race conditions, deadlocks, inverted locks
- resource leaks (file, connection, IDisposable, IAsyncDisposable)
- unhandled or swallowed exceptions
- off-by-one, integer overflow, wrong float/decimal comparison
- SQL injection, command injection, path traversal
- async/await issues (sync-over-async deadlock, ConfigureAwait, missing ct propagation)
- eager evaluation of IEnumerable, double enumeration
- logic that contradicts the stated intent (comments, naming)

DO NOT report: naming, style, formatting, missing XML doc, var vs explicit type, TODO comments, "could be more efficient" without a concrete bug, performance suggestions without profiling.

Severity: `high` = certain bug that impacts production; `med` = conditional or concurrency-dependent bug; `low` = rare/defensive bug or edge-case only.

Structured output per item:
{"bugs_found": <int>, "issues": [{"line": <int>, "severity": "high|med|low", "category": "<short-tag>", "description": "<one sentence, no prose>"}], "summary": "<one line>"}
```

### transformation
```
You are a code/text transformer. Apply the requested transformation MECHANICALLY. Do not reason beyond the transformation: just apply it.

For each item:
1. Read the path
2. Apply the requested transformation (Edit tool)
3. Verify there are no gross syntax errors

Structured output per item:
{"changed": true|false, "lines_changed": <int>, "summary": "<what you did in one sentence>", "skipped_reason": "<if changed=false, why>"}
```

### extraction
```
You are an information extractor. DO NOT modify anything; read and extract the requested data.

For each item:
1. Read the path
2. Extract ONLY the information requested by the task
3. Structured output, no prose

Structured output per item: depends on the task — the user task-prompt MUST specify the schema. If it does not, use `{"data": <whatever-extracted>}`.
```

### validation
```
You are a validator. Verify whether each item satisfies the requested criterion. DO NOT search for "every possible problem" like in code-review — verify ONLY the specified criterion.

For each item:
1. Read the path
2. Apply the criterion
3. Binary output + reason

Structured output: {"passes": true|false, "reason": "<one sentence>", "evidence": [{"line": <int>, "snippet": "..."}]}
```

### audit
```
You are an auditor (security / performance / compliance — the task specifies which). DEEP analysis, cross-file when needed. Use Read on related files (imports, references) when single-file context is not enough.

For each item:
1. Read the path
2. Deep analysis: trace data flow, consider attacker model, consider worst-case input.
3. High-quality output: only accurate findings, no speculation.

Severity: `critical` = exploitable from remote/unauth; `high` = exploitable from local/auth; `med` = info disclosure / partial bypass; `low` = hardening / defense-in-depth.

Structured output per item:
{"findings": [{"line": <int>, "severity": "critical|high|med|low", "category": "<cwe-like>", "description": "<details>", "exploit_scenario": "<how it is abused>", "fix_suggestion": "<how to mitigate>"}], "summary": "<one line>"}
```

### unknown (fallback)
```
For each item:
1. Read the path
2. Run the requested task
3. Structured output — format dictated by the task content. Default schema: {"ok": true, "result": <whatever>, "summary": "<one sentence>"}.
```

---

## AskUserQuestion (when classification is ambiguous)

Trigger: `unknown` AND (task-prompt < 80 chars OR generic verbs only).

Question to ask:
> "The task '<TASK>' is a bit generic. What kind of analysis do you want?"
> Options:
> - **code-review** — find bugs in files
> - **validation** — verify a specific criterion
> - **extraction** — extract information (requires output schema)
> - **audit** — deep security/performance analysis (slower, uses opus)
> - **other** — describe it more precisely

Map the answer to the corresponding kind and proceed.
