/**
 * main.ts -- CLI of the pretend RTS / Telex intercom estate (port of rts_intercom_sim.py main(), lines 2380-2485).
 *
 *   node --experimental-strip-types simulator/src/rts/main.ts                     (world estate)
 *   node --experimental-strip-types simulator/src/rts/main.ts --world --capitals LOND,PARI --map-port 18999
 *   node --experimental-strip-types simulator/src/rts/main.ts --walk 127.0.0.1:16101
 *   node --experimental-strip-types simulator/src/rts/main.ts --trap-listener 16200
 *   node --experimental-strip-types simulator/src/rts/main.ts --check-mibs | --dump-oids
 *
 * Same flags as the Python script.  argparse prefix abbreviations (--cap for --capitals) are not supported.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { errStr, pyFloat, pyInt, pyJson } from "../py.ts";
import { toGeojson } from "../tc-map.ts";
import { checkMibs, clientGet, clientWalk, dumpOids, Estate, trapListener } from "./estate.ts";
import { Mib } from "./mib.ts";
import { type EstateConfig, parsePlan, spawnConfig, worldConfig } from "./world.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** _find_up: walk up until a folder with that name is found (the repo moves things around). */
export function findUp(folderName: string, start = HERE, levels = 8): string | null {
  let d = start;
  for (let i = 0; i < levels; i++) {
    d = path.dirname(d);
    const cand = path.join(d, folderName);
    if (existsSync(cand) && statSync(cand).isDirectory()) return cand;
  }
  return null;
}

/** The Telex MIB folder next to the Python simulator: KNOWN PROTOCOLS/VENDOR/RTS/SNMP. */
export function defaultMibFolder(): string {
  const kp = findUp("KNOWN PROTOCOLS");
  return kp ? path.join(kp, "VENDOR", "RTS", "SNMP") : path.join(HERE, "..", "SNMP");
}

export interface Args {
  mibs: string;
  config: string | null;
  spawn: string | null;
  world: boolean;
  plan: string | null;
  coverage: number;
  capitals: string | null;
  noSubsites: boolean;
  scenario: string;
  vendor: string;
  basePort: number;
  mapPort: number;
  center: string;
  community: string;
  trapTarget: string[];
  chaos: number;
  quiet: boolean;
  walk: string | null;
  get: string | null;
  oid: string[];
  v1: boolean;
  trapListener: number | null;
  dumpOids: boolean;
  checkMibs: boolean;
  writeConfig: string | null;
  exportGeojson: string | null;
}

const USAGE = "usage: main.ts [-h] [--mibs MIBS] [--config CONFIG] [--spawn SPAWN] [--world] [--plan PLAN] [--coverage COVERAGE] [--capitals CAPITALS] [--no-subsites] [--scenario SCENARIO] [--vendor VENDOR] [--base-port BASE_PORT] [--map-port MAP_PORT] [--center CENTER] [-c COMMUNITY] [--trap-target TRAP_TARGET] [--chaos CHAOS] [--quiet] [--walk HOST:PORT] [--get HOST:PORT] [--oid OID] [--v1] [--trap-listener PORT] [--dump-oids] [--check-mibs] [--write-config FILE] [--export-geojson FILE]";

