/**
 * devices.ts -- the pretend boxes (rts_intercom_sim.py lines 697-1985):
 *   Device             OID store + SNMP v1/v2c agent (GET, GETNEXT, GETBULK, SET) + TCP console
 *   AudioEngine        a matrix's series of 256 UDP sockets speaking tc-protocol, 20 ms mixer
 *   MatrixDevice       ADAM / Cronus / Zeus-III frame: port plan, generated panels, calls, trunk calls
 *   RvonDevice         RVON-1/8/C/IO/16 VoIP device
 *   TrunkMasterDevice  TM-2000: trunks between every pair, noTrunksTrap, state changes
 *
 * Python threads -> Node event loop: each SNMP agent is a dgram socket, each console a
 * net.Server, the mixer a self-correcting setTimeout chain, threading.Timer -> setTimeout.
 * Locks disappear (single-threaded).  numpy is not needed: the mixer works on Float32Array.
 */
import * as dgram from "node:dgram";
import * as net from "node:net";
import { choice, errStr, fixed, isoNow, ljust, localTzLabel, now, pyBool, pyDictRepr, pyFloat, pyInt, PyKeyError, PyValueError, randint, rjust, rnd, uniform } from "../py.ts";
import * as tcp from "../tc-protocol.ts";
import {
  buildMessage, ERR_BADVALUE, ERR_NOERROR, ERR_NOSUCHNAME, ERR_NOTWRITABLE, ERR_READONLY, ERR_WRONGTYPE, fmtValue, type Oid, oidCmp, oidParse,
  oidStartsWith, oidStr, parseMessage, PDU_GET, PDU_GETBULK, PDU_GETNEXT, PDU_RESPONSE, PDU_SET, PDU_TRAPV2, type SnmpValue, TAG_ENDOFMIB,
  TAG_NAMES, TAG_NOSUCHINST, TAG_NOSUCHOBJ, TAG_NULL, TAG_OID, TAG_TIMETICKS, type VarBind,
} from "./ber.ts";
import { Mib, SYS_OIDS } from "./mib.ts";
import { buildPorts, DEFAULT_PLAN, type DeviceConfig, type Endpoint, generatePanels, type Plan, Port, PORT_TYPES } from "./world.ts";

export const TRUE = 1, FALSE = 2;
export function truth(b: boolean): number {
  return b ? TRUE : FALSE;
}

export function alphaBytes(text: string, size: number): Uint8Array {
  const b = Buffer.from(text, "utf-8").subarray(0, size);
  const out = Buffer.alloc(size, 0x20);
  b.copy(out);
  return out;
}

export interface Scenario {
  name: string;
  level: number;
  host: string | null;
  hosts: string[];
  since: number;
}

/** What a device needs from its estate (estate.ts implements it). */
export interface EstateLike {
  mib: Mib;
  bind: string;
  community: string;
  vendor: string;
  chaos: number;
  scenario: Scenario;
  trapTargets: [host: string, port: number][];
  devices: Device[];
  stopped: boolean;
  log(msg: string, warn?: boolean): void;
  trafficWeight(m: MatrixDevice): number;
  refreshTrunkMasters(): void;
}

type StoreValue = SnmpValue | (() => SnmpValue);
interface StoreEntry {
  oid: Oid;
  tag: number;
  value: StoreValue;
  writable: boolean;
}

export type Index = number | readonly number[];

export interface DeviceMapState {
  name: string;
  type: string;
  subtype: string;
  lat: number | null;
  lon: number | null;
  online: boolean;
  snmp_port: number;
  console_port: number;
  coverage_m: number | null;
  coverage: [number, number][] | null;
  color: string | null;
  city: string | null;
  country: string | null;
  continent: string | null;
  vendor: string;
  iso2: string | null;
  site_kind: string;
  parent: string | null;
  local_hour: number | null;
  [k: string]: unknown;
}

type Addr = { address: string; port: number };
const sameAddr = (a: Addr | null, b: Addr | null): boolean => !!a && !!b && a.address === b.address && a.port === b.port;

/** Bind a UDP socket; resolves {sock: null, error} when the port is refused. */
function bindUdp(port: number, host: string): Promise<{ sock: dgram.Socket | null; error: string }> {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.once("error", (e) => {
      s.close();
      resolve({ sock: null, error: e.message });
    });
    s.bind(port, host, () => {
      s.removeAllListeners("error");
      s.on("error", () => undefined);
      resolve({ sock: s, error: "" });
    });
  });
}

// =============================================================================
export abstract class Device {
  readonly estate: EstateLike;
  readonly mib: Mib;
  readonly cfg: DeviceConfig;
  name: string;
  dtype: string;
  subtype: string;
  snmpPort: number;
  consolePort: number;
  community: string;
  bind: string;
  lat: number | null;
  lon: number | null;
  coverageM: number | null;
  coverage: [number, number][] | null;
  color: string | null;
  city: string | null;
  country: string | null;
  continent: string | null;
  iso2: string | null;
  siteKind: string;
  parent: string | null;
  vendor: string;
  location: string;
  contact: string;
  start: number;
  store = new Map<string, StoreEntry>();
  private sorted: StoreEntry[] | null = null;
  stats = { in: 0, out: 0, badcomm: 0 };
  online = true;
  private snmpSock: dgram.Socket | null = null;
  private consoleSrv: net.Server | null = null;
  private sessions = new Set<net.Socket>();

  constructor(estate: EstateLike, cfg: DeviceConfig) {
    this.estate = estate;
    this.mib = estate.mib;
    this.cfg = cfg;
    this.name = cfg.name;
    this.dtype = cfg.type;
    this.subtype = cfg.subtype ?? "";
    this.snmpPort = pyInt(cfg.snmp_port ?? null);
    this.consolePort = pyInt(cfg.console_port || 0);
    this.community = cfg.community ?? estate.community;
    this.bind = cfg.bind ?? estate.bind;
    this.lat = cfg.lat ?? null;
    this.lon = cfg.lon ?? null;
    this.coverageM = cfg.coverage_m ?? null; // radius of the coloured coverage area on the map
    this.coverage = cfg.coverage ?? null; // or a polygon of the building
    this.color = cfg.color ?? null; // estate assigns one if missing
    this.city = cfg.city ?? null;
    this.country = cfg.country ?? null;
    this.continent = cfg.continent ?? null;
    this.iso2 = cfg.iso2 ?? null;
    this.siteKind = cfg.site_kind ?? "capital";
    this.parent = cfg.parent ?? null;
    this.vendor = cfg.vendor ?? estate.vendor;
    this.location = cfg.location || [this.city, this.country].filter((x): x is string => !!x).join(", ") || "Trunk-Caster lab";
    this.contact = cfg.contact ?? "simulator";
    this.start = now();
    // populateSystem() is called by each subclass once its own fields exist (Python set them before super().__init__)
  }

  log(msg: string): void {
    this.estate.log(msg);
  }

  // ---- OID store --------------------------------------------------------------
  uptimeTicks(): number {
    return Math.trunc((now() - this.start) * 100) >>> 0;
  }

  static idx(index: Index): number[] {
    return typeof index === "number" ? [index] : [...index];
  }

  put(name: string, index: Index, value: StoreValue, writable = false, tag: number | null = null): Oid {
    const oid = [...this.mib.oid(name), ...Device.idx(index)];
    this.store.set(oidStr(oid), { oid, tag: tag ?? this.mib.tagFor(name), value, writable });
    this.sorted = null;
    return oid;
  }

  get(name: string, index: Index = [0]): SnmpValue {
    const e = this.store.get(oidStr([...this.mib.oid(name), ...Device.idx(index)]));
    if (!e) return null;
    return typeof e.value === "function" ? e.value() : e.value;
  }

  getNum(name: string, index: Index = [0]): number {
    const v = this.get(name, index);
    return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
  }

  set(name: string, index: Index, value: SnmpValue): void {
    const key = oidStr([...this.mib.oid(name), ...Device.idx(index)]);
    const e = this.store.get(key);
    if (!e) throw new PyKeyError(`(${key.split(".").join(", ")})`);
    e.value = value;
  }

  bump(name: string, index: Index, by = 1): void {
    const e = this.store.get(oidStr([...this.mib.oid(name), ...Device.idx(index)]));
    if (e && typeof e.value === "number") e.value = (e.value + by) >>> 0;
  }

  sortedEntries(): StoreEntry[] {
    if (this.sorted === null) this.sorted = [...this.store.values()].sort((a, b) => oidCmp(a.oid, b.oid));
    return this.sorted;
  }

  read(oid: Oid): [tag: number, value: SnmpValue] | null {
    const e = this.store.get(oidStr(oid));
    if (!e) return null;
    return [e.tag, typeof e.value === "function" ? e.value() : e.value];
  }

