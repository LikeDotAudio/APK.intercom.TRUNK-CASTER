/**
 * launch-all.ts -- kick off every vendor emulator with its locations and serve one combined
 * map of all of them (port of TRUNK-SIMULATOR/launch_all.py; subprocess -> node:child_process).
 *
 * Reads TRUNK-SIMULATOR/emulators.json.  For each vendor:
 *   * if its emulator script exists, start it with its capitals, ports and vendor label;
 *   * otherwise start the stand-in emulator (RTS) for those capitals, labelled with the vendor's name.
 * Then runs a combined map on combined_map_port that merges every emulator's /state feed and
 * forwards /api/* calls to whichever emulator owns the matrix.
 *
 *   node --experimental-strip-types simulator/src/launch-all.ts                 start everything
 *   node --experimental-strip-types simulator/src/launch-all.ts --list          show the plan
 *   node --experimental-strip-types simulator/src/launch-all.ts --only RTS,Riedel
 *   node --experimental-strip-types simulator/src/launch-all.ts --runtime python   run the .py emulators like before
 *
 * New: --runtime node|python (default node).  With node, an emulator that has a TypeScript port
 * (TS_PORTS) runs under Node; one without a port still runs under Python.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { errStr, isoNow, localTzLabel, now, PyKeyError, pyFloat, pyInt, PyValueError, stamp } from "./py.ts";
import { type EstateState, MapServer, type MapDevice, type MapLink, type Params } from "./tc-map.ts";
import { CONTINENT, WORLD_CAPITALS } from "./rts/world.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findUp(folderName: string, start = HERE, levels = 8): string | null {
  let d = start;
  for (let i = 0; i < levels; i++) {
    d = path.dirname(d);
    const cand = path.join(d, folderName);
    if (existsSync(cand) && statSync(cand).isDirectory()) return cand;
  }
  return null;
}

/** TRUNK-SIMULATOR, where emulators.json lives; ROOT is its parent (the repo). */
export const TRUNK_SIM_DIR = findUp("TRUNK-SIMULATOR") ?? path.resolve(HERE, "..", "..", "TRUNK-SIMULATOR");
export const ROOT = path.normalize(path.join(TRUNK_SIM_DIR, ".."));

/** registry emulator path (relative to ROOT, forward slashes) -> TypeScript entry point */
export const TS_PORTS: Readonly<Record<string, string>> = {
  "KNOWN PROTOCOLS/VENDOR/RTS/SIMULATOR/rts_intercom_sim.py": path.join(HERE, "rts", "main.ts"),
};

export type Runtime = "node" | "python";

export interface VendorEntry {
  vendor: string;
  emulator: string;
  base_port: number;
  map_port: number;
  capitals: string[];
  region?: string;
}
export interface Registry {
  _comment?: string;
  combined_map_port?: number;
  stand_in?: string;
  chaos?: number;
  vendors: VendorEntry[];
}

export type Log = (msg: string) => void;
const defaultLog: Log = (msg) => process.stdout.write(stamp(msg) + "\n");

export async function fetchJson(url: string, timeout = 2.0): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout * 1000) });
  // urllib raises HTTPError for >= 400 before the body is read; keep that behaviour
  if (r.status >= 400) throw new Error(`HTTP Error ${r.status}: ${r.statusText}`);
  return (await r.json()) as unknown;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Pull the capital table so the launcher shows placeholders for dead emulators. */
export const CAPITALS: ReadonlyMap<string, [city: string, country: string, lat: number, lon: number, continent: string | null]> = new Map(
  WORLD_CAPITALS.map(([a, city, country, lat, lon]) => [a, [city, country, lat, lon, CONTINENT[a] ?? null]] as const),
);

export class Child {
  vendor: string;
  script: string;
  args: string[];
  mapPort: number;
  capitals: string[];
  standInFor: string | null;
  proc: ChildProcess | null = null;
  state: EstateState | null = null;
  lastOk = 0.0;
  error: string | null = null;
  runtime: Runtime;
  private log: Log;

