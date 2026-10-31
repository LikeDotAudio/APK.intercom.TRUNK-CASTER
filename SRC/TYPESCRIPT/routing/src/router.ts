/**
 * Any-to-any trunk routing, ported from RUST-RUNTIME/src/routing.rs.
 *
 * Every exported function names the Rust function it mirrors
 * (`routing.rs:<line>` or `types.rs:<line>` in TRUNK-CASTER-SDK). Behaviour,
 * error strings, tie-breaks and counter bumps are kept identical so a golden
 * file dumped by the Rust tests replays here unchanged (see golden.ts).
 *
 * One deliberate difference, behaviour-preserving: the Rust planner scans
 * every trunk for every candidate step (O(F^2 * T) for two-frame vias) and
 * collects every feasible plan before sorting. Here one `PlanIndex` per
 * planning pass answers "first trunk with room between x and y" and "casters
 * in use on f" in O(1), and `viaPlans` keeps only the best `limit` plans in
 * stable order. Same answers, ~1000x less work on a 700-frame fleet.
 */
import type {
  AllowedTrunk,
  Clock,
  Connection,
  CrossCheck,
  Hop,
  Result,
  RouteAsk,
  RouteFrame,
  RouteKind,
  RouteState,
  Shape,
  Trunk,
} from "./types.ts";
import { systemClock } from "./types.ts";

// ---------------------------------------------------------------------------
// Trunk / Connection helpers: TRUNK-CASTER-SDK/src/types.rs:651-768
// ---------------------------------------------------------------------------

/** types.rs:739 `Trunk::used`. */
export const trunkUsed = (t: Trunk): number => t.connections.length;
/** types.rs:742 `Trunk::free` (saturating). */
export const trunkFree = (t: Trunk): number => Math.max(0, t.capacity - t.connections.length);
/** types.rs:745 `Trunk::joins` (either orientation). */
export const trunkJoins = (t: Trunk, x: string, y: string): boolean =>
  (t.a_frame === x && t.b_frame === y) || (t.a_frame === y && t.b_frame === x);
/** types.rs:748 `Trunk::touches`. */
export const trunkTouches = (t: Trunk, f: string): boolean => t.a_frame === f || t.b_frame === f;
/** types.rs:752 `Trunk::caster_on`. */
export function trunkCasterOn(t: Trunk, frame: string): number | undefined {
  if (t.a_frame === frame) return t.a_caster;
  if (t.b_frame === frame) return t.b_caster;
  return undefined;
}
/** types.rs:761 `Trunk::peer_of`. */
export function trunkPeerOf(t: Trunk, frame: string): string | undefined {
  if (t.a_frame === frame) return t.b_frame;
  if (t.b_frame === frame) return t.a_frame;
  return undefined;
}
/** types.rs:651 `Connection::lease_left`: green while > 0, red at or below 0. */
export const leaseLeft = (c: Connection, simNow: number, leaseSeconds: number): number =>
  leaseSeconds - (simNow - c.last_used_sim);
/** types.rs:663 `Connection::via_frames`. */
export const viaFrames = (c: Connection): string[] => c.hops.slice(1).map((h) => h.from);