  nextOid(oid: Oid): Oid | null {
    const keys = this.sortedEntries();
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (oidCmp((keys[mid] as StoreEntry).oid, oid) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < keys.length ? (keys[lo] as StoreEntry).oid : null;
  }

  existsPrefix(oid: Oid): boolean {
    for (let n = oid.length; n > 0; n--) {
      const k = oidStr(oid.slice(0, n));
      const obj = this.mib.byOid.get(k);
      if (obj) return obj.kind === "column" || obj.kind === "scalar";
      if (Mib.isSysOid(k)) return true;
    }
    return false;
  }

  // ---- system group -------------------------------------------------------------
  sysObjectId(): Oid {
    return this.mib.oid("objIdMtx1Frame");
  }

  sysDescr(): string {
    return `Pretend ${this.dtype} (${this.subtype || "generic"}) - Trunk-Caster simulator`;
  }

  populateSystem(): void {
    this.put("sysDescr", 0, this.sysDescr());
    this.put("sysObjectID", 0, this.sysObjectId());
    this.put("sysUpTime", 0, () => this.uptimeTicks());
    this.put("sysContact", 0, this.contact, true);
    this.put("sysName", 0, this.name, true);
    this.put("sysLocation", 0, this.location, true);
    this.put("sysServices", 0, 72);
    this.put("snmpInPkts", 0, () => this.stats.in);
    this.put("snmpOutPkts", 0, () => this.stats.out);
    this.put("snmpInBadCommunityNames", 0, () => this.stats.badcomm);
    this.put("snmpEnableAuthenTraps", 0, 2);
  }

  // ---- SNMP agent -----------------------------------------------------------------
  async serveSnmp(): Promise<void> {
    const { sock, error } = await bindUdp(this.snmpPort, this.bind);
    if (!sock) {
      this.log(`${this.name}: cannot bind SNMP udp/${this.snmpPort} (${error}); SNMP off for this device`);
      return;
    }
    this.snmpSock = sock;
    sock.on("message", (data, rinfo) => {
      if (this.estate.stopped || !this.online) return; // an offline frame does not answer
      try {
        const resp = this.handle(data, rinfo);
        if (resp) {
          sock.send(resp, rinfo.port, rinfo.address);
          this.stats.out += 1;
        }
      } catch (exc) {
        this.log(`${this.name}: bad SNMP packet from ${rinfo.address}:${rinfo.port} (${errStr(exc)})`);
      }
    });
  }

  handle(data: Uint8Array, addr: { address: string }): Buffer | null {
    this.stats.in += 1;
    const { version, community, pdu, reqId, f1, f2, varbinds: vbs } = parseMessage(data);
    if (community !== this.community) {
      this.stats.badcomm += 1;
      this.log(`${this.name}: wrong community '${community}' from ${addr.address}`);
      return null;
    }
    const v1 = version === 0;
    let out: VarBind[] = [];
    let err = ERR_NOERROR;
    let errIdx = 0;
    if (pdu === PDU_GET) {
      vbs.forEach(([oid], i) => {
        const r = this.read(oid);
        if (r === null) {
          if (v1) {
            err = ERR_NOSUCHNAME;
            errIdx = i + 1;
            out.push([oid, TAG_NULL, null]);
          } else out.push([oid, this.existsPrefix(oid) ? TAG_NOSUCHINST : TAG_NOSUCHOBJ, null]);
        } else out.push([oid, r[0], r[1]]);
      });
    } else if (pdu === PDU_GETNEXT) {
      vbs.forEach(([oid], i) => {
        const nxt = this.nextOid(oid);
        if (nxt === null) {
          if (v1) {
            err = ERR_NOSUCHNAME;
            errIdx = i + 1;
            out.push([oid, TAG_NULL, null]);
          } else out.push([oid, TAG_ENDOFMIB, null]);
        } else {
          const [t, v] = this.read(nxt) as [number, SnmpValue];
          out.push([nxt, t, v]);
        }
      });
    } else if (pdu === PDU_GETBULK && !v1) {
      const nonRep = Math.max(0, f1);
      const maxRep = Math.max(0, Math.min(f2, 200));
      for (const [oid] of vbs.slice(0, nonRep)) {
        const nxt = this.nextOid(oid);
        if (nxt === null) out.push([oid, TAG_ENDOFMIB, null]);
        else {
          const [t, v] = this.read(nxt) as [number, SnmpValue];
          out.push([nxt, t, v]);
        }
      }
      const cursors: (Oid | null)[] = vbs.slice(nonRep).map(([oid]) => oid);
      for (let r = 0; r < maxRep; r++) {
        let progressed = false;
        cursors.forEach((cur, k) => {
          if (cur === null) return;
          const nxt = this.nextOid(cur);
          if (nxt === null) {
            out.push([cur, TAG_ENDOFMIB, null]);
            cursors[k] = null;
          } else {
            const [t, v] = this.read(nxt) as [number, SnmpValue];
            out.push([nxt, t, v]);
            cursors[k] = nxt;
            progressed = true;
          }
        });
        if (!progressed) break;
      }
    } else if (pdu === PDU_SET) {
      for (let i = 0; i < vbs.length; i++) {
        const [oid, tag] = vbs[i] as VarBind;
        const e = this.store.get(oidStr(oid));
        if (!e) {
          err = v1 ? ERR_NOSUCHNAME : ERR_NOTWRITABLE;
          errIdx = i + 1;
          break;
        }
        if (!e.writable) {
          err = v1 ? ERR_READONLY : ERR_NOTWRITABLE;
          errIdx = i + 1;
          break;
        }
        if (tag !== e.tag) {
          err = v1 ? ERR_BADVALUE : ERR_WRONGTYPE;
          errIdx = i + 1;
          break;
        }
      }
      if (err === ERR_NOERROR) {
        for (const [oid, tag, val] of vbs) {
          const e = this.store.get(oidStr(oid));
          if (e) e.value = val;
          this.log(`${this.name}: SET ${this.mib.lookup(oid)} = ${fmtValue(tag, val)}`);
        }
      }
      out = vbs.map(([o, t, v]) => [o, t, v] as VarBind);
    } else return null;
    return buildMessage(version, community, PDU_RESPONSE, reqId, err, errIdx, out);
  }

  // ---- traps ------------------------------------------------------------------------
  trap(notificationName: string, varbinds: readonly [name: string, index: Index, value: SnmpValue][] = []): void {
    const targets = this.estate.trapTargets;
    if (!targets.length) return;
    const vbs: VarBind[] = [
      [[...(SYS_OIDS.sysUpTime as Oid), 0], TAG_TIMETICKS, this.uptimeTicks()],
      [[...(SYS_OIDS.snmpTrapOID as Oid), 0], TAG_OID, this.mib.oid(notificationName)],
    ];
    for (const [name, index, value] of varbinds) vbs.push([[...this.mib.oid(name), ...Device.idx(index)], this.mib.tagFor(name), value]);
    const msg = buildMessage(1, this.community, PDU_TRAPV2, randint(1, 2 ** 30), 0, 0, vbs);
    const s = dgram.createSocket("udp4");
    let pending = targets.length;
    for (const [host, port] of targets) {
      s.send(msg, port, host, (e) => {
        if (e) this.log(`${this.name}: trap to ${host}:${port} failed (${e.message})`);
        if (--pending === 0) s.close();
      });
    }
    this.log(`${this.name}: TRAP ${notificationName}`);
  }

  // ---- console ------------------------------------------------------------------------
  serveConsole(): Promise<void> {
    if (!this.consolePort) return Promise.resolve();
    return new Promise((resolve) => {
      const srv = net.createServer((conn) => this.consoleSession(conn));
      srv.once("error", (e) => {
        this.log(`${this.name}: cannot bind console tcp/${this.consolePort} (${e.message}); console off for this device`);
        resolve();
      });
      srv.listen({ port: this.consolePort, host: this.bind, backlog: 4, exclusive: true }, () => {
        srv.removeAllListeners("error");
        srv.on("error", () => undefined);
        this.consoleSrv = srv;
        resolve();
      });
    });
  }

  consoleSession(conn: net.Socket): void {
    this.sessions.add(conn);
    const send = (txt: string): void => {
      if (!conn.destroyed) conn.write(Buffer.from(txt + "\r\n", "utf-8"));
    };
    const prompt = (): void => {
      if (!conn.destroyed) conn.write(`${this.name}> `);
    };
    send(`${this.name}  [${this.dtype}/${this.subtype || "-"}]  pretend RTS console. Type 'help'.`);
    prompt();
    let buf = Buffer.alloc(0);
    conn.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let nl = buf.indexOf(0x0a);
      while (nl >= 0) {
        const line = buf.subarray(0, nl).toString("utf-8").trim();
        buf = buf.subarray(nl + 1);
        nl = buf.indexOf(0x0a);
        if (this.estate.stopped) {
          conn.destroy();
          return;
        }
        if (!line) {
          prompt();
          continue;
        }
        if (["quit", "exit", "bye"].includes(line.toLowerCase())) {
          send("bye");
          conn.end();
          return;
        }
        let reply: string;
        try {
          reply = this.consoleCommand(line.split(/\s+/).filter(Boolean));
        } catch (exc) {
          reply = "error: " + errStr(exc);
        }
        const lines = (reply || "ok").split(/\r\n|\r|\n/);
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        for (const ln of lines) send(ln);
        prompt();
      }
    });
    conn.on("error", () => undefined);
    conn.on("close", () => this.sessions.delete(conn));
  }

  consoleHelp(): string[] {
    return [
      "help                 this list",
      "show                 device summary",
      "walk [prefix]        dump this device's OID store",
      "sysname <text>       change sysName",
      "geo <lat> <lon>      move this device on the map",
      "coverage <metres>    radius of the coloured coverage area on the map",
      "color <#rrggbb>      coverage colour",
      "offline | online     stop/start answering (SNMP and Trunk Master)",
      "trap <notification>  fire a raw notification by MIB name (e.g. warmStart)",
      "quit",
    ];
  }

  consoleCommand(argv: string[]): string {
    const cmd = (argv[0] ?? "").toLowerCase();
    const a = argv.slice(1);
    if (cmd === "help") return this.consoleHelp().join("\n");
    if (cmd === "show") return this.summary();
    if (cmd === "walk") {
      const prefix = a[0] !== undefined ? oidParse(a[0]) : [];
      const lines: string[] = [];
      for (const e of this.sortedEntries()) {
        if (!oidStartsWith(e.oid, prefix)) continue;
        const [t, v] = this.read(e.oid) as [number, SnmpValue];
        // Python crashed here on str values ('str' object has no attribute 'hex'); fmtValue handles them
        lines.push(`${ljust(this.mib.lookup(e.oid), 40)} ${ljust(TAG_NAMES[t] ?? "?", 10)} ${fmtValue(t, v)}`);
      }
      return lines.join("\n") || "(nothing under that prefix)";
    }
    if (cmd === "sysname" && a.length) {
      this.set("sysName", 0, a.join(" "));
      return "sysName = " + a.join(" ");
    }
    if (cmd === "geo" && a.length >= 2) {
      this.lat = pyFloat(a[0]);
      this.lon = pyFloat(a[1]);
      return `now at ${fixed(this.lat, 5)}, ${fixed(this.lon, 5)}`;
    }
    if (cmd === "coverage" && a.length) {
      this.coverageM = pyFloat(a[0]);
      this.coverage = null;
      return `coverage radius ${a[0] ?? ""} m`;
    }
    if (cmd === "color" && a.length) {
      this.color = a[0] ?? null;
      return `coverage colour ${a[0] ?? ""}`;
    }
    if (cmd === "offline" || cmd === "online") {
      this.setOnline(cmd === "online");
      return `${this.name} is now ${cmd}`;
    }
    if (cmd === "trap" && a.length) {
      this.trap(a[0] as string);
      return "sent " + (a[0] as string);
    }
    return `unknown command '${cmd}' (try help)`;
  }

  setOnline(on: boolean): void {
    this.online = on;
  }

  summary(): string {
    return `${this.name}  type=${this.dtype} subtype=${this.subtype} snmp=udp/${this.snmpPort} console=tcp/${this.consolePort} community=${this.community} online=${pyBool(this.online)} uptime=${fixed(now() - this.start, 0)}s objects=${this.store.size}`;
  }

  tick(): void {
    // nothing by default
  }

  mapState(): DeviceMapState {
    return {
      name: this.name, type: this.dtype, subtype: this.subtype, lat: this.lat, lon: this.lon,
      online: this.online, snmp_port: this.snmpPort, console_port: this.consolePort,
      coverage_m: this.coverageM, coverage: this.coverage, color: this.color,
      city: this.city, country: this.country, continent: this.continent, vendor: this.vendor,
      iso2: this.iso2, site_kind: this.siteKind, parent: this.parent,
      local_hour: this.localHour(),
    };
  }

  /** Solar local time from longitude, as a decimal hour (used for noon / evening traffic). */
  localHour(): number | null {
    if (this.lon === null) return null;
    const d = new Date();
    const h = (((d.getUTCHours() + d.getUTCMinutes() / 60.0 + this.lon / 15.0) % 24.0) + 24.0) % 24.0;
    return Math.round(h * 100) / 100;
  }

  close(): void {
    this.snmpSock?.close();
    this.snmpSock = null;
    for (const s of this.sessions) s.destroy();
    this.consoleSrv?.close();
    this.consoleSrv = null;
  }
}

