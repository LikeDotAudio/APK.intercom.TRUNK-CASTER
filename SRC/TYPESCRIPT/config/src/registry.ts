// Every file the validator knows: where it lives, which check applies, who
// reads it, and what the reader does when the file does not parse. That
// last column matters: three of them are silently REPLACED by defaults.

import type { Check } from "./check.ts";
import * as S from "./schemas.ts";

export type OnInvalid =
  | "overwritten" // the runtime writes defaults over the file at boot
  | "default" // the runtime ignores the file and runs on defaults
  | "crash" // the reader raises
  | "skipped-line" // a JSONL line that does not parse is skipped
  | "unread"; // documentation only

export interface ConfigEntry {
  readonly kind: "config";
  readonly id: string;
  readonly path: string;
  readonly check: Check<unknown>;
  readonly reader: string;
  readonly onInvalid: OnInvalid;
  readonly tracked: boolean;
}

export interface LogEntry {
  readonly kind: "log";
  readonly id: string;
  readonly path: string;
  readonly check: Check<unknown>;
  readonly writer: string;
  /** True when the current runtime no longer writes simulated lines here. */
  readonly simFiltered: boolean;
}

export type Entry = ConfigEntry | LogEntry;

// Check<T> is covariant in T through the phantom, so widening to unknown is safe.
const u = <T>(c: Check<T>): Check<unknown> => c;

export const CONFIGS: readonly ConfigEntry[] = [
  { kind: "config", id: "sites", path: "TRUNK-GLOBAL/sites.json", check: u(S.sites), reader: "RUST-RUNTIME/src/runtime.rs:134-141 (Sites, TRUNK-CASTER-SDK/src/sites.rs:38-60)", onInvalid: "overwritten", tracked: true },
  { kind: "config", id: "globe", path: "TRUNK-GLOBAL/globe.json", check: u(S.globe), reader: "RUST-RUNTIME/src/runtime.rs:142-149 (GlobeConfig, types.rs:1590-1626)", onInvalid: "overwritten", tracked: true },
  { kind: "config", id: "fader", path: "TRUNK-SIMULATOR/fader.json", check: u(S.fader), reader: "runtime.rs:167, 635 (every tick), simulate.rs:54, sdk client.rs:121 (Fader, types.rs:925-976)", onInvalid: "default", tracked: true },
  { kind: "config", id: "emulators", path: "TRUNK-SIMULATOR/emulators.json", check: u(S.emulators), reader: "TRUNK-SIMULATOR/launch_all.py:90-112, 226 (dict access, no schema)", onInvalid: "crash", tracked: true },
  { kind: "config", id: "vendor-policy", path: "TRUNK-CASTER-SDK/vendor-policy.json", check: u(S.vendorPolicy), reader: "runtime.rs:170 (VendorPolicy, types.rs:478-546)", onInvalid: "default", tracked: true },
  { kind: "config", id: "relay", path: "TRUNK-RELAY/relay.json", check: u(S.relay), reader: "RUST-RUNTIME/src/relay.rs:16-26 (RelayConfig, types.rs:1446-1480)", onInvalid: "overwritten", tracked: true },
  { kind: "config", id: "crosspoint-settings", path: "TRUNK-CROSS POINTS/settings.json", check: u(S.crosspointSettings), reader: "RUST-RUNTIME/src/crosspoints.rs:62-63 (CrosspointSettings, types.rs:847-866)", onInvalid: "default", tracked: true },
  { kind: "config", id: "connect", path: "PANELS/connect.json", check: u(S.connect), reader: "nobody: documentation for Stream Deck / Companion users", onInvalid: "unread", tracked: true },
];

export const LOGS: readonly LogEntry[] = [
  { kind: "log", id: "preferences", path: "TRUNK-GLOBAL/preferences.jsonl", check: u(S.preference), writer: "runtime.rs:306-311 Runtime::pref", simFiltered: false },
  { kind: "log", id: "labels", path: "TRUNK-USERS/labels.jsonl", check: u(S.labelEvent), writer: "runtime.rs:1136-1154 (skips origin=simulator)", simFiltered: true },
  { kind: "log", id: "renames", path: "TRUNK-CROSS POINTS/renames.jsonl", check: u(S.renameDispatch), writer: "runtime.rs:1262-1270 (skips simulated)", simFiltered: true },
  { kind: "log", id: "gpio", path: "TRUNK-CROSS POINTS/gpio.jsonl", check: u(S.gpioEvent), writer: "runtime.rs:1496-1500 (skips simulated)", simFiltered: true },
  { kind: "log", id: "deltas", path: "TRUNK-CROSS POINTS/deltas.jsonl", check: u(S.crosspointEvent), writer: "crosspoints.rs (bounded by settings.max_events)", simFiltered: false },
  { kind: "log", id: "relay-events", path: "TRUNK-RELAY/events.jsonl", check: u(S.relayEvent), writer: "runtime.rs:1377-1382", simFiltered: false },
  { kind: "log", id: "gains", path: "TRUNK-USAGE/gains.jsonl", check: u(S.gainEvent), writer: "runtime.rs:1318-1323", simFiltered: false },
];
