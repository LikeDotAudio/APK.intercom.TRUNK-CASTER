/**
 * Runtime key specs for the wire types — a drift detector until ts-rs
 * generates the types from Rust.
 *
 * `KeySpec<T>` is compiler-checked against the interface: every key must
 * be listed, no extra key is allowed, and each must say "req" exactly when
 * the field is required in T and "opt" exactly when it is optional. So if
 * someone edits a TS interface the spec stops compiling; if Rust adds or
 * drops a field, `checkKeys` against a real JSON file reports it.
 */

import type {
  Airport,
  Bandwidth,
  Blackout,
  Capture,
  Connection,
  CrosspointEvent,
  CrosspointSettings,
  CrosspointSnapshot,
  DaySchedule,
  Fader,
  Frame,
  FrameLoad,
  FrameVoice,
  GainEvent,
  GainSet,
  GlobeConfig,
  GpioEvent,
  Olympics,
  Preference,
  Production,
  ProtocolLoad,
  RelayConfig,
  RelaySnapshot,
  RenameDispatch,
  RenameTransport,
  RunSummary,
  Sample,
  SimRun,
  TapFader,
  TapStrip,
  Taps,
  TapsUnity,
  TapsUnityResult,
  Timeline,
  TrunkLoad,
  UserRecord,
  VoiceSummary,
} from "./types.ts";
import type { Assembled } from "./voice.ts";
import type { Label } from "./labels.ts";
import type { Site } from "./sites.ts";

export type Presence = "req" | "opt";

/** Exactly the keys of T, each tagged with its real optionality. */
export type KeySpec<T> = {
  readonly [K in keyof T]-?: {} extends Pick<T, K> ? "opt" : "req";
};

export interface KeyReport {
  /** Required by the TS type but absent in the JSON (and not serde-defaulted). */
  missing: string[];
  /** Absent but `#[serde(default)]` in Rust: older files; apply the default when reading. */
  defaulted: string[];
  /** Present in the JSON but unknown to the TS type (Rust grew a field). */
  unknown: string[];
}

export function checkKeys(obj: unknown, spec: Readonly<Record<string, Presence>>, serdeDefaulted: readonly string[] = []): KeyReport {
  const missing: string[] = [];
  const defaulted: string[] = [];
  const unknown: string[] = [];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { missing: ["<not an object>"], defaulted, unknown };
  const rec = obj as Record<string, unknown>;
  const s = spec;
  for (const [k, p] of Object.entries(s)) {
    if (p === "req" && !(k in rec)) (serdeDefaulted.includes(k) ? defaulted : missing).push(k);
  }
  for (const k of Object.keys(rec)) if (!(k in s)) unknown.push(k);
  return { missing, defaulted, unknown };
}

export const LABEL_KEYS = {
  full: "req", l6: "req", l8: "req", l16: "req", chars: "req", over6: "req", over8: "req", over16: "req",
} as const satisfies KeySpec<Label>;

export const FRAME_KEYS = {
  wire_version: "req", id: "req", protocol: "req", protocol_name: "req", family: "req", site: "req",
  country: "opt", continent: "opt", lat: "opt", lon: "opt", implemented_by: "req", badge: "opt",
  user_ports: "req", casters: "req", channels_per_trunk: "req", caster_status: "req", free_casters: "req",
  port_names: "opt", port_labels: "opt", live_ports: "opt", last_connection: "opt",
  seconds_since_last_connection: "opt", advertised_at: "req", endpoint: "opt",
} as const satisfies KeySpec<Frame>;

export const BLACKOUT_KEYS = { enabled: "req", start_hour: "req", end_hour: "req" } as const satisfies KeySpec<Blackout>;

export const OLYMPICS_KEYS = {
  enabled: "req", hour: "req", hours: "req", peak: "req", venue: "req", trunks: "req",
  calls_per_minute: "req", mean_hold_seconds: "req",
} as const satisfies KeySpec<Olympics>;

export const DAY_SCHEDULE_KEYS = {
  enabled: "req", start_hour: "req", hourly_news: "req", radio_prep: "req", newscasts: "req",
  overnight: "req", blackout: "req", olympics: "req",
} as const satisfies KeySpec<DaySchedule>;

export const PRODUCTION_KEYS = {
  enabled: "req", name: "req", studio: "req", trunks: "req", calls_per_minute: "req",
  mean_hold_seconds: "req", start_hour: "req", end_hour: "req",
} as const satisfies KeySpec<Production>;

export const FADER_KEYS = {
  speed: "req", requests_per_minute: "req", mean_hold_seconds: "req", crosscheck_every_seconds: "req",
  sample_every_seconds: "req", running: "req", seed: "req", day: "req", round_robin_seconds: "req",
  lease_seconds: "req", preset: "req", productions: "req", bookings_per_hour: "req",
  in_building_calls_per_hour: "req",
} as const satisfies KeySpec<Fader>;

