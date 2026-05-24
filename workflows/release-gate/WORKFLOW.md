---
name: release-gate
description: Build/verify → test (auto-retry) → human approval → deploy, with a failure alert. A
  production template — edit the commands; the control flow (retry, timeout, approval, on-failure) is
  wired for you. Self-contained, no external scripts.
params:
  test_cmd:   { default: "npm test", description: "Command that must pass before deploy" }
  deploy_cmd: { default: "echo '(replace deploy_cmd)'", description: "Deploy command" }
config:
  stop_on_failure: true
  on_failure: node "${CLAUDE_PLUGIN_ROOT}/dist/notify.js" --message "release-gate failed: $PIPE_FAIL_REASON"
---

## 1. test · bash
Run the test suite; retry transient flakes, bounded by a timeout.
- retries: 2
- timeout: 900
```sh
{{params.test_cmd}} > "$PIPE_OUTPUT_PATH" 2>&1
```

## 2. approve · bash
Pause for a human to OK the deploy after tests pass.
- approve: true
- approve-prompt: Tests passed — deploy to production?
```sh
echo "approved at $(date -u)" > "$PIPE_OUTPUT_PATH"
```

## 3. deploy · bash
- timeout: 1800
```sh
{{params.deploy_cmd}} > "$PIPE_OUTPUT_PATH" 2>&1
```
