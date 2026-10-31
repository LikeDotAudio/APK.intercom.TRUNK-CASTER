// One validator per config file and per JSONL line shape. Shape checks
// reproduce what serde accepts; `refine` adds the semantic rules the Rust
// code assumes but never checks (unique slugs, one anchor zone, port
// names inside `io`, 56 capitals, ...).

import {
  arr, bool, duplicates, err, int, json, num, obj, oneOf, opt, pattern, record, refine, str, warn,
  type Check,
} from "./check.ts";
import {
  GPIO_FUNCTIONS, PREFERENCE_KINDS, PROJECTIONS, RENAME_TRANSPORTS, TIERS,
  type Blackout, type ConnectGuide, type CrosspointEvent, type CrosspointSettings, type DaySchedule,
  type EmulatorVendor, type Emulators, type Fader, type GainEvent, type GainSet, type GlobeConfig,
  type GpioEvent, type Label, type LabelEvent, type Newscast, type Olympics, type Preference,
  type Production, type RelayBinding, type RelayConfig, type RelayEvent, type RelayMatrix,
  type RenameDispatch, type RenameTransport, type Site, type Sites, type VendorPolicy, type Zone,
} from "./types.ts";

const hour = (): Check<number> => num({ min: 0, max: 24 });
/** Frame ids: `<slug>-<nn>` (london-01, ivc-32-07) or a relay matrix id (relay-a, relay-2x2). */
export const FRAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const at = (): Check<string> => pattern(ISO_AT, "an ISO-8601 UTC time (YYYY-MM-DDTHH:MM:SSZ)");
/** Ports as the logs write them: U<nn> user ports, C<n> casters. */
const PORT = /^(?:U\d{2,}|C\d+)$/;

/** sites.rs:146-154 */
export function slugify(name: string): string {
  return name
    .split("")
    .map((ch) => (/^[A-Za-z0-9]$/.test(ch) ? ch.toLowerCase() : "-"))
    .join("")
    .split("-")
    .filter((p) => p !== "")
    .join("-");
}

export const TIER_DEFAULT_FRAMES: Readonly<Record<string, number>> = { capital: 10, province: 1, city: 2 };

// ---------------------------------------------------------------------------
// sites.json
// ---------------------------------------------------------------------------

export const site: Check<Site> = refine(
  obj<Site>({
    name: str(),
    slug: str(),
    country: str(),
    continent: opt(str()),
    tier: oneOf(TIERS),
    lat: num({ min: -90, max: 90 }),
    lon: num({ min: -180, max: 180 }),
    frames: opt(int({ softMax: 99 })),
  }),
  (s, p, c) => {
    if (s.slug === "") warn(c, `${p}.slug`, `empty: Sites::normalize fills "${slugify(s.name)}"`);
    else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.slug)) err(c, `${p}.slug`, `"${s.slug}" is not lower-case-kebab; frame ids become "${s.slug}-01"`);
    // sites.rs:146 slugify maps every non-ASCII char to '-': Brasília -> bras-lia, Bogotá -> bogot.
    if (/[^\x00-\x7f]/.test(s.name) && s.slug === slugify(s.name)) {
      const ascii = slugify(s.name.normalize("NFD").replace(/[̀-ͯ]/g, ""));
      if (ascii !== s.slug) warn(c, `${p}.slug`, `"${s.slug}" is the ASCII-only slugify of "${s.name}"; accent-folded would be "${ascii}" (frame ids are already on disk, so renaming is a migration)`);
    }
    if ((s.frames ?? 0) > 99) err(c, `${p}.frames`, "frame ids are <slug>-<nn>: more than 99 frames breaks the 2-digit suffix");
  },
);

