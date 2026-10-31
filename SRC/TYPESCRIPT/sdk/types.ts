/**
 * Every JSON shape exchanged between Trunk-Caster components — port of
 * TRUNK-CASTER-SDK/src/types.rs.
 *
 * Rules applied (serde → TS):
 *  - Field names are the Rust names (no struct uses `rename_all`); the only
 *    renames are `where_` → `"where"`.
 *  - Unit enums with `rename_all = "kebab-case"` → string-literal unions plus
 *    a `const` array of every value. (No SDK enum carries data, so there are
 *    no tag/content unions here.)
 *  - `Option<T>` + `skip_serializing_if = "Option::is_none"` → `field?: T`.
 *    Almost every `Option` field in the SDK has that attribute, so the runtime
 *    never emits `null` for them — absent means None. serde still *accepts* `null`
 *    on input. The exceptions are `AllowedTrunk.trunks: Vec<Option<String>>`,
 *    whose elements ARE emitted as `null`, and the `Option` fields of
 *    `FrameVoice` and `VoiceSummary.link` (no skip: `T | null`).
 *  - `BTreeMap` + `skip_serializing_if = "BTreeMap::is_empty"` → optional
 *    record; `Vec` + `skip_serializing_if = "Vec::is_empty"` → optional array.
 *  - `#[serde(default)]` without skip → always present on output, optional
 *    on input. The `*Input` types model what the runtime will accept.
 *  - `#[serde(flatten)]` → intersection (`CrosspointEvent`).
 *  - `PathBuf` → string. `serde_json::Value` → `JsonValue`.
 *  - Integers (`usize`, `u32`, `u64`, `u16`) → `number`. `u64` values above
 *    2^53 (Number.MAX_SAFE_INTEGER) lose precision in JSON.parse; in
 *    practice only `Fader.seed` can be set that high by hand. serde_json
 *    rejects a fractional or negative number in an integer field, so TS
 *    writers must send integers there (see `isUint`).
 *  - `f64` fields: serde_json writes `100.0`, JSON.stringify writes `100`;
 *    both parse identically. NaN/±Infinity serialize as `null` on both sides
 *    and then FAIL to deserialize into `f64` — never send them.
 */

import type { Label } from "./labels.ts";
import type { LinkStats } from "./mqtt.ts";
import type { Assembled } from "./voice.ts";

// ---------------------------------------------------------------------------
// Primitive aliases (documentation only)
// ---------------------------------------------------------------------------

/** Rust `usize`: non-negative integer. */
export type Usize = number;
/** Rust `u16`. */
export type U16 = number;
/** Rust `u32`. */
export type U32 = number;
/** Rust `u64`: exact only up to 2^53 − 1 in JS. */
export type U64 = number;
/** Rust `f64`: must be finite on the wire. */
export type F64 = number;
/** Rust `PathBuf`, serialized as a UTF-8 string. */
export type PathString = string;
/** RFC 3339 timestamp string as written by the runtime (`util::now_iso`). */
export type IsoTime = string;

