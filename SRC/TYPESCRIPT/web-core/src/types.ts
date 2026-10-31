// Wire shapes the web core reads. Each is typed from the Rust that produces
// it. Shapes that belong to the SDK (TRUNK-CASTER-SDK/src/types.rs) are local
// minimal copies here; dedup against TYPESCRIPT/sdk/ (agent 04) later.

// ---- SDK structs (TRUNK-CASTER-SDK/src/types.rs) ---------------------------

/** `Shape` (types.rs ~123). */
export interface Shape {
  frames_per_protocol: number;
  user_ports: number;
  casters_per_frame: number;
  channels_per_trunk: number;
}

/**
 * `Fader` (types.rs ~927). Only the fields the web core reads are typed; the
 * day schedule is opaque here (owned by the simulator area).
 */
export interface Fader {
  speed: number;
  requests_per_minute: number;
  mean_hold_seconds: number;
  crosscheck_every_seconds: number;
  sample_every_seconds: number;
  running: boolean;
  seed: number;
  day: unknown;
  round_robin_seconds: number;
  lease_seconds: number;
  preset: string;
}

/** `Status` (types.rs ~1802). Returned by GET /api/status and POST /api/clock. */
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

/** `ReplyStatus`, `#[serde(rename_all = "kebab-case")]`. */
export type ReplyStatus = 'granted' | 'denied' | 'released';

/** `Reply` (types.rs ~679): POST /api/request answer. `connection` is opaque here. */
export interface Reply {
  wire_version: number;
  id: string;
  status: ReplyStatus;
  connection?: unknown;
  reason?: string;
  replied_at: string;
}

/** `Request` (types.rs ~254), only the fields the page sends. */
export interface RequestBody {
  id?: string;
  who: string;
  from: string;
  to: string;
  from_port?: number;
  to_port?: number;
}

/** `GpioFunction`, kebab-case. Pin 1..8 in order. */
export type GpioFunction =
  | 'blink-panel'
  | 'check-lights'
  | 'set-latch'
  | 'set-listen'
  | 'unset-latch'
  | 'clear'
  | 'last-caller'
  | 'ping';

/** `GpioCommand` (types.rs ~361) as POSTed to /api/gpio. */
export interface GpioCommand {
  connection?: string;
  pin: number;
  state: boolean;
  function?: GpioFunction;
  note?: string;
}

/** `GpioEvent` (types.rs ~378): POST /api/gpio success. */
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
  result?: unknown;
}

/** `Rename` (types.rs ~406) as POSTed to /api/rename. */
export interface RenameBody {
  frame: string;
  port: number;
  name: string;
  l6?: string;
  l8?: string;
  l16?: string;
}

/** http.rs `error()`: every 4xx/5xx JSON body. */
export interface ApiError {
  error: string;
}

// ---- Telemetry over /ws (runtime.rs status_message / globe_message) --------

/** The `status` frame, every 500 ms (runtime.rs `status_message`). */
export interface StatusMessage {
  type: 'status';
  build: string;
  status: Status;
  clock: string;
  /** UTC hour of the simulated day, fractional. */
  hour: number;
  load: number;
  fader: { speed: number; running: boolean; preset: string };
  // The rest is read by page scripts through TC.onStatus, not by the core.
  productions: unknown;
  blackout: boolean;
  muted: number;
  log: unknown[];
  wardbeck: unknown[];
  continents: unknown;
  lines: unknown[];
  run: { id: string; summary: unknown };
  dirty: boolean;
}

/**
 * The `globe-delta` frame, every 2 s (runtime.rs `globe_message`). The core
 * only fans it out to TC.onGlobe; GLOBE_JS owns the inner shapes.
 */
export interface GlobeDeltaMessage {
  type: 'globe-delta';
  frames: number;
  clock: string;
  /** frame id -> live user ports (only frames with > 0). */
  live: Record<string, number>;
  /** frames with at least one call whose lease ran out. */
  red: string[];
  /** frame id -> parked (muted) calls. */
  parked: Record<string, number>;
  blink: string[];
  /** frame id -> who last used it. */
  last: Record<string, string>;
  trunkList: unknown;
  history: unknown;
  today: unknown;
  callList: unknown;
  lights: unknown;
  clusters: unknown;
  sites: unknown;
  trunks: unknown;
  calls: unknown;
  sims: unknown;
}

/** Everything that can arrive on /ws. `build` is only on `status` today. */
export type TelemetryMessage = StatusMessage | GlobeDeltaMessage;

// ---- /api/topics (html.rs `topics`) ----------------------------------------

/** `[name, value]` as serialized from `(&String, &f64)`. */
export type TopicItem = [name: string, value: number];
/** `[lat, lon, calls, site]` (html.rs topics, the `/continents` heat). */
export type HeatPoint = [lat: number, lon: number, calls: number, site: string];

export interface Topic {
  label: string;
  metric: string;
  colour: string;
  ink: string;
  items: TopicItem[];
  /** Only on `/continents`: the heat aurora. */
  heat?: HeatPoint[];
}

/** path -> topic, e.g. `{ "/": {...}, "/continents": {...} }`. */
export type TopicsResponse = Record<string, Topic>;

/** /api/land: rings of flat `[lon, lat, lon, lat, ...]`. */
export type LandRings = number[][];