export const sites: Check<Sites> = refine(obj<Sites>({ sites: arr(site) }), (v, p, c) => {
  for (const d of duplicates(v.sites, (s) => s.slug)) err(c, "sites", `duplicate slug "${d}": two sites would share frame ids`);
  for (const d of duplicates(v.sites, (s) => s.name)) warn(c, "sites", `duplicate name "${d}"`);
  if (v.sites.length === 0) err(c, "sites", "no sites: the fleet would be empty");
});

export function siteFrameIds(s: Sites): Set<string> {
  const ids = new Set<string>();
  for (const x of s.sites) {
    const n = x.frames && x.frames > 0 ? x.frames : (TIER_DEFAULT_FRAMES[x.tier] ?? 1);
    const slug = x.slug || slugify(x.name);
    for (let k = 1; k <= n; k++) ids.add(`${slug}-${String(k).padStart(2, "0")}`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// globe.json
// ---------------------------------------------------------------------------

export const zone: Check<Zone> = obj<Zone>({
  name: str(),
  offset_hours: num({ min: -12, max: 14 }),
  anchor: opt(bool(), false),
});

export const globe: Check<GlobeConfig> = refine(
  obj<GlobeConfig>({
    rotate_deg_per_s: num({ softMin: -90, softMax: 90 }),
    // keydown clamps tilt to [-85, 85] (GLOBE_JS keydown handler in html.rs)
    tilt_deg: num({ softMin: -85, softMax: 85 }),
    show_capitals: bool(),
    show_provinces: bool(),
    show_cities: bool(),
    graticule_deg: num({ min: 0, softMax: 90 }),
    projection: opt(oneOf(PROJECTIONS, "warn"), false),
    // keyboard zoom clamps to [0.6, 8] (GLOBE_JS keydown handler in html.rs)
    zoom: opt(num({ min: 0, softMin: 0.6, softMax: 8 }), false),
    zones: opt(arr(zone), false),
  }),
  (g, p, c) => {
    if (g.graticule_deg < 10) warn(c, "graticule_deg", `${g.graticule_deg} is drawn as 10: GLOBE_JS clamps step = max(10, graticule_deg || 30)`);
    const zones = g.zones ?? [];
    const anchors = zones.filter((z) => z.anchor === true).length;
    if (g.zones && anchors === 0) warn(c, "zones", "no anchor zone: GlobeConfig::anchor falls back to Saskatchewan (types.rs:1640)");
    if (anchors > 1) warn(c, "zones", `${anchors} anchor zones: only the first is used`);
    for (const d of duplicates(zones, (z) => z.name)) warn(c, "zones", `duplicate zone "${d}"`);
    void p;
  },
);

// ---------------------------------------------------------------------------
// fader.json
// ---------------------------------------------------------------------------

const newscast: Check<Newscast> = obj<Newscast>({ hour: hour(), peak: num({ min: 0 }) });
const blackout: Check<Blackout> = obj<Blackout>({ enabled: bool(), start_hour: hour(), end_hour: hour() });
const frameRef = (): Check<string> =>
  pattern(/^$|^[a-z0-9]+(?:-[a-z0-9]+)*-\d{2}$/, "a frame id like london-01 (or empty)");

const olympics: Check<Olympics> = obj<Olympics>({
  enabled: bool(),
  hour: hour(),
  hours: num({ min: 0, max: 24 }),
  peak: num({ min: 0 }),
  venue: opt(frameRef(), false),
  trunks: int(),
  calls_per_minute: num({ min: 0 }),
  mean_hold_seconds: num({ min: 0 }),
});

const day: Check<DaySchedule> = obj<DaySchedule>({
  enabled: bool(),
  start_hour: num({ max: 24 }),
  hourly_news: num({ min: 0 }),
  radio_prep: num({ min: 0 }),
  newscasts: opt(arr(newscast), false),
  overnight: num({ min: 0 }),
  blackout: opt(blackout, false),
  olympics: opt(olympics, false),
});

const production: Check<Production> = refine(
  obj<Production>({
    enabled: bool(),
    name: str(),
    studio: opt(frameRef(), false),
    trunks: int(),
    calls_per_minute: num({ min: 0 }),
    mean_hold_seconds: num({ min: 0 }),
    start_hour: num({ min: -1, max: 24 }),
    end_hour: num({ min: -1, max: 24 }),
  }),
  (x, p, c) => {
    if (x.enabled && x.trunks === 0) warn(c, `${p}.trunks`, "0 trunks: every caller is denied");
  },
);

export const fader: Check<Fader> = refine(
  obj<Fader>({
    speed: num({ min: 0, softMax: 10_000 }),
    requests_per_minute: num({ min: 0 }),
    mean_hold_seconds: num({ min: 0 }),
    crosscheck_every_seconds: num({ min: 0 }),
    sample_every_seconds: num({ min: 0 }),
    running: bool(),
    seed: int(),
    day: opt(day, false),
    round_robin_seconds: opt(num({ min: 0 }), false),
    lease_seconds: opt(num({ min: 0 }), false),
    preset: opt(str(), false),
    productions: opt(arr(production), false),
    bookings_per_hour: opt(num({ min: 0 }), false),
    in_building_calls_per_hour: opt(num({ min: 0 }), false),
  }),
  (f, _p, c) => {
    if (f.sample_every_seconds === 0) warn(c, "sample_every_seconds", "0: a timeline sample every tick");
    if (f.mean_hold_seconds === 0) warn(c, "mean_hold_seconds", "0: calls end the instant they start");
    for (const d of duplicates(f.productions ?? [], (x) => x.name)) warn(c, "productions", `duplicate production "${d}"`);
  },
);

// ---------------------------------------------------------------------------
// emulators.json
// ---------------------------------------------------------------------------

const port16 = (): Check<number> => int({ min: 1, max: 65535 });

const emulatorVendor: Check<EmulatorVendor> = obj<EmulatorVendor>({
  vendor: str(),
  emulator: str(),
  base_port: port16(),
  map_port: port16(),
  capitals: arr(pattern(/^[A-Z]{4}$/, "a four-letter capital code")),
  region: opt(str(), false),
});

/** Ports the comment in emulators.json says are taken by other local services. */
export const RESERVED_LOCAL_PORTS = [8080, 8081] as const;

export const emulators: Check<Emulators> = refine(
  obj<Emulators>({
    _comment: opt(str(), false),
    combined_map_port: opt(port16(), false),
    stand_in: opt(str(), false),
    chaos: opt(num({ min: 0, max: 1 }), false),
    vendors: arr(emulatorVendor),
  }),
  (e, _p, c) => {
    const caps = e.vendors.flatMap((v) => v.capitals);
    for (const d of duplicates(caps, (x) => x)) err(c, "vendors", `capital ${d} is assigned to two emulators`);
    if (caps.length !== 56) warn(c, "vendors", `${caps.length} capitals; the plan is 56`);
    const ports = e.vendors.flatMap((v) => [v.map_port]).concat(e.combined_map_port ?? []);
    for (const d of duplicates(ports, (x) => String(x))) err(c, "vendors", `map port ${d} used twice`);
    for (const port of ports) {
      if ((RESERVED_LOCAL_PORTS as readonly number[]).includes(port)) err(c, "vendors", `map port ${port} collides with a service the _comment reserves`);
    }
    for (const d of duplicates(e.vendors, (v) => v.vendor.toLowerCase())) err(c, "vendors", `vendor ${d} listed twice`);
    if (e.stand_in && !e.vendors.some((v) => v.vendor.toLowerCase() === e.stand_in?.toLowerCase())) {
      err(c, "stand_in", `"${e.stand_in}" is not a listed vendor: launch_all.py would have no stand-in script`);
    }
    // base_port blocks: each emulator uses base_port + 256*k? Only overlap of equal bases is certain.
    for (const d of duplicates(e.vendors, (v) => String(v.base_port))) err(c, "vendors", `base_port ${d} used twice`);
  },
);

// ---------------------------------------------------------------------------
// vendor-policy.json
// ---------------------------------------------------------------------------

const renameTransport: Check<RenameTransport> = refine(
  obj<RenameTransport>({
    transport: oneOf(RENAME_TRANSPORTS, "warn"),
    version: opt(oneOf(["1", "2c"] as const, "warn")),
    community: opt(str()),
    port: opt(port16()),
    target: opt(str()),
    oid: opt(pattern(/^\d+(?:\.\d+)+$/, "a dotted OID")),
    note: opt(str()),
  }),
  (t, p, c) => {
    if (t.transport === "snmp") {
      if (!t.oid) err(c, `${p}.oid`, "snmp transport needs an oid");
      if (!t.target) warn(c, `${p}.target`, "no target: SNMP SET PDUs are built and logged but never sent");
      if (t.oid && t.oid.startsWith("1.3.6.1.4.1.99999.")) warn(c, `${p}.oid`, "enterprise 99999 is a placeholder, not a registered RTS OID");
    }
    if (t.transport === "native") warn(c, `${p}.transport`, "\"native\" is not wired yet (types.rs:483)");
  },
);

export const vendorPolicy: Check<VendorPolicy> = refine(
  obj<VendorPolicy>({ renames: record(renameTransport) }),
  (v, _p, c) => {
    if (!("default" in v.renames)) warn(c, "renames", "no \"default\" entry: vendors not listed get no rename transport");
  },
);

// ---------------------------------------------------------------------------
// relay.json
// ---------------------------------------------------------------------------

const relayBinding: Check<RelayBinding> = obj<RelayBinding>({
  matrix: str(),
  port: int(),
  device_id: str(),
  device_label: str(),
  kind: oneOf(["input", "output"] as const, "warn"),
});

const relayMatrix: Check<RelayMatrix> = refine(
  obj<RelayMatrix>({
    id: pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a kebab-case id"),
    label: str(),
    io: int({ min: 1, softMax: 99 }),
    casters: int({ min: 1, softMax: 64 }),
    port_names: opt(record(str(), pattern(/^U\d{2}$/, "a U<nn> port key")), false),
    bindings: opt(record(relayBinding, pattern(/^U\d{2}$/, "a U<nn> port key")), false),
  }),
  (m, p, c) => {
    for (const k of Object.keys(m.port_names ?? {})) {
      const n = Number(k.slice(1));
      if (n >= m.io) warn(c, `${p}.port_names.${k}`, `port ${k} is outside io=${m.io}: runtime.rs:157 renames it anyway, the frame has no such port`);
    }
    for (const [k, b] of Object.entries(m.bindings ?? {})) {
      if (b.matrix !== m.id) err(c, `${p}.bindings.${k}.matrix`, `"${b.matrix}" but the binding lives under ${m.id}`);
      if (`U${String(b.port).padStart(2, "0")}` !== k) warn(c, `${p}.bindings.${k}.port`, `port ${b.port} does not match key ${k}`);
    }
  },
);

export const relay: Check<RelayConfig> = refine(
  obj<RelayConfig>({
    host: str(),
    protocol_name: opt(str(), false),
    matrices: arr(relayMatrix),
    over_threshold_dbfs: opt(num({ max: 0 }), false),
  }),
  (r, _p, c) => {
    for (const d of duplicates(r.matrices, (m) => m.id)) err(c, "matrices", `duplicate matrix id "${d}"`);
  },
);

// ---------------------------------------------------------------------------
// TRUNK-CROSS POINTS/settings.json
// ---------------------------------------------------------------------------

export const crosspointSettings: Check<CrosspointSettings> = refine(
  obj<CrosspointSettings>({
    max_events: int(),
    checkin_every_seconds: opt(num({ min: 0 }), false),
  }),
  (s, _p, c) => {
    if (s.checkin_every_seconds === 0) warn(c, "checkin_every_seconds", "0: frames restate every crosspoint on every tick");
  },
);

// ---------------------------------------------------------------------------
// PANELS/connect.json
// ---------------------------------------------------------------------------

/** Placeholders a template may use; anything else is a typo. */
export const CONNECT_PLACEHOLDERS = [
  "base_url", "matrix", "port", "target", "remote_icom", "remote_port", "host", "series_plus_port",
] as const;

const template = (): Check<string> =>
  refine(str(), (s, p, c) => {
    for (const m of s.matchAll(/\{([a-z_]+)\}/g)) {
      const name = m[1] ?? "";
      if (!(CONNECT_PLACEHOLDERS as readonly string[]).includes(name)) warn(c, p, `unknown placeholder {${name}}`);
    }
  });

export const connect: Check<ConnectGuide> = refine(
  obj<ConnectGuide>({
    _comment: opt(str(), false),
    api: obj<ConnectGuide["api"]>({
      base_url: pattern(/^https?:\/\/[^/\s]+$/, "an http(s) origin with no path"),
      help: template(),
      content_type: str(),
    }),
    discover: record(template()),
    lifecycle: record(template()),
    buttons: record(template()),
    feedback: obj<ConnectGuide["feedback"]>({ poll: template(), poll_interval_ms: int({ min: 50 }), fields: record(str()) }),
    bitfocus_companion: opt(record(str()), false),
    streamdeck_app_native: opt(record(str()), false),
    audio_for_the_operator: opt(record(template()), false),
  }),
  (g, _p, c) => {
    for (const [group, rec] of [["discover", g.discover], ["lifecycle", g.lifecycle], ["buttons", g.buttons]] as const) {
      for (const [k, v] of Object.entries(rec)) {
        if (!/^(GET|POST) \{base_url\}\//.test(v)) warn(c, `${group}.${k}`, "expected \"GET {base_url}/...\" or \"POST {base_url}/...\"");
      }
    }
  },
);

// ---------------------------------------------------------------------------
// JSONL lines
// ---------------------------------------------------------------------------

export const preference: Check<Preference> = obj<Preference>({
  seq: int(),
  at: at(),
  kind: oneOf(PREFERENCE_KINDS, "warn"),
  who: opt(str()),
  value: json(),
});

let segmenter: Intl.Segmenter | undefined;
/** Panel characters = grapheme clusters (labels.rs:1-4). */
export function graphemes(s: string): string[] {
  segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  return [...segmenter.segment(s)].map((x) => x.segment);
}

export const label: Check<Label> = refine(
  obj<Label>({
    full: str(),
    l6: str(),
    l8: str(),
    l16: str(),
    chars: int(),
    over6: bool(),
    over8: bool(),
    over16: bool(),
  }),
  (l, p, c) => {
    const g = graphemes(l.full);
    const cut = (n: number): string => g.slice(0, n).join("");
    if (l.chars !== g.length) warn(c, `${p}.chars`, `${l.chars} but "${l.full}" is ${g.length} graphemes`);
    if (l.l6 !== cut(6)) err(c, `${p}.l6`, `"${l.l6}" is not the first 6 graphemes "${cut(6)}"`);
    if (l.l8 !== cut(8)) err(c, `${p}.l8`, `"${l.l8}" is not the first 8 graphemes`);
    if (l.l16 !== cut(16)) err(c, `${p}.l16`, `"${l.l16}" is not the first 16 graphemes`);
    if (l.over6 !== l.chars > 6 || l.over8 !== l.chars > 8 || l.over16 !== l.chars > 16) err(c, p, "over6/over8/over16 disagree with chars");
  },
);

export const labelEvent: Check<LabelEvent> = refine(
  obj<LabelEvent>({
    seq: int(),
    at: at(),
    frame: pattern(FRAME_ID, "a frame id"),
    port: pattern(PORT, "a U<nn>/C<n> port"),
    label,
    over: oneOf(["over6", "over8", "over6,over8"] as const),
    connection: opt(str()),
    origin: str(),
  }),
  (e, p, c) => {
    const want = e.label.over6 && e.label.over8 ? "over6,over8" : e.label.over6 ? "over6" : "over8";
    if (e.over !== want) err(c, `${p}.over`, `"${e.over}" but label says "${want}"`);
  },
);

export const renameDispatch: Check<RenameDispatch> = refine(
  obj<RenameDispatch>({
    seq: int(),
    at: at(),
    frame: pattern(FRAME_ID, "a frame id"),
    port: pattern(PORT, "a U<nn>/C<n> port"),
    old_name: opt(str()),
    new_name: str(),
    vendor: str(),
    transport: oneOf(RENAME_TRANSPORTS, "warn"),
    detail: str(),
    payload_hex: opt(pattern(/^(?:[0-9a-f]{2})*$/, "lower-case hex bytes")),
    target: opt(str()),
    sent: bool(),
    connection: opt(str()),
  }),
  (r, p, c) => {
    if (r.transport === "snmp" && !r.payload_hex) warn(c, `${p}.payload_hex`, "snmp dispatch without a PDU");
  },
);

export const gpioEvent: Check<GpioEvent> = refine(
  obj<GpioEvent>({
    seq: int(),
    at: at(),
    sim_time: opt(num({ min: 0 })),
    connection: str(),
    who: str(),
    pin: int({ min: 1, softMax: 8 }),
    state: bool(),
    from_frame: str(),
    to_frame: str(),
    path: arr(str()),
    trunks: arr(str()),
    note: opt(str()),
    function: opt(oneOf(GPIO_FUNCTIONS)),
    result: opt(json()),
  }),
  (g, p, c) => {
    const want = GPIO_FUNCTIONS[Math.min(Math.max(g.pin, 1), 8) - 1];
    if (g.function !== undefined && g.function !== want && g.pin <= 8) warn(c, `${p}.function`, `${g.function} on pin ${g.pin}; from_pin gives ${want}`);
    if (g.path[0] !== g.from_frame || g.path[g.path.length - 1] !== g.to_frame) err(c, `${p}.path`, "path does not run from from_frame to to_frame");
  },
);

export const crosspointEvent: Check<CrosspointEvent> = obj<CrosspointEvent>({
  seq: int(),
  at: at(),
  sim_time: opt(num({ min: 0 })),
  op: oneOf(["set", "clear"] as const),
  frame: pattern(FRAME_ID, "a frame id"),
  input: pattern(PORT, "a U<nn>/C<n> port"),
  output: pattern(PORT, "a U<nn>/C<n> port"),
  connection: str(),
});

export const relayEvent: Check<RelayEvent> = obj<RelayEvent>({
  seq: opt(int(), false),
  at: opt(at(), false),
  kind: oneOf(["over", "device", "bind", "unbind"] as const, "warn"),
  device_label: str(),
  matrix: opt(str()),
  port: opt(int()),
  peak_dbfs: opt(num()),
  threshold_dbfs: opt(num()),
  note: opt(str()),
});

const gainSet: Check<GainSet> = refine(
  obj<GainSet>({
    trunk: opt(str()),
    end: opt(oneOf(["a", "b"] as const)),
    connection: opt(str()),
    hop: opt(int()),
    db: num({ softMin: -60, softMax: 24 }),
    who: opt(str()),
  }),
  (g, p, c) => {
    if (!g.trunk && !g.connection) err(c, p, "give trunk+end or connection+hop");
  },
);

export const gainEvent: Check<GainEvent> = obj<GainEvent>({
  seq: int(),
  at: at(),
  set: gainSet,
  was_db: num(),
  path_gain_db: record(num()),
});
