/**
 * Local wire types for the HTTP + WebSocket contract (area 05).
 *
 * Every type tagged `@sdk` mirrors a serde struct in TRUNK-CASTER-SDK/src
 * (types.rs, labels.rs, sites.rs) and SHOULD be replaced by an import from
 * agent 04's canonical `../sdk/index.ts` once that lands. Types tagged
 * `@runtime` mirror structs in RUST-RUNTIME/src (bookings.rs, routing.rs,
 * trends.rs). Types tagged `@adhoc` describe `serde_json::json!({...})`
 * literals built inside http.rs / runtime.rs / html.rs: they have no Rust
 * struct, so this file is their only schema.
 *
 * Conventions: Rust `usize`/`u32`/`u64`/`f64` are all `number`.
 * `Option<T>` with `skip_serializing_if = "Option::is_none"` is `field?: T`
 * (absent, never null). `Option<T>` without the skip is `field: T | null`.
 * `BTreeMap<String, T>` is `Record<string, T>`.
 */

// ---------------------------------------------------------------------------
// SDK structs (types.rs, labels.rs, sites.rs)
// ---------------------------------------------------------------------------

/** @sdk types.rs:21 */
export type Family = 'analog-audio' | 'audio-over-ip' | 'telephony' | 'control' | 'wireless' | 'media-transport' | 'other';

/** @sdk types.rs:54 */
export interface ManualDigest {
  kind?: string;
  trunking_notes?: string;
  panel_notes?: string;
  sections: string[];
}

/** @sdk types.rs:71 */
export interface Implementation {
  vendor: string;
  flavor?: string;
  documents: string[];
  source: string;
  digest: ManualDigest;
}

/** @sdk types.rs:87 */
export interface Protocol {
  id: string;
  name: string;
  family: Family;
  implementations: Implementation[];
  documents: string[];
  digest: ManualDigest;
}

/** @sdk types.rs:123 */
export interface Shape {
  frames_per_protocol: number;
  user_ports: number;
  casters_per_frame: number;
  channels_per_trunk: number;
}

/** @sdk types.rs:151 */
export interface Badge {
  vendor: string;
  emoji: string;
  color: string;
}

/** @sdk types.rs:181 */
export interface CasterAd {
  index: number;
  /** "free" or "trunked" (a string, not an enum, in Rust). */
  state: string;
  trunk?: string;
  peer_frame?: string;
}

/** @sdk labels.rs:9 */
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

/** @sdk types.rs:574 */
export interface LastActivity {
  at: string;
  unix: number;
  sim_time: number;
  who: string;
  connection: string;
}

/** @sdk types.rs:194 */
export interface Frame {
  wire_version: number;
  id: string;
  protocol: string;
  protocol_name: string;
  family: Family;
  site: string;
  country?: string;
  continent?: string;
  lat?: number;
  lon?: number;
  implemented_by: string[];
  badge?: Badge;
  user_ports: number;
  casters: number;
  channels_per_trunk: number;
  caster_status: CasterAd[];
  free_casters: number;
  port_names?: Record<string, string>;
  port_labels?: Record<string, Label>;
  live_ports?: Record<string, string>;
  last_connection?: LastActivity;
  seconds_since_last_connection?: number;
  advertised_at: string;
  endpoint?: string;
}

/** @sdk types.rs:288 */
export type GpioFunction = 'blink-panel' | 'check-lights' | 'set-latch' | 'set-listen' | 'unset-latch' | 'clear' | 'last-caller' | 'ping';

/** @sdk types.rs:361 */
export interface GpioCommand {
  connection?: string;
  pin: number;
  state: boolean;
  function?: GpioFunction;
  note?: string;
}

/** @sdk types.rs:254 */
export interface Request {
  id?: string;
  who: string;
  from: string;
  to: string;
  from_port?: number;
  to_port?: number;
  why?: string;
  where?: string;
  hold_seconds?: number;
  gpio?: GpioCommand[];
}

/** @sdk types.rs:378 */
export interface GpioEvent {
  seq: number;
  at: string;
  sim_time?: number;
  connection: string;
  who: string;
  pin: number;
  state: boolean;
  from_frame: string;
  to_frame: string;
  path: string[];
  trunks: string[];
  note?: string;
  function?: GpioFunction;
  /** serde_json::Value in Rust: whatever the key function returned. */
  result?: unknown;
}

