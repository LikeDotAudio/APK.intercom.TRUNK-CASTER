import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { RouteFrame, Shape } from "./types.ts";
import { fixedClock } from "./types.ts";
import { Router, newState } from "./router.ts";
import { DEFAULT_BLACKOUT, blackoutActiveAt, decide, expireTick, preview, resetTick, type DecideContext } from "./request.ts";
import { replayFile } from "./golden.ts";

const s: Shape = { frames_per_protocol: 4, user_ports: 56, casters_per_frame: 1, channels_per_trunk: 2 };
const frames = (ids: string[], casters = 1): RouteFrame[] => ids.map((id) => ({ id, casters, user_ports: 56 }));
const ctx = (sim_time: number, over: Partial<DecideContext> = {}): DecideContext => ({
  sim_time,
  blackout_active: false,
  blackout_end_hour: 12,
  lease_seconds: 900,
  origin: "test",
  ...over,
});

test("golden: every assertion of routing.rs tests replays with zero mismatches", () => {
  const path = fileURLToPath(new URL("../golden/rust-tests.json", import.meta.url));
  const r = replayFile(path);
  assert.equal(r.cases, 5);
  assert.deepEqual(r.mismatches, []);
});

test("blackout window: 11:00 inclusive to 12:00 exclusive, wraps midnight", () => {
  const h = (x: number) => x * 3600;
  assert.equal(blackoutActiveAt(DEFAULT_BLACKOUT, h(10.9999)), false);
  assert.equal(blackoutActiveAt(DEFAULT_BLACKOUT, h(11)), true);
  assert.equal(blackoutActiveAt(DEFAULT_BLACKOUT, h(11.99)), true);
  assert.equal(blackoutActiveAt(DEFAULT_BLACKOUT, h(12)), false);
  assert.equal(blackoutActiveAt(DEFAULT_BLACKOUT, h(11) + 86_400 * 3), true, "any sim day");
  assert.equal(blackoutActiveAt(DEFAULT_BLACKOUT, h(11) - 86_400), true, "negative clock (rem_euclid)");
  const wrap = { enabled: true, start_hour: 23, end_hour: 1 };
  assert.equal(blackoutActiveAt(wrap, h(23.5)), true);
  assert.equal(blackoutActiveAt(wrap, h(0.5)), true);
  assert.equal(blackoutActiveAt(wrap, h(12)), false);
  assert.equal(blackoutActiveAt({ ...DEFAULT_BLACKOUT, enabled: false }, h(11.5)), false);
});

test("decide: blackout denies and counts", () => {
  const r = new Router(newState(frames(["A", "B"]), s), fixedClock());
  const d = decide(r, { id: "q", who: "Sam", from: "A", to: "B" }, ctx(0, { blackout_active: true }));
  assert.deepEqual(d, { status: "denied", reason: "daily reset: everything is disconnected until 12:00 UTC on the simulated clock" });
  assert.equal(r.st.counters.denied, 1);
  assert.equal(r.st.connections.length, 0);
});

test("decide: a parked line is picked up in either direction, ports and kind kept", () => {
  const r = new Router(newState(frames(["A", "B"], 8), s), fixedClock());
  const g = decide(r, { id: "c1", who: "Ann", from: "A", to: "B", hold_seconds: 10 }, ctx(0));
  assert.equal(g.status, "granted");
  r.expire(10);
  const p = decide(r, { id: "c2", who: "Bob", from: "B", to: "A", hold_seconds: 30 }, ctx(20));
  assert.equal(p.status, "granted");
  assert.ok(p.status === "granted" && p.how === "picked-up");
  assert.equal(p.connection.id, "c1", "the new request id is not used");
  assert.equal(p.connection.from_frame, "A", "direction of the original call is kept");
  assert.equal(p.connection.who, "Bob");
  assert.equal(p.connection.expires_at_sim, 50);
  assert.equal(p.connection.last_used_sim, 20, "lease reset on use");
  assert.equal(r.st.counters.granted, 1, "pick-up does not count as a grant");
});

