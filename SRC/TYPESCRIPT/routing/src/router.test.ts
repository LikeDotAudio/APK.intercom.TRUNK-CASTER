import { test } from "node:test";
import assert from "node:assert/strict";
import type { RouteFrame, RouteState, Shape, Trunk } from "./types.ts";
import { fixedClock } from "./types.ts";
import { Router, newState, cloneState, reconcile, viaFrames, planNewTrunks, trunkJoins, trunkFree, trunkTouches, type Plan } from "./router.ts";

const shape = (casters: number, channels: number, user_ports = 56): Shape => ({
  frames_per_protocol: 3,
  user_ports,
  casters_per_frame: casters,
  channels_per_trunk: channels,
});
/** routing.rs:793 `fleet`. */
const fleet = (n: number, s: Shape): RouteFrame[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p0-${String(i + 1).padStart(2, "0")}`, casters: s.casters_per_frame, user_ports: s.user_ports }));
const router = (frames: RouteFrame[], s: Shape) => new Router(newState(frames, s), fixedClock());
const go = (r: Router, id: string, from: string, to: string, extra: { from_port?: number; to_port?: number } = {}) =>
  r.route({ id, who: "t", from, to, origin: "test", sim_now: 0, ...extra });

test("error strings match routing.rs:364-406", () => {
  const s = shape(8, 8, 1);
  const r = router(fleet(2, s), s);
  assert.deepEqual(go(r, "a", "p0-01", "p0-01"), { ok: false, error: "from and to are the same frame" });
  assert.deepEqual(go(r, "a", "nope", "p0-01"), { ok: false, error: "unknown frame nope" });
  assert.deepEqual(go(r, "a", "p0-01", "nope"), { ok: false, error: "unknown frame nope" });
  assert.deepEqual(go(r, "a", "p0-01", "p0-02", { from_port: 1 }), { ok: false, error: "p0-01 has no user port 1" });
  assert.equal(go(r, "a", "p0-01", "p0-02").ok, true);
  assert.deepEqual(go(r, "a", "p0-01", "p0-02"), { ok: false, error: "connection a already exists" });
  assert.deepEqual(go(r, "b", "p0-01", "p0-02"), { ok: false, error: "p0-01 has no free user port" });
  assert.equal(r.st.counters.denied, 6);
});

test("trunk ids are trunk-NNNNN and casters are lowest-free first", () => {
  const s = shape(3, 1);
  const r = router(fleet(3, s), s);
  go(r, "a", "p0-01", "p0-02");
  go(r, "b", "p0-01", "p0-03");
  r.release("a");
  go(r, "c", "p0-01", "p0-02");
  assert.deepEqual(
    r.st.trunks.map((t) => [t.id, t.a_frame, t.a_caster, t.b_frame, t.b_caster]),
    [
      ["trunk-00002", "p0-01", 1, "p0-03", 0],
      ["trunk-00003", "p0-01", 0, "p0-02", 0],
    ],
  );
});

test("via two frames when direct and via-one are both blocked", () => {
  // A and B have one caster each; C and D two.
  const s = shape(2, 2);
  const frames: RouteFrame[] = [
    { id: "A", casters: 1, user_ports: 56 },
    { id: "B", casters: 1, user_ports: 56 },
    { id: "C", casters: 2, user_ports: 56 },
    { id: "D", casters: 2, user_ports: 56 },
  ];
  const r = router(frames, s);
  assert.equal(go(r, "1", "A", "C").ok, true);
  assert.equal(go(r, "2", "B", "D").ok, true);
  assert.equal(go(r, "3", "C", "D").ok, true);
  const v = go(r, "4", "A", "B");
  assert.ok(v.ok);
  assert.equal(v.value.kind, "via");
  assert.deepEqual(viaFrames(v.value), ["C", "D"]);
  assert.equal(r.st.trunks.length, 3, "no new trunk: every hop reused");
  assert.deepEqual(r.crosscheck().failures, []);
});

test("via prefers fewer new trunks, then fleet order (stable sort)", () => {
  const s = shape(2, 2);
  const build = (order: string[], bothSides: boolean) => {
    const r = router(order.map((id) => ({ id, casters: 2, user_ports: 56 })), s);
    go(r, "1", "A", "M1");
    go(r, "2", "A", "M2"); // A now has no free caster: direct A-B impossible
    go(r, "3", "B", "M2");
    if (bothSides) go(r, "4", "B", "M1");
    return r.plan("A", "B");
  };
  // M1 comes first but needs a new M1-B trunk; M2 reuses both: M2 wins.
  let p = build(["A", "B", "M1", "M2"], false);
  assert.deepEqual(p?.steps.map((x) => [x.to, x.trunk === null]), [["M2", false], ["B", false]]);
  // Both reuse everything: the first in fleet order wins.
  p = build(["A", "B", "M1", "M2"], true);
  assert.deepEqual(p?.steps.map((x) => x.to), ["M1", "B"]);
  p = build(["A", "B", "M2", "M1"], true);
  assert.deepEqual(p?.steps.map((x) => x.to), ["M2", "B"]);
});

test("allowed_trunks: every direct trunk with room, then a new direct, then vias", () => {
  const s = shape(4, 1);
  const r = router(fleet(3, s), s);
  go(r, "a", "p0-01", "p0-02");
  r.st.trunks[0]!.capacity = 3; // room on the existing direct trunk
  const a = r.allowedTrunks("p0-01", "p0-02", 10);
  assert.deepEqual(a.slice(0, 2).map((x) => [x.kind, x.new_trunks_needed, x.free_channels]), [
    ["direct", 0, 2],
    ["direct", 1, 1],
  ]);
  assert.ok(a.slice(2).every((x) => x.kind === "via"));
  assert.deepEqual(r.allowedTrunks("p0-01", "p0-01", 5), []);
  assert.deepEqual(r.allowedTrunks("p0-01", "zz", 5), []);
});

test("release tears down empty trunks and frees casters", () => {
  const s = shape(1, 2);
  const r = router(fleet(2, s), s);
  go(r, "a", "p0-01", "p0-02");
  go(r, "b", "p0-01", "p0-02");
  assert.equal(r.freeCasters("p0-01"), 0);
  r.release("a");
  assert.equal(r.st.trunks.length, 1);
  r.release("b");
  assert.equal(r.st.trunks.length, 0);
  assert.equal(r.freeCasters("p0-01"), 1);
  assert.equal(r.release("b"), undefined);
  assert.equal(r.st.counters.released, 2);
});

test("latched lines are never parked, held red, swept or reclaimed", () => {
  const s = shape(8, 8);
  const r = router(fleet(2, s), s);
  r.route({ id: "l", who: "t", from: "p0-01", to: "p0-02", origin: "test", sim_now: 0, expires_at_sim: 1 });
  r.st.connections[0]!.latched = true;
  assert.deepEqual(r.expire(5), []);
  assert.deepEqual(r.holdRed(5000, 900), []);
  assert.deepEqual(r.sweep(1e9), []);
  assert.equal(r.reclaimFor("p0-01", "p0-02", 5000, 900), undefined);
  // red_lines does not look at latched (routing.rs:662).
  assert.deepEqual(r.redLines(5000, 900), ["l"]);
});

test("crosscheck catches over-capacity, missing trunks and double-bound casters", () => {
  const s = shape(2, 1);
  const r = router(fleet(2, s), s);
  go(r, "a", "p0-01", "p0-02");
  const st = r.st;
  st.trunks.push({ ...(st.trunks[0] as Trunk), id: "trunk-x", connections: ["ghost"] });
  st.trunks[0]!.connections.push("a2");
  const cc = r.crosscheck();
  assert.equal(cc.checked, 1);
  assert.ok(cc.failures.some((f) => f.includes("over capacity")));
  assert.ok(cc.failures.some((f) => f === "trunk-x: trunk lists dead connection ghost"));
  assert.ok(cc.failures.some((f) => f.includes("caster p0-01#0 also bound by trunk-00001")));
});

test("reconcile drops vanished frames and bumps next_trunk", () => {
  const s = shape(2, 2);
  const r = router(fleet(3, s), s);
  go(r, "a", "p0-01", "p0-02");
  go(r, "b", "p0-01", "p0-03");
  const st: RouteState = { ...cloneState(r.st), next_trunk: 1 };
  const out = reconcile(st, fleet(2, s), s);
  assert.deepEqual(out.connections.map((c) => c.id), ["a"]);
  assert.deepEqual(out.trunks.map((t) => t.id), ["trunk-00001"]);
  assert.equal(out.next_trunk, 2);
  assert.equal(r.st.connections.length, 2, "input untouched");
});

// ---------------------------------------------------------------------------
// The indexed planner must equal a literal transliteration of routing.rs.
// ---------------------------------------------------------------------------

/** routing.rs:448-523 as written: linear scans, collect-all, stable sort. */
function naivePlan(st: RouteState, from: string, to: string): Plan | undefined {
  const casters = (f: string) => st.frames.find((x) => x.id === f)?.casters ?? st.shape.casters_per_frame;
  const free = (f: string) => Math.max(0, casters(f) - st.trunks.filter((t) => trunkTouches(t, f)).length);
  const room = (x: string, y: string) => st.trunks.find((t) => trunkJoins(t, x, y) && trunkFree(t) > 0);
  const evaluate = (path: string[]): Plan | undefined => {
    const tent = new Map<string, number>();
    const steps: Plan["steps"] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const x = path[i]!;
      const y = path[i + 1]!;
      const t = room(x, y);
      if (t) {
        steps.push({ from: x, to: y, trunk: t.id });
        continue;
      }
      if (Math.max(0, free(x) - (tent.get(x) ?? 0)) === 0 || Math.max(0, free(y) - (tent.get(y) ?? 0)) === 0) return undefined;
      tent.set(x, (tent.get(x) ?? 0) + 1);
      tent.set(y, (tent.get(y) ?? 0) + 1);
      steps.push({ from: x, to: y, trunk: null });
    }
    return { steps };
  };
  const t = room(from, to);
  if (t) return { steps: [{ from, to, trunk: t.id }] };
  if (free(from) > 0 && free(to) > 0) return { steps: [{ from, to, trunk: null }] };
  const cands = st.frames.map((f) => f.id).filter((f) => f !== from && f !== to);
  for (const k of [1, 2]) {
    const plans: Plan[] = [];
    if (k === 1) for (const m of cands) { const p = evaluate([from, m, to]); if (p) plans.push(p); }
    else for (const a of cands) for (const b of cands) if (a !== b) { const p = evaluate([from, a, b, to]); if (p) plans.push(p); }
    plans.sort((x, y) => planNewTrunks(x) - planNewTrunks(y));
    if (plans[0]) return plans[0];
  }
  return undefined;
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("indexed planner == literal routing.rs planner over 3000 random states", () => {
  let compared = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const rnd = prng(seed);
    const n = 4 + Math.floor(rnd() * 6);
    const s = shape(1 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 3));
    const frames = fleet(n, s).map((f) => ({ ...f, casters: 1 + Math.floor(rnd() * 3) }));
    const r = router(frames, s);
    for (let i = 0; i < 100; i++) {
      const a = frames[Math.floor(rnd() * n)]!.id;
      const b = frames[Math.floor(rnd() * n)]!.id;
      if (a !== b) {
        assert.deepEqual(r.plan(a, b), naivePlan(r.st, a, b), `seed ${seed} op ${i} ${a}->${b}`);
        compared++;
      }
      if (rnd() < 0.3 && r.st.connections.length > 0) r.release(r.st.connections[Math.floor(rnd() * r.st.connections.length)]!.id);
      else if (a !== b) go(r, `c${seed}-${i}`, a, b);
      assert.deepEqual(r.crosscheck().failures, []);
    }
  }
  assert.ok(compared > 2000, `compared ${compared}`);
});
