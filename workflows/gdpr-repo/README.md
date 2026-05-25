# gdpr-repo — internal GDPR audit of a source repository

The internal-observer twin of [`gdpr-domain`](../gdpr-domain/README.md): audit a codebase for GDPR
posture from the **inside** (files, dependencies, code patterns) and produce a **self-contained HTML
report**. Same thesis — compliance is a checklist, and a checklist must be deterministic.

```
/agentflow:run-workflow workflows/gdpr-repo/WORKFLOW.md --param repo=.
```

The report (`./gdpr-repo-report-<name>-<date>.html`) lands in your working directory with a
`*.summary.json` beside it. It sees what is **committed** — not production runtime, not signed contracts.

## The determinism boundary

The 28 checks in [`checklist.json`](checklist.json) are routed by `decision_mode`:

| mode | count | who decides | examples |
|---|---|---|---|
| **`auto`** | 20 | **code** (`evaluate.mjs`) over the repo scan | committed secrets, weak password hashing, PII in logs, cookie flags, lockfile, PII/special-category fields, DSR export/delete handlers, non-EEA regions, processor SDKs |
| **`llm`** | 6 | **one bounded LLM step** over found docs/code excerpts | Art. 13 notice contents, consent-gating in code, encryption config, data minimisation, rights coverage, retention bounds |
| **`manual`** | 2 | **flagged, never auto-passed** | signed processor DPAs (Art. 28), exercised breach procedure (Art. 33/34) |

The LLM only produces *structured data*; the rollup and report are computed by code. `report.mjs`
validates that every checklist id has a legal verdict — missing ones are backfilled as `not_observable`.

## What the scanner looks for (`scan.mjs`, zero-dep)

- **Privacy docs**: PRIVACY / ROPA (Art. 30) / DPA (Art. 28) / DPIA (Art. 35) / SECURITY / incident runbook.
- **Security (Art. 32)**: committed `.env` / keys / cloud keys, md5/sha1 vs bcrypt/argon2, PII in logs,
  cookie `HttpOnly`/`Secure`/`SameSite`, manifest + lockfile, TLS/encryption config.
- **Data mapping (Art. 5/9/30)**: PII fields and special-category terms in models/schemas.
- **Rights (Art. 15–22)**: export/portability and erasure/deletion handlers.
- **Transfers (Art. 44)**: non-EEA cloud regions and US/non-EEA processor & tracker SDKs in dependencies.
- **Retention (Art. 5(1)(e))**, **consent (Art. 7)**, **children (Art. 8)**, **DPO contact (Art. 37–39)**.

## Honest scope

Static analysis of committed source: presence-style checks detect existence, not adequacy or
truthfulness; production reality and signed contracts are out of scope (the `manual` checks). The output
is an automated indicator, **not legal advice**.
