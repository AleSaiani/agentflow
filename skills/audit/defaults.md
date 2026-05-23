---
# Default config for /flow:audit (a layer-3 recipe over /pipe).

target: "."                         # path to audit; user MUST override or pass --target
file_glob: "**/*.cs"                # which files to include (comma-separated multiple globs allowed)
file_exclude: "**/bin/**,**/obj/**,**/node_modules/**,**/.git/**"

# Stage-level model choices. The recipe defaults to a single-pass review with sonnet.
# Override with --triage-only-haiku for a cheaper sweep, or --deep-opus for a more
# thorough pass on every file (slower, more expensive).
review_model: sonnet                # haiku | sonnet | opus — model for the per-file review pass
review_concurrency: 4               # parallel agents per wave during the review pass

# Grouping strategy (default: path-prefix depth=1 starting from <target>).
# Override --group-method jsonpath --group-config '{"path":"data.component"}'
# if files carry a component metadata field instead.
group_method: path-prefix
group_depth: 1

# Digest configuration.
digest_model: opus                  # opus is recommended — synthesis benefits from reasoning
digest_format: markdown             # markdown | json

# Pipe-level safety.
max_auto_continues: 80              # generous; the review stage alone can take many turns
stop_on_failure: true               # if any stage fails, the audit aborts
---

# Notes

- `/flow:audit` is a **layer-3 recipe** — a thin shell over `/pipe` that wires
  4 stages (find → review → group → digest). It introduces no new framework
  primitives; if you find yourself wanting to add one to make this recipe work,
  fix the underlying primitive instead.

- **Why 4 stages and not 2** (skip group + reduce): the group pass gives the digest
  pass meaningful structure (per-component severity rollup) without spending more
  tokens. Skipping group would force the digest agent to re-discover the partition
  from raw paths. Keeping it explicit is cheaper.

- **`review_model: sonnet`** is the right default for typical C#/Python/JS code-review
  workloads. `haiku` is fine for trivial bugs (typos, obvious null deref) but misses
  async/concurrency/SQL-injection subtlety. `opus` is overkill for the review pass
  but appropriate for the digest.

- **`group_method: path-prefix` at depth 1** assumes the target has a `<component>/...`
  layout. Adjust depth or switch to `jsonpath` if your project is flatter or carries
  component metadata in a field.

- This recipe does NOT modify any files. Outputs land under `.audit/<run-id>/`
  (the pipe run's directory) and the per-file review state under `.foreach/<run-id>-s1-foreach/`.
