---
name: notify
description: |
  Send a notification — a webhook POST (Slack/Discord-compatible) and/or a best-effort OS desktop
  notification — so the user is pinged when a long-running flow finishes or hits a milestone, even if
  they've stepped away from the terminal. Zero-dep; never fails the run.

  USE when the user asks to "notify me / ping me / let me know when this is done", or when wiring a
  completion ping into a long `/agentflow:run-workflow`, `/agentflow:foreach`, or `/agentflow:audit`.
allowed-tools: Bash
argument-hint: --message "<text>" [--title "<title>"] [--webhook <url>] [--no-desktop]
---

# /agentflow:notify

> **Make it visible:** say in one line that you're sending a notification.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/notify.js" --message "<text>" [--title "<title>"] [--webhook <url>] [--no-desktop]
```

- **Webhook** (best for headless/away): pass `--webhook <url>` or set `$AGENTFLOW_NOTIFY_WEBHOOK`. POSTs
  `{ "text": "<title>: <message>" }` — works with Slack/Discord incoming webhooks.
- **Desktop**: a best-effort OS notification (Windows toast / macOS `osascript` / Linux `notify-send`);
  pass `--no-desktop` to skip.
- Always prints `{title, message, sent:[...]}` so you can confirm which channels fired (and surface it).

**On-demand pattern.** When the user says "ping me when the audit is done", run the flow as usual, then
at completion call this with a short summary, e.g.:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/notify.js" --message "audit done — 8 files, 2 critical; digest at ./audit-3f2a-audit.md"
```

It sends and returns regardless of whether any channel is configured — it never blocks or fails the run.
