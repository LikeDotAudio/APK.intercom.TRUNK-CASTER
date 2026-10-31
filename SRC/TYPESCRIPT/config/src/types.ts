// Types for every hand-edited config file and every JSONL log line the
// runtime appends. Each mirrors the Rust struct that reads or writes it.
//
// DEDUP NOTE: canonical wire types belong to agent 04 (TYPESCRIPT/sdk/).
// These are local copies so this folder stands alone; once sdk/ exports
// Fader, GlobeConfig, RelayConfig, Label, etc., re-export from there and
// keep only the validators here.
//
// Optional (`?`) means the Rust field has #[serde(default)] or is Option<_>.

import type { JsonValue } from "./check.ts";

// ---------------------------------------------------------------------------
// TRUNK-GLOBAL/sites.json      TRUNK-CASTER-SDK/src/sites.rs:8-60
// ---------------------------------------------------------------------------

export const TIERS = ["capital", "province", "city"] as const;
export type Tier = (typeof TIERS)[number];

export interface Site {
  name: string;
  slug: string;
  country: string;
  /** Derived from the country when missing (Sites::normalize). */
  continent?: string;
  tier: Tier;
  lat: number;
  lon: number;
  /** 0/absent = the tier's default: capital 10, province 1, city 2. */
  frames?: number;
}

export interface Sites {
  sites: Site[];
}

// ---------------------------------------------------------------------------
// TRUNK-GLOBAL/globe.json      TRUNK-CASTER-SDK/src/types.rs:1590-1665
// ---------------------------------------------------------------------------

/** GLOBE_JS (html.rs) treats anything but "map" as globe; "both" splits the canvas. */
export const PROJECTIONS = ["globe", "map", "both"] as const;
export type Projection = (typeof PROJECTIONS)[number];

export interface Zone {
  name: string;
  offset_hours: number;
  anchor?: boolean;
}

export interface GlobeConfig {
  rotate_deg_per_s: number;
  tilt_deg: number;
  show_capitals: boolean;
  show_provinces: boolean;
  show_cities: boolean;
  graticule_deg: number;
  projection?: string;
  zoom?: number;
  zones?: Zone[];
}

// ---------------------------------------------------------------------------
// TRUNK-SIMULATOR/fader.json   TRUNK-CASTER-SDK/src/types.rs:925-1315
// ---------------------------------------------------------------------------

export interface Newscast {
  hour: number;
  peak: number;
}

export interface Blackout {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
}

export interface Olympics {
  enabled: boolean;
  hour: number;
  hours: number;
  peak: number;
  venue?: string;
  trunks: number;
  calls_per_minute: number;
  mean_hold_seconds: number;
}

export interface DaySchedule {
  enabled: boolean;
  /** Negative = the wall clock's time of day at boot. */
  start_hour: number;
  hourly_news: number;
  radio_prep: number;
  newscasts?: Newscast[];
  overnight: number;
  blackout?: Blackout;
  olympics?: Olympics;
}

export interface Production {
  enabled: boolean;
  name: string;
  /** Frame id `<site-slug>-<nn>`; empty = runtime picks a capital frame. */
  studio?: string;
  trunks: number;
  calls_per_minute: number;
  mean_hold_seconds: number;
  /** -1 = all day. */
  start_hour: number;
  end_hour: number;
}

export interface Fader {
  speed: number;
  requests_per_minute: number;
  mean_hold_seconds: number;
  crosscheck_every_seconds: number;
  sample_every_seconds: number;
  running: boolean;
  seed: number;
  day?: DaySchedule;
  round_robin_seconds?: number;
  lease_seconds?: number;
  preset?: string;
  productions?: Production[];
  bookings_per_hour?: number;
  in_building_calls_per_hour?: number;
}

// ---------------------------------------------------------------------------
// TRUNK-SIMULATOR/emulators.json   read by TRUNK-SIMULATOR/launch_all.py:90-112, 226
// (no Rust struct; Python dict access)
// ---------------------------------------------------------------------------

export interface EmulatorVendor {
  vendor: string;
  /** Path relative to the project root. */
  emulator: string;
  base_port: number;
  map_port: number;
  /** Four-letter capital codes. */
  capitals: string[];
  region?: string;
}

export interface Emulators {
  _comment?: string;
  combined_map_port?: number;
  stand_in?: string;
  chaos?: number;
  vendors: EmulatorVendor[];
}

// ---------------------------------------------------------------------------
// TRUNK-CASTER-SDK/vendor-policy.json   TRUNK-CASTER-SDK/src/types.rs:478-546
// ---------------------------------------------------------------------------

