#!/usr/bin/env node
/**
 * Stage-1 discover helper for the audit workflow. Walks AUDIT_TARGET, matches
 * AUDIT_GLOB (comma-separated globs), skips AUDIT_EXCLUDE, and emits a /foreach-compatible
 * items array — each item carries a sha256 content_hash so the review stage's --cache can
 * skip unchanged files on re-runs. Node builtins only.
 *
 * Env: AUDIT_TARGET (required), AUDIT_GLOB (default "**\/*"), AUDIT_EXCLUDE (default "").
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

const target = process.env.AUDIT_TARGET;
if (!target) {
  process.stderr.write("discover: AUDIT_TARGET env is required\n");
  process.exit(1);
}
const globs = (process.env.AUDIT_GLOB || "**/*").split(",").map((s) => s.trim()).filter(Boolean);
const excludes = (process.env.AUDIT_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean);

/** Minimal glob → RegExp: `**` matches across dirs, `*` within a segment, `?` one char. */
function toRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
const globRes = globs.map(toRe);
const exclRes = excludes.map(toRe);

const items = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (st.isFile()) {
      const rel = relative(target, full).split(sep).join("/");
      if (!globRes.some((r) => r.test(rel))) continue;
      if (exclRes.some((r) => r.test(rel))) continue;
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16);
      items.push({ id: rel, data: { path: full, rel_path: rel, content_hash: hash } });
    }
  }
}
walk(target);
process.stdout.write(JSON.stringify(items, null, 2));
