/**
 * estate.ts -- all spawned devices + the map + the button API (rts_intercom_sim.py lines 1988-2197),
 * and the built-in SNMP client / trap listener / MIB reports (lines 2283-2378).
 */
import * as dgram from "node:dgram";
import { choice, isoNow, localTzLabel, now, pyFloat, pyInt, pyJson, PyKeyError, PyValueError, randint, req, rjust, ljust, sample, stamp } from "../py.ts";
import { type EstateState, MapServer, type MapLink, type Params } from "../tc-map.ts";
import {
  buildMessage, fmtValue, type Oid, oidCmp, oidParse, oidStr, parseMessage, PDU_GET, PDU_GETNEXT, PDU_INFORM, PDU_TRAPV1, PDU_TRAPV2,
  type SnmpMessage, type SnmpValue, TAG_ENDOFMIB, TAG_NAMES, TAG_NULL, TAG_OID, type VarBind,
} from "./ber.ts";
import { DEVICE_CLASSES, type Device, type DeviceMapState, type EstateLike, MatrixDevice, RvonDevice, type Scenario, TrunkMasterDevice } from "./devices.ts";
import { type Mib, splitextStem } from "./mib.ts";
import type { EstateConfig } from "./world.ts";

export const SCENARIOS: Readonly<Record<string, string>> = {
  quiet: "nothing happens unless someone presses a key",
  normal: "light random traffic everywhere, state capitals spike at local noon and on the hour",
  olympics: "a host city (pick one or random) is flooded: everyone trunks to it, its own traffic x4",
  sports: "several sporting venues at once: three random capitals run hot, the rest idle",
  evening: "evening events: cities where it is 18:00-23:00 local run hot, the rest sleep",
  breaking: "breaking news: everything x2 with bursts",
};

const PALETTE = ["#4cc9f0", "#f9c74f", "#90be6d", "#f3722c", "#b5179e", "#43aa8b", "#f94144", "#577590"];

export interface EstateTotals {
  users: number;
  users_calling: number;
  ports: number;
  calls: number;
  devices: number;
}

export interface RtsEstateState extends EstateState {
  time: string;
  tz: string;
  vendor: string;
  map_port: number;
  scenario: Scenario;
  totals: EstateTotals;
  devices: DeviceMapState[];
  links: MapLink[];
}

export type Writer = (line: string) => void;

export class Estate implements EstateLike {
  mib: Mib;
  bind: string;
  community: string;
  chaos: number;
  vendor: string;
  /** traffic scenario driven from the map footer */
  scenario: Scenario;
  mapPort: number;
  trapTargets: [string, number][] = [];
  stopped = false;
  verbose: boolean;
  devices: Device[] = [];
  map: MapServer | null = null;
  out: Writer;
  private tickTimer: NodeJS.Timeout | null = null;
  private done: (() => void) | null = null;

  constructor(mib: Mib, cfg: EstateConfig, verbose = true, out: Writer = (l) => process.stdout.write(l + "\n")) {
    this.mib = mib;
    this.out = out;
    this.bind = cfg.bind ?? "0.0.0.0";
    this.community = cfg.community ?? "public";
    this.chaos = pyFloat(cfg.chaos ?? 0.0);
    this.vendor = cfg.vendor ?? "RTS";
    this.scenario = { name: cfg.scenario ?? "normal", level: this.chaos, host: null, hosts: [], since: now() };
    this.mapPort = pyInt((cfg.map_port ?? 8080) || 0);
    for (const t of cfg.trap_targets ?? []) {
      const i = t.lastIndexOf(":");
      const host = i < 0 ? "" : t.slice(0, i);
      const port = i < 0 ? t : t.slice(i + 1);
      this.trapTargets.push([host || "127.0.0.1", pyInt(port || "162")]);
    }
    this.verbose = verbose;
    for (const dcfg of cfg.devices) {
      const cls = DEVICE_CLASSES[dcfg.type.toLowerCase()];
      if (!cls) throw new PyValueError(`unknown device type '${dcfg.type}' (matrix, rvon, tm2000)`);
      this.devices.push(new cls(this, { ...dcfg }));
    }
    const matrices = this.devices.filter((d): d is MatrixDevice => d instanceof MatrixDevice);
    for (const d of this.devices) if (d instanceof TrunkMasterDevice) d.populate(matrices);
    this.devices.forEach((d, i) => {
      if (!d.color) d.color = PALETTE[i % PALETTE.length] as string;
      if (d.coverageM === null && !d.coverage) d.coverageM = ({ matrix: 150, rvon: 50, tm2000: 80 } as Record<string, number>)[d.dtype] ?? 60;
    });
  }

