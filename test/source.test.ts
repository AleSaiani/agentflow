import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseChecklist, writeChecklistView, loadSource, loadFolder, writeFolderView } from "../dist/source.js";

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

test("folder-kanban source: reads todo/in-progress/done and the view moves files", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  mkdirSync(join(dir, "todo"), { recursive: true });
  mkdirSync(join(dir, "in-progress"), { recursive: true });
  writeFileSync(join(dir, "todo", "a.md"), "task a", "utf8");
  writeFileSync(join(dir, "todo", "b.md"), "task b", "utf8");
  writeFileSync(join(dir, "in-progress", "c.md"), "task c", "utf8");

  const items = loadFolder(dir);
  assert.equal(items.length, 3);
  const byId: Record<string, any> = {};
  for (const it of items) byId[it.id] = it;
  assert.equal(byId["a.md"].status, "pending");
  assert.equal(byId["c.md"].status, "in_progress");

  // a → done, c → done; view moves the files to match
  byId["a.md"].status = "done";
  byId["c.md"].status = "done";
  const moved = writeFolderView(dir, items);
  assert.equal(moved, 2);
  assert.ok(existsSync(join(dir, "done", "a.md")));
  assert.ok(existsSync(join(dir, "done", "c.md")));
  assert.ok(existsSync(join(dir, "todo", "b.md"))); // untouched
  assert.ok(!existsSync(join(dir, "todo", "a.md")));
  assert.ok(!existsSync(join(dir, "in-progress", "c.md")));
});

test("folder-kanban source: a flat folder treats every file as a pending todo", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  writeFileSync(join(dir, "one.txt"), "x", "utf8");
  writeFileSync(join(dir, "two.txt"), "y", "utf8");
  const items = loadFolder(dir);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.status === "pending"));
  // via loadSource too
  assert.equal(loadSource({ source: "folder", path: dir }).length, 2);
});

test("loadSource inline + checkbox; run is orchestrator-only", () => {
  const inline = loadSource({ source: "inline", items: [{ id: "a", data: 1, status: "pending" }] });
  assert.equal(inline.length, 1);

  const dir = mkdtempSync(join(tmpdir(), "src-test-"));
  const p = join(dir, "c.md");
  writeFileSync(p, "- [ ] one\n- [x] two\n", "utf8");
  assert.equal(loadSource({ source: "checkbox", path: p }).length, 2);
});
