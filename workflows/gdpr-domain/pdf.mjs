/**
 * Minimal PDF → text extraction, Node builtins only (`zlib`), for the case that matters here: a
 * privacy notice published as a generated, text-based PDF.
 *
 * Why this exists: a notice served as a PDF used to reach the judging model as raw `%PDF-1.4` binary,
 * so every check that reads the notice came back `not_observable`. That is an EXTRACTION failure, not
 * a judgement failure — and extraction is code's job, not an agent's: deterministic, free, identical
 * every run.
 *
 * Deliberately not a full PDF parser:
 *   - Glyph codes are mapped through the fonts' `/ToUnicode` CMaps (without them a subset font yields
 *     mojibake). All CMaps in the document are merged into one table; per-font scoping would need full
 *     resource resolution, and for a single notice the subsets agree in practice.
 *   - A SCANNED PDF (page images, no text operators) yields nothing — correctly, since only OCR could
 *     read it, and `not_observable` stays the honest verdict.
 *
 * `looksLikeProse` is the guard that keeps this honest: for a compliance audit, silently handing the
 * judge a garbled extraction is far worse than handing it nothing, because it turns "I cannot read
 * this" into a confident verdict on nonsense.
 */
import { inflateSync, inflateRawSync } from "node:zlib";

function decodeLiteralBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out.push(s.charCodeAt(i));
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    if (n === "n") out.push(10);
    else if (n === "r") out.push(13);
    else if (n === "t") out.push(9);
    else if (n === "b") out.push(8);
    else if (n === "f") out.push(12);
    else if (n === "\n") continue;
    else if (n >= "0" && n <= "7") {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
      out.push(parseInt(oct, 8));
    } else out.push(s.charCodeAt(i));
  }
  return out;
}

const hexBytes = (h) => {
  const c = h.replace(/[^0-9a-fA-F]/g, "");
  const out = [];
  for (let i = 0; i + 1 < c.length; i += 2) out.push(parseInt(c.slice(i, i + 2), 16));
  return out;
};

/** Parse `beginbfchar`/`beginbfrange` sections of a ToUnicode CMap into code → string. */
function parseCMap(s, map) {
  for (const blk of s.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = re.exec(blk)) !== null) map.set(parseInt(m[1], 16), utf16(m[2]));
  }
  for (const blk of s.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let m;
    while ((m = re.exec(blk)) !== null) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3] !== undefined) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else {
        const items = m[4].match(/<([0-9a-fA-F]+)>/g) || [];
        items.forEach((it, i) => map.set(lo + i, utf16(it.slice(1, -1))));
      }
    }
  }
  return map;
}

/** A CMap destination is UTF-16BE (often a surrogate pair or a ligature of several code units). */
function utf16(hex) {
  const b = hexBytes(hex);
  let out = "";
  for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return out || String.fromCharCode(b[0] ?? 0);
}

function mapCodes(bytes, cmap, wide) {
  let out = "";
  if (wide) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      out += cmap.get(code) ?? "";
    }
  } else {
    for (const b of bytes) out += cmap.get(b) ?? String.fromCharCode(b);
  }
  return out;
}

/** Split a content stream into PDF tokens (strings stay as byte arrays). */
function* tokens(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c <= " ") continue;
    if (c === "%") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      let lit = "";
      for (; j < s.length && depth > 0; j++) {
        const ch = s[j];
        if (ch === "\\") {
          lit += ch + (s[j + 1] ?? "");
          j++;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")" && --depth === 0) break;
        lit += ch;
      }
      yield { t: "str", v: decodeLiteralBytes(lit) };
      i = j;
    } else if (c === "<" && s[i + 1] === "<") {
      yield { t: "op", v: "<<" };
      i++;
    } else if (c === ">" && s[i + 1] === ">") {
      yield { t: "op", v: ">>" };
      i++;
    } else if (c === "<") {
      const e = s.indexOf(">", i);
      if (e < 0) return;
      yield { t: "str", v: hexBytes(s.slice(i + 1, e)) };
      i = e;
    } else if (c === "[" || c === "]") {
      yield { t: c };
    } else if (c === "/") {
      let j = i + 1;
      while (j < s.length && /[^\s/<>\[\]()%]/.test(s[j])) j++;
      yield { t: "name", v: s.slice(i + 1, j) };
      i = j - 1;
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?\d*\.?\d+/.exec(s.slice(i));
      if (!m) continue;
      yield { t: "num", v: parseFloat(m[0]) };
      i += m[0].length - 1;
    } else {
      const m = /^[A-Za-z'"*][A-Za-z0-9'"*]*/.exec(s.slice(i));
      if (!m) continue;
      yield { t: "op", v: m[0] };
      i += m[0].length - 1;
    }
  }
}

/**
 * Pull text out of one decompressed content stream by tracking the TEXT POSITION, not by
 * pattern-matching a generator's operator habits.
 *
 * Generators differ wildly: some emit one `Td` per word, some per glyph, some rely entirely on `TJ`
 * kerning. Any rule of the form "a Td means a space" fits one sample and breaks the next. What is
 * invariant is the geometry: a jump in Y is a new line, and a horizontal gap wider than a fraction of
 * the font size is a word break. Glyph widths would need font metrics, so the advance is estimated at
 * ~0.5 em — coarse, but only ever used to compare against a gap threshold.
 */
