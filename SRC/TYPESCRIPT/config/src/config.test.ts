import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, validateText, int, obj, opt, str } from "./check.ts";
import { feedLine, newReport, patternKey } from "./jsonl.ts";
import * as S from "./schemas.ts";
import { capitalCodes, crossChecks } from "../validate-config.ts";

const errors = (r: { issues: { level: string }[] }): number => r.issues.filter((i) => i.level === "error").length;

test("obj: missing required field is an error, unknown field a warning (serde ignores it)", () => {
  const c = obj<{ a: string; b?: number }>({ a: str(), b: opt(int()) });
  const r = validate(c, { b: 1, typo: true });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "a" && i.level === "error"));
  assert.ok(r.issues.some((i) => i.path === "typo" && i.level === "warn"));
});

test("int rejects fractions and negatives like serde u64", () => {
  assert.equal(validate(int(), 1.5).ok, false);
  assert.equal(validate(int(), -1).ok, false);
  assert.equal(validate(int(), 7).ok, true);
});

test("validateText reports JSON syntax at the root and tolerates a BOM", () => {
  assert.equal(validateText(str(), "{").ok, false);
  assert.equal(validateText(str(), '﻿"x"').ok, true);
});

test("globe: real file shape passes; zero anchors warns; bad projection warns", () => {
  const g = { rotate_deg_per_s: 5, tilt_deg: 61, show_capitals: true, show_provinces: true, show_cities: true, graticule_deg: 30, projection: "both", zoom: 0.99, zones: [{ name: "Saskatchewan", offset_hours: -6, anchor: true }] };
  assert.equal(errors(validate(S.globe, g)), 0);
  const r = validate(S.globe, { ...g, projection: "sphere", zones: [{ name: "X", offset_hours: 0 }] });
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.path === "projection"));
  assert.ok(r.issues.some((i) => i.path === "zones"));
});

test("globe: `null` for a #[serde(default)] f64 is refused (serde only defaults when absent)", () => {
  const g = { rotate_deg_per_s: 5, tilt_deg: 61, show_capitals: true, show_provinces: true, show_cities: true, graticule_deg: 30, zoom: null };
  assert.equal(validate(S.globe, g).ok, false);
});

test("fader: seed must be an integer; productions optional", () => {
  const f = { speed: 1, requests_per_minute: 1, mean_hold_seconds: 1, crosscheck_every_seconds: 1, sample_every_seconds: 1, running: true, seed: 7 };
  assert.equal(validate(S.fader, f).ok, true);
  assert.equal(validate(S.fader, { ...f, seed: 7.5 }).ok, false);
});

test("sites: duplicate slugs are errors; slugify matches sites.rs", () => {
  const s = { name: "Brasília", slug: "bras-lia", country: "Brazil", tier: "capital", lat: -15.8, lon: -47.9 };
  assert.equal(S.slugify("Brasília"), "bras-lia");
  assert.equal(S.slugify("Bogotá"), "bogot");
  const r = validate(S.sites, { sites: [s, s] });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "sites[0].slug" && i.level === "warn"));
  assert.deepEqual([...S.siteFrameIds({ sites: [{ ...s, tier: "city" }] })], ["bras-lia-01", "bras-lia-02"]);
});

test("relay: port_names outside io warn; duplicate matrix ids error", () => {
  const m = { id: "relay-a", label: "A", io: 2, casters: 2, port_names: { U05: "x" } };
  const r = validate(S.relay, { host: "h", matrices: [m, m] });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "matrices[0].port_names.U05"));
});

test("vendor-policy: snmp without oid is an error, without target a warning", () => {
  assert.equal(validate(S.vendorPolicy, { renames: { RTS: { transport: "snmp" } } }).ok, false);
  const r = validate(S.vendorPolicy, { renames: { default: { transport: "sdk" }, RTS: { transport: "snmp", oid: "1.3.6.1.4.1.1.2" } } });
  assert.equal(r.ok, true);
  assert.ok(r.issues.some((i) => i.path === "renames.RTS.target"));
});

