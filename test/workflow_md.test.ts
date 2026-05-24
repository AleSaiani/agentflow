import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWorkflowMd } from "../dist/workflow_md.js";

test("workflow_md: frontmatter (params nested), bash fence, primitive bullets→init_args, json, when", () => {
  const md = [
    "---",
    "name: demo",
    "description: a demo flow",
    "params:",
    "  target: { required: true, description: Dir }",
    '  glob: "**/*.cs"',
    "config: { stop_on_failure: true }",
    "---",
    "# Demo",
    "Some human prose that the parser ignores.",
    "",
    "## 1. discover · bash",
    "Find files.",
    "```sh",
    'node "{{workflow.dir}}/d.mjs" > "$PIPE_OUTPUT_PATH"',
    "```",
    "- output_path: {{run.dir}}/files.json",
    "",
    "## 2. review · foreach",
    "- items: {{stages.discover.result_pointer}}",
    "- kind: code-review",
    "- cache: true",
    "- prompt: Review the file at `data.path`: report issues.",
    "",
    "## 3. maybe · json",
    "- when: test -f GO",
    '- value: { "ok": true, "ref": "{{stages.review.run_id}}" }',
  ].join("\n");

  const spec = parseWorkflowMd(md) as any;

  assert.equal(spec.name, "demo");
  assert.equal(spec.description, "a demo flow");
  assert.deepEqual(spec.params.target, { required: true, description: "Dir" });
  assert.equal(spec.params.glob, "**/*.cs");
  assert.deepEqual(spec.config, { stop_on_failure: true });
  assert.equal(spec.stages.length, 3);

  // bash stage: fenced command + output_path
  assert.equal(spec.stages[0].type, "bash");
  assert.match(spec.stages[0].spec.command, /d\.mjs/);
  assert.equal(spec.stages[0].spec.output_path, "{{run.dir}}/files.json");

  // primitive stage: bullets become init_args in order; bare true → flag only; colon in value kept
  assert.equal(spec.stages[1].type, "primitive");
  assert.equal(spec.stages[1].spec.cmd, "foreach");
  assert.deepEqual(spec.stages[1].spec.init_args, [
    "--items",
    "{{stages.discover.result_pointer}}",
    "--kind",
    "code-review",
    "--cache",
    "--prompt",
    "Review the file at `data.path`: report issues.",
  ]);

  // json stage: when guard + JSON value (template preserved inside the string)
  assert.equal(spec.stages[2].type, "json");
  assert.deepEqual(spec.stages[2].when, { type: "bash", command: "test -f GO" });
  assert.deepEqual(spec.stages[2].spec.value, { ok: true, ref: "{{stages.review.run_id}}" });
});

test("workflow_md: '## name (type)' heading form and a ```json value fence also parse", () => {
  const md = [
    "## bundle (json)",
    "```json",
    '[ { "a": 1 }, { "b": "{{run.id}}" } ]',
    "```",
    "- output_path: {{run.dir}}/b.json",
  ].join("\n");
  const spec = parseWorkflowMd(md) as any;
  assert.equal(spec.stages.length, 1);
  assert.equal(spec.stages[0].name, "bundle");
  assert.equal(spec.stages[0].type, "json");
  assert.deepEqual(spec.stages[0].spec.value, [{ a: 1 }, { b: "{{run.id}}" }]);
  assert.equal(spec.stages[0].spec.output_path, "{{run.dir}}/b.json");
});
