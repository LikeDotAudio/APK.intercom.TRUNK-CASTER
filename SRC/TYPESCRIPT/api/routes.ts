/**
 * The typed endpoint map for RUST-RUNTIME/src/http.rs (area 05).
 *
 * Two layers:
 *  - `GetRoutes` / `PostRoutes`: compile-time map path -> {res, body, kind}.
 *    `client.ts` infers everything from these.
 *  - `GET_META` / `POST_META` / `WS_META`: a runtime catalogue (same keys,
 *    enforced by mapped types, so a route cannot be in one and not the other)
 *    with summaries, http.rs line numbers, error cases and a light structural
 *    `check` the smoke script and `openapi.ts` use.
 *
 * Paths are exactly as the Rust `match` sees them after it strips the query
 * string and trailing slashes (http.rs:120). `:id` marks a prefix route
 * (`p.starts_with("/api/device/")`); the rest of the path, NOT percent-decoded,
 * is the id.
 */
import type * as T from './types.ts';

export type Kind = 'json' | 'text' | 'markdown' | 'html' | 'audio';

/** One route's contract. `body` is `undefined` when the server ignores it. */
export interface Route<Res, Body = undefined, K extends Kind = 'json'> {
  res: Res;
  body: Body;
  kind: K;
}
type Html = Route<string, undefined, 'html'>;
/** audio/wav, returned as bytes. */
type Wav = Route<Uint8Array, undefined, 'audio'>;

export interface GetRoutes {
  // --- HTML pages (server-rendered, live=true) ---
  '/': Html;
  '/globe': Html;
  '/home': Html;
  '/about': Html;
  '/usage': Html;
  '/users': Html;
  '/crosspoints': Html;
  '/simulator': Html;
  '/space': Html;
  '/overlord': Html;
  '/racks': Html;
  '/relay': Html;
  '/analyzer': Html;
  '/panels': Html;
  '/lights': Html;
  '/panels/editor': Html;
  '/editor': Html;
  '/continents': Html;
  '/discovery': Html;
  // --- JSON ---
  '/api/globe': Route<T.GlobeData>;
  /** Natural Earth 110 m land rings, each a flat [lon, lat, lon, lat, ...] array (html.rs LAND_JSON). Added concurrently by the Rust session. */
  '/api/land': Route<number[][]>;
  '/api/sites': Route<T.Sites>;
  '/api/globe/config': Route<T.GlobeConfig>;
  '/api/preferences': Route<T.Preference[]>;
  '/api/regions': Route<T.Region[]>;
  '/api/captures': Route<T.CapturesList>;
  '/api/analyze/:id': Route<T.Capture>;
  '/api/capture/:id': Route<T.Capture>;
  '/api/phonebook': Route<T.PhoneBookEntry[]>;
  '/api/gpio/functions': Route<T.GpioFunctionInfo[]>;
  '/api/topics': Route<T.Topics>;
  '/api/tree': Route<T.DiscoveryTree>;
  '/api/device/:id': Route<T.DeviceView>;
  '/api/bookings': Route<T.Booking[]>;
  '/api/continents': Route<T.ContinentTotal[]>;
  '/api/lines': Route<T.LeaseLine[]>;
  '/api/runs': Route<T.RunsList>;
  '/api/runs/current': Route<T.SimRun>;
  '/api/labels': Route<T.LabelEvent[]>;
  '/api/gains': Route<T.GainEvent[]>;
  '/api/taps': Route<T.Taps>;
  '/api/taps/:frame': Route<T.TapStrip>;
  '/api/voices': Route<T.VoiceSummary>;
  '/api/voices/:frame': Route<T.FrameVoice>;
  '/api/bandwidth': Route<T.Bandwidth>;
  '/api/airports': Route<T.Airport[]>;
  /** `<frame>-ident.wav` or `<frame>-call.wav`. */
  '/voices/:file': Wav;
  '/api/relay/events': Route<T.RelayEvent[]>;
  '/api/presets': Route<T.Preset[]>;
  '/api/productions': Route<Record<string, T.ProductionSample>>;
  '/api/remotes': Route<T.RemoteFrame[]>;
  '/api/relay': Route<T.RelaySnapshot>;
  '/api/gpio': Route<T.GpioEvent[]>;
  '/api/renames': Route<T.RenameDispatch[]>;
  '/api/policy': Route<T.VendorPolicy>;
  '/api/status': Route<T.Status>;
  '/api/advertisements': Route<T.Frame[]>;
  '/api/protocols': Route<T.Protocol[]>;
  '/api/state': Route<T.RoutingState>;
  '/api/users': Route<T.UserRecord[]>;
  '/api/fader': Route<T.Fader>;
  '/api/timeline': Route<T.Timeline>;
  '/api/seeks': Route<T.PanelOffer[]>;
  '/api/crosspoints': Route<T.CrosspointsView>;
  '/api/crosscheck': Route<T.CrossCheck>;
  '/api/log': Route<string[]>;
  // --- text ---
  '/api/report': Route<string, undefined, 'markdown'>;
  '/report.md': Route<string, undefined, 'markdown'>;
  '/api/wardbeck': Route<string, undefined, 'text'>;
  '/api/checkin': Route<string, undefined, 'text'>;
}