  log(msg: string, warn = false): void {
    if (this.verbose || warn || msg.includes("cannot bind") || msg.includes("unavailable") || msg.includes("not started")) this.out(stamp(msg));
  }

  refreshTrunkMasters(): void {
    for (const d of this.devices) if (d instanceof TrunkMasterDevice) d.refreshAlphas();
  }

  matrices(): MatrixDevice[] {
    return this.devices.filter((d): d is MatrixDevice => d instanceof MatrixDevice);
  }

  // ---- traffic scenarios -------------------------------------------------------------
  setScenario(nameIn: string | null | undefined, level?: string | number | null, host?: string | null): Scenario {
    const name = (nameIn || "normal").toLowerCase();
    if (!(name in SCENARIOS)) throw new PyValueError("scenario must be one of " + Object.keys(SCENARIOS).join(", "));
    const mats = this.matrices().filter((d) => !d.parent);
    const sc: Scenario = {
      name, level: level !== undefined && level !== null ? pyFloat(level) : Math.max(this.scenario.level, 0.15),
      host: null, hosts: [], since: now(),
    };
    if (name === "olympics" && mats.length) {
      const h = host ? host.toUpperCase() : "";
      const hostm = mats.find((m) => host && (m.alpha4 === h || m.name.toUpperCase() === h)) ?? choice(mats);
      sc.host = hostm.alpha4;
    }
    if (name === "sports" && mats.length) sc.hosts = sample(mats, Math.min(3, mats.length)).map((m) => m.alpha4);
    this.scenario = sc;
    this.log("scenario -> " + pyJson(sc));
    return sc;
  }

  /** How busy matrix m should be right now (0 = silent, 1 = the old chaos=1). */
  trafficWeight(m: MatrixDevice): number {
    const sc = this.scenario;
    const { name, level } = sc;
    if (name === "quiet" || level <= 0) return 0.0;
    let w = level;
    const lh = m.localHour();
    if (name === "olympics") w *= m.alpha4 === sc.host || m.parent === sc.host ? 4.0 : 1.5;
    else if (name === "sports") w *= sc.hosts.includes(m.alpha4) || (m.parent !== null && sc.hosts.includes(m.parent)) ? 3.0 : 0.4;
    else if (name === "evening") w *= lh !== null && lh >= 18 && lh < 23 ? 3.0 : 0.25;
    else if (name === "breaking") w *= 2.0 + (Math.trunc(now()) % 20 < 4 ? 1.5 : 0);
    if (m.parent && lh !== null) {
      // the 8x8 frames: higher than normal hit at noon, on the hour, off the hour
      const minute = (lh % 1.0) * 60;
      if (lh >= 11.75 && lh < 12.25) w *= 6.0;
      else if (minute < 2 || minute > 58) w *= 3.0;
      else if (minute >= 29 && minute < 31) w *= 1.8;
    }
    return w;
  }

  // ---- button API (Stream Deck, Companion, PANELS/streamdeck_emulator.py) ------------------
  matrix(ref: string): MatrixDevice {
    for (const d of this.matrices()) if (ref && (d.name.toUpperCase() === ref.toUpperCase() || d.alpha4 === ref.toUpperCase())) return d;
    throw new PyKeyError(`no matrix '${ref}' (have: ${this.matrices().map((d) => d.alpha4).join(", ")})`);
  }

  action(name: string, p: Params): unknown {
    const on = ["1", "on", "true", "down", "press"].includes(String(p.state ?? "1").toLowerCase());
    if (name === "matrices") return this.matrices().map((d) => ({ name: d.name, alpha: d.alpha4, city: d.city, ports: d.nports, parent: d.parent }));
    if (name === "scenario") {
      if (p.name) return this.setScenario(p.name, p.level, p.host);
      return { ...this.scenario, available: SCENARIOS };
    }
    const m = this.matrix(p.matrix ?? "");
    if (name === "ports") {
      return [...m.ports.values()].map((q) => ({
        n: q.n, alpha: q.alpha, type: q.ptype, user: q.user, talk: q.canTalk, listen: q.canListen,
        live: !!q.endpoint, keys: Object.fromEntries([...q.keys].map(([k, t]) => [String(k), t])),
      }));
    }
    if (name === "port") return m.portState(m.portBy(req(p, "port")));
    if (name === "key") {
      const kind = (p.kind ?? "talk").toLowerCase();
      if (kind === "talk") m.talk(req(p, "port"), req(p, "target"), on);
      else if (kind === "listen") m.listen(req(p, "port"), req(p, "target"), on);
      else throw new PyValueError("kind must be talk or listen");
      return m.portState(m.portBy(req(p, "port")));
    }
    if (name === "call") return m.callRemote(req(p, "port"), req(p, "icom"), req(p, "remote"));
    if (name === "hangup") return m.hangup(req(p, "port"));
    if (name === "claim") {
      let n = pyInt(p.port || 0);
      if (n === 0) {
        const free = [...m.ports.values()].filter((q) => q.user && q.canTalk && q.endpoint === null);
        const f = free[0];
        if (!f) throw new PyValueError("no free panel port");
        n = f.n;
      }
      const q = m.ports.get(n);
      if (!q) throw new PyKeyError(n);
      if (q.endpoint && q.endpoint.addr !== null) throw new PyValueError(`port ${n} is live on an audio endpoint`);
      q.endpoint = { addr: null, name: p.name ?? "button panel", last: now(), frames: [], maxFrames: 1, seq: 0, since: now(), buttons: true };
      return { port: n, alpha: q.alpha, matrix: m.name };
    }
    if (name === "release") {
      const n = m.portBy(req(p, "port"));
      const q = m.ports.get(n);
      if (!q) throw new PyKeyError(n);
      if (q.endpoint && q.endpoint.buttons) {
        q.endpoint = null;
        m.clearPort(n);
      }
      return { port: n, released: true };
    }
    throw new PyKeyError(`unknown action '${name}'; GET /api/help`);
  }

