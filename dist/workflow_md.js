/**
 * WORKFLOW.md — the human-authored, markdown source format for an Agent Flow workflow.
 *
 * Deterministically compiles to the SAME WorkflowSpec object that `pipe` already consumes — no new
 * engine, no LLM in the loop. Coherent with `SKILL.md` (frontmatter + markdown body). Zero-dep.
 *
 * Structure:
 *   ---
 *   name: my-flow
 *   description: ...
 *   params:                      # optional; nested one level
 *     target: { required: true }
 *     glob: "**\/*.cs"
 *   config: { stop_on_failure: true }
 *   ---
 *   ## 1. <stage-name> · <type>          (or "## <stage-name> (<type>)")
 *   ...prose is ignored (human notes)...
 *   ```sh                                 # for type=bash: the command
 *   <command>
 *   ```
 *   - key: value                          # spec fields / primitive init_args / json value
 *
 * type ∈ bash | json | enumerate | foreach | group | reduce | iterate | step | skill.
 * Frontmatter / bullet values are parsed as JSON when they look like JSON, else kept as a string
 * (so prompts, paths, and `{{templates}}` pass through verbatim). For primitive stages, each bullet
 * `- key: value` becomes `--key value` (a bare `true` becomes the flag alone); a `when:` bullet on any
 * stage becomes the `{type:"bash", command}` guard.
 */