export interface PostRoutes {
  '/api/globe/config': Route<T.GlobeConfig, T.GlobeConfigInput>;
  '/api/capture/start': Route<T.Capture, T.CaptureStartBody>;
  '/api/capture/stop': Route<T.Capture>;
  '/api/bookings': Route<T.Booking, T.BookingAsk>;
  '/api/bookings/cancel': Route<T.Cancelled, T.IdBody>;
  '/api/fader/preset': Route<T.Fader, T.IdBody>;
  '/api/fader/quick': Route<T.Fader, T.QuickFaderBody>;
  '/api/clock': Route<T.Status, T.ClockBody>;
  '/api/gain': Route<T.GainEvent, T.GainSet>;
  '/api/taps/unity': Route<T.TapsUnityResult, T.TapsUnity>;
  '/api/relay/bind': Route<T.RelayBinding, T.RelayBinding>;
  '/api/relay/unbind': Route<T.Unbound, T.RelayUnbindBody>;
  '/api/relay/event': Route<T.RelayEvent, T.RelayEventInput>;
  '/api/gpio': Route<T.GpioEvent, T.GpioCommand>;
  '/api/rename': Route<T.RenameDispatch[], T.Rename>;
  '/api/request': Route<T.Reply, T.Request>;
  '/api/release': Route<T.Reply, T.IdBody>;
  '/api/fader': Route<T.Fader, T.FaderInput>;
  '/api/panel-seek': Route<T.PanelOffer, T.PanelSeek>;
  '/api/crosspoints/settings': Route<T.CrosspointSettings, T.CrosspointSettings>;
  '/api/crosspoints/reset': Route<T.ResetDone>;
}

export type GetPath = keyof GetRoutes;
export type PostPath = keyof PostRoutes;

/** `'/api/device/:id'` -> `{ id: string }`; no params -> `{}`. */
export type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : Record<never, never>;
export type HasParams<P extends string> = keyof PathParams<P> extends never ? false : true;

// ---------------------------------------------------------------------------
// Runtime catalogue
// ---------------------------------------------------------------------------

/** A light structural check: enough to tell "shape drifted" from "matches". */
export type Check =
  | { type: 'object'; keys: readonly string[] }
  | { type: 'array'; itemKeys?: readonly string[] }
  | { type: 'record'; valueKeys?: readonly string[] }
  | { type: 'string' };

export interface ErrorCase {
  status: 400 | 404 | 405 | 500;
  when: string;
}

export interface RouteMeta {
  summary: string;
  /** http.rs line of the match arm. */
  line: number;
  /** Name of the response type in types.ts (for docs / openapi). */
  response: string;
  /** Name of the request body type in types.ts; absent = body ignored. */
  request?: string;
  /** Query parameters the handler reads (never typed by the server). */
  query?: readonly string[];
  errors?: readonly ErrorCase[];
  check?: Check;
  /** Same handler as another path. */
  aliasOf?: string;
  /** Mutates runtime state and calls `rt.persist()`. */
  persists?: boolean;
}