export const CONNECTION_KEYS = {
  id: "req", who: "req", from_frame: "req", from_port: "req", to_frame: "req", to_port: "req",
  kind: "req", hops: "req", granted_at: "req", granted_unix: "req", granted_sim: "req", why: "opt",
  where: "opt", origin: "req", expires_at_sim: "opt", gpio_sent: "req", hop_gains_db: "req",
  muted: "req", muted_at_sim: "opt", reconnects: "req", last_used_sim: "req", latched: "req", listen: "req",
} as const satisfies KeySpec<Connection>;

export const USER_RECORD_KEYS = {
  wire_version: "req", id: "req", who: "req", whom: "req", from: "req", when: "req", why: "opt",
  where: "opt", how: "opt", status: "req", reason: "opt", origin: "req", released_at: "opt",
  connected_seconds: "opt", connected_sim_seconds: "opt", gpio_sent: "req",
} as const satisfies KeySpec<UserRecord>;

export const CROSSPOINT_SETTINGS_KEYS = { max_events: "req", checkin_every_seconds: "req" } as const satisfies KeySpec<CrosspointSettings>;

export const CROSSPOINT_SNAPSHOT_KEYS = {
  wire_version: "req", updated_at: "req", settings: "req", events_logged: "req", log_ended: "req", crosspoints: "req",
} as const satisfies KeySpec<CrosspointSnapshot>;

export const CROSSPOINT_EVENT_KEYS = {
  seq: "req", at: "req", sim_time: "opt", op: "req", frame: "req", input: "req", output: "req", connection: "req",
} as const satisfies KeySpec<CrosspointEvent>;

export const GPIO_EVENT_KEYS = {
  seq: "req", at: "req", sim_time: "opt", connection: "req", who: "req", pin: "req", state: "req",
  from_frame: "req", to_frame: "req", path: "req", trunks: "req", note: "opt", function: "opt", result: "opt",
} as const satisfies KeySpec<GpioEvent>;

export const RENAME_DISPATCH_KEYS = {
  seq: "req", at: "req", frame: "req", port: "req", old_name: "opt", new_name: "req", vendor: "req",
  transport: "req", detail: "req", payload_hex: "opt", target: "opt", sent: "req", connection: "opt",
} as const satisfies KeySpec<RenameDispatch>;

export const RENAME_TRANSPORT_KEYS = {
  transport: "req", version: "opt", community: "opt", port: "opt", target: "opt", oid: "opt", note: "opt",
} as const satisfies KeySpec<RenameTransport>;

export const RELAY_CONFIG_KEYS = {
  host: "req", protocol_name: "req", matrices: "req", over_threshold_dbfs: "req",
} as const satisfies KeySpec<RelayConfig>;

export const RELAY_SNAPSHOT_KEYS = {
  wire_version: "req", host: "req", updated_at: "req", matrices: "req",
} as const satisfies KeySpec<RelaySnapshot>;

export const GLOBE_CONFIG_KEYS = {
  rotate_deg_per_s: "req", tilt_deg: "req", show_capitals: "req", show_provinces: "req", show_cities: "req",
  graticule_deg: "req", projection: "req", zoom: "req", zones: "req",
} as const satisfies KeySpec<GlobeConfig>;

export const PREFERENCE_KEYS = { seq: "req", at: "req", kind: "req", who: "opt", value: "req" } as const satisfies KeySpec<Preference>;

export const SAMPLE_KEYS = {
  sim_time: "req", wall_time: "req", active: "req", active_via: "req", trunks: "req", granted_total: "req",
  granted_via_total: "req", denied_total: "req", released_total: "req", channel_utilization: "req",
  caster_utilization: "req", crosschecks_ok: "req", crosschecks_failed: "req", time_of_day: "req",
  load_multiplier: "req", muted: "req", blackout: "req", continents: "opt", productions: "opt",
} as const satisfies KeySpec<Sample>;

export const TIMELINE_KEYS = { wire_version: "req", samples: "req" } as const satisfies KeySpec<Timeline>;

export const RUN_SUMMARY_KEYS = {
  samples: "req", duration_sim_seconds: "req", granted: "req", granted_via: "req", denied: "req",
  released: "req", peak_live: "req", avg_live: "req", peak_muted: "req", avg_channel_utilization: "req",
  max_channel_utilization: "req", avg_caster_utilization: "req", crosschecks_failed: "req",
  blackout_samples: "req", productions: "opt",
} as const satisfies KeySpec<RunSummary>;

export const SIM_RUN_KEYS = {
  wire_version: "req", id: "req", started_at: "req", started_sim: "req", ended_at: "opt", ended_sim: "opt",
  reason: "req", fader: "req", frames: "req", sites: "req", summary: "req", samples: "req",
} as const satisfies KeySpec<SimRun>;

