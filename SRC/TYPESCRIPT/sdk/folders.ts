/**
 * The folder contract — port of TRUNK-CASTER-SDK/src/folders.rs.
 * Every component finds its way around the project root using these names
 * and nothing else. Pure (no `node:` imports) so browser bundles can use the
 * names; `Layout.find` (needs the filesystem) lives in `node.ts`.
 */

/** Manuals and API references, one folder per vendor, one sub-folder per protocol. */
export const KNOWN_PROTOCOLS = "KNOWN PROTOCOLS";
/** One JSON file per advertised frame, written by the runtime. */
export const ADVERTISEMENT = "TRUNK-ADVERTISEMENT";
/** Seekers drop `<id>.json`; the runtime answers `<id>.reply.json`. Deleting the request releases. */
export const INTERFACE = "TRUNK-CASTER-INTERFACE";
export const USAGE = "TRUNK-USAGE";
export const USERS = "TRUNK-USERS";
/** Note the space: "TRUNK-CROSS POINTS". */
export const CROSS_POINTS = "TRUNK-CROSS POINTS";
export const SIMULATOR = "TRUNK-SIMULATOR";
export const RELAY = "TRUNK-RELAY";
export const GLOBAL = "TRUNK-GLOBAL";
export const SDK = "TRUNK-CASTER-SDK";
export const RUNTIME = "RUST-RUNTIME";

/** Folders that are never treated as a vendor when scanning the root. */
export const RESERVED: readonly string[] = [
  KNOWN_PROTOCOLS,
  ADVERTISEMENT,
  INTERFACE,
  USAGE,
  USERS,
  CROSS_POINTS,
  SIMULATOR,
  RELAY,
  GLOBAL,
  SDK,
  RUNTIME,
];

const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());

export function isReserved(name: string): boolean {
  const upper = asciiUpper(name);
  return RESERVED.some((r) => asciiUpper(r) === upper) || upper.startsWith("TRUNK-");
}

/** Join path segments with the separator the root already uses (`\` for a Windows root, else `/`). */
export function joinPath(root: string, ...parts: string[]): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  let out = root.replace(/[\\/]+$/, "");
  for (const p of parts) out = out === "" ? p : `${out}${sep}${p}`;
  return out;
}

/** Typed view of a project root. Paths are strings joined with `join` (default `joinPath`). */
export class Layout {
  readonly root: string;
  private readonly join: (root: string, ...parts: string[]) => string;

  constructor(root: string, join: (root: string, ...parts: string[]) => string = joinPath) {
    this.root = root;
    this.join = join;
  }

  private at(...parts: string[]): string {
    return this.join(this.root, ...parts);
  }

  knownProtocols(): string { return this.at(KNOWN_PROTOCOLS); }
  advertisement(): string { return this.at(ADVERTISEMENT); }
  interface(): string { return this.at(INTERFACE); }
  usage(): string { return this.at(USAGE); }
  users(): string { return this.at(USERS); }
  crossPoints(): string { return this.at(CROSS_POINTS); }
  simulator(): string { return this.at(SIMULATOR); }
  sdk(): string { return this.at(SDK); }
  relay(): string { return this.at(RELAY); }
  relayConfig(): string { return this.at(RELAY, "relay.json"); }
  relayState(): string { return this.at(RELAY, "state.json"); }
  global(): string { return this.at(GLOBAL); }

  // Well-known files.
  /** The booking timeline: ports held for programs. */
  bookingsJson(): string { return this.at(USAGE, "bookings.json"); }
  usageState(): string { return this.at(USAGE, "state.json"); }
  crosspointsJson(): string { return this.at(CROSS_POINTS, "crosspoints.json"); }
  crosspointDeltas(): string { return this.at(CROSS_POINTS, "deltas.jsonl"); }
  crosspointSettings(): string { return this.at(CROSS_POINTS, "settings.json"); }
  seekingJson(): string { return this.at(CROSS_POINTS, "seeking.json"); }
  gpioLog(): string { return this.at(CROSS_POINTS, "gpio.jsonl"); }
  renamesLog(): string { return this.at(CROSS_POINTS, "renames.jsonl"); }
  /** Every crosspoint delta and check-in as Ward-Beck lines, appended. */
  wardbeckLog(): string { return this.at(CROSS_POINTS, "wardbeck.log"); }
  /** The latest check-in: full state of every frame as Ward-Beck lines. */
  checkinFile(): string { return this.at(CROSS_POINTS, "checkin.wb"); }
  vendorPolicy(): string { return this.at(SDK, "vendor-policy.json"); }
  sites(): string { return this.at(GLOBAL, "sites.json"); }
  globeConfig(): string { return this.at(GLOBAL, "globe.json"); }
  regionsJson(): string { return this.at(GLOBAL, "regions.json"); }
  preferences(): string { return this.at(GLOBAL, "preferences.jsonl"); }
  trendsJson(): string { return this.at(GLOBAL, "trends.json"); }
  labelEvents(): string { return this.at(USERS, "labels.jsonl"); }
  relayEvents(): string { return this.at(RELAY, "events.jsonl"); }
  spaceHtml(): string { return this.at(USAGE, "space.html"); }
  seeksDir(): string { return this.at(CROSS_POINTS, "seeks"); }
  fader(): string { return this.at(SIMULATOR, "fader.json"); }
  timeline(): string { return this.at(SIMULATOR, "timeline.json"); }
  runsDir(): string { return this.at(SIMULATOR, "runs"); }
  runsIndex(): string { return this.at(SIMULATOR, "runs.json"); }
  capturesDir(): string { return this.at(SIMULATOR, "captures"); }
}
