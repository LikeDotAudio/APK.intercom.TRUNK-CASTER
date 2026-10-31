import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GPIO_FUNCTIONS,
  biggestPeak,
  blackoutActiveAt,
  dayMultiplier,
  dayMultiplierAt,
  defaultDaySchedule,
  defaultFader,
  defaultGlobeConfig,
  defaultShape,
  defaultVendorPolicy,
  faderWithDefaults,
  globeAnchor,
  gpioFunctionFromPin,
  gpioLabel,
  gpioPin,
  isUint,
  makeReply,
  makeRequest,
  matrixSize,
  olympicsMultiplier,
  olympicsOnAirAt,
  policyForVendor,
  presetStartUtcHour,
  presets,
  productionOnAirAt,
  remEuclid,
  trunkCasterOn,
  trunkFree,
  trunkJoins,
  trunkPeerOf,
  vendorBadge,
  viaFrames,
  type Connection,
  type FaderInput,
  type Trunk,
} from "./types.ts";

// --- Mirrors of types.rs #[cfg(test)] --------------------------------------

test("presets_start_before_their_one_event (types.rs)", () => {
  const all = presets(defaultFader());
  const day = all.find((p) => p.id === "broadcast-day");
  assert.ok(day);
  assert.equal(presetStartUtcHour(day, -6), 23);
  const reset = all.find((p) => p.id === "daily-reset");
  assert.ok(reset);
  assert.ok(Math.abs(presetStartUtcHour(reset, 9) - (11 - 5 / 60)) < 1e-9);
  for (const p of all) {
    assert.ok(p.fader.day.newscasts.length <= 1 && !p.fader.day.olympics.enabled, `${p.id} has more than one major event`);
  }
  assert.equal(all.length, 11);
});

test("olympics_surge_everywhere_at_once (types.rs)", () => {
  const d = defaultDaySchedule();
  const at = (h: number): number => h * 3600;
  for (const lon of [139.7, -77.0]) {
    assert.equal(Math.max(dayMultiplierAt(d, at(20), lon), d.olympics.peak), dayMultiplierAt(d, at(20), lon));
  }
  assert.ok(olympicsOnAirAt(d.olympics, at(19)) && !olympicsOnAirAt(d.olympics, at(21)));
  assert.ok(Math.abs(olympicsMultiplier(d.olympics, at(18.75)) - 3) < 1e-9);
  assert.equal(olympicsMultiplier(d.olympics, at(7)), 1);
  // Older fader files pick up the defaults.
  const text = JSON.stringify(defaultFader()).replace(',"in_building_calls_per_hour":100', "");
  const f = faderWithDefaults(JSON.parse(text) as FaderInput);
  assert.equal(f.in_building_calls_per_hour, 100);
});

// --- Extra cases -----------------------------------------------------------

test("shape: 56 + 8 = 64, 10 frames, 8 channels", () => {
  const s = defaultShape();
  assert.equal(matrixSize(s), 64);
  assert.equal(s.frames_per_protocol, 10);
  assert.equal(s.channels_per_trunk, 8);
});

test("gpio pins 1..8 and fallback", () => {
  GPIO_FUNCTIONS.forEach((f, i) => {
    assert.equal(gpioPin(f), i + 1);
    assert.equal(gpioFunctionFromPin(i + 1), f);
  });
  assert.equal(gpioFunctionFromPin(0), "ping");
  assert.equal(gpioFunctionFromPin(99), "ping");
  assert.equal(gpioLabel("check-lights"), "check lights");
});

test("vendor badges by substring, never an address", () => {
  assert.equal(vendorBadge("RTS").emoji, "🟣");
  assert.equal(vendorBadge("Clear-Com").color, "#1f6feb");
  assert.equal(vendorBadge("Telex").emoji, "🟡");
  assert.equal(vendorBadge("Ward-Beck").emoji, "🟠");
  assert.equal(vendorBadge("").emoji, "⚪");
  assert.equal(vendorBadge("Acme").emoji, "⚫");
  // ordering quirk preserved: "Clear" with "rts" anywhere is purple
  assert.equal(vendorBadge("Clear-Com Arts").emoji, "🟣");
});