// =============================================================================
/**
 * The matrix's series of sockets: series + 0 is the intercom's own socket (HELLO with port=0
 * or a wanted port, and it tells you which socket is yours); series + n is port n's socket,
 * spoken to only by the endpoint that claimed port n.  Pretend panels feed their tone
 * generator into the mix when they talk.
 */
export class AudioEngine {
  readonly m: MatrixDevice;
  readonly series: number;
  readonly name: string;
  socks = new Map<number, dgram.Socket>();
  endpoints = new Map<number, Endpoint>();
  seq = 0;
  frameCount = 0;
  bound = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(matrix: MatrixDevice, series: number) {
    this.m = matrix;
    this.series = Math.trunc(series);
    this.name = matrix.name + "-audio";
  }

  socketFor(n: number): number {
    return this.series + n;
  }

  async start(): Promise<void> {
    const wanted = [0, ...[...this.m.ports.keys()].filter((n) => n <= 255).sort((a, b) => a - b)];
    const socks = await Promise.all(wanted.map((n) => bindUdp(this.series + n, this.m.bind).then((r) => [n, r.sock, r.error] as const)));
    for (const [n, s, why] of socks) {
      if (!s) {
        this.m.log(`${this.m.name}: cannot bind socket udp/${this.series + n} for port ${n} (${why})`);
        continue;
      }
      this.socks.set(n, s);
      this.bound += 1;
      s.on("message", (data, rinfo) => {
        if (this.stopped) return;
        const msg = tcp.unpack(data);
        if (!msg) return;
        try {
          this.onMessage(n, msg.type, msg.port, msg.payload, { address: rinfo.address, port: rinfo.port });
        } catch (exc) {
          this.m.log(`${this.m.name} audio: ${errStr(exc)}`);
        }
      });
    }
    if (!this.socks.has(0)) {
      this.m.log(`${this.m.name}: series socket udp/${this.series} unavailable; audio off for this matrix`);
      return;
    }
    if (this.m.ports.size > 255) this.m.log(`${this.m.name}: ${this.m.ports.size} ports but a series holds 255 sockets; ports above 255 have no socket`);
    this.startMixer();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.socks.values()) s.close();
    this.socks.clear();
  }

  send(port: number, addr: Addr, data: Buffer): void {
    const s = this.socks.get(port) ?? this.socks.get(0);
    if (!s) return;
    try {
      s.send(data, addr.port, addr.address);
    } catch {
      // OSError: ignored
    }
  }

  nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  // ---- claiming ---------------------------------------------------------------------
  /** Give `addr` port `port` (0 = next free panel).  Returns the port or null. */
  claim(portIn: number, name: string, addr: Addr): number | null {
    const m = this.m;
    let port = portIn;
    for (const [n, e] of this.endpoints) {
      if (sameAddr(e.addr, addr)) {
        e.last = now();
        e.name = name;
        return n;
      }
    }
    const p = m.ports.get(port);
    if (port === 0 || p === undefined || !this.socks.has(p.n) || (p.endpoint && p.endpoint.addr !== null && !sameAddr(p.endpoint.addr, addr))) {
      const free = [...m.ports.values()].filter((q) => q.user && q.canTalk && q.endpoint === null && this.socks.has(q.n));
      const f = free[0];
      if (!f) return null;
      port = f.n;
    }
    const ep: Endpoint = { addr, name, last: now(), frames: [], maxFrames: 6, seq: 0, since: now() };
    this.endpoints.set(port, ep);
    (m.ports.get(port) as Port).endpoint = ep;
    m.log(`${m.name}: endpoint '${name}' from ${addr.address}:${addr.port} took port ${port} ${(m.ports.get(port) as Port).alpha} on socket udp/${this.series + port}`);
    return port;
  }

  helloAck(port: number, addr: Addr): void {
    const m = this.m;
    const info: tcp.HelloAck = {
      port, alpha: m.portAlpha(port), matrix: m.name, tz: localTzLabel(),
      series: this.series, socket: this.series + port,
      ports: [...m.ports.values()].map((p) => ({ n: p.n, alpha: p.alpha, type: p.ptype, user: p.user, socket: this.series + p.n })),
    };
    this.send(port, addr, tcp.packHelloAck(port, this.nextSeq(), info));
    this.sendState(port);
  }

  onMessage(sockN: number, mtype: number, hdrPort: number, payload: Buffer, addr: Addr): void {
    const m = this.m;
    if (sockN === 0) {
      // the intercom's own socket only hands out ports
      if (mtype === tcp.TYPE_HELLO) {
        const port = this.claim(hdrPort, payload.toString("utf-8") || "endpoint", addr);
        if (port === null) return;
        // answer from the intercom socket so the endpoint learns where to go
        this.send(0, addr, tcp.packHelloAck(port, this.nextSeq(), {
          port, alpha: m.portAlpha(port), matrix: m.name, tz: localTzLabel(),
          series: this.series, socket: this.series + port, ports: [],
        }));
      }
      return;
    }
    const port = sockN; // the socket decides the port, not the header
    const ep = this.endpoints.get(port);
    if (mtype === tcp.TYPE_HELLO) {
      if (ep === undefined || sameAddr(ep.addr, addr)) {
        const got = this.claim(port, payload.toString("utf-8") || "endpoint", addr);
        if (got === port) this.helloAck(port, addr);
      } else {
        m.log(`${m.name}: ${addr.address}:${addr.port} tried socket udp/${this.series + port} but port ${port} belongs to '${ep.name}'`);
      }
      return;
    }
    if (ep === undefined || !sameAddr(ep.addr, addr)) return; // it and only it
    ep.last = now();
    if (mtype === tcp.TYPE_AUDIO) {
      if (payload.length >= tcp.FRAME_BYTES) {
        ep.frames.push(Buffer.from(payload.subarray(0, tcp.FRAME_BYTES)));
        while (ep.frames.length > ep.maxFrames) ep.frames.shift();
      }
    } else if (mtype === tcp.TYPE_KEY) {
      const { kind, target, state } = tcp.unpackKey(payload);
      if (kind === tcp.KEY_TALK) m.talk(port, target, state);
      else m.listen(port, target, state);
      this.sendState(port);
    } else if (mtype === tcp.TYPE_BYE) this.drop(port);
  }

  drop(port: number): void {
    const ep = this.endpoints.get(port);
    this.endpoints.delete(port);
    if (ep) {
      const p = this.m.ports.get(port);
      if (p) p.endpoint = null;
      this.m.clearPort(port);
      this.m.log(`${this.m.name}: endpoint '${ep.name}' left port ${port}`);
    }
  }

  sendState(port: number): void {
    const ep = this.endpoints.get(port);
    if (ep && ep.addr !== null) this.send(port, ep.addr, tcp.packState(port, this.nextSeq(), this.m.portState(port)));
  }

  broadcastState(): void {
    for (const port of [...this.endpoints.keys()]) this.sendState(port);
  }

  // ---- the 20 ms mixer loop ------------------------------------------------------------
  private startMixer(): void {
    const frameS = tcp.FRAME_MS / 1000.0;
    const n = tcp.FRAME_SAMPLES;
    const tIdx = new Float32Array(n);
    for (let i = 0; i < n; i++) tIdx[i] = i / tcp.SAMPLE_RATE;
    let nextT = performance.now() / 1000;
    let lastState = 0.0;
    const m = this.m;

    const step = (): void => {
      if (this.stopped || m.estate.stopped) return;
      this.frameCount += 1;
      const t = now();
      for (const [port, ep] of [...this.endpoints]) if (t - ep.last > tcp.ENDPOINT_TIMEOUT) this.drop(port);
      const live = [...this.endpoints].filter(([, ep]) => ep.addr !== null);
      if (!live.length) {
        // nobody listening: idle cheaply
        nextT = performance.now() / 1000 + 0.1;
        schedule();
        return;
      }
      const sources = new Map<number, Float32Array | null>();
      const src = (pn: number): Float32Array | null => {
        if (sources.has(pn)) return sources.get(pn) ?? null;
        const p = m.ports.get(pn);
        let out: Float32Array | null = null;
        if (p !== undefined) {
          if (p.endpoint !== null && p.endpoint.addr !== null) {
            const fr = p.endpoint.frames.shift();
            if (fr) {
              out = new Float32Array(n);
              for (let i = 0; i < n; i++) out[i] = fr.readInt16LE(i * 2);
            }
          } else if (m.talks.get(pn)?.size) {
            if (Math.floor(this.frameCount / 20) % 3 !== 2) {
              // 400 ms on / 200 ms off identifying tone
              out = new Float32Array(n);
              const w = 2 * Math.PI * p.freq;
              for (let i = 0; i < n; i++) out[i] = 6000.0 * Math.fround(Math.sin(w * (tIdx[i] as number) + p.phase));
            }
            p.phase = (p.phase + 2 * Math.PI * p.freq * frameS) % (2 * Math.PI);
          }
        }
        sources.set(pn, out);
        return out;
      };
      for (const [port, ep] of live) {
        const mix = new Float32Array(n);
        const heard = new Set<number>();
        for (const [talker, targets] of m.talks) if (targets.has(port) && talker !== port) heard.add(talker);
        for (const sPort of m.listens.get(port) ?? []) {
          heard.add(sPort);
          for (const [talker, targets] of m.talks) if (targets.has(sPort) && talker !== port) heard.add(talker);
        }
        for (const h of heard) {
          const frame = src(h);
          if (frame) for (let i = 0; i < n; i++) (mix[i] as number) += frame[i] as number;
        }
        const pcm = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.trunc(Math.max(-32767, Math.min(32767, mix[i] as number))), i * 2);
        this.send(port, ep.addr as Addr, tcp.packAudio(port, this.nextSeq(), pcm));
      }
      if (t - lastState > 1.0) {
        lastState = t;
        this.broadcastState();
      }
      nextT += frameS;
      const lag = performance.now() / 1000 - nextT;
      if (lag > 0.5) nextT = performance.now() / 1000;
      schedule();
    };
    const schedule = (): void => {
      if (this.stopped) return;
      const delay = Math.max(0, (nextT - performance.now() / 1000) * 1000);
      this.timer = setTimeout(step, delay);
      this.timer.unref();
    };
    nextT += frameS;
    schedule();
  }
}