/** @sdk types.rs:406 */
export interface Rename {
  frame: string;
  port: number;
  name: string;
  l6?: string;
  l8?: string;
  l16?: string;
}

/** @sdk types.rs:421 */
export interface LabelEvent {
  seq: number;
  at: string;
  frame: string;
  port: string;
  label: Label;
  over: string;
  connection?: string;
  origin: string;
}

/** @sdk types.rs:445 */
export interface RelayBinding {
  matrix: string;
  port: number;
  device_id: string;
  device_label: string;
  kind: string;
}

/** @sdk types.rs:457 — `seq` and `at` are `#[serde(default)]`: optional on input, always present on output. */
export interface RelayEvent {
  seq: number;
  at: string;
  kind: string;
  device_label: string;
  matrix?: string;
  port?: number;
  peak_dbfs?: number;
  threshold_dbfs?: number;
  note?: string;
}
/** What POST /api/relay/event accepts. */
export type RelayEventInput = Omit<RelayEvent, 'seq' | 'at'> & Partial<Pick<RelayEvent, 'seq' | 'at'>>;

/** @sdk types.rs:482 */
export interface RenameTransport {
  transport: string;
  version?: string;
  community?: string;
  port?: number;
  target?: string;
  oid?: string;
  note?: string;
}

/** @sdk types.rs:503 */
export interface VendorPolicy {
  renames: Record<string, RenameTransport>;
}

/** @sdk types.rs:550 */
export interface RenameDispatch {
  seq: number;
  at: string;
  frame: string;
  port: string;
  old_name?: string;
  new_name: string;
  vendor: string;
  transport: string;
  detail: string;
  payload_hex?: string;
  target?: string;
  sent: boolean;
  connection?: string;
}

/** @sdk types.rs:584 */
export type RouteKind = 'direct' | 'via';

/** @sdk types.rs:590 */
export interface Hop {
  trunk: string;
  from: string;
  to: string;
}

/** @sdk types.rs:597 */
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

/** @sdk types.rs:670 */
export type ReplyStatus = 'granted' | 'denied' | 'released';

/** @sdk types.rs:679 */
export interface Reply {
  wire_version: number;
  id: string;
  status: ReplyStatus;
  connection?: Connection;
  reason?: string;
  replied_at: string;
}

/** @sdk types.rs:692 */
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

/** @sdk types.rs:713 */
export interface GainSet {
  /** With `input` + `output`: one crosspoint inside a frame (the TAPS and Mixes faders). */
  frame?: string;
  input?: string;
  output?: string;
  trunk?: string;
  end?: string;
  connection?: string;
  hop?: number;
  db: number;
  who?: string;
}

/** @sdk types.rs:729 */
export interface GainEvent {
  seq: number;
  at: string;
  set: GainSet;
  was_db: number;
  path_gain_db: Record<string, number>;
}

/** @sdk types.rs:777 */
export interface How {
  kind: RouteKind;
  hops: Hop[];
  via: string[];
}

/** @sdk types.rs:784 */
export interface UserRecord {
  wire_version: number;
  id: string;
  who: string;
  whom: string;
  from: string;
  when: string;
  why?: string;
  where?: string;
  how?: How;
  status: ReplyStatus;
  reason?: string;
  origin: string;
  released_at?: string;
  connected_seconds?: number;
  connected_sim_seconds?: number;
  gpio_sent: number;
}

/** @sdk types.rs:821 */
export interface Crosspoint {
  frame: string;
  input: string;
  output: string;
  connection: string;
}

/** @sdk types.rs:830 */
export type DeltaOp = 'set' | 'clear';

/** @sdk types.rs:837 — `crosspoint` is `#[serde(flatten)]`. */
export interface CrosspointEvent extends Crosspoint {
  seq: number;
  at: string;
  sim_time?: number;
  op: DeltaOp;
}

/** @sdk types.rs:849 */
export interface CrosspointSettings {
  max_events: number;
  checkin_every_seconds: number;
}

