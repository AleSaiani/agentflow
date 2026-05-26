# Shipped workflows

Ready-to-run `WORKFLOW.md` recipes. Run any with `/agentflow:run-workflow workflows/<name>/WORKFLOW.md`
(add `--param k=v`), or copy a folder into your own project and edit it. Author new ones with
`/agentflow:create-workflow`.

| Workflow | What it does | Params | Showcases |
|---|---|---|---|
| **[gdpr-domain](gdpr-domain/WORKFLOW.md)** | Enterprise GDPR/ePrivacy audit of a public domain, from outside: collect evidence → code-decided technical checks → one bounded LLM judgment of the privacy notice → **self-contained HTML report** | `domain` (req), `report_out`, `browser` | the **determinism boundary** — 11 checks decided by code, 17 by a schema-grounded LLM step, 13 manual (9 promotable by an optional live-browser step: Vercel CLI / Playwright MCP); law-mapped `checklist.json` |
| **[gdpr-repo](gdpr-repo/WORKFLOW.md)** | Enterprise GDPR audit of a source repository, from inside: scan files/deps/code → code-decided checks → one bounded LLM judgment of found docs/code → **self-contained HTML report** | `repo`, `report_out` | internal-observer twin of gdpr-domain — 20 code-decided + 6 LLM-judged + 2 manual checks; secrets/hashing/PII/DSR/retention signals |
| **[security-domain](security-domain/WORKFLOW.md)** | Web-security posture of a public domain (OWASP headers, TLS, exposure, CORS, SRI) → **HTML report** | `domain` (req), `report_out` | **fully deterministic** (16 code checks, no LLM) — the purest "same input → same verdict" showcase |
| **[security-repo](security-repo/WORKFLOW.md)** | SAST-lite source review (secrets, injection, crypto, deserialization, deps, containers) → **HTML report** | `repo`, `report_out` | **fully deterministic** (16 code checks); high-confidence fails, heuristic warns |
| **[security-pack](security-pack/WORKFLOW.md)** | Meta-workflow: nests security-domain + security-repo, then a combined index with an overall verdict | `domain` (req), `repo`, `report_out` | **workflow composition** — the `· workflow` stage (a pipe nested in a pipe), driven inline |
| **[pr-review](pr-review/WORKFLOW.md)** | **Adaptive, diff-scoped code review**: discover changed + related files → detect each file's stack → apply matching lenses → review every file → deterministic gate + PR-comment report | `repo`, `base`, `head`, `related`, `rules`, `gate`, `report_out` | **Mode-B census** (LLM judges per rule, code gates on severity) · the **lens cascade** (shipped→org→project, additive + override) · git-diff source + "related" expansion |
| **[audit](audit/WORKFLOW.md)** | Discover files → per-file LLM review (cached) → partition by component → executive digest | `target` (req), `glob`, `exclude` | `{{workflow.dir}}` script, foreach `--cache`, group, reduce |
| **[release-gate](release-gate/WORKFLOW.md)** | Test (auto-retry) → human approval → deploy, with a failure alert. A production template — edit the commands. | `test_cmd`, `deploy_cmd` | stage **retry**/**timeout**, **human approval**, **on_failure** alert |

These double as worked examples of the workflow layer. See
[docs/cookbook.md](../docs/cookbook.md) for the patterns and
[docs/reference.md#workflow-file-schema](../docs/reference.md#workflow-file-schema) for the full schema.
