/**
 * The Ward-Beck crosspoint line — port of TRUNK-CASTER-SDK/src/wardbeck.rs.
 *
 *     SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
 *
 * Left side: where the signal enters. Right side: where it leaves. Both
 * carry their own frame and site, so one line is either a crosspoint inside
 * a frame (same frame, same site) or an end-to-end connection between two
 * frames anywhere. `CLOSE` makes the connection; `OPEN` expresses that it
 * is gone — OPEN is always written out, never implied by absence.
 *
 * A **check-in** is a line whose INPUT is `CHECKIN`: the frame restates how
 * many crosspoints it has closed, followed by one CLOSE line per crosspoint.
 */

import { rustTrim } from "./labels.ts";

/** serde `rename_all = "UPPERCASE"`. */
export type Switch = "CLOSE" | "OPEN";
export const SWITCHES: readonly Switch[] = ["CLOSE", "OPEN"];

/** The marker INPUT of a check-in line. */
export const CHECKIN = "CHECKIN";

/**
 * `wardbeck::Line` (re-exported by the crate as `WbLine`). When serialized
 * as JSON by serde the field names are exactly these (snake_case).
 */
export interface WbLine {
  site: string;
  frame: string;
  input: string;
  input_name: string;
  switch: Switch;
  output_name: string;
  output: string;
  out_frame: string;
  out_site: string;
}

/** Result of `parse`: mirrors Rust `Result<Line, String>` without throwing. */
export type ParseResult = { ok: true; line: WbLine } | { ok: false; error: string };

/** A crosspoint inside one frame (`Line::local`). */
export function local(
  site: string,
  frame: string,
  input: string,
  inputName: string,
  sw: Switch,
  outputName: string,
  output: string,
): WbLine {
  return {
    site,
    frame,
    input,
    input_name: inputName,
    switch: sw,
    output_name: outputName,
    output,
    out_frame: frame,
    out_site: site,
  };
}

/** An end-to-end connection between two frames, possibly at two sites (`Line::between`). */
export function between(
  site: string,
  frame: string,
  input: string,
  inputName: string,
  sw: Switch,
  outputName: string,
  output: string,
  outFrame: string,
  outSite: string,
): WbLine {
  return {
    site,
    frame,
    input,
    input_name: inputName,
    switch: sw,
    output_name: outputName,
    output,
    out_frame: outFrame,
    out_site: outSite,
  };
}

/**
 * A check-in: `SITE,FRAME,CHECKIN,<when>,CLOSE|OPEN,<n> crosspoints,<n>,FRAME,SITE`.
 * `CLOSE` when the frame has crosspoints closed, `OPEN` when it is idle.
 * Simulators put `"<when> @<host>"` in `when`; the caster reads the host
 * after the last `@`. `frame` may be a wildcard `<protocol>-*`.
 */
export function checkin(site: string, frame: string, when: string, closed: number): WbLine {
  return local(site, frame, CHECKIN, when, closed > 0 ? "CLOSE" : "OPEN", `${closed} crosspoints`, String(closed));
}

export function isCheckin(l: WbLine): boolean {
  return l.input === CHECKIN;
}

export function isLocal(l: WbLine): boolean {
  return l.frame === l.out_frame && l.site === l.out_site;
}

/** The opposite switch, same crosspoint (`Line::flipped`). */
export function flipped(l: WbLine): WbLine {
  return { ...l, switch: l.switch === "CLOSE" ? "OPEN" : "CLOSE" };
}

/** ASCII-only uppercase, like Rust `to_ascii_uppercase` (JS toUpperCase maps "ſ"→"S"). */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

/** Split one CSV record; `""` inside quotes is a literal quote; every field trimmed. */
export function splitCsv(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '"' && inQ && chars[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (c === '"') {
      inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(rustTrim(cur));
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(rustTrim(cur));
  return out;
}

/** Parse one line (`Line::parse`). Fields are trimmed; a field containing a comma must be double-quoted. */
export function parse(text: string): ParseResult {
  const f = splitCsv(rustTrim(text));
  if (f.length !== 9) return { ok: false, error: `expected 9 fields, got ${f.length}` };
  const sw = asciiUpper(f[4] ?? "");
  if (sw !== "CLOSE" && sw !== "OPEN") return { ok: false, error: `field 5 must be CLOSE or OPEN, got ${sw}` };
  const at = (i: number): string => f[i] ?? "";
  return {
    ok: true,
    line: {
      site: at(0),
      frame: at(1),
      input: at(2),
      input_name: at(3),
      switch: sw,
      output_name: at(5),
      output: at(6),
      out_frame: at(7),
      out_site: at(8),
    },
  };
}

/** Parse or throw — convenience for callers that want Rust's `.unwrap()`. */
export function parseOrThrow(text: string): WbLine {
  const r = parse(text);
  if (!r.ok) throw new Error(r.error);
  return r.line;
}

function q(s: string): string {
  return s.includes(",") || s.includes('"') ? `"${s.replaceAll('"', '""')}"` : s;
}

/** `impl Display for Line`: the wire text, without a trailing newline. */
export function format(l: WbLine): string {
  return [
    q(l.site),
    q(l.frame),
    q(l.input),
    q(l.input_name),
    l.switch,
    q(l.output_name),
    q(l.output),
    q(l.out_frame),
    q(l.out_site),
  ].join(",");
}

/** Structural equality (`#[derive(PartialEq)]`). */
export function lineEquals(a: WbLine, b: WbLine): boolean {
  return (
    a.site === b.site &&
    a.frame === b.frame &&
    a.input === b.input &&
    a.input_name === b.input_name &&
    a.switch === b.switch &&
    a.output_name === b.output_name &&
    a.output === b.output &&
    a.out_frame === b.out_frame &&
    a.out_site === b.out_site
  );
}

/**
 * True when `format(l)` parses back to `l` exactly. The Rust formatter only
 * quotes on `,` or `"`, so values with leading/trailing whitespace (lost to
 * trim) or CR/LF (breaks newline framing on the TCP port) do not survive.
 * Use this to validate names before they reach the wire.
 */
export function roundTrips(l: WbLine): boolean {
  const s = format(l);
  if (/[\r\n]/.test(s)) return false;
  const r = parse(s);
  return r.ok && lineEquals(r.line, l);
}