export const CAPTURE_KEYS = {
  wire_version: "req", id: "req", note: "req", started_at: "req", started_sim: "req", started_clock: "req",
  ended_at: "opt", ended_sim: "opt", fader: "req", frames: "req", sites: "req", summary: "req",
  buckets: "req", samples: "req",
} as const satisfies KeySpec<Capture>;

export const SITE_KEYS = {
  name: "req", slug: "req", country: "req", continent: "req", tier: "req", lat: "req", lon: "req", frames: "req",
} as const satisfies KeySpec<Site>;

export const GAIN_SET_KEYS = {
  frame: "opt", input: "opt", output: "opt", trunk: "opt", end: "opt", connection: "opt", hop: "opt", db: "req", who: "opt",
} as const satisfies KeySpec<GainSet>;

export const GAIN_EVENT_KEYS = { seq: "req", at: "req", set: "req", was_db: "req", path_gain_db: "req" } as const satisfies KeySpec<GainEvent>;

export const ASSEMBLED_KEYS = {
  id: "req", frame: "req", kind: "req", text: "req", rate: "req", seconds: "req", from_1s: "req",
  corrected_from_5s: "req", lost: "req", damaged: "req", chunks: "req", transmit_s: "req", at: "req",
} as const satisfies KeySpec<Assembled>;

export const TAP_FADER_KEYS = { input: "req", output: "req", connection: "req", who: "req", db: "req" } as const satisfies KeySpec<TapFader>;

export const TAP_STRIP_KEYS = {
  frame: "req", site: "req", protocol: "req", vendor: "req", accent: "req", kbps: "req", faders: "req",
} as const satisfies KeySpec<TapStrip>;

export const TAPS_KEYS = { frames: "req", crosspoints: "req", trimmed: "req", strips: "req" } as const satisfies KeySpec<Taps>;

export const TAPS_UNITY_KEYS = { frame: "opt", who: "opt" } as const satisfies KeySpec<TapsUnity>;

export const TAPS_UNITY_RESULT_KEYS = { reset: "req" } as const satisfies KeySpec<TapsUnityResult>;

export const FRAME_VOICE_KEYS = {
  frame: "req", site: "req", country: "req", airport: "req", accent: "req", kbps: "req", bytes: "req",
  ident: "req", call: "req", ident_wav: "req", call_wav: "req",
} as const satisfies KeySpec<FrameVoice>;

export const VOICE_SUMMARY_KEYS = {
  chunks_in: "req", bad_chunks: "req", recordings: "req", corrected_seconds: "req", lost_seconds: "req",
  waiting: "req", kbps: "req", talking: "req", by_protocol_kbps: "req", link: "req", latest: "req",
} as const satisfies KeySpec<VoiceSummary>;

export const PROTOCOL_LOAD_KEYS = { protocol: "req", talking: "req", kbps: "req", bytes: "req" } as const satisfies KeySpec<ProtocolLoad>;

export const FRAME_LOAD_KEYS = { frame: "req", protocol: "req", calls: "req", kbps: "req", bytes: "req" } as const satisfies KeySpec<FrameLoad>;

export const TRUNK_LOAD_KEYS = {
  trunk: "req", a_frame: "req", b_frame: "req", calls: "req", capacity: "req", kbps: "req", kbps_per_channel: "req",
} as const satisfies KeySpec<TrunkLoad>;

export const BANDWIDTH_KEYS = {
  window_s: "req", kbps: "req", carried_kbps: "req", talking: "req", bytes: "req", by_protocol: "req", frames: "req", trunks: "req",
} as const satisfies KeySpec<Bandwidth>;

export const AIRPORT_KEYS = { site: "req", country: "req", airport: "req", accent: "req" } as const satisfies KeySpec<Airport>;

/** Fields Rust fills with `#[serde(default)]` when a file omits them (older writers, hand edits). */
export const FADER_DEFAULTED = [
  "day", "round_robin_seconds", "lease_seconds", "preset", "productions", "bookings_per_hour", "in_building_calls_per_hour",
] as const satisfies readonly (keyof Fader)[];
export const SITE_DEFAULTED = ["continent", "frames"] as const satisfies readonly (keyof Site)[];
export const FRAME_DEFAULTED = ["site", "caster_status", "free_casters", "advertised_at"] as const satisfies readonly (keyof Frame)[];
export const CONNECTION_DEFAULTED = [
  "granted_unix", "granted_sim", "gpio_sent", "hop_gains_db", "muted", "reconnects", "last_used_sim", "latched", "listen",
] as const satisfies readonly (keyof Connection)[];
export const SAMPLE_DEFAULTED = ["time_of_day", "load_multiplier", "muted", "blackout"] as const satisfies readonly (keyof Sample)[];
export const CAPTURE_DEFAULTED = ["buckets", "samples"] as const satisfies readonly (keyof Capture)[];
export const TAP_FADER_DEFAULTED = ["who"] as const satisfies readonly (keyof TapFader)[];
export const TAP_STRIP_DEFAULTED = ["vendor"] as const satisfies readonly (keyof TapStrip)[];
