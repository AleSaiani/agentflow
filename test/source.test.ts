import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseChecklist, writeChecklistView, loadSource } from "../dist/source.js";

const CHECKLIST = `# Plan
Some intro prose.

- [ ] Review the parser {model:opus, subagent:code-reviewer}
- [x] Scaffold the repo
  - [ ] nested subtask
- [ ] Review the parser
* [ ] Star-bullet task {prompt:do it carefully, priority:high}
not a checkbox line
`;

test("parseChecklist extracts items, statuses, annotations, nesting", () => {
  const items = parseChecklist(CHECKLIST);
  assert.equal(items.length, 5);

  const [first, second, nested, dupe, star] = items;
  assert.equal(first?.status, "pending");
  assert.deepEqual(first?.task, { model: "opus", subagentType: "code-reviewer" });
  assert.equal((first?.data as any).text, "Review the parser");

  assert.equal(second?.status, "done");
  assert.equal((nested?.data as any).level, 1); // 2-space indent → level 1
  assert.equal(dupe?.id, "review-the-parser-2"); // duplicate text gets a suffixed id

  assert.equal(star?.task?.prompt, "do it carefully");
  assert.equal((star?.data as any).priority, "high"); // unknown annotation → data
});

test("writeChecklistView toggles boxes from item status, preserves prose", () => {
  const dir = mkdtempSync(join(tmpdir(), "src-test-"));
  const p = join(dir, "plan.md");
  writeFileSync(p, CHECKLIST, "utf8");

  const items = parseChecklist(CHECKLIST);
  // mark the first task done
  items[0]!.status = "done";
  const toggled = writeChecklistView(p, items);
  assert.ok(toggled >= 1);

  const out = readFileSync(p, "utf8");
  assert.match(out, /- \[x\] Review the parser \{model:opus/);
  assert.match(out, /Some intro prose\./); // prose preserved
  assert.match(out, /not a checkbox line/);
});

test("loadSource inline + checkbox; run is orchestrator-only", () => {
  const inline = loadSource({ source: "inline", items: [{ id: "a", data: 1, status: "pending" }] });
  assert.equal(inline.length, 1);

  const dir = mkdtempSync(join(tmpdir(), "src-test-"));
  const p = join(dir, "c.md");
  writeFileSync(p, "- [ ] one\n- [x] two\n", "utf8");
  assert.equal(loadSource({ source: "checkbox", path: p }).length, 2);
});
