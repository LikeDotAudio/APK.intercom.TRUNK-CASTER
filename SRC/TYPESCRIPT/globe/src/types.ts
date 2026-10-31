// Wire shapes the map engine consumes, typed field-by-field from the Rust
// that produces them. Local minimal copies: agent 04 (TYPESCRIPT/sdk/) owns
// the shared wire contract, so dedup these against it once it lands.
//
// Sources (line numbers as audited, html.rs moves under concurrent edits):
//   globe_data()            RUST-RUNTIME/src/html.rs        fn globe_data   (~961-1099)
//   globe_message()         RUST-RUNTIME/src/runtime.rs     ~582-632  (the `globe-delta` frame)
//   status message          RUST-RUNTIME/src/runtime.rs     ~560-580, continent_totals ~2510-2537, lines ~2662-2685
//   GlobeConfig / Zone      TRUNK-CASTER-SDK/src/types.rs   ~1585-1615
//   Badge / Family          TRUNK-CASTER-SDK/src/types.rs   ~18-50, ~151-177
//   Tier                    TRUNK-CASTER-SDK/src/sites.rs   ~8-17
//   TrunkTrend              RUST-RUNTIME/src/trends.rs      ~64-87

/** `Family`, serde kebab-case. `fam` is `serde_json::to_string(&family)` with quotes trimmed. */
export type Family =
  | 'analog-audio'
  | 'audio-over-ip'
  | 'telephony'
  | 'control'
  | 'wireless'
  | 'media-transport'
  | 'other';

/** `Tier` (kebab-case) plus the synthetic `"protocol"` tier globe_data adds for fallback centres. */
export type Tier = 'capital' | 'province' | 'city';
export type ClusterTier = Tier | 'protocol';

/** `trunk_caster_sdk::Badge`. */
export interface Badge {
  vendor: string;
  emoji: string;
  color: string;
}

/** `trunk_caster_sdk::Zone`. */
export interface Zone {
  name: string;
  offset_hours: number;
  anchor: boolean;
}

/** `trunk_caster_sdk::GlobeConfig` (serialised whole as `config`). */
export interface GlobeConfig {
  rotate_deg_per_s: number;
  tilt_deg: number;
  show_capitals: boolean;
  show_provinces: boolean;
  show_cities: boolean;
  graticule_deg: number;
  /** "globe" | "map" | "both" in practice; serde accepts any string. */
  projection: string;
  zoom: number;
  zones: Zone[];
}

/** One frame on the map (`nodes[]`). */
export interface GlobeNode {
  id: string;
  /** Protocol id (`f.protocol`). GLOBE_FILTER matches this. */
  proto: string;
  /** Display name (`f.protocol_name`). The toolbar filter matches this. */
  protoName: string;
  site: string;
  fam: Family;
  badge: Badge | null;
  lat: number;
  lon: number;
  /** Live user ports. Overwritten by every globe-delta. */
  live: number;
  /** `f.continent`: Option<String>. */
  cont: string | null;
  free: number;
  cas: number;
  ports: number;
  /** `seconds_since_last`: Option<u64>. */
  since: number | null;
  /** Remote simulator connected: Option<bool>, null when no simulator is known. */
  sim: boolean | null;
  /** Day-curve load multiplier at the frame's longitude; null without coordinates. */
  load: number | null;
  /** `"<port> <who>"` per live port. */
  who: string[];
}

/** A site with frames, or a protocol centre for frames without coordinates. */
export interface SiteCluster {
  name: string;
  tier: Tier;
  country: string;
  lat: number;
  lon: number;
  frames: number;
  /** Local time "HH:MM". */
  local: string;
  load: number;
}
export interface ProtocolCluster {
  name: string;
  tier: 'protocol';
  lat: number;
  lon: number;
  /** Always 0. */
  frames: number;
}
export type GlobeCluster = SiteCluster | ProtocolCluster;

/** One trunk up now (`trunkList[]`). */
export interface LiveTrunk {
  id: string;
  a: string;
  b: string;
  used: number;
  cap: number;
  /** gain_a_db + gain_b_db. */
  gain: number;
  uses: number;
  streak: number;
}

/** `trunk_caster_sdk::Hop` reduced to `[from, to]`. */
export type HopPair = [from: string, to: string];