const html = (line: number, summary: string, aliasOf?: string, query?: readonly string[]): RouteMeta => ({
  summary,
  line,
  response: 'string (text/html)',
  check: { type: 'string' },
  ...(aliasOf ? { aliasOf } : {}),
  ...(query ? { query } : {}),
});
const NOT_FOUND = (what: string): ErrorCase => ({ status: 404, when: what });
const BAD = (what: string): ErrorCase => ({ status: 400, when: what });
const IO = (what: string): ErrorCase => ({ status: 500, when: what });

const CAPTURE_KEYS = ['wire_version', 'id', 'note', 'started_at', 'started_sim', 'started_clock', 'fader', 'frames', 'sites', 'summary', 'buckets', 'samples'] as const;
const FADER_KEYS = ['speed', 'requests_per_minute', 'mean_hold_seconds', 'running', 'seed', 'day', 'lease_seconds', 'preset', 'productions'] as const;
const SIMRUN_KEYS = ['wire_version', 'id', 'started_at', 'started_sim', 'reason', 'fader', 'frames', 'sites', 'summary', 'samples'] as const;
const STATUS_KEYS = ['wire_version', 'root', 'endpoint', 'shape', 'protocols', 'frames', 'trunks', 'connections', 'sim_time', 'fader', 'updated_at', 'remote_frames', 'remotes_connected', 'sites', 'clock', 'blackout', 'muted'] as const;

