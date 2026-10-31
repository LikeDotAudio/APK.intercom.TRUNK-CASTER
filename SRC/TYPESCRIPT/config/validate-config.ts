// validate-config: check every hand-edited Trunk-Caster config file and
// every JSONL log against the shapes the Rust runtime reads and writes.
//
//   node --experimental-strip-types config/validate-config.ts            (from TYPESCRIPT/)
//   ... --root <project root>    default: two folders up from this file
//   ... --quick                  read at most 200k lines of each log
//   ... --no-logs                configs only (instant)
//   ... --json                   machine-readable report on stdout
//   ... --strict                 exit 1 on warnings and on log errors too
//
// Exit code: 0 when every config parses the way serde would and passes the
// semantic rules; 1 otherwise. Never writes anything.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateText, type Issue } from "./src/check.ts";
import { scanJsonl, type JsonlReport } from "./src/jsonl.ts";
import { CONFIGS, LOGS, type ConfigEntry } from "./src/registry.ts";
import { siteFrameIds } from "./src/schemas.ts";
import type { ConnectGuide, Emulators, Fader, Sites, VendorPolicy } from "./src/types.ts";

interface ConfigResult {
  readonly id: string;
  readonly path: string;
  readonly present: boolean;
  readonly ok: boolean;
  readonly onInvalid: string;
  readonly issues: Issue[];
}

interface LogResult {
  readonly id: string;
  readonly path: string;
  readonly present: boolean;
  readonly rotated: boolean;
  readonly simFiltered: boolean;
  readonly report: JsonlReport | undefined;
}

export interface Report {
  readonly root: string;
  readonly configs: ConfigResult[];
  readonly cross: Issue[];
  readonly logs: LogResult[];
}

function args(argv: readonly string[]): { root: string; quick: boolean; logs: boolean; json: boolean; strict: boolean } {
  const here = dirname(fileURLToPath(import.meta.url));
  let root = resolve(here, "..", "..");
  const i = argv.indexOf("--root");
  if (i >= 0 && argv[i + 1]) root = resolve(argv[i + 1] ?? root);
  return { root, quick: argv.includes("--quick"), logs: !argv.includes("--no-logs"), json: argv.includes("--json"), strict: argv.includes("--strict") };
}

function checkConfig(root: string, e: ConfigEntry): { result: ConfigResult; value: unknown } {
  const file = join(root, e.path);
  if (!existsSync(file)) {
    return { result: { id: e.id, path: e.path, present: false, ok: true, onInvalid: e.onInvalid, issues: [{ level: "warn", path: "", message: "missing: the runtime writes defaults on boot" }] }, value: undefined };
  }
  const parsed = validateText(e.check, readFileSync(file, "utf8"));
  const issues = [...parsed.issues];
  if (!parsed.ok && e.onInvalid === "overwritten") {
    issues.push({ level: "error", path: "", message: "THE RUNTIME WILL OVERWRITE THIS FILE WITH DEFAULTS on next boot (your edits are lost)" });
  } else if (!parsed.ok && e.onInvalid === "default") {
    issues.push({ level: "error", path: "", message: "the runtime silently ignores this file and runs on built-in defaults" });
  }
  return { result: { id: e.id, path: e.path, present: true, ok: parsed.ok && !issues.some((x) => x.level === "error"), onInvalid: e.onInvalid, issues }, value: parsed.value };
}

/** Four-letter codes a capital name may go by in the Python emulators (MEXC = Mexico City, DELH = New Delhi). */
export function capitalCodes(name: string): string[] {
  const words = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const joined = words.join("");
  const codes = [joined.slice(0, 4)];
  const last = words[words.length - 1];
  if (last) codes.push(last.slice(0, 4));
  const first = words[0];
  const second = words[1];
  if (first && second) codes.push(first.slice(0, 3) + second.slice(0, 1));
  return codes;
}

/** Rules that span two files. */
export function crossChecks(root: string, v: Readonly<Record<string, unknown>>): Issue[] {
  const out: Issue[] = [];
  const sites = v["sites"] as Sites | undefined;
  const fader = v["fader"] as Fader | undefined;
  const emu = v["emulators"] as Emulators | undefined;
  const policy = v["vendor-policy"] as VendorPolicy | undefined;
  const connect = v["connect"] as ConnectGuide | undefined;

  if (sites && fader) {
    const ids = siteFrameIds(sites);
    (fader.productions ?? []).forEach((p, i) => {
      if (p.studio && !ids.has(p.studio)) out.push({ level: "warn", path: `fader.productions[${i}].studio`, message: `"${p.studio}" is not a site frame from sites.json` });
    });
    const venue = fader.day?.olympics?.venue;
    if (venue && !ids.has(venue)) out.push({ level: "warn", path: "fader.day.olympics.venue", message: `"${venue}" is not a site frame from sites.json` });
  }
  if (sites && emu) {
    const capitals = sites.sites.filter((s) => s.tier === "capital");
    const missing: string[] = [];
    for (const vend of emu.vendors) {
      for (const code of vend.capitals) {
        if (!capitals.some((s) => capitalCodes(s.name).includes(code))) missing.push(code);
      }
    }
    if (missing.length) {
      out.push({ level: "warn", path: "emulators.vendors[*].capitals", message: `${missing.length} emulator capitals have no capital-tier site in sites.json (${capitals.length} capitals there): ${missing.join(" ")}` });
    }
  }
  if (emu) {
    for (const vend of emu.vendors) {
      if (!existsSync(join(root, vend.emulator))) out.push({ level: "warn", path: `emulators.${vend.vendor}.emulator`, message: `${vend.emulator} does not exist: launch_all.py uses the ${emu.stand_in ?? "RTS"} stand-in` });
    }
  }
  if (policy) {
    const vendorDir = join(root, "KNOWN PROTOCOLS", "VENDOR");
    const vendors = existsSync(vendorDir) ? readdirSync(vendorDir).filter((n) => statSync(join(vendorDir, n)).isDirectory()) : [];
    for (const k of Object.keys(policy.renames)) {
      if (k !== "default" && !vendors.includes(k)) out.push({ level: "warn", path: `vendor-policy.renames.${k}`, message: `no KNOWN PROTOCOLS/VENDOR/${k} folder: the key never matches a vendor` });
    }
  }
  if (connect && emu?.combined_map_port) {
    const m = /:(\d+)$/.exec(connect.api.base_url);
    if (m && Number(m[1]) !== emu.combined_map_port) out.push({ level: "warn", path: "connect.api.base_url", message: `port ${m[1]} but emulators.combined_map_port is ${emu.combined_map_port}` });
  }
  return out;
}

