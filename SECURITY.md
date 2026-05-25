# Security Policy

## Supported versions

Agent Flow is pre-1.0. Security fixes are applied to the latest released version only.

| Version | Supported |
|---------|-----------|
| latest (`1.0.0-beta.*`) | ✅ |
| older pre-releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/AleSaiani/agentflow/security/advisories/new) for
this repository. Include:

- a description of the issue and its impact,
- the affected version (or commit),
- steps to reproduce, and a proof of concept if possible.

You can expect an initial response within a few days. Once a fix is ready, disclosure will be
coordinated with you.

## Scope notes

Agent Flow runs LLM-driven workflows on your machine and executes **shell stages** and **subagents** as
instructed by the workflows you author or run. Treat untrusted `WORKFLOW.md` files as untrusted code:
review them before running, exactly as you would a shell script. The engine itself has **zero runtime
dependencies** (Node builtins only), which keeps its dependency attack surface minimal.