const STAGE_HEADING = /^##\s+(?:\d+[.)]\s*)?(.+?)\s*(?:·\s*|\(\s*)([a-z][a-z-]*)\s*\)?\s*$/;
const PRIMITIVE_TYPES = ["enumerate", "foreach", "group", "reduce", "iterate"];
function unquote(s) {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
        return t.slice(1, -1);
    return t;
}
/** Split on `sep` at top level, respecting `{}`/`[]` nesting and quotes. */
function splitTop(s, sep = ",") {
    const out = [];
    let depth = 0;
    let quote = "";
    let cur = "";
    for (const ch of s) {
        if (quote) {
            cur += ch;
            if (ch === quote)
                quote = "";
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        if (ch === "{" || ch === "[")
            depth++;
        else if (ch === "}" || ch === "]")
            depth--;
        if (ch === sep && depth === 0) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    if (cur.trim() !== "")
        out.push(cur);
    return out;
}
/** Parse a YAML-style flow map/seq (`{ k: v, … }` / `[ a, b ]`) with unquoted keys/values. */
function parseFlow(s) {
    const t = s.trim();
    if (t.startsWith("{")) {
        const obj = {};
        for (const part of splitTop(t.slice(1, -1))) {
            const i = part.indexOf(":");
            if (i < 0)
                continue;
            obj[unquote(part.slice(0, i))] = parseScalar(part.slice(i + 1));
        }
        return obj;
    }
    if (t.startsWith("["))
        return splitTop(t.slice(1, -1)).map((p) => parseScalar(p));
    return parseScalar(t);
}
/**
 * Parse a scalar: strict JSON when valid, else a YAML-style flow map/seq for `{…}`/`[…]`, else a
 * bare string (so prompts, paths, and `{{templates}}` pass through verbatim).
 */
function parseScalar(raw) {
    const s = raw.trim();
    if (s === "")
        return "";
    if (s === "true")
        return true;
    if (s === "false")
        return false;
    if (s === "null")
        return null;
    if (/^-?\d+(\.\d+)?$/.test(s))
        return Number(s);
    // `{{…}}` is a wiring template, never a flow map — leave it as a string.
    if (/^[[{]/.test(s) && !s.startsWith("{{") && !s.startsWith("[[")) {
        try {
            return JSON.parse(s);
        }
        catch {
            try {
                return parseFlow(s); // YAML-flow fallback: { required: true, description: Dir }
            }
            catch {
                /* fall through to string */
            }
        }
    }
    if (/^".*"$/.test(s)) {
        try {
            return JSON.parse(s);
        }
        catch {
            return unquote(s);
        }
    }
    return s;
}
/** Parse leading `--- … ---` frontmatter. Top-level `key: value`; one level of indented nesting. */
function parseFrontmatter(lines) {
    if ((lines[0] ?? "").trim() !== "---")
        return { meta: {}, rest: lines };
    let end = -1;
    for (let i = 1; i < lines.length; i++)
        if ((lines[i] ?? "").trim() === "---") {
            end = i;
            break;
        }
    if (end < 0)
        return { meta: {}, rest: lines };
    const fm = lines.slice(1, end);
    const meta = {};
    for (let i = 0; i < fm.length; i++) {
        const line = fm[i] ?? "";
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const m = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!m)
            continue;
        const indent = (m[1] ?? "").length;
        if (indent > 0)
            continue; // consumed by the nested collector below
        const key = m[2];
        const val = m[3] ?? "";
        if (val.trim() !== "") {
            meta[key] = parseScalar(val);
            continue;
        }
        // empty value → gather indented `subkey: subvalue` lines into an object
        const obj = {};
        let j = i + 1;
        for (; j < fm.length; j++) {
            const sub = fm[j] ?? "";
            if (!sub.trim())
                continue;
            const sm = sub.match(/^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/);
            if (!sm)
                break;
            obj[sm[2]] = parseScalar(sm[3] ?? "");
        }
        if (Object.keys(obj).length)
            meta[key] = obj;
        i = j - 1;
    }
    return { meta, rest: lines.slice(end + 1) };
}
/** Collect fenced code blocks (by language) and `- key: value` bullets from a stage's body lines. */
function collectBody(body) {
    const fences = {};
    const bullets = [];
    let fenceLang = null;
    let buf = [];
    for (const line of body) {
        const f = line.match(/^```(\w*)\s*$/);
        if (f) {
            if (fenceLang === null) {
                fenceLang = f[1] || "";
                buf = [];
            }
            else {
                fences[fenceLang] = buf.join("\n");
                fenceLang = null;
            }
            continue;
        }
        if (fenceLang !== null) {
            buf.push(line);
            continue;
        }
        const b = line.match(/^\s*[-*]\s+([A-Za-z0-9_-]+):\s*(.*)$/);
        if (b)
            bullets.push([b[1], parseScalar(b[2] ?? "")]);
    }
    return { fences, bullets };
}
function bulletGet(bullets, key) {
    for (const [k, v] of bullets)
        if (k === key)
            return v;
    return undefined;
}
function compileStage(s) {
    const { fences, bullets } = collectBody(s.body);
    const stage = { name: s.name };
    const when = bulletGet(bullets, "when");
    if (when !== undefined)
        stage["when"] = { type: "bash", command: String(when) };
    const schema = bulletGet(bullets, "output-schema") ?? bulletGet(bullets, "output_schema");
    if (schema !== undefined)
        stage["output_schema"] = schema;
    if (s.type === "bash") {
        stage["type"] = "bash";
        const cmd = fences["sh"] ?? fences["bash"] ?? fences["shell"] ?? fences[""];
        const spec = {};
        if (cmd !== undefined)
            spec["command"] = cmd.trim();
        const out = bulletGet(bullets, "output_path") ?? bulletGet(bullets, "output-path");
        if (out !== undefined)
            spec["output_path"] = String(out);
        stage["spec"] = spec;
    }
    else if (s.type === "json") {
        stage["type"] = "json";
        const spec = {};
        const v = bulletGet(bullets, "value");
        if (v !== undefined)
            spec["value"] = v;
        else if (fences["json"] !== undefined)
            spec["value"] = JSON.parse(fences["json"]);
        const out = bulletGet(bullets, "output_path") ?? bulletGet(bullets, "output-path");
        if (out !== undefined)
            spec["output_path"] = String(out);
        stage["spec"] = spec;
    }
    else if (PRIMITIVE_TYPES.includes(s.type)) {
        stage["type"] = "primitive";
        const initArgs = [];
        for (const [k, v] of bullets) {
            if (k === "when" || k === "output-schema" || k === "output_schema")
                continue;
            const flag = `--${k}`;
            if (v === true) {
                initArgs.push(flag);
                continue;
            }
            if (v === false || v === null || v === "")
                continue;
            initArgs.push(flag, typeof v === "object" ? JSON.stringify(v) : String(v));
        }
        stage["spec"] = { cmd: s.type, init_args: initArgs };
    }
    else {
        // step / skill / unknown — forward-compatible: emit as-is so pipe's validation surfaces a clear
        // "type must be bash|json|primitive" until the `step` primitive lands.
        stage["type"] = s.type;
        const spec = {};
        for (const [k, v] of bullets)
            if (k !== "when")
                spec[k] = v;
        stage["spec"] = spec;
    }
    return stage;
}
/** Compile WORKFLOW.md text into a WorkflowSpec object (`{name?, description?, params?, config?, stages[]}`). */
export function parseWorkflowMd(text) {
    const lines = text.split(/\r?\n/);
    const { meta, rest } = parseFrontmatter(lines);
    const stages = [];
    let cur = null;
    const flush = () => {
        if (cur)
            stages.push(compileStage(cur));
        cur = null;
    };
    for (const line of rest) {
        const h = line.match(STAGE_HEADING);
        if (h) {
            flush();
            cur = { name: (h[1] ?? "").trim(), type: h[2], body: [] };
            continue;
        }
        if (cur)
            cur.body.push(line);
    }
    flush();
    const spec = { stages };
    for (const k of ["name", "description", "params", "config"])
        if (k in meta)
            spec[k] = meta[k];
    return spec;
}