/** @sdk types.rs:883 */
export interface PanelSeek {
  id?: string;
  who: string;
  from: string;
  panel_frame: string;
  panel_port?: number;
  why?: string;
}

/** @sdk types.rs:900 — `trunks` holds `null` for a trunk that would be new. */
export interface AllowedTrunk {
  kind: RouteKind;
  path: string[];
  trunks: (string | null)[];
  new_trunks_needed: number;
  free_channels: number;
}

/** @sdk types.rs:912 */
export interface PanelOffer {
  wire_version: number;
  seek: PanelSeek;
  seek_id: string;
  offered_at: string;
  allowed_trunks: AllowedTrunk[];
}

/** @sdk types.rs:978 */
export interface Production {
  enabled: boolean;
  name: string;
  studio: string;
  trunks: number;
  calls_per_minute: number;
  mean_hold_seconds: number;
  start_hour: number;
  end_hour: number;
}

/** @sdk types.rs:1184 */
export interface Blackout {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
}

/** @sdk types.rs:1213 */
export interface Newscast {
  hour: number;
  peak: number;
}

/** @sdk types.rs:1253 */
export interface Olympics {
  enabled: boolean;
  hour: number;
  hours: number;
  peak: number;
  venue: string;
  trunks: number;
  calls_per_minute: number;
  mean_hold_seconds: number;
}

/** @sdk types.rs:1225 */
export interface DaySchedule {
  enabled: boolean;
  start_hour: number;
  hourly_news: number;
  radio_prep: number;
  newscasts: Newscast[];
  overnight: number;
  blackout: Blackout;
  olympics: Olympics;
}

/** @sdk types.rs:927 */
export interface Fader {
  speed: number;
  requests_per_minute: number;
  mean_hold_seconds: number;
  crosscheck_every_seconds: number;
  sample_every_seconds: number;
  running: boolean;
  seed: number;
  day: DaySchedule;
  round_robin_seconds: number;
  lease_seconds: number;
  preset: string;
  productions: Production[];
  bookings_per_hour: number;
  in_building_calls_per_hour: number;
}
/**
 * What POST /api/fader accepts: the seven fields without a serde default are
 * required; the rest fall back to Rust defaults (a missing `day` is NOT the
 * current day: it resets to `DaySchedule::default()`).
 */
export type FaderInput = Pick<Fader, 'speed' | 'requests_per_minute' | 'mean_hold_seconds' | 'crosscheck_every_seconds' | 'sample_every_seconds' | 'running' | 'seed'> &
  Partial<Omit<Fader, 'speed' | 'requests_per_minute' | 'mean_hold_seconds' | 'crosscheck_every_seconds' | 'sample_every_seconds' | 'running' | 'seed'>>;

/** @sdk types.rs:1016 */
export interface ProductionSample {
  offered: number;
  answered: number;
  busy: number;
  live: number;
  trunks_used: number;
  trunks: number;
  on_air: boolean;
  studio: string;
}

/** @sdk types.rs:1033 */
export interface ProductionSummary {
  studio: string;
  trunks: number;
  offered: number;
  answered: number;
  busy: number;
  peak_live: number;
  first_busy_sim?: number;
}

/** @sdk types.rs:1049 */
export interface Preset {
  id: string;
  name: string;
  blurb: string;
  fader: Fader;
  surge_hour: number;
  surge_utc: boolean;
  lead_hours: number;
}

/** @sdk types.rs:1397 */
export interface Sample {
  sim_time: number;
  wall_time: string;
  active: number;
  active_via: number;
  trunks: number;
  granted_total: number;
  granted_via_total: number;
  denied_total: number;
  released_total: number;
  channel_utilization: number;
  caster_utilization: number;
  crosschecks_ok: number;
  crosschecks_failed: number;
  time_of_day: number;
  load_multiplier: number;
  muted: number;
  blackout: boolean;
  continents?: Record<string, number>;
  productions?: Record<string, ProductionSample>;
}

/** @sdk types.rs:1435 */
export interface Timeline {
  wire_version: number;
  samples: Sample[];
}