export const RENAME_TRANSPORTS = ["sdk", "snmp", "native"] as const;
export type RenameTransportKind = (typeof RENAME_TRANSPORTS)[number];

export interface RenameTransport {
  transport: string;
  version?: string;
  community?: string;
  port?: number;
  target?: string;
  oid?: string;
  note?: string;
}

export interface VendorPolicy {
  renames: Record<string, RenameTransport>;
}

// ---------------------------------------------------------------------------
// TRUNK-RELAY/relay.json       TRUNK-CASTER-SDK/src/types.rs:443-452, 1446-1480
// ---------------------------------------------------------------------------

export interface RelayBinding {
  matrix: string;
  port: number;
  device_id: string;
  device_label: string;
  kind: string;
}

export interface RelayMatrix {
  id: string;
  label: string;
  io: number;
  casters: number;
  port_names?: Record<string, string>;
  bindings?: Record<string, RelayBinding>;
}

export interface RelayConfig {
  host: string;
  protocol_name?: string;
  matrices: RelayMatrix[];
  over_threshold_dbfs?: number;
}

// ---------------------------------------------------------------------------
// TRUNK-CROSS POINTS/settings.json   TRUNK-CASTER-SDK/src/types.rs:847-866
// ---------------------------------------------------------------------------

export interface CrosspointSettings {
  max_events: number;
  checkin_every_seconds?: number;
}

// ---------------------------------------------------------------------------
// PANELS/connect.json   documentation for Stream Deck / Companion users;
// read by nothing in Rust or Python (panels agent 07 may read it in TS).
// ---------------------------------------------------------------------------

export interface ConnectGuide {
  _comment?: string;
  api: { base_url: string; help: string; content_type: string };
  discover: Record<string, string>;
  lifecycle: Record<string, string>;
  buttons: Record<string, string>;
  feedback: { poll: string; poll_interval_ms: number; fields: Record<string, string> };
  bitfocus_companion?: Record<string, string>;
  streamdeck_app_native?: Record<string, string>;
  audio_for_the_operator?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// JSONL line shapes
// ---------------------------------------------------------------------------

/** TRUNK-GLOBAL/preferences.jsonl   types.rs:1667-1678, written runtime.rs:306-311 */
export const PREFERENCE_KINDS = [
  // documented in types.rs:1672-1673
  "fader", "fader-quick", "clock", "gain", "rename", "relay-bind", "relay-unbind",
  "crosspoint-settings", "crosspoint-reset", "globe",
  // seen on disk / in the runtime but not in the doc comment
  "capture-start", "capture-stop", "daily-reset",
] as const;

export interface Preference {
  seq: number;
  at: string;
  kind: string;
  who?: string;
  value: JsonValue;
}

/** TRUNK-CASTER-SDK/src/labels.rs:8-24 */
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

/** TRUNK-USERS/labels.jsonl   types.rs:419-431, written runtime.rs:1136-1154 */
export interface LabelEvent {
  seq: number;
  at: string;
  frame: string;
  port: string;
  label: Label;
  over: "over6" | "over8" | "over6,over8";
  connection?: string;
  origin: string;
}

/** TRUNK-CROSS POINTS/renames.jsonl   types.rs:548-570, written runtime.rs:1244-1270 */
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

export const GPIO_FUNCTIONS = [
  "blink-panel", "check-lights", "set-latch", "set-listen", "unset-latch", "clear", "last-caller", "ping",
] as const;
export type GpioFunction = (typeof GPIO_FUNCTIONS)[number];

/** TRUNK-CROSS POINTS/gpio.jsonl   types.rs:376-400, written runtime.rs:1480-1500 */
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
  result?: JsonValue;
}

/** TRUNK-CROSS POINTS/deltas.jsonl   types.rs:819-846 (Crosspoint is #[serde(flatten)]) */
export interface CrosspointEvent {
  seq: number;
  at: string;
  sim_time?: number;
  op: "set" | "clear";
  frame: string;
  input: string;
  output: string;
  connection: string;
}

/** TRUNK-RELAY/events.jsonl   types.rs:453-476, written runtime.rs:1377-1382 */
export interface RelayEvent {
  seq?: number;
  at?: string;
  kind: string;
  device_label: string;
  matrix?: string;
  port?: number;
  peak_dbfs?: number;
  threshold_dbfs?: number;
  note?: string;
}

/** types.rs:711-736, TRUNK-USAGE/gains.jsonl written runtime.rs:1318-1323 */
export interface GainSet {
  trunk?: string;
  end?: string;
  connection?: string;
  hop?: number;
  db: number;
  who?: string;
}

export interface GainEvent {
  seq: number;
  at: string;
  set: GainSet;
  was_db: number;
  path_gain_db: Record<string, number>;
}