  constructor(vendor: string, script: string, args: string[], mapPort: number, capitals: string[], standInFor: string | null, runtime: Runtime, log: Log) {
    this.vendor = vendor;
    this.script = script;
    this.args = args;
    this.mapPort = mapPort;
    this.capitals = capitals;
    this.standInFor = standInFor;
    this.runtime = runtime;
    this.log = log;
  }

  get label(): string {
    return !this.standInFor ? this.vendor : `${this.standInFor} (stand-in: ${this.vendor})`;
  }

  /** the command line that will run this emulator */
  command(quiet: boolean): [string, string[]] {
    const rel = path.relative(ROOT, this.script).split(path.sep).join("/");
    const ts = TS_PORTS[rel];
    const extra = quiet ? ["--quiet"] : [];
    if (this.runtime === "node" && ts) return [process.execPath, ["--experimental-strip-types", "--no-warnings", ts, ...this.args, ...extra]];
    const py = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    return [py, ["-u", this.script, ...this.args, ...extra]];
  }

  start(quiet: boolean): void {
    const [cmd, argv] = this.command(quiet);
    const proc = spawn(cmd, argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true });
    this.proc = proc;
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf-8");
      readline.createInterface({ input: stream }).on("line", (raw) => {
        const line = raw.trimEnd();
        if (line && !line.includes("DeprecationWarning") && !line.includes("re.split") && !line.includes("ExperimentalWarning")) {
          this.log(`[${this.standInFor ?? this.vendor}] ${line}`);
        }
      });
    }
    proc.on("error", (e) => this.log(`${this.label} failed to start: ${e.message}`));
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) {
        this.log(`${this.label} exited with code ${code ?? signal ?? "?"}`);
        this.proc = null;
      }
    });
    this.log(`started ${this.label.padEnd(28)} pid ${String(proc.pid ?? 0).padEnd(6)} map :${this.mapPort}  ${this.capitals.join(" ")}`);
  }

  async refresh(): Promise<void> {
    try {
      this.state = (await fetchJson(`http://127.0.0.1:${this.mapPort}/state`)) as EstateState;
      this.lastOk = now();
      this.error = null;
    } catch (exc) {
      this.error = errStr(exc);
    }
  }

  stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }
}

export interface EmulatorStatus {
  vendor: string;
  stand_in_for: string | null;
  map_port: number;
  capitals: string[];
  up: boolean;
  error: string | null;
}

export interface CombinedState extends EstateState {
  time: string;
  tz: string;
  totals: { users: number; users_calling: number; ports: number; calls: number; devices: number; emulators: number; emulators_up: number };
  devices: MapDevice[];
  links: MapLink[];
  scenario: unknown;
  emulators: EmulatorStatus[];
}

export class Launcher {
  reg: Registry;
  children: Child[] = [];
  only: Set<string> | null;
  private pollTimer: NodeJS.Timeout | null = null;
  private log: Log;

  constructor(registry: Registry, only: string | null = null, chaosIn: number | null = null, runtime: Runtime = "node", log: Log = defaultLog) {
    this.reg = registry;
    this.log = log;
    this.only = only ? new Set(only.split(",").map((v) => v.trim().toLowerCase())) : null;
    const standIn = registry.stand_in ?? "RTS";
    let standInScript: string | null = null;
    for (const v of registry.vendors) if (v.vendor.toLowerCase() === standIn.toLowerCase()) standInScript = path.join(ROOT, v.emulator);
    const chaos = chaosIn === null ? registry.chaos ?? 0.0 : chaosIn;
    for (const v of registry.vendors) {
      if (this.only && !this.only.has(v.vendor.toLowerCase())) continue;
      const script = path.join(ROOT, v.emulator);
      const common = ["--world", "--capitals", v.capitals.join(","), "--base-port", String(v.base_port), "--map-port", String(v.map_port), "--chaos", String(chaos)];
      if (existsSync(script)) this.children.push(new Child(v.vendor, script, [...common, "--vendor", v.vendor], v.map_port, v.capitals, null, runtime, log));
      else if (standInScript && existsSync(standInScript)) {
        this.children.push(new Child(standIn, standInScript, [...common, "--vendor", v.vendor], v.map_port, v.capitals, v.vendor, runtime, log));
      } else log(`no emulator for ${v.vendor} and no stand-in available`);
    }
  }