/** One call in flight (`callList[]`). */
export interface LiveCall {
  id: string;
  who: string;
  why: string | null;
  kind: 'direct' | 'via';
  muted: boolean;
  badge: Badge | null;
  toBadge: Badge | null;
  /** Caller frame's protocol_name; null when the frame is gone. */
  proto: string | null;
  from_site: string | null;
  to_site: string | null;
  /** Non-empty in a healthy state (crosscheck flags "no hops"); the engine guards anyway. */
  hops: HopPair[];
  gpio: number;
  /** Pre-formatted duration, `dur()`. */
  for: string;
  gain: number;
}

/** `trends::TrunkTrend` as globe_data reshapes it (`history[]`). */
export interface TrunkHistory {
  a: string;
  b: string;
  uses: number;
  /** Consecutive days locked, ending today or yesterday. */
  streak: number;
  /** locked_days in the window. */
  ld: number;
  /** locked_today. */
  lt: boolean;
  /** Uses per day, oldest first, DAYS_SHOWN long. */
  d: number[];
  /** Locked per day, 1/0. */
  l: Array<0 | 1>;
  /** Hours held per day, one decimal. */
  hh: number[];
  /** lock_hours: per hour of day, how many shown days were locked then. 24 long. */
  lh: number[];
  /** Uses by hour of day. 24 long. */
  hours: number[];
  longest: number;
  last: string;
}

/** `globe_data()` — what `window.GLOBE_DATA` and `GET /api/globe` hold. */
export interface GlobeData {
  site: string;
  /** Simulated UTC "HH:MM:SS". */
  clock: string;
  load: number;
  sim_time: number;
  frames: number;
  sites: number;
  trunks: number;
  calls: number;
  sims: number;
  config: GlobeConfig;
  nodes: GlobeNode[];
  clusters: GlobeCluster[];
  trunkList: LiveTrunk[];
  callList: LiveCall[];
  history: TrunkHistory[];
  /** Simulated day number (i64). */
  today: number;
  /** LOCK_SECONDS / 3600 (1.0). */
  lockHours: number;
  /** DAYS_SHOWN (14). */
  daysShown: number;
}

/** The `globe-delta` telemetry frame (runtime.rs globe_message). */
export interface GlobeDelta {
  type: 'globe-delta';
  frames: number;
  clock: string;
  trunkList: LiveTrunk[];
  history: TrunkHistory[];
  today: number;
  callList: LiveCall[];
  /** frame id → live port count; only frames with live > 0. */
  live: Record<string, number>;
  red: string[];
  parked: Record<string, number>;
  blink: string[];
  last: Record<string, string>;
  /** Owned by the panels/lights area; the map ignores it. */
  lights: unknown;
  clusters: GlobeCluster[];
  sites: number;
  trunks: number;
  calls: number;
  sims: number;
}

/** continent_totals() rows. */
export interface ContinentTotal {
  from: string;
  to: string;
  ocean: string | null;
  calls: number;
  muted: number;
  crossing: boolean;
}

/** lines() rows. */
export interface LeaseLine {
  id: string;
  who: string;
  from: string;
  to: string;
  from_site: string | null;
  to_site: string | null;
  from_continent: string | null;
  to_continent: string | null;
  badge: Badge | null;
  left: number;
  lease: number;
  state: 'parked' | 'red' | 'green';
  muted: boolean;
  reconnects: number;
  kind: string;
}

/** The parts of the `status` telemetry frame the map side panels read. */
export interface StatusMessage {
  type?: 'status';
  continents?: ContinentTotal[];
  lines?: LeaseLine[];
  run?: { id: string; summary: { granted: number; denied: number; peak_live: number } };
  status?: { connections: number };
}

/** `window.GLOBE_HUB` (html.rs, the aggregator page). */
export interface Hub {
  name: string;
  endpoint: string;
  lat: number;
  lon: number;
}

/** LAND_JSON: one flat `[lon, lat, lon, lat, …]` array per ring. */
export type LandRing = number[];

export type ViewMode = 'both' | 'globe' | 'map';
export type Projection = 'globe' | 'map';
export type ColourView = 'uses' | 'trend' | 'live';
export type LayerKey = 'sun' | 'trunks' | 'calls' | 'frames' | 'ports' | 'continents' | 'labels' | 'grid';