/** @sdk types.rs:1509 */
export interface RelayPort {
  port: string;
  name?: string;
  live_who?: string;
  connected_to?: string;
  connection?: string;
  connected_seconds?: number;
  binding?: RelayBinding;
}

/** @sdk types.rs:1527 */
export interface RelayMatrixState {
  id: string;
  label: string;
  io: number;
  casters: number;
  ports: RelayPort[];
  caster_status: CasterAd[];
  crosspoints: Crosspoint[];
}

/** @sdk types.rs:1539 */
export interface RelaySnapshot {
  wire_version: number;
  host: string;
  updated_at: string;
  matrices: RelayMatrixState[];
}

/** @sdk types.rs:1554 */
export interface RemoteFrame {
  frame: string;
  peer: string;
  connected_at: string;
  last_seen: string;
  last_checkin?: string;
  reported_closed: number;
  lines_sent: number;
  acks: number;
  checkins: number;
  connected: boolean;
  host?: string;
}

/** @sdk types.rs:1610 */
export interface Zone {
  name: string;
  offset_hours: number;
  anchor: boolean;
}

/** @sdk types.rs:1585 */
export interface GlobeConfig {
  rotate_deg_per_s: number;
  tilt_deg: number;
  show_capitals: boolean;
  show_provinces: boolean;
  show_cities: boolean;
  graticule_deg: number;
  /** "both" | "globe" | "map" by convention; a free string in Rust. */
  projection: string;
  zoom: number;
  zones: Zone[];
}
export type GlobeConfigInput = Omit<GlobeConfig, 'projection' | 'zoom' | 'zones'> & Partial<Pick<GlobeConfig, 'projection' | 'zoom' | 'zones'>>;

/** @sdk types.rs:1662 */
export interface Preference {
  seq: number;
  at: string;
  kind: string;
  who?: string;
  value: unknown;
}

/** @sdk types.rs:1681 */
export interface RunSummary {
  samples: number;
  duration_sim_seconds: number;
  granted: number;
  granted_via: number;
  denied: number;
  released: number;
  peak_live: number;
  avg_live: number;
  peak_muted: number;
  avg_channel_utilization: number;
  max_channel_utilization: number;
  avg_caster_utilization: number;
  crosschecks_failed: number;
  blackout_samples: number;
  productions?: Record<string, ProductionSummary>;
}

/** @sdk types.rs:1703 */
export interface SimRun {
  wire_version: number;
  id: string;
  started_at: string;
  started_sim: number;
  ended_at?: string;
  ended_sim?: number;
  reason: string;
  fader: Fader;
  frames: number;
  sites: number;
  summary: RunSummary;
  /** Always present; emptied by GET /api/runs (`current`) and empty in the saved index. */
  samples: Sample[];
}

/** @sdk types.rs:1725 */
export interface PhoneBookEntry {
  who: string;
  label: Label;
  panels: string[];
  sites: string[];
  calls: number;
  live_now: number;
  last_seen?: string;
  last_called?: string;
  badge?: Badge;
}

/** @sdk types.rs:1749 */
export interface Bucket {
  start_sim: number;
  clock: string;
  samples: number;
  avg_live: number;
  peak_live: number;
  avg_muted: number;
  granted: number;
  denied: number;
  released: number;
  avg_channel_utilization: number;
  max_channel_utilization: number;
  avg_load: number;
  blackout: boolean;
  crosschecks_failed: number;
}

/** @sdk types.rs:1770 */
export interface CaptureBuckets {
  hour: Bucket[];
  half_hour: Bucket[];
  quarter_hour: Bucket[];
}

/** @sdk types.rs:1779 */
export interface Capture {
  wire_version: number;
  id: string;
  note: string;
  started_at: string;
  started_sim: number;
  started_clock: string;
  ended_at?: string;
  ended_sim?: number;
  fader: Fader;
  frames: number;
  sites: number;
  summary: RunSummary;
  buckets: CaptureBuckets;
  /** Always present; `[]` on every route except GET /api/capture/:id. */
  samples: Sample[];
}