  state(): RtsEstateState {
    const devices = this.devices.map((d) => d.mapState());
    const links: MapLink[] = [];
    const byAlpha = new Map(this.matrices().map((d) => [d.alpha4, d.name] as const));
    let users = 0, calls = 0, ports = 0, calling = 0;
    for (const d of this.matrices()) {
      ports += d.nports;
      users += d.users();
      calling += d.usersCalling();
      for (const c of d.activeCalls()) {
        calls += 1;
        const to = c.remote ? byAlpha.get(c.remote) : undefined;
        if (to !== undefined) links.push({ from_device: d.name, from_port: c.from, to_device: to, to_port: c.to, since: c.since });
      }
    }
    return {
      time: isoNow(), tz: localTzLabel(), vendor: this.vendor, map_port: this.mapPort, scenario: this.scenario,
      totals: { users, users_calling: calling, ports, calls, devices: this.devices.length },
      devices, links,
    };
  }

  /** Bind everything, start the map, send coldStart, tick every second.  Resolves when stop() is called. */
  async run(): Promise<void> {
    this.log("local time zone: " + localTzLabel());
    const starts: Promise<void>[] = [];
    for (const d of this.devices) {
      starts.push(d.serveSnmp(), d.serveConsole());
      if (d instanceof MatrixDevice && d.audio) starts.push(d.audio.start());
    }
    await Promise.all(starts);
    if (this.mapPort) {
      const srv = new MapServer(() => this.state(), this.bind, this.mapPort, (m) => this.log(m), (n, p) => this.action(n, p));
      try {
        await srv.start();
        this.map = srv;
      } catch (exc) {
        this.log(`map server not started on ${this.mapPort}: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const d of this.devices) d.trap("coldStart");
    this.log(`estate up: ${this.devices.length} device(s). Ctrl-C to stop.`);
    for (const d of this.devices) this.log("  " + d.summary());
    const finished = new Promise<void>((resolve) => {
      this.done = resolve;
    });
    this.tickTimer = setInterval(() => {
      for (const d of this.devices) {
        try {
          d.tick();
        } catch (exc) {
          this.log(`${d.name}: tick error ${exc instanceof Error ? exc.message : String(exc)}`);
        }
      }
    }, 1000);
    await finished;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const d of this.devices) d.close();
    if (this.map) await this.map.stop();
    this.log("estate stopping");
    this.done?.();
  }
}

// =============================================================================
// Built-in client / trap listener / reports
// =============================================================================
export function snmpRequest(host: string, port: number, community: string, pdu: number, varbinds: VarBind[], version = 1, timeout = 2.0, f1 = 0, f2 = 0): Promise<SnmpMessage> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      s.close();
      reject(new Error("timed out"));
    }, timeout * 1000);
    s.once("message", (data) => {
      clearTimeout(timer);
      s.close();
      try {
        resolve(parseMessage(data));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      s.close();
      reject(e);
    });
    s.send(buildMessage(version, community, pdu, randint(1, 2 ** 30), f1, f2, varbinds), port, host);
  });
}

export function target(t: string, defaultPort = 161): [string, number] {
  const i = t.lastIndexOf(":");
  const host = i < 0 ? "" : t.slice(0, i);
  const port = i < 0 ? t : t.slice(i + 1);
  return [host || "127.0.0.1", pyInt(port || String(defaultPort))];
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

export async function clientWalk(mib: Mib, tgt: string, community: string, startOid: string, version = 1, print: Writer = console.log): Promise<number> {
  const [host, port] = target(tgt);
  let cur: Oid = startOid && isDigit(startOid[0]) ? oidParse(startOid) : startOid ? mib.oid(startOid) : [1, 3, 6, 1];
  let count = 0;
  for (;;) {
    const r = await snmpRequest(host, port, community, PDU_GETNEXT, [[cur, TAG_NULL, null]], version);
    const vb = r.varbinds[0];
    if (r.f1 || !vb) {
      print(`error-status ${r.f1}`);
      break;
    }
    const [oid, tag, val] = vb;
    if (tag === TAG_ENDOFMIB || oidCmp(oid, cur) <= 0) break;
    print(`${ljust(mib.lookup(oid), 48)} = ${TAG_NAMES[tag] ?? "?"}: ${fmtValue(tag, val)}`);
    count += 1;
    cur = oid;
  }
  print(`-- ${count} objects`);
  return count;
}

export async function clientGet(mib: Mib, tgt: string, community: string, oids: string[], version = 1, print: Writer = console.log): Promise<void> {
  const [host, port] = target(tgt);
  const vbs: VarBind[] = [];
  for (const o of oids) {
    if (isDigit(o[0])) vbs.push([oidParse(o), TAG_NULL, null]);
    else {
      const i = o.indexOf(".");
      const name = i < 0 ? o : o.slice(0, i);
      const idx = i < 0 ? "" : o.slice(i + 1);
      vbs.push([[...mib.oid(name), ...(idx ? oidParse(idx) : [0])], TAG_NULL, null]);
    }
  }
  const r = await snmpRequest(host, port, community, PDU_GET, vbs, version);
  if (r.f1) print(`error-status ${r.f1} at index ${r.f2}`);
  for (const [oid, tag, val] of r.varbinds) print(`${ljust(mib.lookup(oid), 48)} = ${TAG_NAMES[tag] ?? "?"}: ${fmtValue(tag, val)}`);
}

export function trapListener(mib: Mib, port: number, print: Writer = console.log): dgram.Socket {
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  s.on("message", (data, rinfo) => {
    let msg: SnmpMessage;
    try {
      msg = parseMessage(data);
    } catch (exc) {
      print(`bad packet from ('${rinfo.address}', ${rinfo.port}): ${exc instanceof Error ? exc.message : String(exc)}`);
      return;
    }
    const kinds: Record<number, string> = { [PDU_TRAPV2]: "TRAPv2c", [PDU_INFORM]: "INFORM", [PDU_TRAPV1]: "TRAPv1" };
    const kind = kinds[msg.pdu] ?? `pdu 0x${msg.pdu.toString(16).padStart(2, "0")}`;
    print(`${stamp(kind)} from ${rinfo.address}:${rinfo.port} community=${msg.community}`);
    for (const [oid, tag, val] of msg.varbinds) {
      const shown = tag === TAG_OID && Array.isArray(val) ? mib.lookup(val as Oid) : fmtValue(tag, val as SnmpValue);
      print(`    ${ljust(mib.lookup(oid), 44)} = ${shown}`);
    }
  });
  s.bind(port, "0.0.0.0", () => print(`listening for traps on udp/${port} (Ctrl-C to stop)`));
  return s;
}

export function dumpOids(mib: Mib): string {
  const rows = [...mib.objects.values()].filter((o) => o.oid !== null).sort((a, b) => oidCmp(a.oid as Oid, b.oid as Oid));
  const lines = rows.map((o) => `${ljust(oidStr(o.oid as Oid), 36)} ${ljust(o.kind, 12)} ${ljust(o.name, 26)} ${ljust(o.access, 16)} ${(o.syntax || "").slice(0, 40)}`);
  lines.push(`-- ${rows.length} objects, ${mib.tcs.size} textual conventions, ${mib.modules.size} modules`);
  return lines.join("\n") + "\n";
}

export function checkMibs(mib: Mib): string {
  const lines = ["modules found (by content):"];
  for (const [module, fname] of [...mib.modules].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const flag = splitextStem(fname).toLowerCase() === module.toLowerCase() ? "" : "   <-- filename does not match module";
    lines.push(`  ${ljust(module, 22)} in ${fname}${flag}`);
  }
  const needed = ["Telex-REG", "Telex-Icom-TC", "Telex-Icom-MIB", "Telex-RVON-MIB", "Telex-TM-MIB"];
  const missing = needed.filter((n) => !mib.modules.has(n));
  if (missing.length) {
    lines.push("missing modules: " + missing.join(", "));
    if (missing.includes("Telex-Icom-MIB")) lines.push("  (Telex-Icom-MIB describes the matrix frame itself; without it matrix devices only answer the system group)");
  }
  for (const w of mib.warnings) lines.push("warning: " + w);
  return lines.join("\n") + "\n";
}

export { RvonDevice, rjust };