export const GET_META: { readonly [P in GetPath]: RouteMeta } = {
  '/': html(140, 'Globe page (home).'),
  '/globe': html(140, 'Globe page.', '/'),
  '/home': html(144, 'Index / about page.'),
  '/about': html(144, 'Index / about page.', '/home'),
  '/usage': html(152, 'Usage page.'),
  '/users': html(156, 'Users page.'),
  '/crosspoints': html(160, 'Crosspoints page.'),
  '/simulator': html(164, 'Simulator page.'),
  '/space': html(168, 'Space page.'),
  '/overlord': html(172, 'Overlord page.'),
  '/racks': html(176, 'Racks page.'),
  '/relay': html(180, 'Relay page.'),
  '/analyzer': html(210, 'Analyzer page; ?id= selects a capture or run (NOT percent-decoded, unlike /panels/editor).', undefined, ['id']),
  '/panels': html(285, 'Panels / light board.'),
  '/lights': html(285, 'Panels / light board.', '/panels'),
  '/panels/editor': html(289, 'Panel editor; ?frame=&port=U<nn> (percent-decoded).', undefined, ['frame', 'port']),
  '/editor': html(289, 'Panel editor.', '/panels/editor', ['frame', 'port']),
  '/continents': html(323, 'Continents / discovery page.'),
  '/discovery': html(323, 'Continents / discovery page.', '/continents'),

  '/api/globe': { line: 148, summary: 'Full globe data: nodes, clusters, trunks, calls, history, config.', response: 'GlobeData', check: { type: 'object', keys: ['site', 'clock', 'load', 'sim_time', 'frames', 'sites', 'trunks', 'calls', 'sims', 'config', 'nodes', 'clusters', 'trunkList', 'callList', 'history', 'today', 'lockHours', 'daysShown'] } },
  '/api/land': { line: 272, summary: 'Land outlines (static, served from include_str!). Added after the audit began.', response: 'number[][]', check: { type: 'array' } },
  '/api/sites': { line: 184, summary: 'The site list (sites.json).', response: 'Sites', check: { type: 'object', keys: ['sites'] } },
  '/api/globe/config': { line: 188, summary: 'Globe view configuration.', response: 'GlobeConfig', check: { type: 'object', keys: ['rotate_deg_per_s', 'tilt_deg', 'show_capitals', 'show_provinces', 'show_cities', 'graticule_deg', 'projection', 'zoom', 'zones'] } },
  '/api/preferences': { line: 202, summary: 'Recent preference changes.', response: 'Preference[]', check: { type: 'array', itemKeys: ['seq', 'at', 'kind', 'value'] } },
  '/api/regions': { line: 206, summary: 'Per-site usage with local clock and load.', response: 'Region[]', check: { type: 'array', itemKeys: ['site', 'slug', 'country', 'tier', 'lat', 'lon', 'frames', 'local_clock', 'load', 'calls', 'trunks', 'panels_live'] } },
  '/api/captures': { line: 233, summary: 'Current capture (samples cleared) and saved captures (samples cleared).', response: 'CapturesList', check: { type: 'object', keys: ['current', 'captures'] } },
  '/api/analyze/:id': { line: 241, summary: 'A capture or run by id, as a Capture, samples cleared.', response: 'Capture', errors: [NOT_FOUND('no capture or run with that id')], check: { type: 'object', keys: CAPTURE_KEYS } },
  '/api/capture/:id': { line: 252, summary: 'A capture or run by id, WITH samples.', response: 'Capture', errors: [NOT_FOUND('no capture or run with that id')], check: { type: 'object', keys: CAPTURE_KEYS } },
  '/api/phonebook': { line: 260, summary: 'Everyone who has called, with labels and badges.', response: 'PhoneBookEntry[]', check: { type: 'array', itemKeys: ['who', 'label', 'panels', 'sites', 'calls', 'live_now'] } },
  '/api/gpio/functions': { line: 264, summary: 'GPIO key functions and their pins.', response: 'GpioFunctionInfo[]', check: { type: 'array', itemKeys: ['pin', 'function', 'label'] } },
  '/api/topics': { line: 268, summary: 'Header topic metrics, keyed by page path.', response: 'Topics', check: { type: 'record', valueKeys: ['label', 'metric', 'colour', 'ink', 'items'] } },
  '/api/tree': { line: 273, summary: 'Discovery tree: global -> continent -> country -> site -> device.', response: 'DiscoveryTree', check: { type: 'object', keys: ['global', 'continents'] } },
  '/api/device/:id': { line: 277, summary: 'One frame, centred: lines, trunks, events, labels.', response: 'DeviceView', errors: [NOT_FOUND('no frame with that id')], check: { type: 'object', keys: ['frame', 'site', 'local_clock', 'load', 'lines', 'trunks', 'events', 'labels', 'last', 'remote'] } },
  '/api/bookings': { line: 295, summary: 'The booking timeline.', response: 'Booking[]', check: { type: 'array', itemKeys: ['id', 'frame', 'port', 'kind', 'program', 'who', 'start', 'end', 'daily', 'source', 'status', 'created_at'] } },
  '/api/continents': { line: 327, summary: 'Calls between continent pairs.', response: 'ContinentTotal[]', check: { type: 'array', itemKeys: ['from', 'to', 'ocean', 'calls', 'muted', 'crossing'] } },
  '/api/lines': { line: 331, summary: 'Every live line with its lease, soonest-to-expire first.', response: 'LeaseLine[]', check: { type: 'array', itemKeys: ['id', 'who', 'from', 'to', 'left', 'lease', 'state', 'muted', 'reconnects', 'kind'] } },
  '/api/runs': { line: 335, summary: 'Current run (samples cleared) and the run index.', response: 'RunsList', check: { type: 'object', keys: ['current', 'previous'] } },
  '/api/runs/current': { line: 341, summary: 'Current run with samples.', response: 'SimRun', check: { type: 'object', keys: SIMRUN_KEYS } },
  '/api/labels': { line: 345, summary: 'Recent panel label events.', response: 'LabelEvent[]', check: { type: 'array', itemKeys: ['seq', 'at', 'frame', 'port', 'label', 'over', 'origin'] } },
  '/api/gains': { line: 349, summary: 'Recent gain changes.', response: 'GainEvent[]', check: { type: 'array', itemKeys: ['seq', 'at', 'set', 'was_db', 'path_gain_db'] } },
  '/api/taps': { line: 363, summary: 'TAPS and Mixes: a strip per connected frame, a fader per closed crosspoint (gain, accent, live voice rate).', response: 'Taps', check: { type: 'object', keys: ['frames', 'crosspoints', 'trimmed', 'strips'] } },
  '/api/taps/:frame': { line: 367, summary: "One frame's TAPS strip (empty faders when nothing is crossed).", response: 'TapStrip', errors: [NOT_FOUND('no frame with that id')], check: { type: 'object', keys: ['frame', 'site', 'protocol', 'vendor', 'accent', 'kbps', 'faders'] } },
  '/api/voices': { line: 349, summary: "Everything heard of the frames' voices: chunk and correction counters, live rate, newest recording per frame and kind.", response: 'VoiceSummary', check: { type: 'object', keys: ['chunks_in', 'bad_chunks', 'recordings', 'corrected_seconds', 'lost_seconds', 'waiting', 'kbps', 'talking', 'by_protocol_kbps', 'link', 'latest'] } },
  '/api/voices/:frame': { line: 354, summary: "One frame's voice: site, country, airport, accent, live rate, newest ident and call with their WAV paths.", response: 'FrameVoice', errors: [NOT_FOUND('no frame with that id')], check: { type: 'object', keys: ['frame', 'site', 'country', 'airport', 'accent', 'kbps', 'bytes', 'ident', 'call', 'ident_wav', 'call_wav'] } },
  '/api/bandwidth': { line: 374, summary: 'The bandwidth simulation: voice on the wire over the last window_s seconds, by protocol, by frame and spread over the trunks each call crosses.', response: 'Bandwidth', check: { type: 'object', keys: ['window_s', 'kbps', 'carried_kbps', 'talking', 'bytes', 'by_protocol', 'frames', 'trunks'] } },
  '/api/airports': { line: 380, summary: 'Every site with its IATA airport code and accent.', response: 'Airport[]', check: { type: 'array', itemKeys: ['site', 'country', 'airport', 'accent'] } },
  '/voices/:file': { line: 395, summary: 'A re-assembled recording (audio/wav, 8 kHz 16-bit mono): <frame>-ident.wav or <frame>-call.wav.', response: 'binary (audio/wav)', errors: [NOT_FOUND('no such recording')] },
  '/api/relay/events': { line: 353, summary: 'Recent relay (sound device) events.', response: 'RelayEvent[]', check: { type: 'array', itemKeys: ['seq', 'at', 'kind', 'device_label'] } },
  '/api/presets': { line: 357, summary: 'Fader presets derived from the current fader.', response: 'Preset[]', check: { type: 'array', itemKeys: ['id', 'name', 'blurb', 'fader', 'surge_hour', 'surge_utc', 'lead_hours'] } },
  '/api/productions': { line: 361, summary: 'Per-production live sample, keyed by production name.', response: 'Record<string, ProductionSample>', check: { type: 'record', valueKeys: ['offered', 'answered', 'busy', 'live', 'trunks_used', 'trunks', 'on_air', 'studio'] } },
  '/api/remotes': { line: 441, summary: 'Remote (simulator) frames, by frame id.', response: 'RemoteFrame[]', check: { type: 'array', itemKeys: ['frame', 'peer', 'connected_at', 'last_seen', 'connected'] } },
  '/api/relay': { line: 445, summary: 'Relay snapshot: matrices, ports, crosspoints.', response: 'RelaySnapshot', check: { type: 'object', keys: ['wire_version', 'host', 'updated_at', 'matrices'] } },
  '/api/gpio': { line: 449, summary: 'Recent GPIO events.', response: 'GpioEvent[]', check: { type: 'array', itemKeys: ['seq', 'at', 'connection', 'who', 'pin', 'state', 'from_frame', 'to_frame', 'path', 'trunks'] } },
  '/api/renames': { line: 453, summary: 'Recent rename dispatches.', response: 'RenameDispatch[]', check: { type: 'array', itemKeys: ['seq', 'at', 'frame', 'port', 'new_name', 'vendor', 'transport', 'detail', 'sent'] } },
  '/api/policy': { line: 457, summary: 'Vendor rename policy.', response: 'VendorPolicy', check: { type: 'object', keys: ['renames'] } },
  '/api/status': { line: 498, summary: 'Runtime status.', response: 'Status', check: { type: 'object', keys: STATUS_KEYS } },
  '/api/advertisements': { line: 502, summary: 'Every frame advertisement.', response: 'Frame[]', check: { type: 'array', itemKeys: ['wire_version', 'id', 'protocol', 'protocol_name', 'family', 'site', 'implemented_by', 'user_ports', 'casters', 'channels_per_trunk', 'caster_status', 'free_casters', 'advertised_at'] } },
  '/api/protocols': { line: 506, summary: 'Discovered protocol repertoire.', response: 'Protocol[]', check: { type: 'array', itemKeys: ['id', 'name', 'family', 'implementations', 'documents', 'digest'] } },
  '/api/state': { line: 510, summary: 'The whole routing state (frames, trunks, connections). Large.', response: 'RoutingState', check: { type: 'object', keys: ['shape', 'frames', 'trunks', 'connections', 'counters', 'updated_at', 'port_names', 'port_labels', 'last_activity', 'next_trunk'] } },
  '/api/users': { line: 514, summary: 'Recent user records.', response: 'UserRecord[]', check: { type: 'array', itemKeys: ['wire_version', 'id', 'who', 'whom', 'from', 'when', 'status', 'origin', 'gpio_sent'] } },
  '/api/fader': { line: 518, summary: 'Current fader.', response: 'Fader', check: { type: 'object', keys: FADER_KEYS } },
  '/api/timeline': { line: 522, summary: 'Sample timeline.', response: 'Timeline', check: { type: 'object', keys: ['wire_version', 'samples'] } },
  '/api/seeks': { line: 526, summary: 'Outstanding panel offers.', response: 'PanelOffer[]', check: { type: 'array', itemKeys: ['wire_version', 'seek', 'seek_id', 'offered_at', 'allowed_trunks'] } },
  '/api/crosspoints': { line: 530, summary: 'Crosspoint settings, closed crosspoints (sorted) and recent events.', response: 'CrosspointsView', check: { type: 'object', keys: ['settings', 'events_logged', 'log_ended', 'crosspoints', 'recent_events'] } },
  '/api/crosscheck': { line: 546, summary: 'Last crosscheck result.', response: 'CrossCheck', check: { type: 'object', keys: ['checked', 'ok', 'failures'] } },
  '/api/log': { line: 550, summary: 'Runtime log lines, oldest first.', response: 'string[]', check: { type: 'array' } },
  '/api/report': { line: 365, summary: 'Markdown report (text/markdown).', response: 'string (text/markdown)', check: { type: 'string' } },
  '/report.md': { line: 365, summary: 'Markdown report (text/markdown).', response: 'string (text/markdown)', aliasOf: '/api/report', check: { type: 'string' } },
  '/api/wardbeck': { line: 461, summary: 'Recent Ward-Beck lines, newline-joined (text/plain).', response: 'string (text/plain)', check: { type: 'string' } },
  '/api/checkin': { line: 466, summary: 'Last check-in file, "" when missing (text/plain).', response: 'string (text/plain)', check: { type: 'string' } },
};

