// Streaming validation of the append-only JSONL logs. Some are hundreds of
// MB (renames.jsonl was 216 MB), so lines are read one at a time and the
// issues are folded into counted patterns instead of one entry per line.

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { isPlainObject, newCtx, type Check, type Level } from "./check.ts";

export interface IssuePattern {
  readonly level: Level;
  readonly path: string;
  readonly message: string;
  count: number;
  readonly firstLine: number;
}

export interface JsonlReport {
  readonly bytes: number;
  lines: number;
  blank: number;
  syntaxErrors: number;
  valid: number;
  invalid: number;
  /** Lines whose seq is not greater than the previous line's: a restart. */
  seqResets: number;
  /** Lines written by simulated traffic (connection sim-/bldg-, origin simulator). */
  simulated: number;
  firstAt: string | undefined;
  lastAt: string | undefined;
  truncated: boolean;
  readonly patterns: Map<string, IssuePattern>;
  ms: number;
}

/** Fold variable parts so one bad field over a million lines is one pattern. */
export function patternKey(level: Level, path: string, message: string): string {
  const p = path.replace(/\[\d+\]/g, "[*]");
  const m = message.replace(/"[^"]*"/g, '"…"').replace(/-?\d+(?:\.\d+)?/g, "#");
  return `${level}|${p}|${m}`;
}

export function isSimulated(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const conn = v["connection"];
  if (typeof conn === "string" && (conn.startsWith("sim-") || conn.startsWith("bldg-"))) return true;
  return v["origin"] === "simulator";
}

export function newReport(bytes: number): JsonlReport {
  return {
    bytes, lines: 0, blank: 0, syntaxErrors: 0, valid: 0, invalid: 0, seqResets: 0, simulated: 0,
    firstAt: undefined, lastAt: undefined, truncated: false, patterns: new Map(), ms: 0,
  };
}

/** Validate one line into the report. Exposed for tests. */
export function feedLine<T>(r: JsonlReport, check: Check<T>, line: string, lineNo: number, prevSeq: { v: number }): void {
  r.lines++;
  if (line.trim() === "") {
    r.blank++;
    return;
  }
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    r.syntaxErrors++;
    const glued = /\}\{"seq":/.test(line);
    bump(r, "error", "", glued
      ? "two records glued on one line: concurrent appenders (writeln! issues line and \\n as separate writes)"
      : "JSON syntax error: partial line (torn write)", lineNo);
    return;
  }
  const ctx = newCtx();
  if (check(v, "", ctx)) r.valid++;
  else r.invalid++;
  for (const i of ctx.issues) bump(r, i.level, i.path, i.message, lineNo);
  if (isSimulated(v)) r.simulated++;
  if (isPlainObject(v)) {
    const seq = v["seq"];
    if (typeof seq === "number") {
      if (r.lines > 1 && seq <= prevSeq.v) r.seqResets++;
      prevSeq.v = seq;
    }
    const at = v["at"];
    if (typeof at === "string") {
      r.firstAt ??= at;
      r.lastAt = at;
    }
  }
}

function bump(r: JsonlReport, level: Level, path: string, message: string, line: number): void {
  const k = patternKey(level, path, message);
  const hit = r.patterns.get(k);
  if (hit) hit.count++;
  else r.patterns.set(k, { level, path, message, count: 1, firstLine: line });
}

export async function scanJsonl<T>(file: string, check: Check<T>, maxLines = Infinity): Promise<JsonlReport> {
  const t0 = performance.now();
  const r = newReport(statSync(file).size);
  const prev = { v: -1 };
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    feedLine(r, check, line, n, prev);
    if (n >= maxLines) {
      r.truncated = true;
      rl.close();
      stream.destroy();
      break;
    }
  }
  r.ms = performance.now() - t0;
  return r;
}