test("vendor policy falls back to default", () => {
  const p = defaultVendorPolicy();
  assert.equal(policyForVendor(p, "RTS")?.transport, "snmp");
  assert.equal(policyForVendor(p, "Riedel")?.transport, "sdk");
  assert.equal(policyForVendor(p, "toString")?.transport, "sdk");
});

test("day multiplier shapes", () => {
  const d = defaultDaySchedule();
  assert.equal(dayMultiplier(d, 18 * 3600), 6); // the big newscast
  // LATENT (types.rs:1333-1366): every newscast outside its window contributes
  // `m.max(1.0)`, which cancels the overnight quiet whenever newscasts exist.
  assert.equal(dayMultiplier(d, 2 * 3600 + 20 * 60), 1); // faithful to Rust: overnight 0.3 is lost
  assert.equal(dayMultiplier({ ...d, newscasts: [] }, 2 * 3600 + 20 * 60), 0.3); // only without newscasts
  assert.equal(dayMultiplier(d, 14 * 3600), 3); // top of the hour rush
  assert.equal(dayMultiplier({ ...d, enabled: false }, 18 * 3600), 1);
  assert.equal(biggestPeak(d), 6);
  assert.equal(dayMultiplier(d, -6 * 3600), dayMultiplier(d, 18 * 3600)); // rem_euclid
});

test("blackout and production windows wrap midnight", () => {
  assert.ok(blackoutActiveAt({ enabled: true, start_hour: 11, end_hour: 12 }, 11.5 * 3600));
  assert.ok(!blackoutActiveAt({ enabled: true, start_hour: 11, end_hour: 12 }, 12 * 3600));
  const p = { enabled: true, name: "x", studio: "", trunks: 8, calls_per_minute: 1, mean_hold_seconds: 1, start_hour: 18, end_hour: 2 };
  assert.ok(productionOnAirAt(p, 23 * 3600));
  assert.ok(productionOnAirAt(p, 1 * 3600));
  assert.ok(!productionOnAirAt(p, 12 * 3600));
  assert.ok(productionOnAirAt({ ...p, start_hour: -1 }, 12 * 3600));
});

test("remEuclid matches Rust", () => {
  assert.equal(remEuclid(-1, 24), 23);
  assert.equal(remEuclid(25, 24), 1);
  assert.equal(remEuclid(-0.5, 24), 23.5);
});

test("trunk helpers", () => {
  const t: Trunk = { id: "t1", a_frame: "a", a_caster: 0, b_frame: "b", b_caster: 3, capacity: 8, connections: ["c1", "c2"], created_at: "", gain_a_db: 0, gain_b_db: 0 };
  assert.equal(trunkFree(t), 6);
  assert.ok(trunkJoins(t, "b", "a"));
  assert.equal(trunkCasterOn(t, "b"), 3);
  assert.equal(trunkPeerOf(t, "a"), "b");
  assert.equal(trunkCasterOn(t, "z"), undefined);
  assert.equal(trunkFree({ ...t, capacity: 1 }), 0); // saturating_sub
});

test("via frames skip the first hop's origin", () => {
  const c = { hops: [{ trunk: "t1", from: "a", to: "m" }, { trunk: "t2", from: "m", to: "b" }] } as Pick<Connection, "hops"> as Connection;
  assert.deepEqual(viaFrames(c), ["m"]);
});

test("optional fields are omitted, never null (skip_serializing_if)", () => {
  assert.equal(JSON.stringify(makeRequest("Andrey", "relay-a", "sip-03")), '{"who":"Andrey","from":"relay-a","to":"sip-03"}');
  const r = makeReply("x", "denied", undefined, "no route", "now");
  assert.deepEqual(Object.keys(r), ["wire_version", "id", "status", "replied_at", "reason"]);
});

test("globe anchor is Saskatchewan", () => {
  const g = defaultGlobeConfig();
  assert.equal(globeAnchor(g).name, "Saskatchewan");
  assert.equal(globeAnchor({ ...g, zones: [] }).offset_hours, -6);
  assert.equal(g.projection, "both");
});

test("isUint guards integer fields", () => {
  assert.ok(isUint(0) && isUint(56));
  assert.ok(!isUint(1.5) && !isUint(-1) && !isUint(Number.NaN));
});
