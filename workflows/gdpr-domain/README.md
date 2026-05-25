# gdpr-domain — external GDPR/ePrivacy audit

Audit the GDPR posture of any public website **from the outside** (no code, no credentials — just the
domain) and produce a **self-contained HTML report**. It is a showcase for why determinism matters in
agent workflows: compliance is a checklist, and a checklist must give the same answer for the same
evidence every time.

```
/agentflow:run-workflow workflows/gdpr-domain/WORKFLOW.md --param domain=example.com
```

The report (`./gdpr-report-<domain>-<date>.html`) lands in your working directory, with a machine-readable
`*.summary.json` beside it.

## The determinism boundary

The 41 checks in [`checklist.json`](checklist.json) are each routed by `decision_mode`:

| mode | count | who decides | examples |
|---|---|---|---|
| **`auto`** | 11 | **code** (`evaluate.mjs`) — pure rules over collected evidence, fully reproducible | cookies before consent, TLS/HSTS, security headers, tracker enumeration, third-country transfer signals |
| **`llm`** | 17 | **one bounded LLM step** reading the privacy-notice prose, output schema-validated and re-checked in code | Art. 13 mandatory contents, lawful basis stated, DSR/DPO contact, transfer disclosure |
| **`manual`** | 13 | **flagged, never auto-passed** — 9 are promoted to pass/fail by the optional live-browser pass (below); 4 need internal documents | reject-all parity, pre-ticked toggles, dark patterns (browser); Art. 30 records, Art. 35 DPIA (internal) |

The LLM only ever produces *structured data*; every pass/fail rollup and the report are computed by
code. `report.mjs` validates that **every** checklist id has a legal verdict — a flaky LLM step can
never silently drop a check (missing verdicts are backfilled as `not_observable`).

## Legal grounding

`checklist.json` is mapped to specific articles of the **GDPR (Regulation (EU) 2016/679)** and the
**ePrivacy Directive 2002/58/EC Art. 5(3)**, with EDPB guidance (Consent 05/2020, Cookie Banner
Taskforce 2023, Dark Patterns 03/2022, Technical Scope 02/2023) and CJEU case law (Planet49, Fashion ID,
Orange Romania, Schrems II) plus the EU-US Data Privacy Framework. Each check carries its `gdpr_articles`,
`obligation`, `confidence` and `references`.

## Live-browser layer (optional)

The static collector cannot judge runtime banner behaviour. The optional stages `build-browser-assess`
+ `browser-assess` cover the 9 runtime `manual` checks (reject-all parity, pre-ticked toggles, cookie
wall, granularity, choice-honoured-after-reject, withdrawal, dark patterns) by driving a **real
browser** through a subagent step — the same model/tools the skills use:

- The agent **prefers a Vercel / agent browser CLI** if the environment exposes one, **falls back to
  Playwright MCP** if those browser tools are available in the session, and **degrades to
  `manual_review`** if neither is present (never faked).
- Controlled by the `browser` param: `auto` (default — run if a browser tool is available) or `none`
  (skip the two stages entirely via a `when` guard).
- `report.mjs` merges browser verdicts with precedence, promoting those checks from `manual_review` to
  `pass`/`fail` (shown with a `browser` "by" tag).

No new dependency is added to the plugin: the browser is reached through the session's MCP tools or a
CLI the environment already provides.

## Honest scope

Without the browser layer this is a **static external observer**: it reads the first server response,
the landing HTML and the linked notices — JS-rendered banner behaviour and post-interaction cookies are
the `manual` checks, reported as requiring the browser pass, never faked. The output is an automated
indicator, **not legal advice**.

## Files

- `WORKFLOW.md` — the 5-stage pipeline (collect → evaluate → build-assess → assess · step → report).
- `checklist.json` — the law-mapped checklist (the knowledge asset).
- `collect.mjs` — deterministic evidence collector (Node builtins + fetch, zero deps).
- `evaluate.mjs` — deterministic rules engine for the `auto` checks.
- `build-assess.mjs` / `assess-prompt.md` — input + instructions for the bounded LLM step.
- `build-browser-assess.mjs` / `browser-prompt.md` — input + instructions for the optional live-browser step.
- `report.mjs` — merge (code + LLM + browser + manual) + validate + rollup + HTML/JSON report.