  startAll(quiet: boolean): void {
    for (const c of this.children) c.start(quiet);
  }

  stopAll(): Promise<void> {
    this.stopPolling();
    return Promise.all(this.children.map((c) => c.stop())).then(() => undefined);
  }

  // ---- combined state -------------------------------------------------------------
  startPolling(): void {
    const tick = async (): Promise<void> => {
      await Promise.all(this.children.map((c) => c.refresh()));
      this.pollTimer = setTimeout(() => void tick(), 1000);
    };
    void tick();
  }

  stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private isUp(c: Child): boolean {
    return !!c.state && now() - c.lastOk <= 10;
  }

  state(): CombinedState {
    const devices: MapDevice[] = [];
    const links: MapLink[] = [];
    const totals = { users: 0, users_calling: 0, ports: 0, calls: 0, devices: 0, emulators: this.children.length, emulators_up: 0 };
    for (const c of this.children) {
      const st = c.state;
      if (!st || now() - c.lastOk > 10) {
        // emulator not answering: show its capitals as offline placeholders
        for (const alpha of c.capitals) {
          const cap = CAPITALS.get(alpha);
          if (cap) {
            devices.push({
              name: alpha, type: "matrix", subtype: "?", vendor: c.standInFor ?? c.vendor,
              city: cap[0], country: cap[1], lat: cap[2], lon: cap[3], continent: cap[4], online: false,
              coverage_m: 400, color: "#666666", calls: [], note: `emulator not answering: ${c.error ?? "starting"}`,
            });
          }
        }
        continue;
      }
      totals.emulators_up += 1;
      for (const d0 of st.devices ?? []) {
        const d: MapDevice = { ...d0 };
        d.vendor = c.standInFor ?? (typeof d0.vendor === "string" && d0.vendor ? d0.vendor : c.vendor);
        if (c.standInFor) d.stand_in = c.vendor;
        d.emulator_map_port = c.mapPort;
        devices.push(d);
      }
      links.push(...(st.links ?? []));
      const t = st.totals ?? {};
      for (const k of ["users", "users_calling", "ports", "calls", "devices"] as const) totals[k] += t[k] ?? 0;
    }
    const scenario = this.children.map((c) => (c.state ? c.state.scenario : null)).find((s) => !!s) ?? null;
    return {
      time: isoNow(), tz: localTzLabel(), totals, devices, links, scenario,
      emulators: this.children.map((c) => ({ vendor: c.vendor, stand_in_for: c.standInFor, map_port: c.mapPort, capitals: c.capitals, up: this.isUp(c), error: c.error })),
    };
  }

  async action(name: string, params: Params): Promise<unknown> {
    if (name === "emulators") return this.state().emulators;
    const qs = new URLSearchParams(params).toString();
    if (name === "scenario") {
      // estate-wide: fan out to every emulator; the host city only exists in one of them, the others pick randomly
      const results = await Promise.all(this.children.map(async (c) => {
        try {
          return asRecord(await fetchJson(`http://127.0.0.1:${c.mapPort}/api/scenario?${qs}`, 5)).result ?? null;
        } catch (exc) {
          return { error: errStr(exc) };
        }
      }));
      const out: Record<string, unknown> = {};
      this.children.forEach((c, i) => {
        out[c.standInFor ?? c.vendor] = results[i];
      });
      return out;
    }
    if (name === "matrices") {
      const out: unknown[] = [];
      for (const c of this.children) {
        try {
          const r = asRecord(await fetchJson(`http://127.0.0.1:${c.mapPort}/api/matrices`)).result;
          if (Array.isArray(r)) out.push(...(r as unknown[]));
        } catch {
          // skipped
        }
      }
      return out;
    }
    const m = (params.matrix ?? "").toUpperCase();
    let owner: Child | null = null;
    for (const c of this.children) {
      if (c.capitals.map((x) => x.toUpperCase()).includes(m)) {
        owner = c;
        break;
      }
    }
    if (owner === null) {
      for (const c of this.children) {
        for (const d of c.state?.devices ?? []) {
          const nm = typeof d.name === "string" ? d.name.toUpperCase() : "";
          const al = typeof d.alpha === "string" ? d.alpha.toUpperCase() : "";
          if (nm === m || al === m) owner = c; // no break: the last match wins, as in Python
        }
      }
    }
    if (owner === null) throw new PyKeyError(`no emulator owns matrix '${m}'`);
    const data = asRecord(await fetchJson(`http://127.0.0.1:${owner.mapPort}/api/${name}?${qs}`, 5));
    if (!data.ok) throw new PyValueError(typeof data.error === "string" ? data.error : "emulator error");
    return data.result;
  }
}