/** @sdk types.rs:1802 */
export interface Status {
  wire_version: number;
  root: string;
  endpoint: string;
  shape: Shape;
  protocols: number;
  frames: number;
  trunks: number;
  connections: number;
  sim_time: number;
  fader: Fader;
  updated_at: string;
  remote_frames: number;
  remotes_connected: number;
  wb_endpoint?: string;
  sites: number;
  clock: string;
  blackout: boolean;
  muted: number;
  capturing?: string;
}

/** @sdk sites.rs:10 */
export type Tier = 'capital' | 'province' | 'city';

/** @sdk sites.rs:39 */
export interface Site {
  name: string;
  slug: string;
  country: string;
  continent: string;
  tier: Tier;
  lat: number;
  lon: number;
  frames: number;
}

/** @sdk sites.rs:57 */
export interface Sites {
  sites: Site[];
}

// ---------------------------------------------------------------------------
// Runtime structs (RUST-RUNTIME/src)
// ---------------------------------------------------------------------------

/** @runtime bookings.rs:22 */
export type PortKind = 'panel' | 'input';
/** @runtime bookings.rs:41 */
export type BookingStatus = 'booked' | 'on-air' | 'done' | 'failed' | 'missed';

/** @runtime bookings.rs:68 */
export interface Booking {
  id: string;
  frame: string;
  port: number;
  kind: PortKind;
  program: string;
  who: string;
  to?: string;
  start: number;
  end: number;
  daily: boolean;
  source: string;
  status: BookingStatus;
  connection?: string;
  reason?: string;
  created_at: string;
}

/** @runtime bookings.rs:104 (Deserialize only). `who`/`to` accept null. */
export interface BookingAsk {
  frame: string;
  port: number;
  kind?: PortKind;
  program: string;
  who?: string | null;
  to?: string | null;
  start_hour: number;
  minutes: number;
  daily?: boolean;
}

/** @runtime routing.rs:16 */
export interface Counters {
  granted: number;
  granted_via: number;
  denied: number;
  released: number;
}

/** @runtime routing.rs:24 — note `next_trunk` is a private Rust field that serde still serializes. */
export interface RoutingState {
  shape: Shape;
  frames: Frame[];
  trunks: Trunk[];
  connections: Connection[];
  counters: Counters;
  updated_at: string;
  port_names: Record<string, string>;
  port_labels: Record<string, Label>;
  last_activity: Record<string, LastActivity>;
  next_trunk: number;
}

/** @runtime routing.rs:62 */
export interface CrossCheck {
  checked: number;
  ok: number;
  failures: string[];
}

// ---------------------------------------------------------------------------
// Ad-hoc json!({...}) shapes (no Rust struct; this file is their schema)
// ---------------------------------------------------------------------------

/** "green" | "red" | "parked" — runtime.rs:2633, 2677. */
export type LineState = 'green' | 'red' | 'parked';

/** @adhoc runtime.rs:2662 `lines()` — GET /api/lines and `status.lines` on the stream. */
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
  state: LineState;
  muted: boolean;
  reconnects: number;
  kind: RouteKind;
}

/** @adhoc runtime.rs:2517 `continent_totals()` */
export interface ContinentTotal {
  from: string;
  to: string;
  ocean: string;
  calls: number;
  muted: number;
  crossing: boolean;
}

/** @adhoc runtime.rs:339 `regions()` */
export interface Region {
  site: string;
  slug: string;
  country: string;
  tier: Tier;
  lat: number;
  lon: number;
  frames: number;
  local_clock: string;
  load: number;
  calls: number;
  trunks: number;
  panels_live: number;
}

/** @adhoc http.rs:265 */
export interface GpioFunctionInfo {
  pin: number;
  function: GpioFunction;
  label: string;
}

/** @adhoc runtime.rs:2563 tree device leaf */
export interface TreeDevice {
  id: string;
  protocol: string;
  badge: Badge | null;
  ports: number;
  casters: number;
  free_casters: number;
  calls: number;
  parked: number;
  panels_live: number;
  since: number | null;
  sim: boolean | null;
}
interface TreeStats {
  frames: number;
  calls: number;
  parked: number;
  panels_live: number;
}
export interface TreeSite extends TreeStats {
  site: string;
  tier: Tier | null;
  lat: number | null;
  lon: number | null;
  local_clock: string | null;
  load: number | null;
  devices: TreeDevice[];
}
export interface TreeCountry extends TreeStats {
  country: string;
  sites: number;
  children: TreeSite[];
}
export interface TreeContinent extends TreeStats {
  continent: string;
  countries: number;
  children: TreeCountry[];
}
/** @adhoc runtime.rs:2541 `tree()` */
export interface DiscoveryTree {
  global: { sites: number; frames: number; calls: number; parked: number; trunks: number; clock: string };
  continents: TreeContinent[];
}

