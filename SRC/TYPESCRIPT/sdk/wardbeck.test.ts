import { test } from "node:test";
import assert from "node:assert/strict";
import * as wb from "./wardbeck.ts";

// --- Mirrors of wardbeck.rs #[cfg(test)] -----------------------------------

test("round_trip (wardbeck.rs)", () => {
  const l = wb.between("HQ", "dante-01", "U00", "Andrey", "CLOSE", "Sam", "U05", "sip-03", "HQ");
  const s = wb.format(l);
  assert.equal(s, "HQ,dante-01,U00,Andrey,CLOSE,Sam,U05,sip-03,HQ");
  assert.deepEqual(wb.parseOrThrow(s), l);
  assert.equal(wb.isLocal(l), false);
  assert.equal(wb.flipped(l).switch, "OPEN");
});

test("checkin_line (wardbeck.rs)", () => {
  const c = wb.checkin("HQ", "rvon-02", "2026-10-20T12:00:00Z", 4);
  assert.ok(wb.isCheckin(c));
  assert.equal(wb.format(c), "HQ,rvon-02,CHECKIN,2026-10-20T12:00:00Z,CLOSE,4 crosspoints,4,rvon-02,HQ");
  assert.equal(wb.checkin("HQ", "rvon-02", "t", 0).switch, "OPEN");
});

test("quoted_fields (wardbeck.rs)", () => {
  const l = wb.local("Site, North", "f", "U01", "Smith, J", "OPEN", "x", "C0");
  const s = wb.format(l);
  assert.ok(s.startsWith('"Site, North"'));
  assert.deepEqual(wb.parseOrThrow(s), l);
  assert.equal(wb.parse("a,b,c").ok, false);
});

// --- Extra cases -----------------------------------------------------------

test("OPEN is expressed, never implied", () => {
  const l = wb.local("HQ", "dante-01", "U03", "Ann", "OPEN", "Bob", "C1");
  assert.equal(wb.format(l), "HQ,dante-01,U03,Ann,OPEN,Bob,C1,dante-01,HQ");
  assert.ok(wb.isLocal(l));
  assert.deepEqual(wb.flipped(wb.flipped(l)), l);
});

test("error messages match Rust", () => {
  assert.deepEqual(wb.parse("a,b,c"), { ok: false, error: "expected 9 fields, got 3" });
  assert.deepEqual(wb.parse("a,b,c,d,maybe,f,g,h,i"), { ok: false, error: "field 5 must be CLOSE or OPEN, got MAYBE" });
  assert.equal(wb.parse("a,b,c,d,e,f,g,h,i,j").ok, false);
});

test("switch is case-insensitive (ASCII only), fields trimmed", () => {
  const r = wb.parseOrThrow("  HQ , f , U00 , A , close , B , U01 , f , HQ  ");
  assert.equal(r.switch, "CLOSE");
  assert.equal(r.site, "HQ");
  assert.equal(r.out_site, "HQ");
  // U+017F LATIN SMALL LETTER LONG S uppercases to "S" in JS but not in Rust's to_ascii_uppercase.
  const longS = String.fromCodePoint(0x17f);
  assert.equal(wb.parse(`a,b,c,d,clo${longS}e,f,g,h,i`).ok, false);
});

test("embedded quotes double and round-trip", () => {
  const l = wb.local("HQ", "f", "U01", 'Jo "DJ" Smith', "CLOSE", "x,y", "C0");
  const s = wb.format(l);
  assert.equal(s, 'HQ,f,U01,"Jo ""DJ"" Smith",CLOSE,"x,y",C0,f,HQ');
  assert.deepEqual(wb.parseOrThrow(s), l);
  assert.ok(wb.roundTrips(l));
});

test("emoji names survive the line", () => {
  const l = wb.between("London", "london-01", "U07", "🎙️ Studio B", "CLOSE", "🇺🇸 NYC", "U12", "washington-03", "Washington");
  assert.deepEqual(wb.parseOrThrow(wb.format(l)), l);
});

test("latent: whitespace-edged and CR/LF names do not round-trip", () => {
  const padded = wb.local("HQ", "f", "U01", " Ann ", "CLOSE", "x", "C0");
  assert.equal(wb.parseOrThrow(wb.format(padded)).input_name, "Ann");
  assert.equal(wb.roundTrips(padded), false);
  const nl = wb.local("HQ", "f", "U01", "Ann\nBob", "CLOSE", "x", "C0");
  assert.equal(wb.roundTrips(nl), false);
});

test("unbalanced quote is accepted, like Rust", () => {
  const r = wb.parse('a,b,c,"d,CLOSE,f,g,h,i');
  // the quote swallows the rest: 4 fields, so rejected on count, not on syntax
  assert.deepEqual(r, { ok: false, error: "expected 9 fields, got 4" });
});

test("serde JSON shape of WbLine", () => {
  const l = wb.local("HQ", "f", "U00", "A", "CLOSE", "B", "U01");
  assert.deepEqual(Object.keys(l).sort(), ["frame", "input", "input_name", "out_frame", "out_site", "output", "output_name", "site", "switch"]);
});

test("wildcard announce as frame-sim sends it", () => {
  const a = wb.checkin("HQ", "dante-*", "2026-10-21T00:00:00Z @sim-dante", 0);
  const s = wb.format(a);
  assert.equal(s, "HQ,dante-*,CHECKIN,2026-10-21T00:00:00Z @sim-dante,OPEN,0 crosspoints,0,dante-*,HQ");
  const back = wb.parseOrThrow(s);
  // wb.rs: host = text after the last '@', trimmed
  const at = back.input_name.lastIndexOf("@");
  assert.equal(back.input_name.slice(at + 1).trim(), "sim-dante");
});
