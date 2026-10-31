// Regenerate golden/golden.json by compiling the *real* Rust functions.
//
//   node --experimental-strip-types charts/golden/gen-golden.ts
//
// Extracts dur, dur_f, hm, hms, md_html, line_chart, bar_chart, heat_matrix,
// nice_ceiling, fmt_num, tile, last_connection_overall and users_page verbatim
// from RUST-RUNTIME/src/html.rs (plus util::esc and sdk ocean_between),
// wraps them in a tiny shim crate under the OS temp dir, runs rustc, and
// writes every output string for the inputs in cases.ts. If html.rs changes,
// re-running this (and the tests) shows exactly which output drifted.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Series } from "../src/charts.ts";
import type { UserRecord, UsersPageData } from "../src/users-page.ts";
import { barCases, durCases, durFCases, fmtCases, heatCases, hmCases, lineCases, mdCases, niceCases, usersCases } from "./cases.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

/** Return the source of `fn <name>` (with doc-less body), lexing strings,
 * raw strings and char literals so braces inside them are ignored. */
export function extractFn(src: string, name: string): string {
  const m = new RegExp(`(^|\\n)((?:pub(?:\\([a-z]+\\))? )?fn ${name}\\b)`).exec(src);
  if (!m) throw new Error(`fn ${name} not found`);
  const start = m.index + m[1]!.length;
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "r" && /^r#*"/.test(src.slice(i, i + 8)) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      const hashes = /^r(#*)"/.exec(src.slice(i))![1]!;
      const close = '"' + hashes;
      const end = src.indexOf(close, i + 2 + hashes.length);
      i = end + close.length - 1;
    } else if (c === '"') {
      i++;
      while (src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (c === "'") {
      if (src[i + 1] === "\\") i = src.indexOf("'", i + 3);
      else if (src[i + 2] === "'") i += 2;
      else if (src.codePointAt(i + 1)! > 0xffff && src[i + 3] === "'") i += 3;
      // otherwise a lifetime: skip nothing
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced fn ${name}`);
}

const rs = {
  f64(v: number): string {
    if (Number.isNaN(v)) return "f64::NAN";
    if (v === Infinity) return "f64::INFINITY";
    if (v === -Infinity) return "f64::NEG_INFINITY";
    if (Object.is(v, -0)) return "-0.0_f64";
    return `${String(v)}_f64`.replace("e+", "e");
  },
  str(s: string): string {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"';
  },
  string(s: string): string {
    return `${rs.str(s)}.to_string()`;
  },
  opt(s: string | null | undefined): string {
    return s == null ? "None" : `Some(${rs.string(s)})`;
  },
  vecF(v: readonly number[]): string {
    return `vec![${v.map(rs.f64).join(", ")}]`;
  },
  series(s: readonly Series[]): string {
    return `vec![${s.map(([l, c, v]) => `(${rs.str(l)}, ${rs.str(c)}, ${rs.vecF(v)})`).join(", ")}]`;
  },
  record(r: UserRecord): string {
    const how = r.how ? `Some(How { kind: RouteKind::${r.how.kind === "via" ? "Via" : "Direct"}, via: vec![${r.how.via.map(rs.string).join(", ")}] })` : "None";
    const status = r.status === "granted" ? "Granted" : r.status === "denied" ? "Denied" : "Released";
    return `UserRecord { id: ${rs.string(r.id)}, who: ${rs.string(r.who)}, whom: ${rs.string(r.whom)}, from: ${rs.string(r.from)}, when: ${rs.string(r.when)}, why: ${rs.opt(r.why)}, where_: ${rs.opt(r.where)}, how: ${how}, status: ReplyStatus::${status}, reason: ${rs.opt(r.reason)}, origin: ${rs.string(r.origin)}, connected_seconds: ${r.connected_seconds == null ? "None" : `Some(${r.connected_seconds})`}, gpio_sent: ${r.gpio_sent ?? 0} }`;
  },
  runtime(d: UsersPageData): string {
    const conns = d.state.connections.map((c) => `Connection { id: ${rs.string(c.id)}, who: ${rs.string(c.who)}, granted_unix: ${c.granted_unix ?? 0} }`);
    const acts = Object.entries(d.state.last_activity ?? {}).map(([k, a]) => `(${rs.string(k)}, LastActivity { unix: ${a.unix} })`);
    return `Runtime { now: ${d.now}, recent_records: vec![${d.records.map(rs.record).join(", ")}], state: State { connections: vec![${conns.join(", ")}], last_activity: BTreeMap::from([${acts.join(", ")}]) } }`;
  },
};

const SHIM = `
#![allow(dead_code, unused, private_interfaces)]
use std::collections::BTreeMap;
use std::fmt::Write;

mod trunk_caster_sdk {
    __OCEAN__
}

__ESC__

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind { Direct, Via }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplyStatus { Granted, Denied, Released }
struct How { kind: RouteKind, via: Vec<String> }
struct UserRecord {
    id: String, who: String, whom: String, from: String, when: String,
    why: Option<String>, where_: Option<String>, how: Option<How>, status: ReplyStatus,
    reason: Option<String>, origin: String, connected_seconds: Option<u64>, gpio_sent: u32,
}
struct Connection { id: String, who: String, granted_unix: u64 }
impl Connection { fn connected_for(&self, now_unix: u64) -> u64 { now_unix.saturating_sub(self.granted_unix) } }
struct LastActivity { unix: u64 }
struct State { connections: Vec<Connection>, last_activity: BTreeMap<String, LastActivity> }
impl State { fn connection(&self, id: &str) -> Option<&Connection> { self.connections.iter().find(|c| c.id == id) } }
struct Runtime { now: u64, recent_records: Vec<UserRecord>, state: State }
fn page(_title: &str, _rt: &Runtime, _live: bool, _refresh_ms: u32, body: &str) -> String { body.to_string() }

fn j(s: &str) -> String {
    let mut o = String::from("\\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\\\\""),
            '\\\\' => o.push_str("\\\\\\\\"),
            c if (c as u32) < 0x20 => { let _ = write!(o, "\\\\u{:04x}", c as u32); }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

__FNS__

fn main() {
    let mut groups: Vec<(&str, Vec<String>)> = Vec::new();
    __CASES__
    let mut out = String::from("{\\n");
    for (gi, (name, items)) in groups.iter().enumerate() {
        let _ = write!(out, "  {}: [\\n", j(name));
        for (i, s) in items.iter().enumerate() {
            let _ = write!(out, "    {}{}\\n", j(s), if i + 1 < items.len() { "," } else { "" });
        }
        let _ = write!(out, "  ]{}\\n", if gi + 1 < groups.len() { "," } else { "" });
    }
    out.push_str("}\\n");
    print!("{}", out);
}
`;

function main(): void {
  const html = readFileSync(join(repo, "RUST-RUNTIME", "src", "html.rs"), "utf8").replace(/\r\n/g, "\n");
  const util = readFileSync(join(repo, "RUST-RUNTIME", "src", "util.rs"), "utf8").replace(/\r\n/g, "\n");
  const sites = readFileSync(join(repo, "TRUNK-CASTER-SDK", "src", "sites.rs"), "utf8").replace(/\r\n/g, "\n");
  const names = ["dur", "dur_f", "hm", "hms", "md_html", "line_chart", "bar_chart", "heat_matrix", "nice_ceiling", "fmt_num", "tile", "last_connection_overall", "users_page"];
  const fns = names.map((n) => extractFn(html, n)).join("\n\n").replace("let now = util::now_unix();", "let now = rt.now;");

  const c: string[] = [];
  const group = (name: string, exprs: string[]): void => {
    c.push(`groups.push((${rs.str(name)}, vec![${exprs.map((e) => `(${e}).to_string()`).join(",\n        ")}]));`);
  };
  group("dur", durCases.map((v) => `dur(${v}_u64)`));
  group("dur_f", durFCases.map((v) => `dur_f(${rs.f64(v)})`));
  group("hm", hmCases.map((v) => `hm(${rs.f64(v)})`));
  group("hms", hmCases.map((v) => `hms(${rs.f64(v)})`));
  group("nice_ceiling", niceCases.map((v) => `format!("{}", nice_ceiling(${rs.f64(v)}))`));
  group("fmt_num", fmtCases.map((v) => `fmt_num(${rs.f64(v)})`));
  group("md_html", mdCases.map((m) => `md_html(${rs.str(m)})`));
  group("line_chart", lineCases.map((k) => `line_chart(${rs.str(k.title)}, &${rs.vecF(k.xs)}, &${rs.series(k.series)}, ${k.yMax === null ? "None" : `Some(${rs.f64(k.yMax)})`})`));
  group("bar_chart", barCases.map((k) => `bar_chart(${rs.str(k.title)}, &[${k.cats.map(rs.str).join(", ")}], &${rs.series(k.series)})`));
  group(
    "heat_matrix",
    heatCases.map((k) => {
      const labels = `[${k.labels.map(rs.str).join(", ")}]`;
      const m = `vec![${k.matrix.map((row) => rs.vecF(row)).join(", ")}]`;
      return `{ let l: Vec<&str> = vec!${labels}; let m: Vec<Vec<f64>> = ${m}; heat_matrix(${rs.str(k.title)}, &l, &|a: &str, b: &str| { let i = l.iter().position(|x| *x == a).unwrap(); let k = l.iter().position(|x| *x == b).unwrap(); m[i][k] }) }`;
    }),
  );
  group("users_page", usersCases.map((d) => `{ let rt = ${rs.runtime(d)}; users_page(&rt, true) }`));

  const program = SHIM.replace("__OCEAN__", extractFn(sites, "ocean_between"))
    .replace("__ESC__", extractFn(util, "esc"))
    .replace("__FNS__", fns)
    .replace("__CASES__", c.join("\n    "));
  const dir = join(tmpdir(), "trunk-caster-charts-golden");
  mkdirSync(dir, { recursive: true });
  const srcPath = join(dir, "main.rs");
  const exe = join(dir, process.platform === "win32" ? "golden.exe" : "golden");
  writeFileSync(srcPath, program);
  execFileSync("rustc", ["--edition", "2021", "-O", srcPath, "-o", exe], { stdio: "inherit" });
  const out = execFileSync(exe, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  JSON.parse(out); // validate
  writeFileSync(join(here, "golden.json"), out);
  console.log(`golden.json: ${out.length} bytes from ${srcPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