test("decide: no capacity -> reclaim the oldest red line -> retry succeeds", () => {
  const r = new Router(newState(frames(["A", "B"]), { ...s, channels_per_trunk: 1 }), fixedClock());
  decide(r, { id: "old", who: "x", from: "A", to: "B" }, ctx(0));
  const d = decide(r, { id: "new", who: "y", from: "A", to: "B" }, ctx(1000));
  assert.equal(d.status, "granted");
  assert.equal(d.status === "granted" && d.how === "routed" ? d.reclaimed?.id : undefined, "old");
  assert.equal(r.st.counters.denied, 0, "the first denial is un-counted");
  assert.equal(r.st.counters.released, 1);
});

test("decide: reclaim releases ONE red line, which may not free a caster (finding)", () => {
  // A, B, C have one caster; A's is bound to a 2-channel trunk to C holding two red lines.
  const r = new Router(newState(frames(["A", "B", "C"]), s), fixedClock());
  decide(r, { id: "r1", who: "x", from: "A", to: "C" }, ctx(0));
  decide(r, { id: "r2", who: "x", from: "A", to: "C" }, ctx(1));
  const d = decide(r, { id: "n", who: "y", from: "A", to: "B" }, ctx(2000));
  assert.equal(d.status, "denied");
  assert.equal(d.reclaimed?.id, "r1");
  // r2 is still red and still holds A's only caster; releasing it too would have let A-B go direct.
  assert.deepEqual(r.redLines(2000, 900), ["r2"]);
  assert.equal(r.freeCasters("A"), 0);
});

test("preview never mutates the live state", () => {
  const r = new Router(newState(frames(["A", "B"], 8), s), fixedClock());
  decide(r, { id: "a", who: "x", from: "A", to: "B" }, ctx(0));
  const before = JSON.stringify(r.st);
  const d = preview(r, { id: "b", who: "y", from: "A", to: "B" }, ctx(5));
  assert.equal(d.status, "granted");
  assert.equal(JSON.stringify(r.st), before);
});

test("expireTick parks, holds red, sweeps on the round-robin schedule", () => {
  const r = new Router(newState(frames(["A", "B"], 8), { ...s, channels_per_trunk: 8 }), fixedClock());
  decide(r, { id: "h", who: "x", from: "A", to: "B", hold_seconds: 5 }, ctx(0));
  decide(r, { id: "l", who: "x", from: "A", to: "B" }, ctx(0));
  const clock = { last_sweep: 0, next_sweep: 60 };
  let t = expireTick(r, 10, 900, 60, clock);
  assert.deepEqual([t.parked, t.red, t.swept.map((c) => c.id)], [["h"], [], []]);
  t = expireTick(r, 60, 900, 60, clock); // sweep due, but since = last_sweep = 0 and "h" parked at 10
  assert.deepEqual(t.swept, [], "sweep releases lines parked at or before the PREVIOUS sweep");
  assert.deepEqual(clock, { last_sweep: 60, next_sweep: 120 });
  t = expireTick(r, 120, 900, 60, clock);
  assert.deepEqual(t.swept.map((c) => c.id), ["h"]);
  t = expireTick(r, 900, 900, 60, clock);
  assert.deepEqual(t.red, ["l"], "15 minutes unused: red, parked");
});

test("resetTick releases everything on entering the window only", () => {
  const r = new Router(newState(frames(["A", "B"], 8), { ...s, channels_per_trunk: 8 }), fixedClock());
  decide(r, { id: "a", who: "x", from: "A", to: "B" }, ctx(0));
  decide(r, { id: "b", who: "x", from: "A", to: "B" }, ctx(0));
  let st = resetTick(r, DEFAULT_BLACKOUT, 10.5 * 3600, false);
  assert.equal(st.edge, "none");
  st = resetTick(r, DEFAULT_BLACKOUT, 11 * 3600, false);
  assert.deepEqual([st.edge, st.released.length, r.st.trunks.length], ["enter", 2, 0]);
  st = resetTick(r, DEFAULT_BLACKOUT, 11.5 * 3600, true);
  assert.equal(st.edge, "none");
  st = resetTick(r, DEFAULT_BLACKOUT, 12 * 3600, true);
  assert.deepEqual([st.edge, st.active], ["leave", false]);
});