function textFromContentStream(s, cmap, wide) {
  let out = "";
  const st = { size: 12, scale: 1, x: 0, y: 0, lx: 0, ly: 0, leading: 0 };
  let prevY = null;
  const eff = () => Math.abs(st.size * st.scale) || 12;
  const stack = [];
  let arr = null;

  // NB: only show() may update prevEnd. Resetting it in the positioning operators would erase the very
  // gap (new x vs. where the last glyph ended) that tells a word break from a continuing word.
  const show = (bytes) => {
    const t = mapCodes(bytes, cmap, wide);
    const e = eff();
    if (t) {
      if (prevY !== null && Math.abs(st.y - prevY) > 0.5 * e) {
        if (!out.endsWith("\n")) out += "\n";
      } else if (prevY !== null && st.x - (st.prevEnd ?? st.x) > 0.25 * e && !/\s$/.test(out)) {
        out += " ";
      }
      out += t;
    }
    st.x += t.length * e * 0.5; // estimated advance
    st.prevEnd = st.x;
    prevY = st.y;
  };

  for (const tk of tokens(s)) {
    if (tk.t === "[") {
      arr = [];
      continue;
    }
    if (tk.t === "]") {
      stack.push({ t: "arr", v: arr || [] });
      arr = null;
      continue;
    }
    if (tk.t !== "op") {
      (arr ?? stack).push(tk);
      continue;
    }
    const n = (k) => (stack[stack.length - k]?.t === "num" ? stack[stack.length - k].v : 0);
    switch (tk.v) {
      // BT/ET delimit a text object, NOT a line: plenty of generators wrap every single word in its
      // own BT…ET. Treating either as a break is the same category of mistake as "a Td means a space".
      // Position carries over; only the geometry below decides spaces and line breaks.
      case "BT":
      case "ET":
        break;
      case "Tf":
        st.size = n(1) || st.size;
        break;
      case "TL":
        st.leading = n(1);
        break;
      case "Tm": {
        const a = n(6), d = n(3);
        st.scale = Math.abs(a) || Math.abs(d) || 1;
        st.lx = st.x = n(2);
        st.ly = st.y = n(1);
        break;
      }
      case "TD":
        st.leading = -n(1);
      // falls through — TD is Td plus a leading side-effect
      case "Td":
        st.lx += n(2);
        st.ly += n(1);
        st.x = st.lx;
        st.y = st.ly;
        break;
      case "T*":
        st.ly -= st.leading;
        st.x = st.lx;
        st.y = st.ly;
        break;
      case "Tj":
      case "'":
      case '"': {
        if (tk.v !== "Tj") {
          st.ly -= st.leading;
          st.x = st.lx;
          st.y = st.ly;
        }
        const top = stack[stack.length - 1];
        if (top?.t === "str") show(top.v);
        break;
      }
      case "TJ": {
        const a = stack[stack.length - 1];
        if (a?.t === "arr") {
          for (const el of a.v) {
            if (el.t === "str") show(el.v);
            else if (el.t === "num") {
              // A kern is exact data (thousandths of an em), unlike our estimated glyph advance — so
              // word breaks inside a TJ are decided by the kern itself, not by accumulated position.
              // This is what keeps LaTeX-style PDFs (which space words purely by kerning) readable.
              if (el.v <= -120 && out && !/\s$/.test(out)) out += " ";
              st.x -= (el.v / 1000) * eff();
              st.prevEnd = st.x;
            }
          }
        }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
  return out;
}

/** Heuristic: does this read like human prose, or like a failed extraction? */
export function looksLikeProse(t) {
  if (!t || t.length < 200) return false;
  const letters = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (letters / t.length < 0.55) return false; // mostly symbols/whitespace → garbage
  const words = t.split(/\s+/).filter((w) => /^[A-Za-zÀ-ÿ'’-]{2,}$/.test(w));
  return words.length >= 40;
}

/**
 * Extract text from a PDF buffer. Returns "" when nothing readable comes out (scanned PDF, unmapped
 * subset font, encrypted). Callers must treat "" as "no notice text" — never as an empty notice.
 */
export function pdfToText(buf) {
  const bin = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  if (!bin.startsWith("%PDF")) return "";

  const streams = [];
  const re = /stream\r?\n([\s\S]*?)[\r\n]*endstream/g;
  let m;
  while ((m = re.exec(bin)) !== null) {
    const raw = Buffer.from(m[1], "latin1");
    let data = null;
    for (const fn of [inflateSync, inflateRawSync]) {
      try {
        data = fn(raw);
        break;
      } catch {
        /* try the next encoding */
      }
    }
    streams.push(data ? data.toString("latin1") : m[1]);
  }

  const cmap = new Map();
  for (const s of streams) if (/beginbfchar|beginbfrange/.test(s)) parseCMap(s, cmap);
  // Identity-H style fonts index by 2-byte codes; a CMap whose keys exceed one byte tells us so.
  const wide = [...cmap.keys()].some((k) => k > 0xff);

  const chunks = [];
  for (const s of streams) {
    if (!/\)\s*Tj|\]\s*TJ|BT[\s\r\n]/.test(s)) continue; // not a text content stream
    chunks.push(textFromContentStream(s, cmap, wide));
  }
  const text = chunks
    .join("\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return looksLikeProse(text) ? text : "";
}
