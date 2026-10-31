/**
 * Local copies of the wire types the router touches.
 *
 * DEDUP NOTE: the canonical versions belong to agent 04 (TYPESCRIPT/sdk/).
 * Each type below names the Rust struct it mirrors so the two can be merged
 * by replacing this file with re-exports from the SDK. Field names are the
 * serde (snake_case) JSON names, so a `State` read from
 * TRUNK-USAGE/state.json (or `/api/state`) drops straight in.
 */

/** TRUNK-CASTER-SDK/src/types.rs:123 `Shape`. */
export interface Shape {
  frames_per_protocol: number;
  user_ports: number;
  casters_per_frame: number;
  channels_per_trunk: number;
}

/**
 * TRUNK-CASTER-SDK/src/types.rs:194 `Frame`, cut to what routing reads.
 * The full advertisement has ~30 more fields; extra fields pass through.
 */
export interface RouteFrame {
  id: string;
  /** Casters (trunk ports) on this frame. */
  casters: number;
  /** User (panel) ports on this frame. */
  user_ports: number;
}

/** types.rs:584 `RouteKind` (serde kebab-case). */
export type RouteKind = "direct" | "via";

/** types.rs:590 `Hop`. */
export interface Hop {
  trunk: string;
  from: string;
  to: string;
}

/** types.rs:597 `Connection`. `where_` is serialised as `where`. */
export interface Connection {
  id: string;
  who: string;
  from_frame: string;
  from_port: number;
  to_frame: string;
  to_port: number;
  kind: RouteKind;
  hops: Hop[];
  granted_at: string;
  granted_unix: number;
  granted_sim: number;
  why?: string;
  where?: string;
  origin: string;
  expires_at_sim?: number;
  gpio_sent: number;
  hop_gains_db: number[];
  muted: boolean;
  muted_at_sim?: number;
  reconnects: number;
  last_used_sim: number;
  latched: boolean;
  listen: boolean;
}

/** types.rs:692 `Trunk`. */
export interface Trunk {
  id: string;
  a_frame: string;
  a_caster: number;
  b_frame: string;
  b_caster: number;
  capacity: number;
  connections: string[];
  created_at: string;
  gain_a_db: number;
  gain_b_db: number;
}

/** types.rs:900 `AllowedTrunk`. `null` = a new trunk would be bound. */
export interface AllowedTrunk {
  kind: RouteKind;
  path: string[];
  trunks: (string | null)[];
  new_trunks_needed: number;
  free_channels: number;
}

/** RUST-RUNTIME/src/routing.rs:15 `Counters`. */
export interface Counters {
  granted: number;
  granted_via: number;
  denied: number;
  released: number;
}

/** types.rs `LastActivity`. */
export interface LastActivity {
  at: string;
  unix: number;
  sim_time: number;
  who: string;
  connection: string;
}

/** routing.rs:61 `CrossCheck`. */
export interface CrossCheck {
  checked: number;
  ok: number;
  failures: string[];
}

/** types.rs:1184 `Blackout` (the daily reset, 11:00 -> 12:00 UTC sim clock by default). */
export interface Blackout {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
}

/**
 * routing.rs:23 `State`, routing-relevant fields only. Port names, labels
 * and gains are not routing inputs and are left to the SDK types.
 */
export interface RouteState {
  shape: Shape;
  frames: RouteFrame[];
  trunks: Trunk[];
  connections: Connection[];
  counters: Counters;
  last_activity: Record<string, LastActivity>;
  /** Private in Rust (`next_trunk`), serialised all the same. */
  next_trunk: number;
}

/** routing.rs:46 `RouteAsk`. */
export interface RouteAsk {
  id: string;
  who: string;
  from: string;
  to: string;
  from_port?: number;
  to_port?: number;
  why?: string;
  where?: string;
  origin: string;
  sim_now: number;
  expires_at_sim?: number;
}

/** Rust `Result<T, String>`. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Wall clock, injected so previews and golden replays are deterministic. */
export interface Clock {
  nowUnix(): number;
  nowIso(): string;
}

export const systemClock: Clock = {
  nowUnix: () => Math.floor(Date.now() / 1000),
  nowIso: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
};

/** A fixed clock for tests and golden replays. */
export function fixedClock(unix = 1_792_600_000): Clock {
  return { nowUnix: () => unix, nowIso: () => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
}