/** @adhoc runtime.rs:2616 `device()` */
export interface DeviceView {
  frame: Frame;
  site: Site | null;
  local_clock: string | null;
  load: number | null;
  lines: {
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
  }[];
  trunks: { id: string; caster: number | null; peer: string | null; used: number; capacity: number; gain: number; since: string }[];
  events: {
    when: string;
    who: string;
    from: string;
    whom: string;
    why: string | null;
    status: ReplyStatus;
    lasted: number | null;
    via: string[] | null;
  }[];
  labels: Record<string, Label>;
  last: LastActivity | null;
  remote: RemoteFrame | null;
}

/** @adhoc html.rs:4371 `topics()` — keyed by page path ("/", "/usage", ...). */
export interface Topic {
  label: string;
  metric: string;
  colour: string;
  ink: string;
  /** `Vec<(&String, &f64)>` serializes as `[name, value]` tuples. */
  items: [string, number][];
  /** Only on "/continents": `[lat, lon, calls, site]`. */
  heat?: [number, number, number, string][];
}
export type Topics = Record<string, Topic>;

/** @adhoc http.rs:239 */
export interface CapturesList {
  current: Capture | null;
  captures: Capture[];
}

/** @adhoc http.rs:338 */
export interface RunsList {
  current: SimRun;
  previous: SimRun[];
}

/** @adhoc http.rs:536 */
export interface CrosspointsView {
  settings: CrosspointSettings;
  events_logged: number;
  log_ended: boolean;
  crosspoints: Crosspoint[];
  recent_events: CrosspointEvent[];
}

// --- globe_data (html.rs:990) ----------------------------------------------

/** @adhoc html.rs:1050 node */
export interface GlobeNode {
  id: string;
  proto: string;
  protoName: string;
  site: string;
  fam: Family;
  badge: Badge | null;
  lat: number;
  lon: number;
  live: number;
  cont: string | null;
  free: number;
  cas: number;
  ports: number;
  since: number | null;
  sim: boolean | null;
  load: number | null;
  who: string[];
}
/** @adhoc html.rs:1065 cluster: a site, or a protocol fallback centre (`tier: "protocol"`, fewer keys). */
export interface GlobeCluster {
  name: string;
  tier: Tier | 'protocol';
  lat: number;
  lon: number;
  frames: number;
  country?: string;
  local?: string;
  load?: number;
}
/** @adhoc html.rs:1090 history row */
export interface GlobeHistory {
  a: string;
  b: string;
  uses: number;
  streak: number;
  ld: number;
  lt: boolean;
  d: number[];
  l: (0 | 1)[];
  hh: number[];
  lh: number[];
  hours: number[];
  longest: number;
  last: string;
}
/** @adhoc html.rs:1100 */
export interface GlobeTrunk {
  id: string;
  a: string;
  b: string;
  used: number;
  cap: number;
  gain: number;
  uses: number;
  streak: number;
}
/** @adhoc html.rs:1110 */
export interface GlobeCall {
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
  hops: [string, string][];
  gpio: number;
  /** Human duration from `dur()`, e.g. "42s", "3m". */
  for: string;
  gain: number;
}
/** @adhoc html.rs:1120 `globe_data()` — GET /api/globe and the page's seed. */
export interface GlobeData {
  site: string;
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
  trunkList: GlobeTrunk[];
  callList: GlobeCall[];
  history: GlobeHistory[];
  today: number;
  lockHours: number;
  daysShown: number;
}