export const POST_META: { readonly [P in PostPath]: RouteMeta } = {
  '/api/globe/config': { line: 192, summary: 'Replace the globe config.', request: 'GlobeConfigInput', response: 'GlobeConfig', errors: [BAD('body is not a GlobeConfig'), IO('could not save')] },
  '/api/capture/start': { line: 215, summary: 'Start a capture. Invalid JSON is silently treated as {}.', request: 'CaptureStartBody', response: 'Capture' },
  '/api/capture/stop': { line: 223, summary: 'Stop the capture in progress.', response: 'Capture', errors: [BAD('no capture in progress')] },
  '/api/bookings': { line: 299, summary: 'Book a port for a program.', request: 'BookingAsk', response: 'Booking', errors: [BAD('bad booking JSON, or the runtime refused it')], persists: true },
  '/api/bookings/cancel': { line: 312, summary: 'Cancel a booking. Missing id becomes "" and yields 404, not 400.', request: 'IdBody', response: 'Cancelled', errors: [NOT_FOUND('no booking with that id (including a missing id)')], persists: true },
  '/api/fader/preset': { line: 370, summary: 'Apply a preset. Missing id becomes "" and yields 400 from the runtime.', request: 'IdBody', response: 'Fader', errors: [BAD('unknown preset')] },
  '/api/fader/quick': { line: 379, summary: 'Change speed and/or running. Invalid JSON is silently {}.', request: 'QuickFaderBody', response: 'Fader', errors: [IO('could not save fader')] },
  '/api/clock': { line: 387, summary: 'Scrub the simulated clock to an hour (wrapped mod 24). Starts a new run.', request: 'ClockBody', response: 'Status', errors: [BAD('hour missing or not a number')] },
  '/api/gain': { line: 463, summary: 'Set a gain: trunk+end (a caster), connection+hop (one hop of a call) or frame+input+output (one crosspoint, a TAPS fader).', request: 'GainSet', response: 'GainEvent', errors: [BAD('bad JSON, no such point, or runtime refused')] },
  '/api/taps/unity': { line: 453, summary: 'Every crosspoint (of one frame, or of all when the body is empty) back to 0 dB; each change logged in gains.jsonl.', request: 'TapsUnity', response: 'TapsUnityResult', errors: [BAD('bad JSON or no such frame')] },
  '/api/relay/bind': { line: 409, summary: 'Bind a relay port to a sound device.', request: 'RelayBinding', response: 'RelayBinding', errors: [BAD('bad JSON or runtime refused')] },
  '/api/relay/unbind': { line: 419, summary: 'Unbind a relay port.', request: 'RelayUnbindBody', response: 'Unbound', errors: [BAD('matrix/port missing, or runtime refused')] },
  '/api/relay/event': { line: 433, summary: 'Report a relay (sound device) event.', request: 'RelayEventInput', response: 'RelayEvent', errors: [BAD('bad JSON')] },
  '/api/gpio': { line: 471, summary: 'Send a GPIO command over a connection.', request: 'GpioCommand', response: 'GpioEvent', errors: [BAD('bad JSON or runtime refused')], persists: true },
  '/api/rename': { line: 484, summary: 'Rename a user port; returns one dispatch per vendor transport.', request: 'Rename', response: 'RenameDispatch[]', errors: [BAD('bad JSON or runtime refused')], persists: true },
  '/api/request': { line: 555, summary: 'Ask for a connection. A denial is 200 with status "denied".', request: 'Request', response: 'Reply', errors: [BAD('bad JSON')], persists: true },
  '/api/release': { line: 564, summary: 'Release a connection. Unknown id is 200 (Reply carries the outcome).', request: 'IdBody', response: 'Reply', errors: [BAD('id missing')], persists: true },
  '/api/fader': { line: 578, summary: 'Replace the fader.', request: 'FaderInput', response: 'Fader', errors: [BAD('bad JSON'), IO('could not save')] },
  '/api/panel-seek': { line: 591, summary: 'Seek allowed trunks for a panel.', request: 'PanelSeek', response: 'PanelOffer', errors: [BAD('bad JSON')], persists: true },
  '/api/crosspoints/settings': { line: 600, summary: 'Change crosspoint log settings.', request: 'CrosspointSettings', response: 'CrosspointSettings', errors: [BAD('bad JSON'), IO('could not save')], persists: true },
  '/api/crosspoints/reset': { line: 616, summary: 'Reset the crosspoint log.', response: 'ResetDone', errors: [IO('could not reset')], persists: true },
};

export const WS_META = {
  path: '/ws',
  line: 125,
  summary:
    'Telemetry stream (RFC 6455, server->client text frames). No snapshot on connect: a `status` frame every >=500 ms and a `globe-delta` frame every >=2000 ms, only while at least one client is open. A plain GET without Sec-WebSocket-Key is 400.',
  messages: ['StatusMessage', 'GlobeDeltaMessage'],
} as const;

/** Errors common to every route (http.rs:628-629). */
export const COMMON_ERRORS: readonly ErrorCase[] = [
  { status: 404, when: 'GET to an unknown path' },
  { status: 405, when: 'any non-GET method to a path with no handler for it, including unknown paths, HEAD and OPTIONS (so CORS preflight always fails)' },
];