export class ArgError extends Error {}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    mibs: defaultMibFolder(), config: null, spawn: null, world: false, plan: null, coverage: 400, capitals: null,
    noSubsites: false, scenario: "normal", vendor: "RTS", basePort: 16100, mapPort: 8080, center: "40.7128,-74.0060",
    community: "public", trapTarget: [], chaos: 0.0, quiet: false, walk: null, get: null, oid: [], v1: false,
    trapListener: null, dumpOids: false, checkMibs: false, writeConfig: null, exportGeojson: null,
  };
  const flags: Record<string, (args: Args) => void> = {
    "--world": (x) => { x.world = true; },
    "--no-subsites": (x) => { x.noSubsites = true; },
    "--quiet": (x) => { x.quiet = true; },
    "--v1": (x) => { x.v1 = true; },
    "--dump-oids": (x) => { x.dumpOids = true; },
    "--check-mibs": (x) => { x.checkMibs = true; },
  };
  const num = (k: string, v: string, f: (s: string) => number): number => {
    try {
      return f(v);
    } catch {
      throw new ArgError(`argument ${k}: invalid value: '${v}'`);
    }
  };
  const opts: Record<string, (x: Args, v: string) => void> = {
    "--mibs": (x, v) => { x.mibs = v; },
    "--config": (x, v) => { x.config = v; },
    "--spawn": (x, v) => { x.spawn = v; },
    "--plan": (x, v) => { x.plan = v; },
    "--coverage": (x, v) => { x.coverage = num("--coverage", v, pyFloat); },
    "--capitals": (x, v) => { x.capitals = v; },
    "--scenario": (x, v) => { x.scenario = v; },
    "--vendor": (x, v) => { x.vendor = v; },
    "--base-port": (x, v) => { x.basePort = num("--base-port", v, pyInt); },
    "--map-port": (x, v) => { x.mapPort = num("--map-port", v, pyInt); },
    "--center": (x, v) => { x.center = v; },
    "-c": (x, v) => { x.community = v; },
    "--community": (x, v) => { x.community = v; },
    "--trap-target": (x, v) => { x.trapTarget.push(v); },
    "--chaos": (x, v) => { x.chaos = num("--chaos", v, pyFloat); },
    "--walk": (x, v) => { x.walk = v; },
    "--get": (x, v) => { x.get = v; },
    "--oid": (x, v) => { x.oid.push(v); },
    "--trap-listener": (x, v) => { x.trapListener = num("--trap-listener", v, pyInt); },
    "--write-config": (x, v) => { x.writeConfig = v; },
    "--export-geojson": (x, v) => { x.exportGeojson = v; },
  };
  for (let i = 0; i < argv.length; i++) {
    let k = argv[i] as string;
    let v: string | undefined;
    const eq = k.startsWith("--") ? k.indexOf("=") : -1;
    if (eq > 0) {
      v = k.slice(eq + 1);
      k = k.slice(0, eq);
    }
    if (k === "-h" || k === "--help") throw new ArgError("help");
    const f = flags[k];
    if (f) {
      f(a);
      continue;
    }
    const o = opts[k];
    if (!o) throw new ArgError(`unrecognized arguments: ${argv[i] as string}`);
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined) throw new ArgError(`argument ${k}: expected one argument`);
    }
    o(a, v);
  }
  return a;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      if (e.message === "help") {
        console.log(USAGE);
        return 0;
      }
      console.error(USAGE + "\nmain.ts: error: " + e.message);
      return 2;
    }
    throw e;
  }

  const mib = new Mib().loadFolder(args.mibs);
  if (!mib.objects.size) {
    console.log(`no MIB objects loaded from ${args.mibs}`);
    return 2;
  }
  const version = args.v1 ? 0 : 1;

  if (args.checkMibs) {
    process.stdout.write(checkMibs(mib));
    return 0;
  }
  if (args.dumpOids) {
    process.stdout.write(dumpOids(mib));
    return 0;
  }
  if (args.trapListener) {
    const s = trapListener(mib, args.trapListener);
    await new Promise<void>((resolve) => process.once("SIGINT", () => {
      s.close();
      resolve();
    }));
    return 0;
  }
  if (args.walk) {
    await clientWalk(mib, args.walk, args.community, args.oid[0] ?? "", version);
    return 0;
  }
  if (args.get) {
    if (!args.oid.length) {
      console.error(USAGE + "\nmain.ts: error: --get needs at least one --oid");
      return 2;
    }
    await clientGet(mib, args.get, args.community, args.oid, version);
    return 0;
  }

  const center = args.center.split(",").map((x) => pyFloat(x)) as [number, number];
  let cfg: EstateConfig;
  if (args.config) {
    cfg = JSON.parse(readFileSync(args.config, "utf-8")) as EstateConfig;
    if (args.trapTarget.length) cfg.trap_targets = [...(cfg.trap_targets ?? []), ...args.trapTarget];
    if (args.chaos) cfg.chaos = args.chaos;
    if (cfg.map_port === undefined) cfg.map_port = args.mapPort;
  } else if (args.spawn && !args.world) {
    cfg = spawnConfig(args.spawn, args.basePort, args.community, args.trapTarget, args.chaos, center, args.mapPort);
    if (args.plan) for (const d of cfg.devices) if (d.type === "matrix") d.plan = parsePlan(args.plan);
  } else {
    if (!args.world) console.log("no --config or --spawn given; spawning the world estate: one intercom per country capital (56)");
    cfg = worldConfig({
      baseSnmp: args.basePort, community: args.community, trapTargets: args.trapTarget, chaos: args.chaos, mapPort: args.mapPort,
      plan: args.plan ? parsePlan(args.plan) : null, coverageM: args.coverage,
      capitals: args.capitals ? args.capitals.split(",").map((c) => c.trim().toUpperCase()) : null,
      vendor: args.vendor, subsites: !args.noSubsites,
    });
    cfg.scenario = args.scenario;
  }

  if (args.writeConfig) {
    writeFileSync(args.writeConfig, pyJson(cfg, { indent: 2 }), "utf-8");
    console.log(`wrote ${args.writeConfig}`);
    return 0;
  }

  for (const [fname, module] of mib.moduleMismatches()) if (!args.quiet) console.log(`note: ${fname} actually contains module ${module}`);
  if (!mib.modules.has("Telex-Icom-MIB") && !args.quiet) console.log(`note: Telex-Icom-MIB is not in ${args.mibs}; matrix devices answer the system group only`);

  const estate = new Estate(mib, cfg, !args.quiet);
  if (args.exportGeojson) {
    writeFileSync(args.exportGeojson, pyJson(toGeojson(estate.state()), { indent: 2 }), "utf-8");
    console.log(`wrote ${args.exportGeojson}`);
    return 0;
  }
  const stop = (): void => {
    void estate.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await estate.run();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
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