/** crosspoints.rs:30 `user_port`. */
export const userPort = (i: number): string => `U${String(i).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** routing.rs:71 `Plan`: each step reuses `trunk`, or binds a new one when null. */
export interface PlanStep {
  from: string;
  to: string;
  trunk: string | null;
}
export interface Plan {
  steps: PlanStep[];
}
/** routing.rs:76 `Plan::new_trunks`. */
export const planNewTrunks = (p: Plan): number => p.steps.filter((s) => s.trunk === null).length;
/** routing.rs:79 `Plan::path`. */
export function planPath(p: Plan): string[] {
  const out = p.steps.map((s) => s.from);
  const last = p.steps[p.steps.length - 1];
  if (last) out.push(last.to);
  return out;
}

const pairKey = (x: string, y: string): string => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);

/**
 * Snapshot answers for one planning pass. Valid only while state is not
 * mutated; `route` builds one, plans, then commits.
 */
export class PlanIndex {
  private readonly room = new Map<string, Trunk>();
  private readonly casterUse = new Map<string, number>();
  private readonly casters = new Map<string, number>();

  private readonly st: RouteState;

  constructor(st: RouteState) {
    this.st = st;
    for (const t of st.trunks) {
      // existing_with_room returns the FIRST trunk in vector order.
      const k = pairKey(t.a_frame, t.b_frame);
      if (trunkFree(t) > 0 && !this.room.has(k)) this.room.set(k, t);
      this.casterUse.set(t.a_frame, (this.casterUse.get(t.a_frame) ?? 0) + 1);
      if (t.b_frame !== t.a_frame) this.casterUse.set(t.b_frame, (this.casterUse.get(t.b_frame) ?? 0) + 1);
    }
    for (const f of st.frames) if (!this.casters.has(f.id)) this.casters.set(f.id, f.casters);
  }
  /** routing.rs:334 `existing_with_room`. */
  existingWithRoom(x: string, y: string): Trunk | undefined {
    return this.room.get(pairKey(x, y));
  }
  /** routing.rs:283 `free_casters`. */
  freeCasters(f: string): number {
    const n = this.casters.get(f) ?? this.st.shape.casters_per_frame;
    return Math.max(0, n - (this.casterUse.get(f) ?? 0));
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/** routing.rs:89 `State::new`. */
export function newState(frames: RouteFrame[], shape: Shape): RouteState {
  return {
    shape,
    frames,
    trunks: [],
    connections: [],
    counters: { granted: 0, granted_via: 0, denied: 0, released: 0 },
    last_activity: {},
    next_trunk: 1,
  };
}

/** Deep copy, so a what-if preview never touches the live state. Browser-safe. */
export function cloneState(st: RouteState): RouteState {
  return {
    shape: { ...st.shape },
    frames: st.frames.map((f) => ({ ...f })),
    trunks: st.trunks.map((t) => ({ ...t, connections: [...t.connections] })),
    connections: st.connections.map((c) => ({ ...c, hops: c.hops.map((h) => ({ ...h })), hop_gains_db: [...c.hop_gains_db] })),
    counters: { ...st.counters },
    last_activity: Object.fromEntries(Object.entries(st.last_activity).map(([k, v]) => [k, { ...v }])),
    next_trunk: st.next_trunk,
  };
}

export class Router {
  st: RouteState;
  private readonly clock: Clock;

  /** No TS parameter properties: the file must run under --experimental-strip-types. */
  constructor(st: RouteState, clock: Clock = systemClock) {
    this.st = st;
    this.clock = clock;
  }

  // ---- lookups: routing.rs:260-336 ---------------------------------------

  frame(id: string): RouteFrame | undefined {
    return this.st.frames.find((f) => f.id === id);
  }
  trunk(id: string): Trunk | undefined {
    return this.st.trunks.find((t) => t.id === id);
  }
  connection(id: string): Connection | undefined {
    return this.st.connections.find((c) => c.id === id);
  }
  /** routing.rs:271 `casters_of`. */
  castersOf(frame: string): number {
    return this.frame(frame)?.casters ?? this.st.shape.casters_per_frame;
  }
  /** routing.rs:275 `user_ports_of`. */
  userPortsOf(frame: string): number {
    return this.frame(frame)?.user_ports ?? this.st.shape.user_ports;
  }
  /** routing.rs:280 `used_casters`. */
  usedCasters(frame: string): number {
    return this.st.trunks.filter((t) => trunkTouches(t, frame)).length;
  }
  /** routing.rs:283 `free_casters`. */
  freeCasters(frame: string): number {
    return Math.max(0, this.castersOf(frame) - this.usedCasters(frame));
  }
  /** routing.rs:287 `free_caster_indices`. */
  freeCasterIndices(frame: string): number[] {
    const used = new Set<number>();
    for (const t of this.st.trunks) {
      const c = trunkCasterOn(t, frame);
      if (c !== undefined) used.add(c);
    }
    const out: number[] = [];
    for (let i = 0; i < this.castersOf(frame); i++) if (!used.has(i)) out.push(i);
    return out;
  }
  /** routing.rs:308 `used_user_ports`. */
  usedUserPorts(frame: string): Set<number> {
    const s = new Set<number>();
    for (const c of this.st.connections) {
      if (c.from_frame === frame) s.add(c.from_port);
      if (c.to_frame === frame) s.add(c.to_port);
    }
    return s;
  }
  /** routing.rs:321 `alloc_user_port`: lowest free port, or the wanted one if free. */
  allocUserPort(frame: string, wanted: number | undefined, taken: ReadonlySet<number> = new Set()): Result<number> {
    const used = this.usedUserPorts(frame);
    const n = this.userPortsOf(frame);
    if (wanted !== undefined) {
      if (wanted >= n) return { ok: false, error: `${frame} has no user port ${wanted}` };
      if (used.has(wanted) || taken.has(wanted)) return { ok: false, error: `${frame} user port ${wanted} is busy` };
      return { ok: true, value: wanted };
    }
    for (let p = 0; p < n; p++) if (!used.has(p) && !taken.has(p)) return { ok: true, value: p };
    return { ok: false, error: `${frame} has no free user port` };
  }
  /** routing.rs:334 `existing_with_room`. */
  existingWithRoom(x: string, y: string): Trunk | undefined {
    return this.st.trunks.find((t) => trunkJoins(t, x, y) && trunkFree(t) > 0);
  }
  /** routing.rs:339 `channel_utilization`, 0..1. */
  channelUtilization(): number {
    const cap = this.st.trunks.reduce((a, t) => a + t.capacity, 0);
    return cap === 0 ? 0 : this.st.trunks.reduce((a, t) => a + trunkUsed(t), 0) / cap;
  }
  /** routing.rs:349 `caster_utilization`, 0..1. */
  casterUtilization(): number {
    const total = this.st.frames.reduce((a, f) => a + f.casters, 0);
    return total === 0 ? 0 : (this.st.trunks.length * 2) / total;
  }

  // ---- planning: routing.rs:448-523 --------------------------------------

  /** routing.rs:448 `plan_direct`: an existing trunk with room, else one new trunk. */
  planDirect(from: string, to: string, ix: PlanIndex = new PlanIndex(this.st)): Plan | undefined {
    const t = ix.existingWithRoom(from, to);
    if (t) return { steps: [{ from, to, trunk: t.id }] };
    if (ix.freeCasters(from) > 0 && ix.freeCasters(to) > 0) return { steps: [{ from, to, trunk: null }] };
    return undefined;
  }

  /**
   * routing.rs:461 `evaluate`: walk a candidate path, reusing trunks with
   * room, otherwise binding one caster on each end; caster use along the
   * path is tracked so no frame is over-committed within one plan.
   */
  evaluate(path: readonly string[], ix: PlanIndex = new PlanIndex(this.st)): Plan | undefined {
    const tentative = new Map<string, number>();
    const steps: PlanStep[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const x = path[i] as string;
      const y = path[i + 1] as string;
      const t = ix.existingWithRoom(x, y);
      if (t) {
        steps.push({ from: x, to: y, trunk: t.id });
        continue;
      }
      const fx = Math.max(0, ix.freeCasters(x) - (tentative.get(x) ?? 0));
      const fy = Math.max(0, ix.freeCasters(y) - (tentative.get(y) ?? 0));
      if (fx === 0 || fy === 0) return undefined;
      tentative.set(x, (tentative.get(x) ?? 0) + 1);
      tentative.set(y, (tentative.get(y) ?? 0) + 1);
      steps.push({ from: x, to: y, trunk: null });
    }
    return { steps };
  }

  /** routing.rs:482 `candidates`: every other frame, in fleet order. */
  candidates(from: string, to: string): string[] {
    return this.st.frames.map((f) => f.id).filter((f) => f !== from && f !== to);
  }

  /**
   * routing.rs:492 `via_plans`: feasible plans with exactly 1 or 2
   * intermediate frames, fewest new trunks first, ties in candidate order
   * (Rust `sort_by_key` is stable), truncated to `limit`.
   *
   * Equivalent to "collect all, stable sort, truncate": plans are bucketed
   * by new-trunk count (0..3) in iteration order, each bucket capped at
   * `limit`, and the scan stops once bucket 0 is full.
   */
  viaPlans(from: string, to: string, intermediates: number, limit: number, ix: PlanIndex = new PlanIndex(this.st)): Plan[] {
    if (limit <= 0) return [];
    const cands = this.candidates(from, to);
    const buckets: Plan[][] = [[], [], [], []];
    const take = (p: Plan | undefined): boolean => {
      if (!p) return false;
      const b = buckets[planNewTrunks(p)];
      if (b && b.length < limit) b.push(p);
      return (buckets[0]?.length ?? 0) >= limit;
    };
    if (intermediates === 1) {
      for (const m of cands) if (take(this.evaluate([from, m, to], ix))) break;
    } else if (intermediates === 2) {
      outer: for (const m1 of cands) {
        // If from->m1 alone is infeasible, every from->m1->m2->to is too.
        if (!this.evaluate([from, m1], ix)) continue;
        for (const m2 of cands) {
          if (m1 !== m2 && take(this.evaluate([from, m1, m2, to], ix))) break outer;
        }
      }
    }
    return buckets.flat().slice(0, limit);
  }

  /** routing.rs:521 `plan_via`. */
  planVia(from: string, to: string, intermediates: number, ix: PlanIndex = new PlanIndex(this.st)): Plan | undefined {
    return this.viaPlans(from, to, intermediates, 1, ix)[0];
  }

  /** The plan `route` would commit, without committing it (routing.rs:399-402). */
  plan(from: string, to: string): Plan | undefined {
    const ix = new PlanIndex(this.st);
    return this.planDirect(from, to, ix) ?? this.planVia(from, to, 1, ix) ?? this.planVia(from, to, 2, ix);
  }

  /** routing.rs:527 `allowed_trunks`: direct options, then via one, then via two. */
  allowedTrunks(from: string, to: string, limit: number): AllowedTrunk[] {
    const out: AllowedTrunk[] = [];
    if (from === to || !this.frame(from) || !this.frame(to)) return out;
    const ix = new PlanIndex(this.st);
    for (const t of this.st.trunks) {
      if (trunkJoins(t, from, to) && trunkFree(t) > 0) {
        out.push({ kind: "direct", path: [from, to], trunks: [t.id], new_trunks_needed: 0, free_channels: trunkFree(t) });
      }
    }
    if (ix.freeCasters(from) > 0 && ix.freeCasters(to) > 0) {
      out.push({ kind: "direct", path: [from, to], trunks: [null], new_trunks_needed: 1, free_channels: this.st.shape.channels_per_trunk });
    }
    const via = this.viaPlans(from, to, 1, limit, ix);
    if (via.length < limit) via.push(...this.viaPlans(from, to, 2, limit - via.length, ix));
    for (const p of via) {
      let free = Number.POSITIVE_INFINITY;
      for (const s of p.steps) {
        const f = s.trunk === null ? this.st.shape.channels_per_trunk : (() => { const t = this.trunk(s.trunk); return t ? trunkFree(t) : 0; })();
        free = Math.min(free, f);
      }
      out.push({
        kind: "via",
        path: planPath(p),
        trunks: p.steps.map((s) => s.trunk),
        new_trunks_needed: planNewTrunks(p),
        free_channels: Number.isFinite(free) ? free : 0,
      });
    }
    return out.slice(0, limit);
  }

  // ---- commit: routing.rs:362-446, 576-609 --------------------------------

  /** routing.rs:362 `route`. Bumps `denied` on every error, `granted`/`granted_via` on success. */
  route(ask: RouteAsk): Result<Connection> {
    const { id, who, from, to, sim_now } = ask;
    const deny = (error: string): Result<Connection> => {
      this.st.counters.denied += 1;
      return { ok: false, error };
    };
    if (from === to) return deny("from and to are the same frame");
    if (!this.frame(from)) return deny(`unknown frame ${from}`);
    if (!this.frame(to)) return deny(`unknown frame ${to}`);
    if (this.connection(id)) return deny(`connection ${id} already exists`);

    const fp = this.allocUserPort(from, ask.from_port);
    if (!fp.ok) return deny(fp.error);
    const tp = this.allocUserPort(to, ask.to_port);
    if (!tp.ok) return deny(tp.error);

    const plan = this.plan(from, to);
    if (!plan) return deny("no capacity: no direct trunk, no free casters, no via path");

    const hops = this.commit(plan, id);
    const kind: RouteKind = hops.length === 1 ? "direct" : "via";
    const now = this.clock.nowUnix();
    const conn: Connection = {
      id,
      who,
      from_frame: from,
      from_port: fp.value,
      to_frame: to,
      to_port: tp.value,
      kind,
      hops,
      granted_at: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      granted_unix: now,
      granted_sim: sim_now,
      origin: ask.origin,
      gpio_sent: 0,
      hop_gains_db: hops.map(() => 0),
      muted: false,
      reconnects: 0,
      last_used_sim: sim_now,
      latched: false,
      listen: false,
    };
    if (ask.why !== undefined) conn.why = ask.why;
    if (ask.where !== undefined) conn.where = ask.where;
    if (ask.expires_at_sim !== undefined) conn.expires_at_sim = ask.expires_at_sim;
    this.st.counters.granted += 1;
    if (kind === "via") this.st.counters.granted_via += 1;
    this.touch(from, who, id, sim_now);
    this.touch(to, who, id, sim_now);
    this.st.connections.push(conn);
    return { ok: true, value: cloneConnection(conn) };
  }

  /** routing.rs:221 `touch`. */
  private touch(frame: string, who: string, conn: string, simNow: number): void {
    const unix = this.clock.nowUnix();
    this.st.last_activity[frame] = { at: this.clock.nowIso(), unix, sim_time: simNow, who, connection: conn };
  }

  /** routing.rs:576 `commit`. */
  private commit(plan: Plan, connId: string): Hop[] {
    const hops: Hop[] = [];
    for (const s of plan.steps) {
      const trunkId = s.trunk ?? this.createTrunk(s.from, s.to);
      this.trunk(trunkId)?.connections.push(connId);
      hops.push({ trunk: trunkId, from: s.from, to: s.to });
    }
    return hops;
  }

  /** routing.rs:591 `create_trunk`: lowest free caster on each end, id `trunk-NNNNN`. */
  private createTrunk(x: string, y: string): string {
    const a = this.freeCasterIndices(x)[0];
    const b = this.freeCasterIndices(y)[0];
    // Rust indexes [0] and would panic; the plan guarantees a free caster.
    if (a === undefined || b === undefined) throw new Error(`no free caster on ${a === undefined ? x : y}`);
    const id = `trunk-${String(this.st.next_trunk).padStart(5, "0")}`;
    this.st.next_trunk += 1;
    this.st.trunks.push({
      id,
      a_frame: x,
      a_caster: a,
      b_frame: y,
      b_caster: b,
      capacity: this.st.shape.channels_per_trunk,
      connections: [],
      created_at: this.clock.nowIso(),
      gain_a_db: 0,
      gain_b_db: 0,
    });
    return id;
  }

  // ---- release, park, sweep, lease: routing.rs:613-708 -------------------

  /** routing.rs:613 `release`: trunks left empty are torn down, freeing casters. */
  release(connId: string): Connection | undefined {
    const pos = this.st.connections.findIndex((c) => c.id === connId);
    if (pos < 0) return undefined;
    const [conn] = this.st.connections.splice(pos, 1);
    for (const t of this.st.trunks) t.connections = t.connections.filter((c) => c !== connId);
    this.st.trunks = this.st.trunks.filter((t) => t.connections.length > 0);
    this.st.counters.released += 1;
    return conn;
  }

  /** routing.rs:627 `expire`: hold ran out -> parked (muted, still connected). */
  expire(now: number): string[] {
    const parked: string[] = [];
    for (const c of this.st.connections) {
      if (!c.muted && !c.latched && c.expires_at_sim !== undefined && c.expires_at_sim <= now) {
        c.muted = true;
        c.muted_at_sim = now;
        parked.push(c.id);
      }
    }
    return parked;
  }

  /** routing.rs:640 `find_parked`: either direction; ports are NOT compared. */
  findParked(from: string, to: string): string | undefined {
    return this.st.connections.find(
      (c) => c.muted && ((c.from_frame === from && c.to_frame === to) || (c.from_frame === to && c.to_frame === from)),
    )?.id;
  }

  /** routing.rs:648 `unmute`: picked up again, lease reset, hold extended. */
  unmute(id: string, who: string, now: number, hold: number | undefined): Connection | undefined {
    const c = this.connection(id);
    if (!c) return undefined;
    c.muted = false;
    delete c.muted_at_sim;
    c.reconnects += 1;
    c.last_used_sim = now;
    c.who = who;
    if (hold === undefined) delete c.expires_at_sim;
    else c.expires_at_sim = now + hold;
    return cloneConnection(c);
  }

  /** routing.rs:662 `red_lines` (test-only in Rust): lease ran out, "may be dead". */
  redLines(now: number, lease: number): string[] {
    return this.st.connections.filter((c) => leaseLeft(c, now, lease) <= 0).map((c) => c.id);
  }

  /** routing.rs:667 `hold_red`: park every red line not latched. */
  holdRed(now: number, lease: number): string[] {
    const out: string[] = [];
    for (const c of this.st.connections) {
      if (!c.muted && !c.latched && leaseLeft(c, now, lease) <= 0) {
        c.muted = true;
        c.muted_at_sim = now;
        out.push(c.id);
      }
    }
    return out;
  }

  /** routing.rs:680 `sweep`: release lines parked at or before `since`. */
  sweep(since: number): Connection[] {
    const due = this.st.connections
      .filter((c) => c.muted && !c.latched && c.muted_at_sim !== undefined && c.muted_at_sim <= since)
      .map((c) => c.id);
    return due.map((id) => this.release(id)).filter((c): c is Connection => c !== undefined);
  }

  /**
   * routing.rs:692 `reclaim_for`: release the longest-unused red line whose
   * path touches `from` or `to`. Releases ONE line, which frees a caster
   * only if it was the last channel on its trunk.
   */
  reclaimFor(from: string, to: string, now: number, lease: number): Connection | undefined {
    const red = this.st.connections
      .filter((c) => !c.latched && leaseLeft(c, now, lease) <= 0)
      .filter(
        (c) =>
          [c.from_frame, c.to_frame].some((f) => f === from || f === to) || c.hops.some((h) => h.from === from || h.to === to),
      );
    // Stable sort; Rust treats NaN as Equal.
    red.sort((a, b) => (a.last_used_sim < b.last_used_sim ? -1 : a.last_used_sim > b.last_used_sim ? 1 : 0));
    const first = red[0];
    return first ? this.release(first.id) : undefined;
  }

  /** routing.rs:705 `release_all` (the daily reset). */
  releaseAll(): Connection[] {
    return this.st.connections
      .map((c) => c.id)
      .map((id) => this.release(id))
      .filter((c): c is Connection => c !== undefined);
  }

  // ---- cross-check: routing.rs:714-785 ------------------------------------

  crosscheck(): CrossCheck {
    const cc: CrossCheck = { checked: 0, ok: 0, failures: [] };
    const byId = new Map(this.st.trunks.map((t) => [t.id, t] as const));
    for (const c of this.st.connections) {
      cc.checked += 1;
      const problems: string[] = [];
      if (c.hops.length === 0) problems.push("no hops");
      if (c.hops[0]?.from !== c.from_frame) problems.push("first hop does not start at from_frame");
      if (c.hops[c.hops.length - 1]?.to !== c.to_frame) problems.push("last hop does not end at to_frame");
      for (let i = 0; i + 1 < c.hops.length; i++) {
        const a = c.hops[i] as Hop;
        const b = c.hops[i + 1] as Hop;
        if (a.to !== b.from) problems.push(`hop chain broken at ${a.to}`);
      }
      for (const h of c.hops) {
        const t = byId.get(h.trunk);
        if (!t) {
          problems.push(`trunk ${h.trunk} missing`);
          continue;
        }
        if (!trunkJoins(t, h.from, h.to)) problems.push(`trunk ${t.id} does not join ${h.from}-${h.to}`);
        if (!t.connections.includes(c.id)) problems.push(`trunk ${t.id} does not list this connection`);
        if (trunkUsed(t) > t.capacity) problems.push(`trunk ${t.id} over capacity`);
      }
      const clash = this.st.connections.some(
        (o) =>
          o.id !== c.id &&
          ((o.from_frame === c.from_frame && o.from_port === c.from_port) ||
            (o.to_frame === c.from_frame && o.to_port === c.from_port) ||
            (o.from_frame === c.to_frame && o.from_port === c.to_port) ||
            (o.to_frame === c.to_frame && o.to_port === c.to_port)),
      );
      if (clash) problems.push("user port shared with another connection");
      if (problems.length === 0) cc.ok += 1;
      else cc.failures.push(`${c.id}: ${problems.join("; ")}`);
    }
    const live = new Set(this.st.connections.map((c) => c.id));
    const bound = new Map<string, string>();
    for (const t of this.st.trunks) {
      for (const cid of t.connections) if (!live.has(cid)) cc.failures.push(`${t.id}: trunk lists dead connection ${cid}`);
      for (const [f, idx] of [[t.a_frame, t.a_caster], [t.b_frame, t.b_caster]] as const) {
        const key = `${f}#${idx}`;
        const other = bound.get(key);
        bound.set(key, t.id);
        if (other !== undefined) cc.failures.push(`${t.id}: caster ${f}#${idx} also bound by ${other}`);
      }
    }
    return cc;
  }
}