// =============================================================================
type TalkKey = number | string; // int port, or "ALPHA:port" for a trunk call

export interface ActiveCall {
  from: string;
  from_n: number;
  to: string;
  to_n: number;
  remote: string | null;
  since: number;
}

const MATRIX_SUBTYPES: Readonly<Record<string, string>> = {
  adam: "objIdMtx1Frame", "adam-bus": "objIdMtxBusExpanded", cronus: "objIdMtxCronus",
  zeus3: "objIdMtxZeusIII", zeus3lite: "objIdMtxZeusIIILite",
};

/** ADAM / Cronus / Zeus-III frame with a port plan, generated panels, call state, tone generators and the audio port. */
export class MatrixDevice extends Device {
  static readonly SUBTYPES = MATRIX_SUBTYPES;
  subtypeKey: string;
  plan: Plan;
  ports: Map<number, Port>;
  alpha4: string;
  alpha8: string;
  /** from port -> {to: since} (to = int port, or "ALPHA:port" for a trunk call) */
  talks = new Map<number, Map<TalkKey, number>>();
  /** port -> set(source ports) */
  listens = new Map<number, Set<number>>();
  /** (from, to) -> end time, for chaos-generated calls */
  autoCalls = new Map<string, { from: number; to: TalkKey; end: number }>();
  /** from port -> trunk number on the Trunk Master */
  trunkCalls = new Map<number, number>();
  series: number;
  audioPort: number;
  audio: AudioEngine | null = null;

  private static prep(cfg: DeviceConfig): DeviceConfig {
    const key = (cfg.subtype || "adam").toLowerCase();
    if (!(key in MATRIX_SUBTYPES)) throw new PyValueError("matrix subtype must be one of " + Object.keys(MATRIX_SUBTYPES).join(", "));
    cfg.subtype = key;
    return cfg;
  }

  constructor(estate: EstateLike, cfgIn: DeviceConfig) {
    const cfg = MatrixDevice.prep(cfgIn);
    super(estate, cfg);
    this.subtypeKey = cfg.subtype as string;
    const plan = cfg.plan && cfg.plan.length ? cfg.plan : DEFAULT_PLAN;
    this.plan = plan.map(([t, c]) => [t.toUpperCase(), Math.trunc(c)] as [string, number]);
    this.ports = buildPorts(this.plan, cfg.port_names);
    generatePanels(this.ports);
    this.alpha4 = (cfg.alpha || cfg.name.slice(0, 4)).toUpperCase().slice(0, 4);
    this.alpha8 = (cfg.alpha8 || cfg.name.slice(0, 8)).toUpperCase().slice(0, 8);
    this.series = pyInt(cfg.series || cfg.audio_port || 0); // first socket of this intercom's series of 256
    this.audioPort = this.series;
    this.populateSystem();
    if (this.series) this.audio = new AudioEngine(this, this.series);
  }

  get nports(): number {
    return this.ports.size;
  }

  portAlpha(n: number): string {
    const p = this.ports.get(n);
    if (!p) throw new PyKeyError(n);
    return p.alpha;
  }

  override sysObjectId(): Oid {
    return this.mib.oid(MATRIX_SUBTYPES[this.subtypeKey] as string);
  }

  override sysDescr(): string {
    return `Pretend RTS ${this.subtypeKey.toUpperCase()} matrix frame, ${this.ports.size} ports (Telex-Icom-MIB not loaded) - Trunk-Caster simulator`;
  }

  // ---- call model ---------------------------------------------------------------
  /** port number from a number or an alpha */
  portBy(ref: number | string): number {
    if (typeof ref === "number") return ref;
    if (/^\d+$/.test(ref)) return Number.parseInt(ref, 10);
    for (const p of this.ports.values()) if (p.alpha.toUpperCase() === ref.toUpperCase()) return p.n;
    throw new PyKeyError(`no port '${ref}'`);
  }

  talk(frmIn: number | string, to: number | string, on = true): void {
    const frm = this.portBy(frmIn);
    const toKey: TalkKey = typeof to === "string" && to.includes(":") ? to : this.portBy(to);
    const p = this.ports.get(frm);
    if (p === undefined) throw new PyKeyError(`no port ${frm}`);
    if (on && !p.canTalk) throw new PyValueError(`${p.alpha} (${p.ptype}) cannot talk`);
    if (on) {
      let d = this.talks.get(frm);
      if (!d) {
        d = new Map();
        this.talks.set(frm, d);
      }
      d.set(toKey, now());
    } else {
      const d = this.talks.get(frm);
      if (d) {
        d.delete(toKey);
        if (!d.size) this.talks.delete(frm);
      }
    }
    if (this.audio && typeof toKey === "number") this.audio.sendState(toKey);
  }

  listen(portIn: number | string, srcIn: number | string, on = true): void {
    const port = this.portBy(portIn);
    const src = this.portBy(srcIn);
    if (on) {
      let s = this.listens.get(port);
      if (!s) {
        s = new Set();
        this.listens.set(port, s);
      }
      s.add(src);
    } else {
      const s = this.listens.get(port);
      if (s) {
        s.delete(src);
        if (!s.size) this.listens.delete(port);
      }
    }
  }

  clearPort(port: number): void {
    this.talks.delete(port);
    this.listens.delete(port);
    for (const d of this.talks.values()) d.delete(port);
    this.hangup(port);
  }

