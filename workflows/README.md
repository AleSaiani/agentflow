# Shipped workflows

Ready-to-run `WORKFLOW.md` recipes. Run any with `/agentflow:run-workflow workflows/<name>/WORKFLOW.md`
(add `--param k=v`), or copy a folder into your own project and edit it. Author new ones with
`/agentflow:create-workflow`.

| Workflow | What it does | Params | Showcases |
|---|---|---|---|
| **[audit](audit/WORKFLOW.md)** | Discover files → per-file LLM review (cached) → partition by component → executive digest | `target` (req), `glob`, `exclude` | `{{workflow.dir}}` script, foreach `--cache`, group, reduce |
| **[release-gate](release-gate/WORKFLOW.md)** | Test (auto-retry) → human approval → deploy, with a failure alert. A production template — edit the commands. | `test_cmd`, `deploy_cmd` | stage **retry**/**timeout**, **human approval**, **on_failure** alert |

These double as worked examples of the workflow layer. See
[docs/cookbook.md](../docs/cookbook.md) for the patterns and
[docs/reference.md#workflow-file-schema](../docs/reference.md#workflow-file-schema) for the full schema.