// ----------------------------------------------------------------------------- CLI
interface LaunchArgs {
  registry: string;
  only: string | null;
  chaos: number | null;
  mapPort: number | null;
  list: boolean;
  quiet: boolean;
  runtime: Runtime;
}

export function parseLaunchArgs(argv: string[]): LaunchArgs {
  const a: LaunchArgs = { registry: path.join(TRUNK_SIM_DIR, "emulators.json"), only: null, chaos: null, mapPort: null, list: false, quiet: false, runtime: "node" };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i] as string;
    let v: string | undefined;
    const eq = k.startsWith("--") ? k.indexOf("=") : -1;
    if (eq > 0) {
      v = k.slice(eq + 1);
      k = k.slice(0, eq);
    }
    const val = (): string => {
      const x = v ?? argv[++i];
      if (x === undefined) throw new PyValueError(`argument ${k}: expected one argument`);
      return x;
    };
    if (k === "--list") a.list = true;
    else if (k === "--quiet") a.quiet = true;
    else if (k === "--registry") a.registry = val();
    else if (k === "--only") a.only = val();
    else if (k === "--chaos") a.chaos = pyFloat(val());
    else if (k === "--map-port") a.mapPort = pyInt(val());
    else if (k === "--runtime") {
      const r = val();
      if (r !== "node" && r !== "python") throw new PyValueError("argument --runtime: invalid choice: " + r);
      a.runtime = r;
    } else throw new PyValueError("unrecognized arguments: " + k);
  }
  return a;
}

export async function main(argv: string[] = process.argv.slice(2), log: Log = defaultLog): Promise<number> {
  let args: LaunchArgs;
  try {
    args = parseLaunchArgs(argv);
  } catch (e) {
    console.error("launch-all: error: " + errStr(e));
    return 2;
  }
  const reg = JSON.parse(readFileSync(args.registry, "utf-8")) as Registry;
  const launcher = new Launcher(reg, args.only, args.chaos, args.runtime, log);
  const port = args.mapPort || (reg.combined_map_port ?? 8080);
  if (args.list) {
    for (const c of launcher.children) {
      const [cmd, cargv] = c.command(args.quiet);
      const how = path.basename(cmd).toLowerCase().startsWith("node") ? "node " + path.relative(ROOT, cargv[2] ?? "") : "python";
      console.log(`${c.label.padEnd(30)} ${path.relative(ROOT, c.script).padEnd(60)} map :${c.mapPort}  ${c.capitals.length} capitals: ${c.capitals.join(", ")}  [${how}]`);
    }
    console.log(`combined map on :${port}`);
    return 0;
  }
  log("local time zone: " + localTzLabel());
  launcher.startAll(args.quiet);
  launcher.startPolling();
  const srv = new MapServer(() => launcher.state(), "0.0.0.0", port, log, (n, p) => launcher.action(n, p));
  try {
    await srv.start();
  } catch (e) {
    log(`combined map not started on ${port}: ${errStr(e)}`);
    await launcher.stopAll();
    return 1;
  }
  log(`combined map: http://127.0.0.1:${port}/   (${launcher.children.length} emulators)`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  log("stopping emulators");
  await launcher.stopAll();
  await srv.stop();
  return 0;
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }, (e: unknown) => {
    console.error(errStr(e));
    process.exitCode = 1;
  });
}