  callRemote(frmIn: number | string, icomAlpha: string, remotePort: number | string): string {
    const frm = this.portBy(frmIn);
    const tms = this.estate.devices.filter((d): d is TrunkMasterDevice => d instanceof TrunkMasterDevice);
    const tm = tms[0];
    if (!tm) return "no Trunk Master spawned";
    const rp = pyInt(remotePort);
    const [tk, text] = tm.requestTrunk(this.alpha4, frm, icomAlpha, rp);
    if (tk) {
      this.trunkCalls.set(frm, tk);
      this.talk(frm, `${icomAlpha.toUpperCase()}:${rp}`, true);
    }
    return text;
  }

  hangup(frmIn: number | string): string {
    const frm = this.portBy(frmIn);
    const tk = this.trunkCalls.get(frm);
    this.trunkCalls.delete(frm);
    const d = this.talks.get(frm);
    if (d) {
      for (const k of [...d.keys()]) if (typeof k === "string") d.delete(k);
      if (!d.size) this.talks.delete(frm);
    }
    if (tk) {
      for (const tm of this.estate.devices) if (tm instanceof TrunkMasterDevice) return tm.releaseTrunk(tk);
    }
    return `port ${frm} has no trunk call`;
  }

  activeCalls(): ActiveCall[] {
    const out: ActiveCall[] = [];
    for (const [frm, targets] of this.talks) {
      for (const [to, since] of targets) {
        const fromAlpha = this.ports.get(frm)?.alpha ?? String(frm);
        if (typeof to === "string") {
          const i = to.indexOf(":");
          const alpha = i < 0 ? to : to.slice(0, i);
          const rp = i < 0 ? "" : to.slice(i + 1);
          out.push({ from: fromAlpha, from_n: frm, to: "P" + rp, to_n: pyInt(rp), remote: alpha, since });
        } else {
          out.push({ from: fromAlpha, from_n: frm, to: this.ports.get(to)?.alpha ?? String(to), to_n: to, remote: null, since });
        }
      }
    }
    return out;
  }

  usersCalling(): number {
    let n = 0;
    for (const [frm, t] of this.talks) if (t.size && this.ports.get(frm)?.user) n += 1;
    return n;
  }

  users(): number {
    let n = 0;
    for (const p of this.ports.values()) if (p.user) n += 1;
    return n;
  }

  portState(port: number): tcp.PortState {
    const mine = this.talks.get(port);
    const talkingTo = [...(mine?.keys() ?? [])].filter((k): k is number => typeof k === "number").sort((a, b) => a - b);
    const remote = [...(mine?.keys() ?? [])].filter((k): k is string => typeof k === "string");
    const incoming: tcp.IncomingCall[] = [];
    for (const [frm, targets] of this.talks) {
      const since = targets.get(port);
      if (since !== undefined && frm !== port) incoming.push({ port: frm, alpha: this.portAlpha(frm), since });
    }
    const listening = [...(this.listens.get(port) ?? [])].sort((a, b) => a - b);
    return {
      port, alpha: this.portAlpha(port), matrix: this.name, talking_to: talkingTo,
      remote, listening, incoming, users: this.users(), users_calling: this.usersCalling(), time: isoNow(),
    };
  }

  override setOnline(on: boolean): void {
    super.setOnline(on);
    for (const tm of this.estate.devices) if (tm instanceof TrunkMasterDevice) tm.icomStatusChanged(this);
  }

  // ---- behaviour --------------------------------------------------------------------
  override tick(): void {
    const t = now();
    for (const [key, c] of [...this.autoCalls]) {
      if (t > c.end) {
        this.autoCalls.delete(key);
        try {
          this.talk(c.from, c.to, false);
        } catch {
          // ignored
        }
      }
    }
    const w = this.estate.trafficWeight(this);
    if (w && rnd() < Math.min(0.95, w * 0.3)) {
      const talkers = [...this.ports.values()].filter((p) => p.canTalk && p.keys.size && p.endpoint === null);
      if (talkers.length) {
        const p = choice(talkers);
        const to = choice([...p.keys.values()]);
        this.talk(p.n, to, true);
        this.autoCalls.set(`${p.n}|${to}`, { from: p.n, to, end: t + uniform(3, 15) });
      }
    }
  }

  // ---- console ------------------------------------------------------------------------
  override consoleHelp(): string[] {
    return [...super.consoleHelp(),
      "plan                 the port plan and user count",
      "ports [TYPE]         list ports (optionally one type)",
      "panel <port>         the generated keypanel for a port",
      "key <port> <k> <target>   reassign a key",
      "name <port> <alpha>  rename a port",
      "talk <from> <to>     press a talk key (port numbers or alphas)",
      "untalk <from> <to>   release it",
      "listen <port> <src>  monitor a source (wireless / IFB listen)",
      "unlisten <port> <src>",
      "calls                who is calling whom right now",
      "call <port> <ICOM> <remote-port>   trunk call via the Trunk Master",
      "hangup <port>        release that port's trunk call",
      "endpoints            live computers joined on the audio port",
    ];
  }

  private port(ref: string): Port {
    const n = this.portBy(ref);
    const p = this.ports.get(n);
    if (!p) throw new PyKeyError(n);
    return p;
  }

  override consoleCommand(argv: string[]): string {
    const cmd = (argv[0] ?? "").toLowerCase();
    const a = argv.slice(1);
    if (cmd === "plan") {
      const lines = this.plan.map(([t, c]) => `${ljust(t, 6)} ${rjust(c, 3)}  ${PORT_TYPES[t]?.desc ?? ""}`);
      lines.push(`total ports ${this.ports.size}, users ${this.users()} (types marked user: ${this.plan.filter(([t]) => PORT_TYPES[t]?.user).map(([t]) => t).join(", ")})`);
      return lines.join("\n");
    }
    if (cmd === "ports") {
      const want = a[0] !== undefined ? a[0].toUpperCase() : null;
      const lines: string[] = [];
      for (const p of this.ports.values()) {
        if (want && p.ptype !== want) continue;
        const flags: string[] = [];
        if (p.endpoint) flags.push("LIVE:" + p.endpoint.name);
        const t = this.talks.get(p.n);
        if (t && t.size) flags.push("talking->" + [...t.keys()].map(String).join(","));
        lines.push(`${rjust(p.n, 4)} ${ljust(p.alpha, 8)} ${ljust(p.ptype, 6)} ${flags.join(" ")}`);
      }
      return lines.join("\n");
    }
    if (cmd === "panel" && a.length) {
      const p = this.port(a[0] as string);
      if (!p.keys.size) return `${p.alpha} (${p.ptype}) has no keypanel`;
      return [...p.keys.entries()].sort((x, y) => x[0] - y[0]).map(([k, t]) => `key ${k} -> ${rjust(t, 4)} ${this.portAlpha(t)}`).join("\n") + `\ntone ${fixed(p.freq, 0)} Hz`;
    }
    if (cmd === "key" && a.length >= 3) {
      this.port(a[0] as string).keys.set(pyInt(a[1]), this.portBy(a[2] as string));
      return "ok";
    }
    if (cmd === "name" && a.length >= 2) {
      this.port(a[0] as string).alpha = (a[1] as string).slice(0, 8);
      this.estate.refreshTrunkMasters();
      return `port ${a[0] as string} = ${(a[1] as string).slice(0, 8)}`;
    }
    if ((cmd === "talk" || cmd === "untalk") && a.length >= 2) {
      this.talk(a[0] as string, a[1] as string, cmd === "talk");
      return `${cmd} ${a[0] as string} -> ${a[1] as string}`;
    }
    if ((cmd === "listen" || cmd === "unlisten") && a.length >= 2) {
      this.listen(a[0] as string, a[1] as string, cmd === "listen");
      return "ok";
    }
    if (cmd === "calls") {
      const calls = this.activeCalls();
      if (!calls.length) return "no calls";
      const t = now();
      return calls.map((c) => `${ljust(c.from, 8)} -> ${c.remote ? c.remote + ":" : ""}${ljust(c.to, 8)}  ${rjust(fixed(t - c.since, 0), 4)}s`).join("\n") +
        `\nusers ${this.users()}, users calling ${this.usersCalling()}`;
    }
    if (cmd === "call" && a.length >= 3) return this.callRemote(a[0] as string, a[1] as string, a[2] as string);
    if (cmd === "hangup" && a.length) return this.hangup(a[0] as string);
    if (cmd === "endpoints") {
      if (!this.audio) return "audio port not running";
      const lines = [...this.audio.endpoints].map(([n, e]) =>
        `port ${n} ${this.portAlpha(n)}  ${e.name}  ${e.addr?.address ?? "None"}:${e.addr?.port ?? 0}  idle ${fixed(now() - e.last, 1)}s`);
      return lines.join("\n") || `no endpoints (start TRUNK-SIMULATOR/trunk_panel.py --matrix host:${this.series})`;
    }
    return super.consoleCommand(argv);
  }

  override summary(): string {
    return super.summary() + `  alpha=${this.alpha4} ports=${this.ports.size} users=${this.users()} calling=${this.usersCalling()} audio=udp/${this.series ? `${this.series}..${this.series + 255}` : "-"}`;
  }