function cloneConnection(c: Connection): Connection {
  return { ...c, hops: c.hops.map((h) => ({ ...h })), hop_gains_db: [...c.hop_gains_db] };
}

/**
 * routing.rs:232 `load_or_new` (the reconcile half): adopt a freshly
 * discovered fleet, drop connections/trunks touching vanished frames, drop
 * empty trunks, and keep `next_trunk` above every surviving id.
 */
export function reconcile(st: RouteState, frames: RouteFrame[], shape: Shape): RouteState {
  const out = cloneState(st);
  const ids = new Set(frames.map((f) => f.id));
  out.frames = frames;
  out.shape = shape;
  out.connections = out.connections.filter((c) => c.hops.every((h) => ids.has(h.from) && ids.has(h.to)));
  const live = new Set(out.connections.map((c) => c.id));
  out.trunks = out.trunks.filter((t) => ids.has(t.a_frame) && ids.has(t.b_frame));
  for (const t of out.trunks) t.connections = t.connections.filter((c) => live.has(c));
  out.trunks = out.trunks.filter((t) => t.connections.length > 0);
  let max = 0;
  for (const t of out.trunks) {
    const m = /^trunk-(\d+)$/.exec(t.id);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  if (out.next_trunk <= max) out.next_trunk = max + 1;
  return out;
}
