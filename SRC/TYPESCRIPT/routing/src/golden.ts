/**
 * Golden-file parity harness: Rust writes cases, TS replays them.
 *
 * A golden file is a list of cases. Each case builds a fleet, then runs ops
 * against the router and compares results. `expect` is a SUBSET match: every
 * key given must deep-equal the actual value; keys left out are not checked.
 * Wall-clock fields (granted_at, granted_unix, created_at, at, unix) are
 * never compared.
 *
 * The hand-written file golden/rust-tests.json encodes the assertions of
 * RUST-RUNTIME/src/routing.rs:817-897. A Rust-side dumper (HANDOFF.md,
 * "Golden parity") can emit the same shape from randomised fleets.
 */
import { readFileSync } from "node:fs";
import type { RouteFrame, Shape } from "./types.ts";
import { fixedClock } from "./types.ts";
import { Router, newState, viaFrames, trunkFree } from "./router.ts";
import { decide, expireTick } from "./request.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObj = { [k: string]: Json };

export interface GoldenCase {
  name: string;
  shape: Shape;
  /** Explicit frames, or `{prefix, count}` = ids `<prefix>-01..` shaped like routing.rs:793 `fleet`. */
  frames: RouteFrame[] | { prefix: string; count: number };
  ops: JsonObj[];
}
export interface GoldenFile {
  version: 1;
  source: string;
  cases: GoldenCase[];
}

const IGNORED = new Set(["granted_at", "granted_unix", "created_at", "at", "unix"]);

/** Subset deep-equal. Returns a list of "path: expected X, got Y". */
export function subsetDiff(actual: unknown, expected: Json, path = "$"): string[] {
  if (expected === null || typeof expected !== "object") {
    return Object.is(actual, expected) || (expected === null && actual === undefined)
      ? []
      : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    }
    return expected.flatMap((e, i) => subsetDiff(actual[i], e, `${path}[${i}]`));
  }
  if (actual === null || typeof actual !== "object") return [`${path}: expected object, got ${JSON.stringify(actual)}`];
  const a = actual as Record<string, unknown>;
  return Object.entries(expected)
    .filter(([k]) => !IGNORED.has(k))
    .flatMap(([k, e]) => subsetDiff(a[k], e, `${path}.${k}`));
}

const num = (v: Json | undefined): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: Json | undefined, d = ""): string => (typeof v === "string" ? v : d);

export function buildFrames(c: GoldenCase): RouteFrame[] {
  if (Array.isArray(c.frames)) return c.frames;
  const { prefix, count } = c.frames;
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(2, "0")}`,
    casters: c.shape.casters_per_frame,
    user_ports: c.shape.user_ports,
  }));
}

/** Run one op; returns the value `expect` is compared against. */
function runOp(r: Router, op: JsonObj, sweep: { last_sweep: number; next_sweep: number }): unknown {
  switch (op["op"]) {
    case "route": {
      const a = (op["ask"] ?? {}) as JsonObj;
      const ask: Parameters<Router["route"]>[0] = {
        id: str(a["id"]),
        who: str(a["who"], "t"),
        from: str(a["from"]),
        to: str(a["to"]),
        origin: str(a["origin"], "test"),
        sim_now: num(a["sim_now"]) ?? 0,
      };
      const fp = num(a["from_port"]);
      const tp = num(a["to_port"]);
      const ex = num(a["expires_at_sim"]);
      if (fp !== undefined) ask.from_port = fp;
      if (tp !== undefined) ask.to_port = tp;
      if (ex !== undefined) ask.expires_at_sim = ex;
      const out = r.route(ask);
      return out.ok
        ? { ok: true, ...out.value, via: viaFrames(out.value) }
        : { ok: false, error: out.error };
    }
    case "decide": {
      const q = (op["req"] ?? {}) as JsonObj;
      const req: Parameters<typeof decide>[1] = { id: str(q["id"]), who: str(q["who"], "t"), from: str(q["from"]), to: str(q["to"]) };
      const hold = num(q["hold_seconds"]);
      if (hold !== undefined) req.hold_seconds = hold;
      return decide(r, req, {
        sim_time: num(op["sim_time"]) ?? 0,
        blackout_active: op["blackout_active"] === true,
        blackout_end_hour: num(op["blackout_end_hour"]) ?? 12,
        lease_seconds: num(op["lease_seconds"]) ?? 900,
        origin: "test",
      });
    }
    case "release":
      return r.release(str(op["id"])) ?? null;
    case "expire":
      return r.expire(num(op["now"]) ?? 0);
    case "find_parked":
      return r.findParked(str(op["from"]), str(op["to"])) ?? null;
    case "unmute":
      return r.unmute(str(op["id"]), str(op["who"]), num(op["now"]) ?? 0, num(op["hold"])) ?? null;
    case "sweep":
      return r.sweep(num(op["since"]) ?? 0).map((c) => c.id);
    case "red_lines":
      return r.redLines(num(op["now"]) ?? 0, num(op["lease"]) ?? 900);
    case "hold_red":
      return r.holdRed(num(op["now"]) ?? 0, num(op["lease"]) ?? 900);
    case "reclaim_for":
      return r.reclaimFor(str(op["from"]), str(op["to"]), num(op["now"]) ?? 0, num(op["lease"]) ?? 900)?.id ?? null;
    case "expire_tick": {
      const t = expireTick(r, num(op["now"]) ?? 0, num(op["lease"]) ?? 900, num(op["round_robin"]) ?? 60, sweep);
      return { parked: t.parked, red: t.red, swept: t.swept.map((c) => c.id) };
    }
    case "allowed_trunks":
      return r.allowedTrunks(str(op["from"]), str(op["to"]), num(op["limit"]) ?? 5);
    case "state": {
      const free: Record<string, number> = {};
      for (const f of r.st.frames) free[f.id] = r.freeCasters(f.id);
      const cc = r.crosscheck();
      return {
        trunks: r.st.trunks.length,
        connections: r.st.connections.length,
        counters: r.st.counters,
        free_casters: free,
        trunk_free: Object.fromEntries(r.st.trunks.map((t) => [t.id, trunkFree(t)])),
        crosscheck_ok: cc.ok,
        crosscheck_failures: cc.failures,
      };
    }
    default:
      throw new Error(`unknown golden op ${JSON.stringify(op["op"])}`);
  }
}

/** Replay one case; returns mismatches (empty = parity). */
export function replayCase(c: GoldenCase): string[] {
  const r = new Router(newState(buildFrames(c), c.shape), fixedClock());
  const sweep = { last_sweep: 0, next_sweep: 0 };
  const out: string[] = [];
  c.ops.forEach((op, i) => {
    const actual = runOp(r, op, sweep);
    const exp = op["expect"];
    if (exp !== undefined) out.push(...subsetDiff(actual, exp, `${c.name}#${i}(${str(op["op"])})`));
  });
  return out;
}

export function replayFile(path: string): { cases: number; ops: number; mismatches: string[] } {
  const g = JSON.parse(readFileSync(path, "utf8")) as GoldenFile;
  const mismatches = g.cases.flatMap(replayCase);
  return { cases: g.cases.length, ops: g.cases.reduce((a, c) => a + c.ops.length, 0), mismatches };
}
