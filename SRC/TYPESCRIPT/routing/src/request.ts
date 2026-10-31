/**
 * The routing decisions the runtime tick makes around `Router.route`,
 * ported from RUST-RUNTIME/src/runtime.rs without the side effects (no
 * files, GPIO, renames, trends, notes). Mirrors:
 *
 *   decide()          runtime.rs:930-1059 `Runtime::handle_request` (decision order only)
 *   expireTick()      runtime.rs:1696-1722 `Runtime::expire_simulated`
 *   resetTick()       runtime.rs:1727-1762 `Runtime::daily_reset` (state half)
 *   blackoutActiveAt  TRUNK-CASTER-SDK/src/types.rs:1197 `Blackout::active_at`
 */
import type { Blackout, Connection } from "./types.ts";
import { Router, cloneState } from "./router.ts";

/** types.rs:1190 `Blackout::default`: 11:00 -> 12:00 UTC, sim clock. */
export const DEFAULT_BLACKOUT: Blackout = { enabled: true, start_hour: 11, end_hour: 12 };
/** types.rs:1151 `default_lease`: green for 15 minutes from last use. */
export const DEFAULT_LEASE_SECONDS = 900;
/** types.rs:1143 `default_round_robin`: sweep every 60 s of sim time. */
export const DEFAULT_ROUND_ROBIN_SECONDS = 60;

/** Rust `f64::rem_euclid`. */
const remEuclid = (a: number, b: number): number => ((a % b) + Math.abs(b)) % Math.abs(b);

/** types.rs:1197 `Blackout::active_at`; handles windows that wrap midnight. */
export function blackoutActiveAt(b: Blackout, utcTodSecs: number): boolean {
  if (!b.enabled) return false;
  const h = remEuclid(utcTodSecs, 86_400) / 3600;
  return b.start_hour <= b.end_hour ? h >= b.start_hour && h < b.end_hour : h >= b.start_hour || h < b.end_hour;
}

/** types.rs `Request`, the routing-relevant subset. */
export interface RouteRequest {
  id: string;
  who: string;
  from: string;
  to: string;
  from_port?: number;
  to_port?: number;
  why?: string;
  where?: string;
  hold_seconds?: number;
}

export interface DecideContext {
  sim_time: number;
  blackout_active: boolean;
  /** `fader.day.blackout.end_hour`, for the denial text. */
  blackout_end_hour: number;
  lease_seconds: number;
  origin: string;
}

export type Decision =
  | { status: "granted"; how: "picked-up"; connection: Connection; reason: "picked up a parked line" }
  | { status: "granted"; how: "routed"; connection: Connection; reclaimed?: Connection }
  | { status: "denied"; reason: string; reclaimed?: Connection };

/**
 * runtime.rs:930 `handle_request`, decision order:
 *  1. daily-reset blackout -> denied (counts as denied);
 *  2. a parked line between the two frames (either direction) -> picked up,
 *     unmuted, lease reset, NO new trunking and NO port rename;
 *  3. route (direct, then via 1, then via 2);
 *  4. on "no capacity": reclaim the longest-unused red line touching either
 *     frame, un-count that denial, route once more.
 */
export function decide(router: Router, req: RouteRequest, ctx: DecideContext): Decision {
  const expires = req.hold_seconds === undefined ? undefined : ctx.sim_time + Math.max(0, req.hold_seconds);

  if (ctx.blackout_active) {
    router.st.counters.denied += 1;
    const end = String(Math.max(0, Math.trunc(ctx.blackout_end_hour))).padStart(2, "0");
    return { status: "denied", reason: `daily reset: everything is disconnected until ${end}:00 UTC on the simulated clock` };
  }

  const parked = router.findParked(req.from, req.to);
  if (parked !== undefined) {
    // NB runtime.rs passes the raw hold here (no max(0)), unlike the route path.
    const c = router.unmute(parked, req.who, ctx.sim_time, req.hold_seconds);
    if (c) return { status: "granted", how: "picked-up", connection: c, reason: "picked up a parked line" };
  }

  const ask = () => {
    const a: Parameters<Router["route"]>[0] = {
      id: req.id,
      who: req.who,
      from: req.from,
      to: req.to,
      origin: ctx.origin,
      sim_now: ctx.sim_time,
    };
    if (req.from_port !== undefined) a.from_port = req.from_port;
    if (req.to_port !== undefined) a.to_port = req.to_port;
    if (req.why !== undefined) a.why = req.why;
    if (req.where !== undefined) a.where = req.where;
    if (expires !== undefined) a.expires_at_sim = expires;
    return a;
  };

  let out = router.route(ask());
  let reclaimed: Connection | undefined;
  if (!out.ok && out.error.includes("no capacity")) {
    reclaimed = router.reclaimFor(req.from, req.to, ctx.sim_time, ctx.lease_seconds);
    if (reclaimed) {
      router.st.counters.denied = Math.max(0, router.st.counters.denied - 1);
      out = router.route(ask());
    }
  }
  if (out.ok) return reclaimed ? { status: "granted", how: "routed", connection: out.value, reclaimed } : { status: "granted", how: "routed", connection: out.value };
  return reclaimed ? { status: "denied", reason: out.error, reclaimed } : { status: "denied", reason: out.error };
}

/**
 * What-if: the decision a request WOULD get, computed on a deep copy.
 * The live state (e.g. the last `/api/state` snapshot in the browser) is
 * never touched.
 */
export function preview(router: Router, req: RouteRequest, ctx: DecideContext): Decision {
  return decide(new Router(cloneState(router.st)), req, ctx);
}

/** Sweep bookkeeping that runtime.rs keeps in `last_sweep` / `next_sweep`. */
export interface SweepClock {
  last_sweep: number;
  next_sweep: number;
}

/** runtime.rs:1696 `expire_simulated`: park expired holds, hold red lines, sweep when due. */
export function expireTick(
  router: Router,
  simTime: number,
  leaseSeconds: number,
  roundRobinSeconds: number,
  clock: SweepClock,
): { parked: string[]; red: string[]; swept: Connection[] } {
  const parked = router.expire(simTime);
  const red = router.holdRed(simTime, leaseSeconds);
  let swept: Connection[] = [];
  if (simTime >= clock.next_sweep) {
    swept = router.sweep(clock.last_sweep);
    clock.last_sweep = simTime;
    clock.next_sweep = simTime + Math.max(1, roundRobinSeconds);
  }
  return { parked, red, swept };
}

/**
 * runtime.rs:1727 `daily_reset`, routing state only: entering the window
 * releases everything; leaving it just clears the flag.
 */
export function resetTick(
  router: Router,
  blackout: Blackout,
  utcTodSecs: number,
  wasActive: boolean,
): { active: boolean; released: Connection[]; edge: "enter" | "leave" | "none" } {
  const now = blackoutActiveAt(blackout, utcTodSecs);
  if (now && !wasActive) return { active: true, released: router.releaseAll(), edge: "enter" };
  if (!now && wasActive) return { active: false, released: [], edge: "leave" };
  return { active: wasActive, released: [], edge: "none" };
}