  override mapState(): DeviceMapState {
    const s = super.mapState();
    return Object.assign(s, {
      alpha: this.alpha4, ports: this.ports.size, users: this.users(),
      users_calling: this.usersCalling(), audio_port: this.series, series: this.series,
      sockets: this.audio ? this.audio.bound : 0,
      calls: this.activeCalls().map((c) => ({ from: c.from, to: c.to, remote: c.remote, since: c.since })),
      endpoints: this.audio ? [...this.audio.endpoints].map(([n, e]) => ({ port: n, alpha: this.portAlpha(n), name: e.name })) : [],
    });
  }

  override close(): void {
    this.audio?.stop();
    super.close();
  }
}

// =============================================================================
const RVON_SUBTYPES: Readonly<Record<string, readonly [string, number, number, number, number]>> = {
  rvon1: ["objIdRvon1", 1, 0, 0, 0], rvon8: ["objIdRvon8", 8, 0, 0, 0],
  rvonc: ["objIdRvonC", 1, 0, 0, 1], rvonio: ["objIdRvonIo", 8, 8, 8, 2],
  rvon16: ["objIdRvon16", 16, 0, 0, 0],
};

export class RvonDevice extends Device {
  static readonly SUBTYPES = RVON_SUBTYPES;
  subtypeKey: string;
  objidName: string;
  nchan: number;
  ngpi: number;
  ngpo: number;
  npt: number;
  partnerIp: string;
  chanUp = new Map<number, boolean>();
  panelPresent = new Map<number, boolean>();
  chanUpSince = new Map<number, number | null>();
  gpi: boolean[];
  gpo: boolean[];

  private static prep(cfg: DeviceConfig): DeviceConfig {
    const key = (cfg.subtype || "rvon16").toLowerCase().replace(/-/g, "").replace(/_/g, "");
    if (!(key in RVON_SUBTYPES)) throw new PyValueError("rvon subtype must be one of " + Object.keys(RVON_SUBTYPES).join(", "));
    cfg.subtype = key;
    return cfg;
  }

  constructor(estate: EstateLike, cfgIn: DeviceConfig) {
    const cfg = RvonDevice.prep(cfgIn);
    super(estate, cfg);
    this.subtypeKey = cfg.subtype as string;
    const spec = RVON_SUBTYPES[this.subtypeKey] as readonly [string, number, number, number, number];
    [this.objidName, this.nchan, this.ngpi, this.ngpo, this.npt] = spec;
    this.partnerIp = cfg.partner_ip ?? "127.0.0.1";
    this.gpi = new Array<boolean>(this.ngpi).fill(false);
    this.gpo = new Array<boolean>(this.ngpo).fill(false);
    this.populateSystem();
    this.populate();
  }

  override sysObjectId(): Oid {
    return this.mib.oid(this.objidName);
  }

  override sysDescr(): string {
    return `Pretend RTS ${this.subtypeKey.toUpperCase()} VoIP intercom interface, ${this.nchan} channels - Trunk-Caster simulator`;
  }

  private pktMs(): number {
    return pyInt(this.cfg.packet_ms ?? 20);
  }

  populate(): void {
    const m = this.mib;
    const codec = m.enumValue("RvonCodec", this.cfg.codec ?? "g711u");
    const pktMs = this.pktMs();
    const partnerName = ({ rvon1: "rvon1", rvon8: "rvon8", rvonc: "rvonC", rvonio: "rvonIo", rvon16: "rvon16" } as Record<string, string>)[this.subtypeKey] ?? "";
    const partnerType = m.enumValue("RvonDevice", partnerName);
    this.put("numGpioInputs", 0, this.ngpi);
    this.put("numGpioOutputs", 0, this.ngpo);
    this.put("deviceDescription", 0, (this.cfg.description ?? `${this.name} pretend RVON`).slice(0, 63));
    this.put("numPassthroughPorts", 0, this.npt);
    this.put("gsInputs", 0, () => RvonDevice.bits(this.gpi));
    this.put("gsOutputs", 0, () => RvonDevice.bits(this.gpo));
    const channelsUp = pyInt(this.cfg.channels_up ?? this.nchan);
    for (let ch = 1; ch <= this.nchan; ch++) {
      const up = ch <= channelsUp;
      this.chanUp.set(ch, up);
      this.panelPresent.set(ch, (this.subtypeKey === "rvonc" || this.subtypeKey === "rvon1") && up);
      this.chanUpSince.set(ch, up ? now() : null);
      this.put("ccPartnerIp", ch, this.partnerIp);
      this.put("ccPartnerType", ch, partnerType);
      this.put("ccPartnerChan", ch, ch);
      this.put("ccCodec", ch, codec);
      this.put("ccPktSizeMsec", ch, pktMs);
      this.put("ccPktSizeBytes", ch, pktMs * 8);
      this.put("ccVad", ch, truth(false));
      this.put("ccVadThreshold", ch, -99);
      this.put("ccDescription", ch, `${this.name} ch${String(ch).padStart(2, "0")}`);
      this.put("iogGainNetRx", ch, 0);
      this.put("iogGainNetTx", ch, 0);
      this.put("csPortNum", ch, this.subtypeKey === "rvon1" || this.subtypeKey === "rvonio" ? 0 : ch);
      this.put("csIsUp", ch, () => truth(this.chanUp.get(ch) ?? false));
      this.put("csPanelPresent", ch, () => truth(this.panelPresent.get(ch) ?? false));
      this.put("csUpTime", ch, () => {
        const since = this.chanUpSince.get(ch);
        return since ? Math.trunc(now() - since) : 0;
      });
      this.put("csCodec", ch, codec);
      this.put("csPktSizeMsec", ch, pktMs);
      this.put("csPktSizeBytes", ch, pktMs * 8);
      this.put("csVad", ch, truth(false));
      this.put("csNumConnects", ch, up ? 1 : 0);
      for (const col of ["csNumUnderruns", "csNumOverruns", "csNumMissedSeqPkts", "csNumReplayedPkts",
        "csVoicePktsTxd", "csVoicePktsRxd", "csDtmfRelayPktsTxd", "csDtmfRelayPktsRxd",
        "csSilenceDetectedPktsTxd", "csSilenceDetectedPktsRxd", "csSuppressedSilencePktsTx"]) this.put(col, ch, 0);
      this.put("csAvgJitter", ch, 2);
      this.put("csPlayoutBufferSize", ch, 120);
      this.put("csNomPlayoutDelay", ch, 40);
      this.put("csAvgPlayoutDelay", ch, 42);
      this.put("csMinPktIntervalTimeRx", ch, pktMs - 1);
      this.put("csMaxPktIntervalTimeRx", ch, pktMs + 3);
      for (const col of ["nweBadHeader", "nweBadMAC", "nweBadSSRC", "nweBadPayload", "nweBadDest", "nweLostPkts", "nweMicroOverrun"]) this.put(col, ch, 0);
    }
    for (let pt = 1; pt <= this.npt; pt++) {
      this.put("ptcfgIp", pt, this.partnerIp);
      this.put("ptcfgSpeed", pt, 9600);
      for (const col of ["ptstatSnBytes", "ptstatSnErrors", "ptstatNsBytes", "ptstatNsErrors"]) this.put(col, pt, 0);
    }
  }

  static bits(flags: readonly boolean[]): Uint8Array {
    const out = new Uint8Array(Math.ceil(flags.length / 8) || 1);
    flags.forEach((f, i) => {
      if (f) out[i >> 3] = (out[i >> 3] ?? 0) | (1 << (i % 8));
    });
    return out;
  }

  setChannel(ch: number, up: boolean): void {
    if (this.chanUp.get(ch) === up) return;
    this.chanUp.set(ch, up);
    this.chanUpSince.set(ch, up ? now() : null);
    if (up) this.bump("csNumConnects", ch);
    this.trap("rvLinkStatChgd", [["csIsUp", ch, truth(up)]]);
  }

  setPanel(ch: number, present: boolean): void {
    if (this.panelPresent.get(ch) === present) return;
    this.panelPresent.set(ch, present);
    this.trap("rvPanelStatChgd", [["csPanelPresent", ch, truth(present)]]);
  }

  override tick(): void {
    const pktPerS = Math.floor(1000 / this.pktMs());
    for (const [ch, up] of this.chanUp) {
      if (up) {
        this.bump("csVoicePktsTxd", ch, pktPerS);
        this.bump("csVoicePktsRxd", ch, pktPerS - choice([0, 0, 0, 1]));
        if (rnd() < this.estate.chaos * 0.2) {
          this.bump("csNumMissedSeqPkts", ch);
          this.bump("nweLostPkts", ch);
        }
      }
    }
    if (rnd() < this.estate.chaos * 0.02 && this.nchan) {
      const ch = randint(1, this.nchan);
      this.setChannel(ch, !this.chanUp.get(ch));
    }
  }

  override consoleHelp(): string[] {
    return [...super.consoleHelp(),
      "channels             channel status",
      "up <ch> | down <ch>  bring a VoIP channel up/down (sends rvLinkStatChgd)",
      "panel <ch> on|off    keypanel present/absent (sends rvPanelStatChgd)",
      "gpi <n> on|off       set a general purpose input",
      "gpo <n> on|off       set a general purpose output",
      "codec <ch> <g711u|g711a|g729|...>",
    ];
  }