/** @adhoc html.rs:1910 `lights_json()` */
export interface Lights {
  now: number;
  lease: number;
  hot: string[];
  stale: string[];
  parked: string[];
  live: Record<string, number>;
  conn: Record<string, { to: string; since: number; left: number; more: number }>;
  /** Per frame, one '0'/'1' character per caster. */
  casters: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Small POST bodies / replies built inline in http.rs
// ---------------------------------------------------------------------------

export interface IdBody { id: string }
export interface CaptureStartBody { note?: string }
export interface QuickFaderBody { speed?: number; running?: boolean }
export interface ClockBody { hour: number }
export interface RelayUnbindBody { matrix: string; port: number }
export interface Cancelled { cancelled: string }
export interface Unbound { unbound: true }
export interface ResetDone { reset: true }

// ---------------------------------------------------------------------------
// TAPS and Mixes, voices, bandwidth (types.rs after GainEvent; voice.rs)
// ---------------------------------------------------------------------------

/** One little fader: one closed crosspoint, `input` (the thing coming in) crossed to `output`. */
export interface TapFader {
  input: string;
  output: string;
  connection: string;
  who: string;
  /** -60..+20, 0 is unity. */
  db: number;
}

/** One frame's strip on the mixer. */
export interface TapStrip {
  frame: string;
  site: string;
  protocol: string;
  vendor: string;
  /** espeak-ng voice the frame speaks in, e.g. "fr-fr+f2". */
  accent: string;
  /** What the frame's voice puts on the wire right now, both cuts. */
  kbps: number;
  faders: TapFader[];
}

/** GET /api/taps */
export interface Taps {
  frames: number;
  crosspoints: number;
  /** Crosspoints off unity. */
  trimmed: number;
  strips: TapStrip[];
}

/** POST /api/taps/unity body; an empty body resets every frame. */
export interface TapsUnity {
  frame?: string;
  who?: string;
}
export interface TapsUnityResult {
  reset: number;
}

/** A recording re-assembled from the wave sender's 1 s and 5 s cuts (voice.rs). */
export interface Assembled {
  id: string;
  frame: string;
  kind: 'ident' | 'call' | (string & {});
  text: string;
  rate: number;
  seconds: number;
  from_1s: number;
  corrected_from_5s: number;
  lost: number;
  damaged: number;
  chunks: number;
  transmit_s: number;
  at: string;
}

/** GET /api/voices/:frame */
export interface FrameVoice {
  frame: string;
  site: string;
  country: string;
  airport: string;
  accent: string;
  kbps: number;
  bytes: number;
  ident: Assembled | null;
  call: Assembled | null;
  /** e.g. "/voices/paris-01-ident.wav" */
  ident_wav: string | null;
  call_wav: string | null;
}

/** mqtt.rs LinkStats */
export interface LinkStats {
  broker: string;
  connected: boolean;
  published: number;
  received: number;
  connects: number;
}

/** GET /api/voices */
export interface VoiceSummary {
  chunks_in: number;
  bad_chunks: number;
  recordings: number;
  corrected_seconds: number;
  lost_seconds: number;
  waiting: number;
  kbps: number;
  talking: number;
  by_protocol_kbps: Record<string, number>;
  link: LinkStats | null;
  latest: Assembled[];
}

export interface ProtocolLoad { protocol: string; talking: number; kbps: number; bytes: number }
export interface FrameLoad { frame: string; protocol: string; calls: number; kbps: number; bytes: number }
export interface TrunkLoad { trunk: string; a_frame: string; b_frame: string; calls: number; capacity: number; kbps: number; kbps_per_channel: number }

/** GET /api/bandwidth: the bandwidth simulation. */
export interface Bandwidth {
  window_s: number;
  /** Voice on the wire into the caster, both cuts, kbit/s. */
  kbps: number;
  /** The same voice summed over every trunk hop it rides. */
  carried_kbps: number;
  talking: number;
  bytes: number;
  by_protocol: ProtocolLoad[];
  /** Busiest first. */
  frames: FrameLoad[];
  /** Busiest first. */
  trunks: TrunkLoad[];
}

/** GET /api/airports */
export interface Airport {
  site: string;
  country: string;
  airport: string;
  accent: string;
}

/** Every non-2xx JSON reply from http.rs `error()` (http.rs:114). */
export interface ApiErrorBody { error: string }
