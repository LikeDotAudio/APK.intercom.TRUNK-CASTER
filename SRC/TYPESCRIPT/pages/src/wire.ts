// Local, minimal wire types for the page scripts (area 03).
// Each shape is transcribed from the Rust that produces the JSON; the source
// is named above every type. DEDUP: these belong to agent 04 (TYPESCRIPT/sdk/)
// once it publishes them — replace these with `import type` from there.

/** TRUNK-CASTER-SDK/src/types.rs `Badge`. */
export interface Badge {
  vendor: string;
  emoji: string;
  color: string;
}

/** TRUNK-CASTER-SDK/src/labels.rs `Label`. */
export interface Label {
  full: string;
  l6: string;
  l8: string;
  l16: string;
  chars: number;
  over6: boolean;
  over8: boolean;
  over16: boolean;
}

/** Any `/api/*` route that failed answers `{ error }`. */
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// /api/tree — runtime.rs `Runtime::tree()`
// ---------------------------------------------------------------------------

/** TRUNK-CASTER-SDK/src/sites.rs `Tier` (kebab-case). */
export type Tier = 'capital' | 'province' | 'city';

export interface TreeDevice {
  id: string;
  /** frame.protocol_name */
  protocol: string;
  badge: Badge | null;
  ports: number;
  casters: number;
  free_casters: number;
  calls: number;
  parked: number;
  panels_live: number;
  since: number | null;
  /** Option<bool>: null when no simulator ever announced this frame. */
  sim: boolean | null;
}

export interface TreeSite {
  site: string;
  tier: Tier | null;
  lat: number | null;
  lon: number | null;
  local_clock: string | null;
  load: number | null;
  frames: number;
  calls: number;
  parked: number;
  panels_live: number;
  devices: TreeDevice[];
}

export interface TreeCountry {
  country: string;
  sites: number;
  frames: number;
  calls: number;
  parked: number;
  panels_live: number;
  children: TreeSite[];
}

export interface TreeContinent {
  continent: string;
  countries: number;
  frames: number;
  calls: number;
  parked: number;
  panels_live: number;
  children: TreeCountry[];
}

export interface TreeJson {
  global: { sites: number; frames: number; calls: number; parked: number; trunks: number; clock: string };
  continents: TreeContinent[];
}

// ---------------------------------------------------------------------------
// /api/device/<id> — runtime.rs `Runtime::device()`
// ---------------------------------------------------------------------------

/** The subset of SDK `Frame` (advertisement_of) the device panel reads. */
export interface FrameAd {
  id: string;
  protocol: string;
  protocol_name: string;
  site: string;
  badge?: Badge;
  user_ports: number;
  casters: number;
  free_casters: number;
  /** Skipped when empty (skip_serializing_if = BTreeMap::is_empty). */
  live_ports?: Record<string, string>;
  seconds_since_last_connection?: number;
}

export type LineState = 'green' | 'red' | 'parked';
export type RouteKind = 'direct' | 'via' | string;

export interface DeviceLine {
  id: string;
  who: string;
  role: 'from' | 'to' | 'via';
  from: string;
  to: string;
  why: string | null;
  kind: RouteKind;
  muted: boolean;
  left: number;
  state: LineState;
  connected_for: number;
  gpio: number;
  gain: number;
  reconnects: number;
}

export interface DeviceTrunk {
  id: string;
  /** Option<usize>: the page prints "C" + caster, so null shows "Cnull". */
  caster: number | null;
  peer: string | null;
  used: number;
  capacity: number;
  gain: number;
  since: string;
}

/** SDK `ReplyStatus` (kebab-case). */
export type ReplyStatus = 'granted' | 'denied' | 'released';

export interface DeviceEvent {
  when: string;
  who: string;
  from: string;
  whom: string;
  why: string | null;
  status: ReplyStatus;
  lasted: number | null;
  via: string[] | null;
}

/** SDK `RemoteFrame`, the fields the page reads. */
export interface RemoteFrame {
  frame: string;
  peer: string;
  connected: boolean;
  acks: number;
  reported_closed: number;
  lines_sent: number;
  checkins: number;
}

export interface DeviceJson {
  error?: undefined;
  frame: FrameAd;
  site: unknown;
  local_clock: string | null;
  load: number | null;
  lines: DeviceLine[];
  trunks: DeviceTrunk[];
  events: DeviceEvent[];
  labels: Record<string, Label>;
  last: unknown;
  remote: RemoteFrame | null;
}

export type DeviceReply = DeviceJson | ApiError;

// ---------------------------------------------------------------------------
// WebSocket `status` frame — runtime.rs `status_message()` (subset)
// ---------------------------------------------------------------------------

/** runtime.rs `continent_totals()` */
export interface ContinentTotal {
  from: string;
  to: string;
  ocean: string | null;
  calls: number;
  muted: number;
  crossing: boolean;
}

/** runtime.rs `lines()` */
export interface LineJson {
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
  state: LineState;
  muted: boolean;
  reconnects: number;
  kind: RouteKind;
}

export interface StatusMessage {
  type: 'status';
  build: string;
  clock: string;
  continents?: ContinentTotal[];
  lines?: LineJson[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket `globe-delta` frame — runtime.rs `globe_message()` (subset)
// ---------------------------------------------------------------------------

/** html.rs `lights_json()` — also injected as window.LIGHTS0. */
export interface LightConnJson {
  to: string;
  /** unix seconds the longest-running connection was granted */
  since: number;
  /** lease seconds left (may be <= 0) */
  left: number;
  more: number;
}

export interface LightsJson {
  now: number;
  lease: number;
  hot: string[];
  stale: string[];
  parked: string[];
  live: Record<string, number>;
  conn: Record<string, LightConnJson>;
  /** frame id -> "0101…" one char per caster */
  casters: Record<string, string>;
}

/** html.rs `globe_data()` callList entry. */
export interface CallJson {
  id: string;
  who: string;
  why: string | null;
  kind: RouteKind;
  muted: boolean;
  badge: Badge | null;
  toBadge: Badge | null;
  proto: string | null;
  from_site: string | null;
  to_site: string | null;
  /** [from, to] per trunk hop. Empty for a call that never left its frame. */
  hops: [string, string][];
}

export interface GlobeDelta {
  type: 'globe-delta';
  frames: number;
  clock: string;
  callList?: CallJson[];
  blink?: string[];
  lights?: LightsJson;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Relay page injections — html.rs `relay_page()`
// ---------------------------------------------------------------------------

/** `{"id","label","io"}` per matrix (window.RELAY_MATRICES). */
export interface RelayMatrixLite {
  id: string;
  label: string;
  io: number;
}

/** SDK `RelayBinding` (window.RELAY_BOUND values, keyed "<matrix>:<port>"). */
export interface RelayBinding {
  matrix: string;
  port: number;
  device_id: string;
  device_label: string;
  kind: 'input' | 'output' | string;
}

// ---------------------------------------------------------------------------
// /api/bookings reply (panel editor)
// ---------------------------------------------------------------------------

/**
 * The editor reads r.error, r.id, r.program. `api()` returns the raw text
 * when the body is not JSON, so at runtime r may be a string; property reads
 * on a string give undefined, which the page relies on ("booked undefined").
 */
export interface BookingReply {
  error?: string;
  id?: string;
  program?: string;
}
