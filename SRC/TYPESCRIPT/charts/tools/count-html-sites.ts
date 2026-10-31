// Count the format!/write! sites in html.rs that build HTML, and classify
// every interpolated value by how it is (or is not) escaped.
//
//   node --experimental-strip-types charts/tools/count-html-sites.ts [path/to/html.rs] [--list]
//
// Heuristic, string-aware lexer; no Rust parser. "unresolved" means the value
// is interpolated raw and is not obviously a number, a literal, or a helper
// that returns already-built HTML: those are the ones to review by hand.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Class = "escaped" | "numeric-spec" | "html-helper" | "literal" | "number-like" | "unresolved";

export interface Hole {
  line: number;
  expr: string;
  spec: string;
  cls: Class;
}

export interface Site {
  line: number;
  macro: "format" | "write";
  html: boolean;
  holes: Hole[];
}

/** Skip a string/raw-string/char literal starting at i; return index of its last char, or -1. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if ((c === "r" || (c === "b" && src[i + 1] === "r")) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
    const m = /^b?r(#*)"/.exec(src.slice(i, i + 10));
    if (m) {
      const close = '"' + (m[1] ?? "");
      return src.indexOf(close, i + m[0].length) + close.length - 1;
    }
  }
  if (c === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    return j;
  }
  if (c === "'") {
    if (src[i + 1] === "\\") return src.indexOf("'", i + 3);
    if (src[i + 2] === "'") return i + 2;
    const cp = src.codePointAt(i + 1) ?? 0;
    if (cp > 0xffff && src[i + 3] === "'") return i + 3;
  }
  return -1;
}

/** Split the argument list of a macro call starting after "(" into top-level args. */
function macroArgs(src: string, open: number): { args: { text: string; at: number }[]; end: number } {
  const args: { text: string; at: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < src.length; i++) {
    const lit = skipLiteral(src, i);
    if (lit >= 0) {
      i = lit;
      continue;
    }
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        args.push({ text: src.slice(start, i), at: start });
        return { args: args.filter((a) => a.text.trim() !== ""), end: i };
      }
      depth--;
    } else if (c === "," && depth === 0) {
      args.push({ text: src.slice(start, i), at: start });
      start = i + 1;
    }
  }
  throw new Error("unbalanced macro");
}

/** The literal's contents (raw or cooked, unescaping only \" and \\). */
function literalBody(text: string): string | null {
  const t = text.trim();
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(t);
  if (raw) return raw[2] ?? "";
  const cooked = /^"([\s\S]*)"$/.exec(t);
  return cooked ? (cooked[1] ?? "").replace(/\\(["\\])/g, "$1") : null;
}

const HELPERS =
  /^(tile|dur|dur_f|hm|hms|fmt_num|bar_chart|line_chart|heat_matrix|connections_table|ago|day_timeline|map_block|md_html|booking_gantt|bookings_table|booking_local|timeline_dropdown|frame_options|route_str|kind_str|gantt_legend|global_crosspoint|last_connection_overall|user_port|page)\(/;

export function classify(expr: string, spec: string): Class {
  const e = expr.trim();
  if (/\besc\(/.test(e)) return "escaped";
  if (/^\.\d|^\d|^0\d|^>|^<|^\^/.test(spec) && spec !== "") return "numeric-spec";
  if (HELPERS.test(e)) return "html-helper";
  if (/^"[^"]*"$/.test(e) || /^if\b[\s\S]*\{\s*"[^"]*"\s*\}\s*else\s*(if\b[\s\S]*)?\{\s*"[^"]*"\s*\}$/.test(e)) return "literal";
  if (/^-?\d/.test(e) || /\b(len|count|used|capacity|casters|user_ports|sum|unix|index|port|gpio_sent|frames|trunks|connections|max|min|round|floor|ceil)\b\(?\)?$/.test(e) || /\bas (u\d+|i\d+|usize|f64|f32)$/.test(e)) return "number-like";
  return "unresolved";
}

export function scan(src: string): Site[] {
  const sites: Site[] = [];
  const lineAt = (i: number): number => src.slice(0, i).split("\n").length;
  const re = /\b(format|write)!\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // Skip matches inside comments (line starts with //).
    const ls = src.lastIndexOf("\n", m.index) + 1;
    if (/^\s*\/\//.test(src.slice(ls, m.index))) continue;
    const kind = m[1] === "write" ? "write" : "format";
    const { args } = macroArgs(src, m.index + m[0].length - 1);
    const fmtArg = kind === "write" ? args[1] : args[0];
    const body = fmtArg ? literalBody(fmtArg.text) : null;
    if (body === null || !fmtArg) continue;
    const rest = args.slice(kind === "write" ? 2 : 1);
    const named = new Map<string, string>();
    const positional: string[] = [];
    for (const a of rest) {
      const nm = /^\s*([a-z_][a-z0-9_]*)\s*=(?!=)\s*([\s\S]*)$/.exec(a.text);
      if (nm && nm[1] && nm[2] !== undefined) named.set(nm[1], nm[2]);
      else positional.push(a.text);
    }
    const holes: Hole[] = [];
    let next = 0;
    const ph = /\{\{|\}\}|\{([^{}]*)\}/g;
    for (let p = ph.exec(body); p; p = ph.exec(body)) {
      if (p[1] === undefined) continue;
      const [argName = "", spec = ""] = p[1].split(":");
      let expr: string;
      if (argName === "") expr = positional[next++] ?? "?";
      else if (/^\d+$/.test(argName)) expr = positional[Number(argName)] ?? "?";
      else expr = named.get(argName) ?? argName;
      holes.push({ line: lineAt(fmtArg.at), expr: expr.trim().replace(/\s+/g, " "), spec, cls: classify(expr, spec) });
    }
    sites.push({ line: lineAt(m.index), macro: kind, html: /<[a-zA-Z/!]/.test(body), holes });
  }
  return sites;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(here, "..", "..", "..", "RUST-RUNTIME", "src", "html.rs");
  const src = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const sites = scan(src);
  const htmlSites = sites.filter((s) => s.html);
  const holes = htmlSites.flatMap((s) => s.holes);
  const by = new Map<Class, number>();
  for (const h of holes) by.set(h.cls, (by.get(h.cls) ?? 0) + 1);
  const withRaw = htmlSites.filter((s) => s.holes.some((h) => h.cls === "unresolved"));
  console.log(`file: ${path} (${src.split("\n").length} lines)`);
  console.log(`format!/write! with a literal format string: ${sites.length} (format! ${sites.filter((s) => s.macro === "format").length}, write! ${sites.filter((s) => s.macro === "write").length})`);
  console.log(`  ...that emit HTML/SVG markup: ${htmlSites.length}`);
  console.log(`interpolated holes in those: ${holes.length}`);
  for (const c of ["escaped", "numeric-spec", "number-like", "html-helper", "literal", "unresolved"] as const) console.log(`  ${c.padEnd(13)} ${by.get(c) ?? 0}`);
  console.log(`HTML sites with >= 1 unresolved raw hole: ${withRaw.length}`);
  if (process.argv.includes("--list")) {
    for (const h of holes.filter((x) => x.cls === "unresolved")) console.log(`  ${h.line}\t{${h.spec ? ":" + h.spec : ""}}\t${h.expr.slice(0, 110)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