  override consoleCommand(argv: string[]): string {
    const cmd = (argv[0] ?? "").toLowerCase();
    const a = argv.slice(1);
    const yes = (s: string | undefined): boolean => ["on", "1", "yes", "true"].includes((s ?? "").toLowerCase());
    if (cmd === "channels") {
      const lines: string[] = [];
      for (let ch = 1; ch <= this.nchan; ch++) {
        lines.push(`ch${String(ch).padStart(2, "0")} ${ljust(this.chanUp.get(ch) ? "UP" : "down", 4)} panel=${ljust(this.panelPresent.get(ch) ? "yes" : "no", 3)} up=${rjust(this.getNum("csUpTime", ch), 5)}s tx=${this.getNum("csVoicePktsTxd", ch)} rx=${this.getNum("csVoicePktsRxd", ch)} lost=${this.getNum("nweLostPkts", ch)}`);
      }
      return lines.join("\n");
    }
    if ((cmd === "up" || cmd === "down") && a.length) {
      this.setChannel(pyInt(a[0]), cmd === "up");
      return `channel ${a[0] as string} ${cmd}`;
    }
    if (cmd === "panel" && a.length >= 2) {
      this.setPanel(pyInt(a[0]), yes(a[1]));
      return `panel on ch ${a[0] as string} ${a[1] as string}`;
    }
    if ((cmd === "gpi" || cmd === "gpo") && a.length >= 2) {
      const arr = cmd === "gpi" ? this.gpi : this.gpo;
      const n = pyInt(a[0]) - 1;
      if (!(n >= 0 && n < arr.length)) return `this device has ${arr.length} ${cmd.toUpperCase()}`;
      arr[n] = yes(a[1]);
      return `${cmd.toUpperCase()} ${n + 1} = ${pyBool(arr[n] as boolean)}`;
    }
    if (cmd === "codec" && a.length >= 2) {
      const val = this.mib.enumValue("RvonCodec", a[1] as string);
      this.set("ccCodec", pyInt(a[0]), val);
      this.set("csCodec", pyInt(a[0]), val);
      return `ch ${a[0] as string} codec ${a[1] as string}`;
    }
    return super.consoleCommand(argv);
  }

  override summary(): string {
    return super.summary() + `  channels=${this.nchan} up=${[...this.chanUp.values()].filter(Boolean).length}`;
  }

  override mapState(): DeviceMapState {
    return Object.assign(super.mapState(), { channels: this.nchan, channels_up: [...this.chanUp.values()].filter(Boolean).length, calls: [] });
  }
}

// =============================================================================
export interface Trunk {
  from_icom: number;
  from_port: number;
  to_icom: number;
  to_port: number;
  state: string;
  since: number;
  users: [string, number, string, number] | null;
}

/** TM-2000 Trunk Master: knows every spawned matrix, defines trunks between each pair, tracks state, raises notifications. */
export class TrunkMasterDevice extends Device {
  icoms: MatrixDevice[] = [];
  trunks = new Map<number, Trunk>();
  trunksPerPair: number;
  /** each frame keeps its top 8 ports as trunk ports (the 8x8 trunk block) */
  trunkPortsReserved = 8;
  standbyIp: string;
  otherPresent: boolean;
  clearTimeout: number;
  errorsClearedAt: number;
  private timers = new Set<NodeJS.Timeout>();

  constructor(estate: EstateLike, cfg: DeviceConfig) {
    super(estate, cfg);
    this.trunksPerPair = pyInt(cfg.trunks_per_pair ?? 4);
    this.standbyIp = cfg.standby_ip ?? "0.0.0.0";
    this.otherPresent = !!cfg.standby_ip;
    this.clearTimeout = pyInt(cfg.clear_alloc_timeout ?? 30);
    this.errorsClearedAt = now();
    this.populateSystem();
  }

  override sysObjectId(): Oid {
    return this.mib.oid("sysTypeTM2000");
  }

  override sysDescr(): string {
    return "Pretend RTS TM-2000 Trunk Master v8.7.0 - Trunk-Caster simulator";
  }

  private sortedTrunks(): [number, Trunk][] {
    return [...this.trunks].sort((x, y) => x[0] - y[0]);
  }

  populate(matrices: MatrixDevice[]): void {
    this.icoms = [...matrices];
    const m = this.mib;
    this.put("tmStdbyIpAddr", 0, this.standbyIp);
    this.put("tmNumIcomPorts", 0, Math.max(8, this.icoms.length));
    this.put("tmVdpEnabled", 0, truth(false));
    this.put("tmVersion", 0, "TM-2000 v8.7.0 (pretend)");
    this.put("tmNumIcoms", 0, 256);
    this.put("tmNumTrunks", 0, 10000);
    this.put("tmNumFnTypes", 0, 2);
    this.put("tmNumGroups", 0, 1000);
    const capsTc = m.tcs.get("TmCapabTypes");
    if (!capsTc) throw new PyKeyError("TmCapabTypes");
    const caps = capsTc.enum;
    this.put("tmNumCapabs", 0, Object.keys(caps).length);
    for (const [label, idx] of Object.entries(caps)) this.put("tmCapabPresent", idx, truth(["tkAllocSecs", "ifbSl", "unicode"].includes(label)));
    this.icoms.forEach((mx, i) => {
      const n = i + 1;
      this.put("icomAlpha4", n, alphaBytes(mx.alpha4, 4));
      this.put("icomAlpha6", n, alphaBytes(mx.alpha8.slice(0, 6), 6));
      this.put("icomAlpha8", n, alphaBytes(mx.alpha8, 8));
      this.put("icomAlpha8u", n, alphaBytes(mx.alpha8, 8));
      this.put("icomComPort", n, n);
      this.put("icomBaudRate", n, 38400);
      this.put("isTalking", n, () => truth(mx.online));
      this.put("isNewProtocol", n, truth(true));
      this.put("isSize", n, mx.nports);
      for (const col of ["isErrorsFrom", "isErrorsTo", "isErrorRateFrom", "isErrorRateTo"]) this.put(col, n, 0);
    });
    this.refreshAlphas();
    this.put("gnName", 1, "ALL-ICOMS");
    for (let n = 1; n <= this.icoms.length; n++) this.put("gmIsMember", [1, n], truth(true));
    this.put("optWaitForTalk", 0, truth(false));
    this.put("optDynamicAlloc", 0, truth(false));
    this.put("optAutoClear", 0, truth(true));
    this.put("optClearAllocTimeout", 0, this.clearTimeout);
    this.put("optLogEnabled", 0, truth(false));
    this.put("tmErrorsCleared", 0, () => Math.trunc((this.errorsClearedAt - this.start) * 100));
    this.put("thisTmActive", 0, truth(true));
    this.put("otPresent", 0, () => truth(this.otherPresent));
    this.put("otActive", 0, truth(false));
    for (const col of ["otErrorsFrom", "otErrorsTo", "otErrorRateFrom", "otErrorRateTo"]) this.put(col, 0, 0);
    this.put("otThreshValue", 0, 20, true);
    this.put("icomThreshValue", 0, 20, true);
    // trunks: capital to capital between every pair; a state / provincial 8x8 only trunks to its own capital
    let tk = 1;
    const used = new Map<number, number>();
    const idxOf = new Map<string, number>();
    this.icoms.forEach((mx, i) => {
      used.set(i + 1, mx.nports);
      idxOf.set(mx.alpha4, i + 1);
    });
    this.icoms.forEach((mx, i) => idxOf.set(mx.name, i + 1));
    const N = this.icoms.length;
    for (let a = 1; a <= N; a++) {
      for (let b = a + 1; b <= N; b++) {
        const ma = this.icoms[a - 1] as MatrixDevice;
        const mb = this.icoms[b - 1] as MatrixDevice;
        if (ma.parent || mb.parent) {
          const child = ma.parent ? ma : mb;
          if (idxOf.get(child.parent as string) !== (child === ma ? b : a)) continue;
        }
        for (let r = 0; r < this.trunksPerPair; r++) {
          const pa = used.get(a) as number;
          const pb = used.get(b) as number;
          used.set(a, pa - 1);
          used.set(b, pb - 1);
          if (pa < 1 || pb < 1) break;
          const t = tk;
          this.trunks.set(t, { from_icom: a, from_port: pa, to_icom: b, to_port: pb, state: "idle", since: now(), users: null });
          this.put("tkFromIcom", t, a);
          this.put("tkFromPort", t, pa);
          this.put("tkToIcom", t, b);
          this.put("tkToPort", t, pb);
          this.put("tkCanCascade", t, truth(true));
          this.put("tkFixed", t, truth(false));
          this.put("tsState", t, () => this.mib.enumValue("TrunkState", (this.trunks.get(t) as Trunk).state));
          tk += 1;
        }
      }
    }
  }

  refreshAlphas(): void {
    this.icoms.forEach((mx, i) => {
      for (const p of mx.ports.values()) {
        for (const [col, size] of [["taAlpha4", 4], ["taAlpha6", 6], ["taAlpha8", 8], ["taAlpha8u", 8]] as const) this.put(col, [i + 1, 1, p.n], alphaBytes(p.alpha, size));
      }
    });
  }

  icomIndex(alpha4: string): number {
    const i = this.icoms.findIndex((mx) => mx.alpha4 === alpha4.toUpperCase() || mx.name.toUpperCase() === alpha4.toUpperCase());
    if (i < 0) throw new PyKeyError(`no intercom '${alpha4}' (known: ${this.icoms.map((x) => x.alpha4).join(", ")})`);
    return i + 1;
  }