/** `serde_json::Value`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Make the keys `K` of `T` optional (for `#[serde(default)]` fields on input). */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** True when `n` is a valid Rust unsigned integer value (what serde accepts for usize/u32/u64). */
export function isUint(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** Rust `f64::rem_euclid`. */
export function remEuclid(x: number, m: number): number {
  const r = x % m;
  return r < 0 ? r + Math.abs(m) : r;
}

/** Rust `f64::max`: ignores NaN rather than propagating it. */
function fmax(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a > b ? a : b;
}

/** Wire-format version (`lib.rs` `WIRE_VERSION`). Bump when a JSON shape changes incompatibly. */
export const WIRE_VERSION = 1;

// ---------------------------------------------------------------------------
// Repertoire: protocols and their vendor implementations      types.rs:14-115
// ---------------------------------------------------------------------------

/** Broad family a protocol belongs to. serde kebab-case. */
export type Family =
  | "analog-audio"
  | "audio-over-ip"
  | "telephony"
  | "control"
  | "wireless"
  | "media-transport"
  | "other";
export const FAMILIES: readonly Family[] = [
  "analog-audio",
  "audio-over-ip",
  "telephony",
  "control",
  "wireless",
  "media-transport",
  "other",
];
export function familyLabel(f: Family): string {
  switch (f) {
    case "analog-audio":
      return "Analog audio";
    case "audio-over-ip":
      return "Audio over IP";
    case "telephony":
      return "Telephony";
    case "control":
      return "Control";
    case "wireless":
      return "Wireless";
    case "media-transport":
      return "Media transport";
    case "other":
      return "Other";
  }
}

/** What the runtime learned from reading one manual. */
export interface ManualDigest {
  /** The `**Type:**` line, if present. */
  kind?: string;
  /** Body of the "Trunking notes" section, if present. */
  trunking_notes?: string;
  /** Body of the "Talking to the panel" section, if present. */
  panel_notes?: string;
  /** Section headings found, in order. `#[serde(default)]`. */
  sections: string[];
}

/** One vendor's implementation of a protocol, as found in the manuals. */
export interface Implementation {
  /** Vendor folder name, e.g. "Riedel". */
  vendor: string;
  /** Vendor flavour of the protocol, e.g. "Performer" for Riedel 2-Wire. */
  flavor?: string;
  /** Manuals and API references found, relative to the protocol folder. */
  documents: PathString[];
  /** Where the documents live (absolute). */
  source: PathString;
  digest: ManualDigest;
}

/** A protocol in the discovered repertoire (`GET /api/protocols`). */
export interface Protocol {
  /** Stable kebab-case identifier, e.g. "dante", "2-wire". */
  id: string;
  name: string;
  family: Family;
  implementations: Implementation[];
  /** Brand-neutral manuals for the protocol itself. */
  documents: PathString[];
  digest: ManualDigest;
}
export function protocolVendors(p: Protocol): string[] {
  return p.implementations.map((i) => i.vendor);
}
export function protocolDocumentCount(p: Protocol): number {
  return p.documents.length + p.implementations.reduce((n, i) => n + i.documents.length, 0);
}
/** The `**Type:**` line: the protocol's own manual first, then any vendor's. */
export function protocolKind(p: Protocol): string | undefined {
  return p.digest.kind ?? p.implementations.find((i) => i.digest.kind !== undefined)?.digest.kind;
}

// ---------------------------------------------------------------------------
// Fleet shape and frames                                       types.rs:117-245
// ---------------------------------------------------------------------------

/** Shape of the fleet the runtime advertises. */
export interface Shape {
  frames_per_protocol: Usize;
  user_ports: Usize;
  casters_per_frame: Usize;
  channels_per_trunk: Usize;
}
export function defaultShape(): Shape {
  return { frames_per_protocol: 10, user_ports: 56, casters_per_frame: 8, channels_per_trunk: 8 };
}
/** Total matrix size: user ports plus casters (56 + 8 = 64). */
export function matrixSize(s: Shape): Usize {
  return s.user_ports + s.casters_per_frame;
}

/** A vendor's colour and emoji. Informational only: trunks are addressed by protocol, never by brand. */
export interface Badge {
  vendor: string;
  emoji: string;
  color: string;
}

/** `vendor_badge`. Uses ASCII lowercasing like Rust `to_ascii_lowercase`. */
export function vendorBadge(vendor: string): Badge {
  const v = vendor.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let emoji: string;
  let color: string;
  if (v.includes("rts")) [emoji, color] = ["🟣", "#8957e5"];
  else if (v.includes("clear")) [emoji, color] = ["🔵", "#1f6feb"];
  else if (v.includes("riedel")) [emoji, color] = ["🔴", "#c62828"];
  else if (v.includes("telos") || v.includes("telex")) [emoji, color] = ["🟡", "#f6c343"];
  else if (v.includes("intracom")) [emoji, color] = ["🟢", "#1a7f37"];
  else if (v.includes("ward")) [emoji, color] = ["🟠", "#e3a35a"];
  else if (v === "" || v.includes("relay")) [emoji, color] = ["⚪", "#cfd6e4"];
  else [emoji, color] = ["⚫", "#9aa3ad"];
  return { vendor, emoji, color };
}

/** "free" or "trunked" (free-form `String` in Rust). */
export type CasterState = "free" | "trunked" | (string & {});

/** A caster (trunk port) as advertised. */
export interface CasterAd {
  index: Usize;
  state: CasterState;
  trunk?: string;
  peer_frame?: string;
}

/**
 * A frame advertised by the runtime. Identity is `<protocol>-<nn>` (or
 * `<site-slug>-<nn>` for site-hosted frames). One JSON per frame in
 * TRUNK-ADVERTISEMENT, and `GET /api/advertisements`.
 */
export interface Frame {
  wire_version: U32;
  id: string;
  protocol: string;
  protocol_name: string;
  family: Family;
  /** Fills the SITE field of the frame's Ward-Beck lines. `#[serde(default)]`. */
  site: string;
  country?: string;
  continent?: string;
  lat?: F64;
  lon?: F64;
  /** Informational only: a trunk is never addressed by brand. */
  implemented_by: string[];
  badge?: Badge;
  user_ports: Usize;
  casters: Usize;
  channels_per_trunk: Usize;
  /** `#[serde(default)]`. */
  caster_status: CasterAd[];
  /** `#[serde(default)]`. */
  free_casters: Usize;
  /** Keyed `U<nn>`; omitted when empty. */
  port_names?: Record<string, string>;
  /** 6/8/16 cuts keyed `U<nn>`; omitted when empty. */
  port_labels?: Record<string, Label>;
  /** Who is on this frame right now, keyed `U<nn>`; omitted when empty. */
  live_ports?: Record<string, string>;
  last_connection?: LastActivity;
  seconds_since_last_connection?: U64;
  /** `#[serde(default)]`. */
  advertised_at: IsoTime;
  endpoint?: string;
}

// ---------------------------------------------------------------------------
// Requests, replies, connections                               types.rs:247-768
// ---------------------------------------------------------------------------

/** A seeker asking for a trunk: `<id>.json` in TRUNK-CASTER-INTERFACE or `POST /api/request`. */
export interface Request {
  /** Caller-chosen id. If omitted, the runtime assigns one. */
  id?: string;
  who: string;
  /** Frame the conversation starts on. */
  from: string;
  /** Frame the conversation must reach. */
  to: string;
  /** User port on `from`; lowest free port if omitted. */
  from_port?: Usize;
  to_port?: Usize;
  why?: string;
  where?: string;
  /** Hold time in simulated seconds. Omitted: until released. */
  hold_seconds?: F64;
  /** GPIO commands sent down the path once granted. Omitted when empty. */
  gpio?: GpioCommand[];
}

/** What each GPIO pin does: the intercom key functions. serde kebab-case. */
export type GpioFunction =
  | "blink-panel"
  | "check-lights"
  | "set-latch"
  | "set-listen"
  | "unset-latch"
  | "clear"
  | "last-caller"
  | "ping";
/** `GpioFunction::all()`, in pin order (index + 1 = pin). */
export const GPIO_FUNCTIONS: readonly GpioFunction[] = [
  "blink-panel",
  "check-lights",
  "set-latch",
  "set-listen",
  "unset-latch",
  "clear",
  "last-caller",
  "ping",
];
/** `GpioFunction::from_pin`: 1..7 map in order, anything else is `ping`. */
export function gpioFunctionFromPin(pin: U32): GpioFunction {
  return pin >= 1 && pin <= 7 ? (GPIO_FUNCTIONS[pin - 1] ?? "ping") : "ping";
}
export function gpioPin(f: GpioFunction): U32 {
  return GPIO_FUNCTIONS.indexOf(f) + 1;
}
export function gpioLabel(f: GpioFunction): string {
  return f.replace("-", " ");
}

/** A GPIO command that rides a connection's trunk path. `POST /api/gpio` or inside a `Request`. */
export interface GpioCommand {
  /** Filled in by the runtime when sent with a request. */
  connection?: string;
  pin: U32;
  /** Closed (true) or open (false). */
  state: boolean;
  /** Derived from the pin when omitted. */
  function?: GpioFunction;
  note?: string;
}

/** A GPIO command as delivered: one line of `gpio.jsonl`; reply to `POST /api/gpio`. */
export interface GpioEvent {
  seq: U64;
  at: IsoTime;
  sim_time?: F64;
  connection: string;
  who: string;
  pin: U32;
  state: boolean;
  from_frame: string;
  to_frame: string;
  /** Frames the command passed through, endpoints included. */
  path: string[];
  trunks: string[];
  note?: string;
  function?: GpioFunction;
  /** Light states / last callers / latch state, depending on the function. Untyped in Rust. */
  result?: JsonValue;
}

/** Rename a user port. `POST /api/rename` → `RenameDispatch[]`. */
export interface Rename {
  frame: string;
  port: Usize;
  name: string;
  l6?: string;
  l8?: string;
  l16?: string;
}

/** One line of `TRUNK-USERS/labels.jsonl`: a name longer than a 6- or 8-char panel. */
export interface LabelEvent {
  seq: U64;
  at: IsoTime;
  frame: string;
  port: string;
  label: Label;
  /** "over6", "over8" or "over6,over8". */
  over: "over6" | "over8" | "over6,over8" | (string & {});
  connection?: string;
  origin: string;
}

/** A local sound device seen by the relay page. */
export interface SoundDevice {
  device_id: string;
  label: string;
  kind: "input" | "output" | (string & {});
}

/** Bind a local sound device to a relay port. `POST /api/relay/bind`. */
export interface RelayBinding {
  matrix: string;
  port: Usize;
  device_id: string;
  device_label: string;
  kind: string;
}

/** `POST /api/relay/event`, appended to `TRUNK-RELAY/events.jsonl`. */
export interface RelayEvent {
  /** `#[serde(default)]`. */
  seq: U64;
  /** `#[serde(default)]`. */
  at: IsoTime;
  kind: "over" | "device" | "bind" | "unbind" | (string & {});
  device_label: string;
  matrix?: string;
  port?: Usize;
  peak_dbfs?: F64;
  threshold_dbfs?: F64;
  note?: string;
}
export type RelayEventInput = PartialBy<RelayEvent, "seq" | "at">;

/** How a rename reaches one vendor's equipment (`vendor-policy.json`). */
export interface RenameTransport {
  /** "sdk", "snmp" or "native". */
  transport: "sdk" | "snmp" | "native" | (string & {});
  version?: string;
  community?: string;
  port?: U16;
  /** Host or host:port. Absent = build the PDU, log it, do not send. */
  target?: string;
  /** OID prefix; the user-port index is appended. */
  oid?: string;
  note?: string;
}

export interface VendorPolicy {
  renames: Record<string, RenameTransport>;
}
export function defaultVendorPolicy(): VendorPolicy {
  return {
    renames: {
      default: { transport: "sdk", note: "Rename is kept inside Trunk-Caster and shown in advertisements." },
      RTS: {
        transport: "snmp",
        version: "2c",
        community: "private",
        port: 161,
        oid: "1.3.6.1.4.1.99999.1.2.1.3",
        note:
          "RTS port label over SNMP SET (ODIN/ADAM). The RTS SNMP manual lists monitoring only: " +
          "confirm the writable port-name OID against the RTS MIB and set `target` to the frame's address.",
      },
    },
  };
}
/** `VendorPolicy::for_vendor`: exact key, else `default`. */
export function policyForVendor(p: VendorPolicy, vendor: string): RenameTransport | undefined {
  return Object.hasOwn(p.renames, vendor) ? p.renames[vendor] : p.renames["default"];
}

/** One rename as dispatched to one vendor: a line of `renames.jsonl`. */
export interface RenameDispatch {
  seq: U64;
  at: IsoTime;
  frame: string;
  port: string;
  old_name?: string;
  new_name: string;
  vendor: string;
  transport: string;
  detail: string;
  /** Encoded packet, hex. */
  payload_hex?: string;
  target?: string;
  sent: boolean;
  connection?: string;
}

/** When a frame last carried a connection. */
export interface LastActivity {
  at: IsoTime;
  unix: U64;
  sim_time: F64;
  who: string;
  connection: string;
}

export type RouteKind = "direct" | "via";
export const ROUTE_KINDS: readonly RouteKind[] = ["direct", "via"];

export interface Hop {
  trunk: string;
  from: string;
  to: string;
}

export interface Connection {
  id: string;
  who: string;
  from_frame: string;
  from_port: Usize;
  to_frame: string;
  to_port: Usize;
  kind: RouteKind;
  hops: Hop[];
  granted_at: IsoTime;
  /** `#[serde(default)]`. */
  granted_unix: U64;
  /** `#[serde(default)]`. */
  granted_sim: F64;
  why?: string;
  where?: string;
  /** "interface", "http" or "simulator". */
  origin: "interface" | "http" | "simulator" | (string & {});
  expires_at_sim?: F64;
  /** `#[serde(default)]`. */
  gpio_sent: U32;
  /** Per-hop gain dB, aligned with `hops`. `#[serde(default)]`. */
  hop_gains_db: F64[];
  /** Parked: connected but muted until the next sweep. `#[serde(default)]`. */
  muted: boolean;
  muted_at_sim?: F64;
  /** `#[serde(default)]`. */
  reconnects: U32;
  /** `#[serde(default)]`. */
  last_used_sim: F64;
  /** `#[serde(default)]`. */
  latched: boolean;
  /** `#[serde(default)]`. */
  listen: boolean;
}
/** Seconds of lease left: green while positive, red at or below zero. */
export function leaseLeft(c: Connection, simNow: F64, leaseSeconds: F64): F64 {
  return leaseSeconds - (simNow - c.last_used_sim);
}
/** Wall-clock seconds up (`saturating_sub`). */
export function connectedFor(c: Connection, nowUnix: U64): U64 {
  return Math.max(0, nowUnix - c.granted_unix);
}
export function connectedForSim(c: Connection, simNow: F64): F64 {
  return fmax(simNow - c.granted_sim, 0);
}
/** Intermediate frames, in order. */
export function viaFrames(c: Connection): string[] {
  return c.hops.slice(1).map((h) => h.from);
}

export type ReplyStatus = "granted" | "denied" | "released";
export const REPLY_STATUSES: readonly ReplyStatus[] = ["granted", "denied", "released"];

/** The runtime's answer: `<id>.reply.json` or the body of `/api/request` / `/api/release`. */
export interface Reply {
  wire_version: U32;
  id: string;
  status: ReplyStatus;
  connection?: Connection;
  reason?: string;
  replied_at: IsoTime;
}

/** A trunk link between two casters. */
export interface Trunk {
  id: string;
  a_frame: string;
  a_caster: Usize;
  b_frame: string;
  b_caster: Usize;
  capacity: Usize;
  connections: string[];
  created_at: IsoTime;
  /** `#[serde(default)]`. */
  gain_a_db: F64;
  /** `#[serde(default)]`. */
  gain_b_db: F64;
}
export function trunkUsed(t: Trunk): Usize {
  return t.connections.length;
}
export function trunkFree(t: Trunk): Usize {
  return Math.max(0, t.capacity - t.connections.length);
}
export function trunkJoins(t: Trunk, x: string, y: string): boolean {
  return (t.a_frame === x && t.b_frame === y) || (t.a_frame === y && t.b_frame === x);
}
export function trunkTouches(t: Trunk, f: string): boolean {
  return t.a_frame === f || t.b_frame === f;
}
export function trunkCasterOn(t: Trunk, frame: string): Usize | undefined {
  return t.a_frame === frame ? t.a_caster : t.b_frame === frame ? t.b_caster : undefined;
}
export function trunkPeerOf(t: Trunk, frame: string): string | undefined {
  return t.a_frame === frame ? t.b_frame : t.b_frame === frame ? t.a_frame : undefined;
}

/**
 * `POST /api/gain`: `trunk`+`end` for a caster, or `connection`+`hop` for one
 * hop of one call, or `frame`+`input`+`output` for one crosspoint inside a
 * frame (the TAPS and Mixes faders). `db` is absolute; 0 is unity.
 */
export interface GainSet {
  frame?: string;
  input?: string;
  output?: string;
  trunk?: string;
  end?: "a" | "b" | (string & {});
  connection?: string;
  hop?: Usize;
  db: F64;
  who?: string;
}

/** One line of `TRUNK-USAGE/gains.jsonl`. */
export interface GainEvent {
  seq: U64;
  at: IsoTime;
  set: GainSet;
  was_db: F64;
  /** Total gain along the affected call(s), by connection id. Always present (no skip). */
  path_gain_db: Record<string, F64>;
}

// ---------------------------------------------------------------------------
// TAPS and Mixes, voices, bandwidth (GET /api/taps, /api/voices, /api/bandwidth)
// ---------------------------------------------------------------------------

/**
 * One little fader: one closed crosspoint inside a frame, the thing coming
 * in on `input` crossed to `output`. Set it with `POST /api/gain`
 * `{frame, input, output, db}`.
 */
export interface TapFader {
  input: string;
  output: string;
  connection: string;
  /** `#[serde(default)]`. */
  who: string;
  /** -60..+20, 0 is unity. */
  db: F64;
}

/** One frame's strip on the mixer. */
export interface TapStrip {
  frame: string;
  site: string;
  protocol: string;
  /** `#[serde(default)]`. */
  vendor: string;
  /** The espeak-ng voice the frame speaks in (`voice.accentOf`). */
  accent: string;
  /** What the frame's voice puts on the wire right now, both cuts. */
  kbps: F64;
  faders: TapFader[];
}

/** `GET /api/taps`: the whole mixer. */
export interface Taps {
  frames: Usize;
  crosspoints: Usize;
  /** Crosspoints off unity. */
  trimmed: Usize;
  strips: TapStrip[];
}

/** `POST /api/taps/unity` `{frame?, who?}`: every crosspoint (of one frame, or of all) back to 0 dB. */
export interface TapsUnity {
  frame?: string;
  who?: string;
}

/** The reply to `POST /api/taps/unity`. */
export interface TapsUnityResult {
  reset: Usize;
}

/**
 * `GET /api/voices/<frame>`: one frame's voice.
 *
 * NOTE: the four `Option` fields here have NO `skip_serializing_if`, so
 * the runtime emits `null` (not absent) when there is nothing yet — an
 * exception to the rule in this file's header.
 */
export interface FrameVoice {
  frame: string;
  site: string;
  country: string;
  airport: string;
  accent: string;
  kbps: F64;
  /** Bytes heard from this frame since the caster started. */
  bytes: U64;
  /** The newest re-assembled recordings, and where to fetch their WAVs. */
  ident: Assembled | null;
  call: Assembled | null;
  ident_wav: string | null;
  call_wav: string | null;
}

/** `GET /api/voices`: everything heard so far. `link` is emitted as `null` when absent (no skip). */
export interface VoiceSummary {
  chunks_in: U64;
  bad_chunks: U64;
  recordings: U64;
  corrected_seconds: U64;
  lost_seconds: U64;
  /** Recordings still waiting for chunks. */
  waiting: Usize;
  kbps: F64;
  talking: Usize;
  by_protocol_kbps: Record<string, F64>;
  link: LinkStats | null;
  latest: Assembled[];
}

export interface ProtocolLoad {
  protocol: string;
  talking: Usize;
  kbps: F64;
  bytes: U64;
}

export interface FrameLoad {
  frame: string;
  protocol: string;
  calls: Usize;
  kbps: F64;
  bytes: U64;
}

/**
 * One trunk's share of the voice: every call it carries brings the voices
 * of both its ends (each frame's rate shared between its calls).
 */
export interface TrunkLoad {
  trunk: string;
  a_frame: string;
  b_frame: string;
  calls: Usize;
  capacity: Usize;
  kbps: F64;
  kbps_per_channel: F64;
}

/** `GET /api/bandwidth`: the bandwidth simulation. */
export interface Bandwidth {
  /** Seconds the rates average over. */
  window_s: U64;
  /** Voice on the wire into the caster, both cuts, kbit/s. */
  kbps: F64;
  /** The same voice summed over every trunk hop it rides. */
  carried_kbps: F64;
  talking: Usize;
  bytes: U64;
  by_protocol: ProtocolLoad[];
  /** Busiest first. */
  frames: FrameLoad[];
  /** Busiest first. */
  trunks: TrunkLoad[];
}

/** `GET /api/airports`: every site with its airport code and accent. */
export interface Airport {
  site: string;
  country: string;
  airport: string;
  /** The accent of the site (variant left out: each frame adds its own). */
  accent: string;
}

// ---------------------------------------------------------------------------
// TRUNK-USERS                                                  types.rs:770-814
// ---------------------------------------------------------------------------

export interface How {
  kind: RouteKind;
  hops: Hop[];
  via: string[];
}

export interface UserRecord {
  wire_version: U32;
  id: string;
  who: string;
  /** The frame (and panel port) being reached. */
  whom: string;
  from: string;
  when: IsoTime;
  why?: string;
  where?: string;
  how?: How;
  status: ReplyStatus;
  reason?: string;
  origin: string;
  released_at?: IsoTime;
  connected_seconds?: U64;
  connected_sim_seconds?: F64;
  /** `#[serde(default)]`. */
  gpio_sent: U32;
}

// ---------------------------------------------------------------------------
// TRUNK-CROSS POINTS                                           types.rs:816-920
// ---------------------------------------------------------------------------

/** A closed crosspoint inside one frame. Ports `U<nn>` (users) and `C<n>` (casters). */
export interface Crosspoint {
  frame: string;
  input: string;
  output: string;
  connection: string;
}

export type DeltaOp = "set" | "clear";
export const DELTA_OPS: readonly DeltaOp[] = ["set", "clear"];

/** One line of `deltas.jsonl`. `#[serde(flatten)] crosspoint` → intersection. */
export type CrosspointEvent = {
  seq: U64;
  at: IsoTime;
  sim_time?: F64;
  op: DeltaOp;
} & Crosspoint;

/** `/api/crosspoints/settings`. */
export interface CrosspointSettings {
  /** The delta log ends after this many events. */
  max_events: U64;
  /** Ward-Beck check-in period, wall seconds. `#[serde(default = 30.0)]`. */
  checkin_every_seconds: F64;
}
export type CrosspointSettingsInput = PartialBy<CrosspointSettings, "checkin_every_seconds">;
export function defaultCrosspointSettings(): CrosspointSettings {
  return { max_events: 1000, checkin_every_seconds: 30 };
}

/** Snapshot written to `crosspoints.json`. */
export interface CrosspointSnapshot {
  wire_version: U32;
  updated_at: IsoTime;
  settings: CrosspointSettings;
  events_logged: U64;
  /** True once `events_logged >= settings.max_events`. */
  log_ended: boolean;
  crosspoints: Crosspoint[];
}

/** Someone looking for a panel: `seeks/<id>.json` or `POST /api/panel-seek`. */
export interface PanelSeek {
  id?: string;
  who: string;
  from: string;
  panel_frame: string;
  panel_port?: Usize;
  why?: string;
}

/** One trunk route the seeker may take. */
export interface AllowedTrunk {
  kind: RouteKind;
  path: string[];
  /** Existing trunk ids reused along the path; `null` = new trunk needed. The ONLY place the SDK emits `null`. */
  trunks: (string | null)[];
  new_trunks_needed: Usize;
  free_channels: Usize;
}

export interface PanelOffer {
  wire_version: U32;
  seek: PanelSeek;
  seek_id: string;
  offered_at: IsoTime;
  allowed_trunks: AllowedTrunk[];
}

// ---------------------------------------------------------------------------
// TRUNK-SIMULATOR                                             types.rs:922-1428
// ---------------------------------------------------------------------------

/** A production: one studio, `trunks` trunks, `calls_per_minute` callers while on air. */
export interface Production {
  enabled: boolean;
  name: string;
  /** Frame id of the studio. Empty: the runtime picks a capital. `#[serde(default)]`. */
  studio: string;
  trunks: Usize;
  calls_per_minute: F64;
  mean_hold_seconds: F64;
  /** Studio local hour; -1 = all day. */
  start_hour: F64;
  end_hour: F64;
  /** A segment repeating inside the window: on air `for_minutes` from `at_minute` of every `every_minutes`; 0 = the whole window. `#[serde(default)]`. */
  every_minutes?: F64;
  at_minute?: F64;
  for_minutes?: F64;
}
export type ProductionInput = PartialBy<Production, "studio">;

/** Is the production on air at this local time of day (seconds)? */
export function productionOnAirAt(p: Production, localTodSecs: F64): boolean {
  if (!p.enabled) return false;
  const tod = remEuclid(localTodSecs, 86_400);
  if ((p.every_minutes ?? 0) > 0 && remEuclid(tod / 60 - (p.at_minute ?? 0), p.every_minutes!) >= (p.for_minutes ?? 0)) return false;
  if (p.start_hour < 0 || p.end_hour < 0) return true;
  const h = tod / 3600;
  return p.start_hour <= p.end_hour ? h >= p.start_hour && h < p.end_hour : h >= p.start_hour || h < p.end_hour;
}

export interface ProductionSample {
  offered: U64;
  answered: U64;
  busy: U64;
  live: Usize;
  trunks_used: Usize;
  trunks: Usize;
  on_air: boolean;
  studio: string;
}

export interface ProductionSummary {
  studio: string;
  trunks: Usize;
  offered: U64;
  answered: U64;
  busy: U64;
  peak_live: Usize;
  first_busy_sim?: F64;
}

/** The daily reset (UTC on the simulated clock). */
export interface Blackout {
  enabled: boolean;
  start_hour: F64;
  end_hour: F64;
}
export function defaultBlackout(): Blackout {
  return { enabled: true, start_hour: 11, end_hour: 12 };
}
export function blackoutActiveAt(b: Blackout, utcTodSecs: F64): boolean {
  if (!b.enabled) return false;
  const h = remEuclid(utcTodSecs, 86_400) / 3600;
  return b.start_hour <= b.end_hour ? h >= b.start_hour && h < b.end_hour : h >= b.start_hour || h < b.end_hour;
}

/** A newscast surge around a local hour. */
export interface Newscast {
  hour: F64;
  peak: F64;
}

/** The Olympics: once a day at `hour` UTC for `hours` hours, every site at once. */
export interface Olympics {
  enabled: boolean;
  hour: F64;
  hours: F64;
  peak: F64;
  /** `#[serde(default)]`. */
  venue: string;
  trunks: Usize;
  calls_per_minute: F64;
  mean_hold_seconds: F64;
}
export type OlympicsInput = PartialBy<Olympics, "venue">;
export function defaultOlympics(): Olympics {
  return { enabled: true, hour: 19, hours: 2, peak: 5, venue: "", trunks: 8, calls_per_minute: 3000, mean_hold_seconds: 120 };
}
function olympicsSince(o: Olympics, utcTodSecs: F64): F64 {
  const x = remEuclid(utcTodSecs / 3600 - o.hour, 24);
  return x > 12 ? x - 24 : x;
}
export function olympicsOnAirAt(o: Olympics, utcTodSecs: F64): boolean {
  const x = olympicsSince(o, utcTodSecs);
  return o.enabled && x >= 0 && x < o.hours;
}
/** Builds for half an hour, holds `peak` while on air, fades over half an hour. */
export function olympicsMultiplier(o: Olympics, utcTodSecs: F64): F64 {
  if (!o.enabled) return 1;
  const x = olympicsSince(o, utcTodSecs);
  if (x < -0.5 || x > o.hours + 0.5) return 1;
  if (x < 0) return 1 + (o.peak - 1) * ((x + 0.5) / 0.5);
  if (x <= o.hours) return o.peak;
  return 1 + (o.peak - 1) * (1 - (x - o.hours) / 0.5);
}

/** The news cycle multipliers. */
export interface DaySchedule {
  enabled: boolean;
  /** Simulated UTC hour at sim_time 0; negative = wall clock at boot. */
  start_hour: F64;
  hourly_news: F64;
  radio_prep: F64;
  /** `#[serde(default = default_newscasts)]`. */
  newscasts: Newscast[];
  overnight: F64;
  /** `#[serde(default)]`. */
  blackout: Blackout;
  /** `#[serde(default)]`. */
  olympics: Olympics;
}
export type DayScheduleInput = PartialBy<DaySchedule, "newscasts" | "blackout" | "olympics">;
export function defaultNewscasts(): Newscast[] {
  return [
    { hour: 6, peak: 4 },
    { hour: 12, peak: 4 },
    { hour: 18, peak: 6 },
  ];
}
export function defaultDaySchedule(): DaySchedule {
  return {
    enabled: true,
    start_hour: -1,
    hourly_news: 3,
    radio_prep: 2,
    newscasts: defaultNewscasts(),
    overnight: 0.3,
    blackout: defaultBlackout(),
    olympics: defaultOlympics(),
  };
}

/** Load multiplier at a local time of day (seconds since midnight). */
export function dayMultiplier(d: DaySchedule, todSecs: F64): F64 {
  if (!d.enabled) return 1;
  const tod = remEuclid(todSecs, 86_400);
  const hour = tod / 3600;
  const minute = (tod % 3600) / 60;
  let m = 1;
  if (hour < 5) m *= d.overnight;
  const distToHour = Math.min(minute, 60 - minute);
  if (minute >= 55) m = fmax(m, 1 + (d.hourly_news - 1) * ((minute - 55) / 5));
  else if (minute <= 10) m = fmax(m, 1 + (d.hourly_news - 1) * (1 - minute / 10));
  const distToHalf = Math.abs(minute - 30);
  for (const dd of [distToHour, distToHalf]) {
    if (dd <= 5) m = fmax(m, 1 + (d.radio_prep - 1) * (1 - dd / 5));
  }
  for (const n of d.newscasts) {
    let x = hour - n.hour;
    if (x > 12) x -= 24;
    else if (x < -12) x += 24;
    let v: number;
    if (!(x >= -1 && x <= 1)) v = 1;
    else if (x < -0.25) v = 1 + (n.peak - 1) * ((x + 1) / 0.75);
    else if (x <= 0.5) v = n.peak;
    else v = 1 + (n.peak - 1) * (1 - (x - 0.5) / 0.5);
    m = fmax(m, v);
  }
  return m;
}
/** Solar local time of day at a longitude: one hour per 15°, no DST. */
export function localTod(utcTodSecs: F64, lon: F64): F64 {
  return remEuclid(utcTodSecs + (lon / 15) * 3600, 86_400);
}
/** TV and radio by the site's own clock, the Olympics by UTC. */
export function dayMultiplierAt(d: DaySchedule, utcTodSecs: F64, lon: F64): F64 {
  const m = dayMultiplier(d, localTod(utcTodSecs, lon));
  return d.enabled ? fmax(m, olympicsMultiplier(d.olympics, utcTodSecs)) : m;
}
export function biggestPeak(d: DaySchedule): F64 {
  let p = d.newscasts.reduce((a, n) => fmax(a, n.peak), 1);
  p = fmax(p, d.hourly_news);
  p = fmax(p, d.radio_prep);
  return fmax(p, d.olympics.enabled ? d.olympics.peak : 1);
}

/** The fader: `fader.json` or `POST /api/fader`; re-read every tick. */
export interface Fader {
  /** Simulated seconds per wall second. 0 pauses. */
  speed: F64;
  requests_per_minute: F64;
  mean_hold_seconds: F64;
  crosscheck_every_seconds: F64;
  sample_every_seconds: F64;
  running: boolean;
  /** RNG seed. u64: values above 2^53 are NOT round-trippable through JS. */
  seed: U64;
  /** `#[serde(default)]`. */
  day: DaySchedule;
  /** `#[serde(default = 60.0)]`. */
  round_robin_seconds: F64;
  /** `#[serde(default = 900.0)]`. */
  lease_seconds: F64;
  /** `#[serde(default)]`; empty when set by hand. */
  preset: string;
  /** `#[serde(default)]`. */
  productions: Production[];
  /** `#[serde(default = 12.0)]`. */
  bookings_per_hour: F64;
  /** `#[serde(default = 100.0)]`. */
  in_building_calls_per_hour: F64;
}
export type FaderInput = PartialBy<
  Fader,
  "day" | "round_robin_seconds" | "lease_seconds" | "preset" | "productions" | "bookings_per_hour" | "in_building_calls_per_hour"
>;
export function defaultFader(): Fader {
  return {
    speed: 1,
    requests_per_minute: 30,
    mean_hold_seconds: 600,
    crosscheck_every_seconds: 5,
    sample_every_seconds: 5,
    running: true,
    seed: 7,
    day: defaultDaySchedule(),
    round_robin_seconds: 60,
    lease_seconds: 900,
    preset: "",
    productions: [],
    bookings_per_hour: 12,
    in_building_calls_per_hour: 100,
  };
}
/** Apply serde defaults to a partial fader, as `serde_json::from_str::<Fader>` would. */
export function faderWithDefaults(f: FaderInput): Fader {
  const d = defaultFader();
  return {
    ...f,
    day: f.day ?? d.day,
    round_robin_seconds: f.round_robin_seconds ?? d.round_robin_seconds,
    lease_seconds: f.lease_seconds ?? d.lease_seconds,
    preset: f.preset ?? "",
    productions: f.productions ?? [],
    bookings_per_hour: f.bookings_per_hour ?? d.bookings_per_hour,
    in_building_calls_per_hour: f.in_building_calls_per_hour ?? d.in_building_calls_per_hour,
  };
}

/** An event preset: a complete fader and the one major event of its day. */
export interface Preset {
  id: string;
  name: string;
  blurb: string;
  fader: Fader;
  /** Hour the major event starts (local at the first studio / anchor zone, or UTC when `surge_utc`). */
  surge_hour: F64;
  /** `#[serde(default)]`. */
  surge_utc: boolean;
  lead_hours: F64;
}
/** UTC hour to start the clock at, given the event's local offset (hours). */
export function presetStartUtcHour(p: Preset, localOffsetHours: F64): F64 {
  const off = p.surge_utc ? 0 : localOffsetHours;
  return remEuclid(p.surge_hour - p.lead_hours - off, 24);
}

/** `presets(base)`: the event presets, one major event per day each. */
export function presets(base: Fader): Preset[] {
  const day = (hourly: F64, radio: F64, casts: [F64, F64][], overnight: F64, blackout: boolean): DaySchedule => ({
    enabled: true,
    start_hour: -1,
    hourly_news: hourly,
    radio_prep: radio,
    newscasts: casts.map(([hour, peak]) => ({ hour, peak })),
    overnight,
    blackout: { ...base.day.blackout, enabled: blackout },
    // A preset is its own one major event: no Olympics on top.
    olympics: { ...base.day.olympics, enabled: false },
  });
  const prod = (name: string, trunks: Usize, cpm: F64, hold: F64, start: F64, end: F64): Production => ({
    enabled: true,
    name,
    studio: "",
    trunks,
    calls_per_minute: cpm,
    mean_hold_seconds: hold,
    start_hour: start,
    end_hour: end,
  });
  type Surge = [F64, F64, boolean];
  const f = (
    id: string,
    name: string,
    blurb: string,
    speed: F64,
    rpm: F64,
    hold: F64,
    [surge_hour, lead_hours, surge_utc]: Surge,
    d: DaySchedule,
    productions: Production[],
  ): Preset => ({
    id,
    name,
    blurb,
    fader: {
      speed,
      requests_per_minute: rpm,
      mean_hold_seconds: hold,
      crosscheck_every_seconds: base.crosscheck_every_seconds,
      sample_every_seconds: base.sample_every_seconds,
      running: true,
      seed: base.seed,
      day: d,
      round_robin_seconds: base.round_robin_seconds,
      lease_seconds: base.lease_seconds,
      preset: id,
      productions,
      bookings_per_hour: base.bookings_per_hour,
      in_building_calls_per_hour: base.in_building_calls_per_hour,
    },
    surge_hour,
    surge_utc,
    lead_hours,
  });
  const local = (h: F64, lead: F64): Surge => [h, lead, false];
  const routine = (): DaySchedule => day(3, 2, [], 0.3, true);
  return [
    f("broadcast-day", "Broadcast day", "The news cycle as it is: hourly rushes, radio prep, quiet overnight, and the one big newscast at 18:00 local. Starts at 17:00.", 120, 6000, 120, local(18, 1), day(3, 2, [[18, 6]], 0.3, true), []),
    f("quiet-night", "Quiet night", "Overnight: a trickle of calls, long holds, nothing scheduled. Starts at 01:00 local. Watch parked lines and leases.", 60, 600, 400, local(1, 0), day(1.5, 1.2, [], 0.3, true), []),
    f("morning-drive", "Morning drive", "Every station on the air at once, short calls, the 06:00 newscast on top. Starts at 05:00 local.", 120, 7000, 90, local(6, 1), day(4, 3, [[6, 6]], 0.3, true), []),
    f("breaking-news", "Breaking news", "The story breaks at 16:00 local: hourly rushes at ×8, the newscast at ×10, callers everywhere. Starts at 15:00.", 120, 9000, 100, local(16, 1), day(8, 3, [[16, 10]], 0.6, true), []),
    f("phone-in", "Phone-in show", "One studio, 8 trunks made available, 2000 callers a minute from 09:00 to 12:00 local. Starts at 08:45. Most of them hear busy.", 120, 3000, 120, local(9, 0.25), routine(), [prod("Phone-in", 8, 2000, 90, 9, 12)]),
    f("election-night", "Election night", "The results desk: 8 trunks, 3000 callers a minute from 18:00 local until 02:00, the 18:00 results newscast at ×8. Starts at 17:00.", 120, 6000, 150, local(18, 1), day(6, 2, [[18, 8]], 0.8, true), [prod("Results desk", 8, 3000, 150, 18, 2)]),
    f("telethon", "Telethon", "Two studios, 8 trunks each, 4000 callers a minute into each from 09:00 to 21:00 local. Starts at 08:45. The trunks are the bottleneck.", 120, 3000, 120, local(9, 0.25), routine(), [prod("Telethon A", 8, 4000, 180, 9, 21), prod("Telethon B", 8, 4000, 180, 9, 21)]),
    f("world-cup-final", "World Cup final", "Three studios on three continents, 8 trunks each, 5000 callers a minute into each for the two hours of the match, 15:00 to 17:00 local, the final whistle newscast at ×10. Starts at 14:45.", 120, 8000, 120, local(15, 0.25), day(5, 2, [[17, 10]], 0.6, true), [prod("Stadium desk", 8, 5000, 120, 15, 17), prod("Studio two", 8, 5000, 120, 15, 17), prod("Studio three", 8, 5000, 120, 15, 17)]),
    f("daily-reset", "Daily reset drill", "Starts at 10:55 UTC: five minutes later everything disconnects, at 12:00 it all comes back. Watch the reconnect wave.", 60, 6000, 120, [11, 5 / 60, true], routine(), []),
    f("flat-load", "Flat load", "No news cycle: a steady 3000 requests a minute from 12:00 local. The control group.", 120, 3000, 120, local(12, 0), { ...routine(), enabled: false }, []),
    f("stress", "Stress test", "20000 requests a minute, one-minute holds, four times faster, from 12:00 local. Find the ceiling.", 240, 20000, 60, local(12, 0), { ...routine(), enabled: false }, []),
  ];
}

/** One point on the usage graph. */
export interface Sample {
  sim_time: F64;
  wall_time: IsoTime;
  active: Usize;
  active_via: Usize;
  trunks: Usize;
  granted_total: U64;
  granted_via_total: U64;
  denied_total: U64;
  released_total: U64;
  channel_utilization: F64;
  caster_utilization: F64;
  crosschecks_ok: U64;
  crosschecks_failed: U64;
  /** Seconds since midnight. `#[serde(default)]`. */
  time_of_day: F64;
  /** `#[serde(default = 1.0)]` (but `Sample::default()` gives 0.0 — see HANDOFF). */
  load_multiplier: F64;
  /** `#[serde(default)]`. */
  muted: Usize;
  /** `#[serde(default)]`. */
  blackout: boolean;
  /** Live calls per continent; omitted when empty. */
  continents?: Record<string, Usize>;
  /** By production name; omitted when empty. */
  productions?: Record<string, ProductionSample>;
}

export interface Timeline {
  wire_version: U32;
  samples: Sample[];
}

// ---------------------------------------------------------------------------
// TRUNK-RELAY                                                types.rs:1430-1545
// ---------------------------------------------------------------------------

export interface RelayMatrix {
  id: string;
  label: string;
  io: Usize;
  casters: Usize;
  /** Keyed `U<nn>`. `#[serde(default)]`, always emitted (no skip). */
  port_names: Record<string, string>;
  /** Keyed `U<nn>`. `#[serde(default)]`, always emitted. */
  bindings: Record<string, RelayBinding>;
}

/** `TRUNK-RELAY/relay.json`. */
export interface RelayConfig {
  host: string;
  /** `#[serde(default = "Local Sound Card Relay")]`. */
  protocol_name: string;
  matrices: RelayMatrix[];
  /** `#[serde(default = -6.0)]`. */
  over_threshold_dbfs: F64;
}
export type RelayConfigInput = PartialBy<RelayConfig, "protocol_name" | "over_threshold_dbfs">;

/**
 * `RelayConfig::default()`. Rust reads COMPUTERNAME/HOSTNAME and
 * USERNAME/USER from the environment; pass them in so this stays pure.
 */
export function defaultRelayConfig(host = "this-computer", user = "local"): RelayConfig {
  const m = (id: string, label: string, io: Usize, casters: Usize): RelayMatrix => ({ id, label, io, casters, port_names: {}, bindings: {} });
  const me = m("relay-2x2", user, 2, 2);
  me.port_names["U00"] = `${user} mic`;
  me.port_names["U01"] = `${user} speakers`;
  return {
    host,
    protocol_name: "Local Sound Card Relay",
    matrices: [m("relay-a", "Relay 8x8 A", 8, 8), m("relay-b", "Relay 8x8 B", 8, 8), me],
    over_threshold_dbfs: -6,
  };
}

export interface RelayPort {
  port: string;
  name?: string;
  live_who?: string;
  /** Far end as `frame:U<nn>`. */
  connected_to?: string;
  connection?: string;
  connected_seconds?: U64;
  binding?: RelayBinding;
}

export interface RelayMatrixState {
  id: string;
  label: string;
  io: Usize;
  casters: Usize;
  ports: RelayPort[];
  caster_status: CasterAd[];
  crosspoints: Crosspoint[];
}

/** `TRUNK-RELAY/state.json`. */
export interface RelaySnapshot {
  wire_version: U32;
  host: string;
  updated_at: IsoTime;
  matrices: RelayMatrixState[];
}

// ---------------------------------------------------------------------------
// Remote frames on the Ward-Beck port                        types.rs:1547-1578
// ---------------------------------------------------------------------------

export interface RemoteFrame {
  frame: string;
  peer: string;
  connected_at: IsoTime;
  last_seen: IsoTime;
  last_checkin?: IsoTime;
  /** `#[serde(default)]`. */
  reported_closed: Usize;
  /** `#[serde(default)]`. */
  lines_sent: U64;
  /** `#[serde(default)]`. */
  acks: U64;
  /** `#[serde(default)]`. */
  checkins: U64;
  /** Lines acknowledged over MQTT (applied only once both transports agreed). `#[serde(default)]`. */
  mqtt_acks: U64;
  /** Lines rejected because only one transport delivered them. `#[serde(default)]`. */
  rejects: U64;
  connected: boolean;
  /** Container name (`sim-dante`) or machine name, from `@host` in the check-in. */
  host?: string;
}

// ---------------------------------------------------------------------------
// TRUNK-GLOBAL                                               types.rs:1580-1675
// ---------------------------------------------------------------------------

/** A world clock in the footer. Fixed offsets; Saskatchewan is the anchor. */
export interface Zone {
  name: string;
  offset_hours: F64;
  /** `#[serde(default)]`. */
  anchor: boolean;
}

/** "globe", "map" or "both" (the default is "both"). */
export type Projection = "globe" | "map" | "both" | (string & {});

/** `TRUNK-GLOBAL/globe.json`. */
export interface GlobeConfig {
  rotate_deg_per_s: F64;
  tilt_deg: F64;
  show_capitals: boolean;
  show_provinces: boolean;
  show_cities: boolean;
  graticule_deg: F64;
  /** `#[serde(default = "both")]`. */
  projection: Projection;
  /** `#[serde(default = 1.0)]`. */
  zoom: F64;
  /** `#[serde(default = default_zones)]`. */
  zones: Zone[];
}
export type GlobeConfigInput = PartialBy<GlobeConfig, "projection" | "zoom" | "zones">;
export function defaultZones(): Zone[] {
  const z = (name: string, offset_hours: F64, anchor: boolean): Zone => ({ name, offset_hours, anchor });
  return [
    z("Los Angeles", -8, false),
    z("Saskatchewan", -6, true),
    z("New York", -5, false),
    z("London", 0, false),
    z("Paris", 1, false),
    z("Kyiv", 2, false),
    z("Riyadh", 3, false),
    z("Dubai", 4, false),
    z("New Delhi", 5.5, false),
    z("Tokyo", 9, false),
    z("Sydney", 10, false),
  ];
}
export function defaultGlobeConfig(): GlobeConfig {
  return {
    rotate_deg_per_s: 2.5,
    tilt_deg: -18,
    show_capitals: true,
    show_provinces: true,
    show_cities: true,
    graticule_deg: 30,
    projection: "both",
    zoom: 1,
    zones: defaultZones(),
  };
}
/** The anchor zone, else Saskatchewan. */
export function globeAnchor(g: GlobeConfig): Zone {
  const a = g.zones.find((z) => z.anchor);
  return a ? { ...a } : { name: "Saskatchewan", offset_hours: -6, anchor: true };
}

/** Kinds logged to `preferences.jsonl`. Free-form `String` in Rust. */
export type PreferenceKind =
  | "fader"
  | "fader-quick"
  | "clock"
  | "gain"
  | "rename"
  | "relay-bind"
  | "relay-unbind"
  | "crosspoint-settings"
  | "crosspoint-reset"
  | "globe"
  | (string & {});

/** One line of `TRUNK-GLOBAL/preferences.jsonl`. */
export interface Preference {
  seq: U64;
  at: IsoTime;
  kind: PreferenceKind;
  who?: string;
  value: JsonValue;
}

// ---------------------------------------------------------------------------
// Simulation recorder, phone book, capture, status          types.rs:1677-1834
// ---------------------------------------------------------------------------

export interface RunSummary {
  samples: Usize;
  duration_sim_seconds: F64;
  granted: U64;
  granted_via: U64;
  denied: U64;
  released: U64;
  peak_live: Usize;
  avg_live: F64;
  peak_muted: Usize;
  avg_channel_utilization: F64;
  max_channel_utilization: F64;
  avg_caster_utilization: F64;
  crosschecks_failed: U64;
  blackout_samples: Usize;
  /** By production name; omitted when empty. */
  productions?: Record<string, ProductionSummary>;
}

/** `TRUNK-SIMULATOR/runs/<id>.json`. */
export interface SimRun {
  wire_version: U32;
  id: string;
  started_at: IsoTime;
  started_sim: F64;
  ended_at?: IsoTime;
  ended_sim?: F64;
  /** "boot", "fader", "clock", "blackout-end". */
  reason: "boot" | "fader" | "clock" | "blackout-end" | (string & {});
  fader: Fader;
  frames: Usize;
  sites: Usize;
  summary: RunSummary;
  /** `#[serde(default)]`. */
  samples: Sample[];
}

/** One person in the phone book. */
export interface PhoneBookEntry {
  who: string;
  label: Label;
  /** `frame:Unn`. */
  panels: string[];
  sites: string[];
  calls: Usize;
  live_now: Usize;
  last_seen?: IsoTime;
  last_called?: string;
  badge?: Badge;
}

/** One check-in window of a capture. */
export interface Bucket {
  start_sim: F64;
  /** "HH:MM" UTC on the simulated day. */
  clock: string;
  samples: Usize;
  avg_live: F64;
  peak_live: Usize;
  avg_muted: F64;
  granted: U64;
  denied: U64;
  released: U64;
  avg_channel_utilization: F64;
  max_channel_utilization: F64;
  avg_load: F64;
  blackout: boolean;
  crosschecks_failed: U64;
}

export interface CaptureBuckets {
  hour: Bucket[];
  half_hour: Bucket[];
  quarter_hour: Bucket[];
}

/** `TRUNK-SIMULATOR/captures/<id>.json`. */
export interface Capture {
  wire_version: U32;
  id: string;
  note: string;
  started_at: IsoTime;
  started_sim: F64;
  started_clock: string;
  ended_at?: IsoTime;
  ended_sim?: F64;
  fader: Fader;
  frames: Usize;
  sites: Usize;
  summary: RunSummary;
  /** `#[serde(default)]`. */
  buckets: CaptureBuckets;
  /** `#[serde(default)]`. */
  samples: Sample[];
}

/** `GET /api/status`. */
export interface Status {
  wire_version: U32;
  root: PathString;
  endpoint: string;
  shape: Shape;
  protocols: Usize;
  frames: Usize;
  trunks: Usize;
  connections: Usize;
  sim_time: F64;
  fader: Fader;
  updated_at: IsoTime;
  /** `#[serde(default)]`. */
  remote_frames: Usize;
  /** `#[serde(default)]`. */
  remotes_connected: Usize;
  wb_endpoint?: string;
  /** `#[serde(default)]`. */
  sites: Usize;
  /** `#[serde(default)]`. */
  clock: string;
  /** `#[serde(default)]`. */
  blackout: boolean;
  /** `#[serde(default)]`. */
  muted: Usize;
  /** Id of the capture in progress. */
  capturing?: string;
  /** The MQTT transport running in parallel with the Ward-Beck port (mqtt.rs). */
  mqtt?: LinkStats;
}

// ---------------------------------------------------------------------------
// Convenience constructors (client.rs:256-275)
// ---------------------------------------------------------------------------

/** `client::request`: a bare request. */
export function makeRequest(who: string, from: string, to: string): Request {
  return { who, from, to };
}

/** `client::reply`, with the wire version filled in. */
export function makeReply(id: string, status: ReplyStatus, connection: Connection | undefined, reason: string | undefined, now: IsoTime): Reply {
  const r: Reply = { wire_version: WIRE_VERSION, id, status, replied_at: now };
  if (connection !== undefined) r.connection = connection;
  if (reason !== undefined) r.reason = reason;
  return r;
}

/** Error body every runtime handler uses on 4xx: `{"error": "..."}` (http.rs:114). */
export interface ApiError {
  error: string;
}