export async function run(root: string, opts: { quick: boolean; logs: boolean }): Promise<Report> {
  const values: Record<string, unknown> = {};
  const configs: ConfigResult[] = [];
  for (const e of CONFIGS) {
    const { result, value } = checkConfig(root, e);
    configs.push(result);
    if (value !== undefined) values[e.id] = value;
  }
  const cross = crossChecks(root, values);
  const logs: LogResult[] = [];
  if (opts.logs) {
    for (const e of LOGS) {
      const file = join(root, e.path);
      const present = existsSync(file);
      const rotated = existsSync(file.replace(/\.jsonl$/, ".jsonl.1"));
      const report = present ? await scanJsonl(file, e.check, opts.quick ? 200_000 : Infinity) : undefined;
      logs.push({ id: e.id, path: e.path, present, rotated, simFiltered: e.simFiltered, report });
    }
  }
  return { root, configs, cross, logs };
}

const mb = (n: number): string => `${(n / 1_048_576).toFixed(1)} MB`;

export function render(r: Report): string {
  const out: string[] = [`validate-config  root=${r.root}`, "", "CONFIG FILES"];
  for (const c of r.configs) {
    const errs = c.issues.filter((i) => i.level === "error").length;
    const warns = c.issues.length - errs;
    const status = !c.present ? "MISSING" : c.ok ? (warns ? "OK*" : "OK") : "INVALID";
    out.push(`  ${status.padEnd(8)} ${c.path.padEnd(38)} ${errs} errors, ${warns} warnings   (on invalid: ${c.onInvalid})`);
    for (const i of c.issues) out.push(`             ${i.level === "error" ? "E" : "w"} ${i.path || "(root)"}: ${i.message}`);
  }
  out.push("", "CROSS-FILE");
  if (r.cross.length === 0) out.push("  OK");
  for (const i of r.cross) out.push(`  ${i.level === "error" ? "E" : "w"} ${i.path}: ${i.message}`);
  if (r.logs.length) out.push("", "JSONL LOGS");
  for (const l of r.logs) {
    if (!l.report) {
      out.push(`  ABSENT   ${l.path}`);
      continue;
    }
    const x = l.report;
    const bad = x.invalid + x.syntaxErrors;
    out.push(
      `  ${(bad ? "INVALID" : "OK").padEnd(8)} ${l.path.padEnd(38)} ${mb(x.bytes)}, ${x.lines.toLocaleString("en")} lines${x.truncated ? " (truncated --quick)" : ""}, ` +
        `${x.valid.toLocaleString("en")} valid, ${x.invalid} invalid, ${x.syntaxErrors} syntax, ${x.seqResets} seq resets, ${(x.lines ? (100 * x.simulated) / x.lines : 0).toFixed(1)}% simulated, ${Math.round(x.ms)} ms`,
    );
    out.push(`             ${x.firstAt ?? "?"} .. ${x.lastAt ?? "?"}${l.rotated ? "  (+ rotated .1)" : ""}`);
    if (x.bytes > 100 * 1_048_576) out.push(`             w size ${mb(x.bytes)} exceeds util::LOG_CAP (100 MB) and was never rotated`);
    if (l.simFiltered && x.simulated > 0) out.push(`             w ${x.simulated.toLocaleString("en")} simulated lines: the current runtime no longer writes these; stale, safe to archive`);
    const pats = [...x.patterns.values()].sort((a, b) => b.count - a.count).slice(0, 8);
    for (const p of pats) out.push(`             ${p.level === "error" ? "E" : "w"} ${p.count.toLocaleString("en")}x ${p.path || "(line)"}: ${p.message}  [first line ${p.firstLine}]`);
  }
  return out.join("\n");
}

export function exitCode(r: Report, strict: boolean): number {
  const cfgBad = r.configs.some((c) => !c.ok) || r.cross.some((i) => i.level === "error");
  if (cfgBad) return 1;
  if (!strict) return 0;
  const warn = r.configs.some((c) => c.issues.length > 0) || r.cross.length > 0;
  const logBad = r.logs.some((l) => l.report && l.report.invalid + l.report.syntaxErrors > 0);
  return warn || logBad ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = args(process.argv.slice(2));
  const report = await run(a.root, a);
  if (a.json) {
    const plain = { ...report, logs: report.logs.map((l) => ({ ...l, report: l.report ? { ...l.report, patterns: [...l.report.patterns.values()] } : undefined })) };
    process.stdout.write(JSON.stringify(plain, null, 2) + "\n");
  } else {
    process.stdout.write(render(report) + "\n");
  }
  process.exitCode = exitCode(report, a.strict);
}