  icomStatusChanged(matrix: MatrixDevice): void {
    const i = this.icoms.indexOf(matrix);
    if (i < 0) throw new PyValueError("matrix is not in list");
    const n = i + 1;
    for (const t of this.trunks.values()) {
      if (n === t.from_icom || n === t.to_icom) {
        if (!matrix.online) {
          t.state = "outOfService";
          t.since = now();
          t.users = null;
        } else if (t.state === "outOfService") {
          t.state = "idle";
          t.since = now();
        }
      }
    }
    this.trap("icomStatusChgd", [["isTalking", n, truth(matrix.online)]]);
  }

  /** -> [trunk number or null, text] */
  requestTrunk(fromAlpha: string, fromPort: number, toAlpha: string, toPort: number): [number | null, string] {
    const a = this.icomIndex(fromAlpha);
    const b = this.icomIndex(toAlpha);
    if (a === b) return [null, "same intercom, no trunk needed"];
    for (const [tk, t] of this.sortedTrunks()) {
      const pairMatch = (t.from_icom === a && t.to_icom === b) || (t.from_icom === b && t.to_icom === a);
      if (pairMatch && t.state === "idle") {
        t.state = "inUse";
        t.since = now();
        t.users = [fromAlpha.toUpperCase(), fromPort, toAlpha.toUpperCase(), toPort];
        this.log(`${this.name}: trunk ${tk} ${fromAlpha}:${fromPort} -> ${toAlpha}:${toPort} inUse`);
        return [tk, `trunk ${tk} allocated: ${fromAlpha.toUpperCase()} port ${fromPort} -> ${toAlpha.toUpperCase()} port ${toPort} (trunk ports ${t.from_port}/${t.to_port})`];
      }
    }
    this.trap("noTrunksTrap", [["noTksFromIcom", 0, a], ["noTksToIcom", 0, b]]);
    return [null, `NO TRUNKS available between ${fromAlpha.toUpperCase()} and ${toAlpha.toUpperCase()} (noTrunksTrap sent)`];
  }

  releaseTrunk(tk: number): string {
    const t = this.trunks.get(tk);
    if (!t) return `no trunk ${tk}`;
    if (t.state === "inUse" || t.state === "allocd") {
      const nw = this.get("optAutoClear") === TRUE && t.state === "inUse" ? "allocd" : "idle";
      t.state = nw;
      t.since = now();
      if (nw === "idle") t.users = null;
      return `trunk ${tk} -> ${nw}`;
    }
    return `trunk ${tk} is ${t.state}`;
  }

  override tick(): void {
    const t0 = now();
    for (const t of this.trunks.values()) {
      if (t.state === "allocd" && t0 - t.since > this.clearTimeout) {
        t.state = "idle";
        t.since = t0;
        t.users = null;
      }
    }
    const est = this.estate;
    if (this.icoms.length > 1 && est.scenario.name !== "quiet") {
      // a few trunk-call chances per second, scaled to the estate
      for (let i = 0; i < Math.max(1, Math.floor(this.icoms.length / 6)); i++) this.maybeTrunkCall(est, t0);
    }
  }

  private maybeTrunkCall(est: EstateLike, t0: number): void {
    const a = choice(this.icoms);
    const w = est.trafficWeight(a);
    if (!(w && rnd() < Math.min(0.9, w * 0.08))) return;
    const host = est.scenario.host;
    const hosts = this.icoms.filter((m) => m.alpha4 === host || m.name === host);
    let b: MatrixDevice;
    if (hosts.length && !hosts.includes(a) && rnd() < 0.7) b = hosts[0] as MatrixDevice; // everyone calls the host city
    else if (a.parent) b = this.icoms.find((m) => m.alpha4 === a.parent || m.name === a.parent) ?? choice(this.icoms);
    else b = choice(this.icoms);
    if (b === a) return;
    const pa = [...a.ports.values()].filter((p) => p.canTalk && p.endpoint === null);
    const pb = [...b.ports.values()].filter((p) => p.canListen);
    if (pa.length && pb.length) {
      const frm = choice(pa);
      const to = choice(pb);
      a.callRemote(frm.n, b.alpha4, to.n);
      a.autoCalls.set(`${frm.n}|${b.alpha4}:${to.n}`, { from: frm.n, to: `${b.alpha4}:${to.n}`, end: t0 + uniform(5, 20) });
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        try {
          a.hangup(frm.n);
        } catch (exc) {
          this.log(`${this.name}: hangup error ${errStr(exc)}`);
        }
      }, uniform(5, 20) * 1000);
      timer.unref();
      this.timers.add(timer);
    }
  }

  override consoleHelp(): string[] {
    return [...super.consoleHelp(),
      "icoms                intercoms this Trunk Master knows",
      "trunks               trunk table and states",
      "call <fromAlpha4> <fromPort> <toAlpha4> <toPort>   allocate a trunk (noTrunksTrap if none)",
      "hangup <tkNum>       release a trunk",
      "oos <tkNum> | maint <tkNum> | idle <tkNum>   force a trunk state",
      "standby on|off       pretend the other Trunk Master appears/disappears (otStatusChgd)",
      "clear-errors         reset error counters (tmErrorsCleared)",
      "errors <icomIndex> <n>   inject n comm errors (icomErrorRateExceeded if over threshold)",
    ];
  }

  override consoleCommand(argv: string[]): string {
    const cmd = (argv[0] ?? "").toLowerCase();
    const a = argv.slice(1);
    if (cmd === "icoms") {
      return this.icoms.map((mx, i) => `${rjust(i + 1, 3)} ${ljust(mx.alpha4, 4)} ${ljust(mx.alpha8, 8)} ports=${ljust(mx.nports, 4)} talking=${mx.online ? "yes" : "NO"}`).join("\n") || "(no matrices spawned)";
    }
    if (cmd === "trunks") {
      return this.sortedTrunks().map(([tk, t]) =>
        `tk${ljust(tk, 4)} ${(this.icoms[t.from_icom - 1] as MatrixDevice).alpha4}:${t.from_port} <-> ${(this.icoms[t.to_icom - 1] as MatrixDevice).alpha4}:${t.to_port}  ${ljust(t.state, 17)} ${t.users ? `${t.users[0]}:${t.users[1]}->${t.users[2]}:${t.users[3]}` : ""}`).join("\n") || "(no trunks)";
    }
    if (cmd === "call" && a.length >= 4) return this.requestTrunk(a[0] as string, pyInt(a[1]), a[2] as string, pyInt(a[3]))[1];
    if (cmd === "hangup" && a.length) return this.releaseTrunk(pyInt(a[0]));
    if ((cmd === "oos" || cmd === "maint" || cmd === "idle") && a.length) {
      const t = this.trunks.get(pyInt(a[0]));
      if (!t) return `no trunk ${a[0] as string}`;
      t.state = ({ oos: "outOfService", maint: "inMaintenanceMode", idle: "idle" } as Record<string, string>)[cmd] as string;
      t.since = now();
      t.users = null;
      return `trunk ${a[0] as string} -> ${t.state}`;
    }
    if (cmd === "standby" && a.length) {
      this.otherPresent = ["on", "1", "yes", "true"].includes((a[0] as string).toLowerCase());
      this.trap("otStatusChgd", [["otPresent", 0, truth(this.otherPresent)]]);
      return `other Trunk Master present=${pyBool(this.otherPresent)}`;
    }
    if (cmd === "clear-errors") {
      this.errorsClearedAt = now();
      for (let n = 1; n <= this.icoms.length; n++) for (const col of ["isErrorsFrom", "isErrorsTo", "isErrorRateFrom", "isErrorRateTo"]) this.set(col, n, 0);
      return "error counters cleared";
    }
    if (cmd === "errors" && a.length >= 2) {
      const n = pyInt(a[0]);
      const cnt = pyInt(a[1]);
      this.bump("isErrorsFrom", n, cnt);
      const rate = Math.min(255, this.getNum("isErrorRateFrom", n) + cnt);
      this.set("isErrorRateFrom", n, rate);
      if (rate > this.getNum("icomThreshValue")) {
        this.trap("icomErrorRateExceeded", [["isErrorRateFrom", n, rate], ["isErrorRateTo", n, this.get("isErrorRateTo", n)]]);
        return `intercom ${n} error rate ${rate} exceeds threshold ${this.getNum("icomThreshValue")} (trap sent)`;
      }
      return `intercom ${n} error rate now ${rate}`;
    }
    return super.consoleCommand(argv);
  }

  override summary(): string {
    const states = new Map<string, number>();
    for (const t of this.trunks.values()) states.set(t.state, (states.get(t.state) ?? 0) + 1);
    return super.summary() + `  icoms=${this.icoms.length} trunks=${this.trunks.size} ${pyDictRepr(states)}`;
  }

  override mapState(): DeviceMapState {
    return Object.assign(super.mapState(), {
      icoms: this.icoms.map((mx) => mx.alpha4), trunks: this.trunks.size,
      trunks_in_use: [...this.trunks.values()].filter((t) => t.state === "inUse").length,
      calls: [...this.trunks.values()].filter((t) => t.state === "inUse" && t.users).map((t) => {
        const u = t.users as [string, number, string, number];
        return { from: `${u[0]}:${u[1]}`, to: String(u[3]), remote: u[2], since: t.since };
      }),
    });
  }

  override close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    super.close();
  }
}

export type DeviceClass = new (estate: EstateLike, cfg: DeviceConfig) => Device;
export const DEVICE_CLASSES: Readonly<Record<string, DeviceClass>> = {
  matrix: MatrixDevice, rvon: RvonDevice, tm2000: TrunkMasterDevice, tm: TrunkMasterDevice,
};

export { TAG_NULL };