test("label: cuts are graphemes, emoji count as one", () => {
  const full = "Ana 👩🏽‍🚀 Silva!";
  const g = S.graphemes(full);
  const lbl = { full, l6: g.slice(0, 6).join(""), l8: g.slice(0, 8).join(""), l16: g.slice(0, 16).join(""), chars: g.length, over6: g.length > 6, over8: g.length > 8, over16: false };
  assert.equal(g[4], "👩🏽‍🚀");
  assert.equal(errors(validate(S.label, lbl)), 0);
  assert.ok(errors(validate(S.label, { ...lbl, l6: full.slice(0, 6) })) > 0);
});

test("labels.jsonl line from disk validates; wrong `over` is an error", () => {
  const line = { seq: 3073, at: "2026-10-21T13:23:42Z", frame: "hong-kong-10", port: "U00", label: { full: "Sam (sim)", l6: "Sam (s", l8: "Sam (sim", l16: "Sam (sim)", chars: 9, over6: true, over8: true, over16: false }, over: "over6,over8", connection: "sim-1", origin: "simulator" };
  assert.equal(validate(S.labelEvent, line).ok, true);
  assert.equal(validate(S.labelEvent, { ...line, over: "over6" }).ok, false);
});

test("deltas/gpio/renames lines from disk validate", () => {
  assert.equal(validate(S.crosspointEvent, { seq: 1, at: "2026-10-20T18:47:21Z", sim_time: 1e-6, op: "set", frame: "4-wire-09", input: "C0", output: "U00", connection: "sim-000001" }).ok, true);
  assert.equal(validate(S.gpioEvent, { seq: 392, at: "2026-10-21T13:23:42Z", sim_time: 3, connection: "c", who: "w", pin: 1, state: true, from_frame: "a-01", to_frame: "b-01", path: ["a-01", "b-01"], trunks: ["t"], note: "call light" }).ok, true);
  assert.equal(validate(S.renameDispatch, { seq: 1, at: "2026-10-21T13:23:42Z", frame: "prague-01", port: "U00", new_name: "x", vendor: "RTS", transport: "snmp", detail: "d", payload_hex: "3036", sent: true }).ok, true);
});

test("jsonl folding: one bad field over many lines is one counted pattern; seq resets counted", () => {
  const r = newReport(0);
  const prev = { v: -1 };
  for (let i = 1; i <= 5; i++) feedLine(r, S.preference, JSON.stringify({ seq: i % 3, at: "bad", kind: "clock", value: {} }), i, prev);
  feedLine(r, S.preference, "{torn", 6, prev);
  assert.equal(r.invalid, 5);
  assert.equal(r.syntaxErrors, 1);
  assert.equal(r.seqResets, 1);
  const at = [...r.patterns.values()].find((p) => p.path === "at");
  assert.equal(at?.count, 5);
  assert.equal(patternKey("warn", "a[3].b", '"x" is 5'), 'warn|a[*].b|"…" is #');
});

test("capital codes cover the emulator naming", () => {
  assert.ok(capitalCodes("Mexico City").includes("MEXC"));
  assert.ok(capitalCodes("New Delhi").includes("DELH"));
  assert.ok(capitalCodes("Brasília").includes("BRAS"));
  assert.ok(capitalCodes("Abu Dhabi").includes("ABUD"));
});

test("cross: production studio must be a site frame", () => {
  const sites = { sites: [{ name: "Paris", slug: "paris", country: "France", tier: "capital", lat: 48.9, lon: 2.35, frames: 10 }] };
  const fader = { productions: [{ studio: "paris-11" }, { studio: "paris-10" }] };
  const out = crossChecks(".", { sites, fader });
  assert.equal(out.length, 1);
  assert.match(out[0]?.message ?? "", /paris-11/);
});
