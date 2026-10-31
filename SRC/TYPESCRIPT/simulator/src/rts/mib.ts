/**
 * mib.ts -- tiny MIB parser, enough for the Telex SMIv2 files (rts_intercom_sim.py lines 265-453).
 * Modules are keyed by the module name INSIDE each file, so mislabeled filenames do not matter.
 * Regexes are the Python ones with re.M -> "m" and re.S -> "s".
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { PyKeyError } from "../py.ts";
import {
  type Oid, oidStr, TAG_COUNTER32, TAG_COUNTER64, TAG_GAUGE32, TAG_INT, TAG_IPADDR, TAG_OCTSTR, TAG_OID, TAG_TIMETICKS,
} from "./ber.ts";

export const WELL_KNOWN: Readonly<Record<string, Oid>> = {
  iso: [1], org: [1, 3], dod: [1, 3, 6], internet: [1, 3, 6, 1],
  mgmt: [1, 3, 6, 1, 2], "mib-2": [1, 3, 6, 1, 2, 1], system: [1, 3, 6, 1, 2, 1, 1],
  interfaces: [1, 3, 6, 1, 2, 1, 2], snmp: [1, 3, 6, 1, 2, 1, 11],
  experimental: [1, 3, 6, 1, 3], private: [1, 3, 6, 1, 4], enterprises: [1, 3, 6, 1, 4, 1],
  snmpV2: [1, 3, 6, 1, 6], snmpModules: [1, 3, 6, 1, 6, 3], snmpMIB: [1, 3, 6, 1, 6, 3, 1],
  snmpMIBObjects: [1, 3, 6, 1, 6, 3, 1, 1], snmpTraps: [1, 3, 6, 1, 6, 3, 1, 1, 5],
};

export const SYS_OIDS: Readonly<Record<string, Oid>> = {
  sysDescr: [1, 3, 6, 1, 2, 1, 1, 1], sysObjectID: [1, 3, 6, 1, 2, 1, 1, 2],
  sysUpTime: [1, 3, 6, 1, 2, 1, 1, 3], sysContact: [1, 3, 6, 1, 2, 1, 1, 4],
  sysName: [1, 3, 6, 1, 2, 1, 1, 5], sysLocation: [1, 3, 6, 1, 2, 1, 1, 6],
  sysServices: [1, 3, 6, 1, 2, 1, 1, 7],
  snmpInPkts: [1, 3, 6, 1, 2, 1, 11, 1], snmpOutPkts: [1, 3, 6, 1, 2, 1, 11, 2],
  snmpInBadCommunityNames: [1, 3, 6, 1, 2, 1, 11, 4], snmpEnableAuthenTraps: [1, 3, 6, 1, 2, 1, 11, 30],
  snmpTrapOID: [1, 3, 6, 1, 6, 3, 1, 1, 4, 1], coldStart: [1, 3, 6, 1, 6, 3, 1, 1, 5, 1],
  warmStart: [1, 3, 6, 1, 6, 3, 1, 1, 5, 2],
};
export const SYS_TAGS: Readonly<Record<string, number>> = {
  sysDescr: TAG_OCTSTR, sysObjectID: TAG_OID, sysUpTime: TAG_TIMETICKS, sysContact: TAG_OCTSTR,
  sysName: TAG_OCTSTR, sysLocation: TAG_OCTSTR, sysServices: TAG_INT,
  snmpInPkts: TAG_COUNTER32, snmpOutPkts: TAG_COUNTER32, snmpInBadCommunityNames: TAG_COUNTER32,
  snmpEnableAuthenTraps: TAG_INT, snmpTrapOID: TAG_OID,
};
const SYS_OID_STRS = new Set(Object.values(SYS_OIDS).map(oidStr));

export type MibKind = "node" | "module" | "notification" | "meta" | "table" | "row" | "column" | "scalar";

export class MibObject {
  name: string;
  module: string;
  parent: string;
  sub: number;
  kind: MibKind;
  syntax: string;
  access: string;
  index: string[];
  description: string;
  oid: Oid | null = null;

  constructor(name: string, module: string, parent: string, sub: string | number, kind: MibKind, syntax = "", access = "", index: string[] = [], description = "") {
    this.name = name;
    this.module = module;
    this.parent = parent;
    this.sub = typeof sub === "number" ? sub : Number.parseInt(sub, 10);
    this.kind = kind;
    this.syntax = syntax;
    this.access = access;
    this.index = index;
    this.description = description;
  }
}

export interface TextualConvention {
  name: string;
  module: string;
  base: string;
  enum: Record<string, number>;
}

export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  let inStr = false;
  while (i < n) {
    const c = text[i] as string;
    if (inStr) {
      out += c;
      if (c === '"') inStr = false;
      i += 1;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i += 1;
    } else if (text.startsWith("--", i)) {
      const j = text.indexOf("\n", i);
      i = j < 0 ? n : j;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const ws = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ");

/** re.split(pattern, s, maxsplit=1)[0] */
function splitFirst(s: string, re: RegExp): string {
  const m = re.exec(s);
  return m ? s.slice(0, m.index) : s;
}

/** os.path.splitext(f)[0] */
function stem(f: string): string {
  const ext = path.extname(f);
  return ext && ext !== f ? f.slice(0, -ext.length) : f;
}

export class Mib {
  objects = new Map<string, MibObject>();
  tcs = new Map<string, TextualConvention>();
  modules = new Map<string, string>();
  byOid = new Map<string, MibObject>();
  warnings: string[] = [];

  loadFolder(folder: string): this {
    let names: string[] = [];
    try {
      names = readdirSync(folder);
    } catch {
      names = [];
    }
    // glob order is per pattern then sorted(); sorted() of the full paths is what decides
    const paths = names.filter((f) => /\.(mib|txt|my)$/.test(f)).map((f) => path.join(folder, f)).sort();
    for (const p of paths) {
      try {
        // Python's text mode turns \r\n and \r into \n (universal newlines); the regexes depend on it
        this.loadText(readFileSync(p, "utf-8").replace(/\r\n?/g, "\n"), path.basename(p));
      } catch (exc) {
        this.warnings.push(`${path.basename(p)}: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
    this.resolve();
    return this;
  }

  loadText(textIn: string, filename = "<text>"): void {
    const text = stripComments(textIn);
    const mm = /^\s*([\w-]+)\s+DEFINITIONS\s*::=\s*BEGIN/m.exec(text);
    const module = mm ? (mm[1] as string) : filename;
    this.modules.set(module, filename);

    for (const m of text.matchAll(/^\s*([\w-]+)\s+OBJECT IDENTIFIER\s*::=\s*\{\s*([\w-]+)\s+(\d+)\s*\}/gm)) {
      this.objects.set(m[1] as string, new MibObject(m[1] as string, module, m[2] as string, m[3] as string, "node"));
    }
    for (const m of text.matchAll(/^\s*([\w-]+)\s+MODULE-IDENTITY\b.*?::=\s*\{\s*([\w-]+)\s+(\d+)\s*\}/gms)) {
      this.objects.set(m[1] as string, new MibObject(m[1] as string, module, m[2] as string, m[3] as string, "module"));
    }
    const re = /^\s*([\w-]+)\s+(OBJECT-TYPE|NOTIFICATION-TYPE|AGENT-CAPABILITIES|MODULE-COMPLIANCE|OBJECT-GROUP|NOTIFICATION-GROUP)\b(.*?)::=\s*\{\s*([\w-]+)\s+(\d+)\s*\}/gms;
    for (const m of text.matchAll(re)) {
      const [, name, macro, body, parent, sub] = m as unknown as [string, string, string, string, string, string];
      if (macro !== "OBJECT-TYPE") {
        const kind: MibKind = macro === "NOTIFICATION-TYPE" ? "notification" : "meta";
        this.objects.set(name, new MibObject(name, module, parent, sub, kind, "", "", [], Mib.descr(body)));
        continue;
      }
      const syn = /SYNTAX\s+(.+?)\s*(?:\n\s*(?:UNITS|MAX-ACCESS|ACCESS|STATUS)\b)/s.exec(body);
      const syntax = syn ? ws(syn[1] as string) : "";
      const acc = /(?:MAX-ACCESS|ACCESS)\s+([\w-]+)/.exec(body);
      const idx = /INDEX\s*\{([^}]*)\}/.exec(body);
      const index = idx ? (idx[1] as string).split(",").map((x) => x.trim()) : [];
      const kind: MibKind = syntax.startsWith("SEQUENCE OF") ? "table" : index.length ? "row" : "column";
      this.objects.set(name, new MibObject(name, module, parent, sub, kind, syntax, acc ? (acc[1] as string) : "", index, Mib.descr(body)));
    }

    const starts: [number, string][] = [];
    for (const m of text.matchAll(/^\s*([\w-]+)\s*::=\s*TEXTUAL-CONVENTION/gm)) starts.push([m.index ?? 0, m[1] as string]);
    starts.forEach(([pos, name], i) => {
      const end = i + 1 < starts.length ? (starts[i + 1] as [number, string])[0] : text.length;
      const chunk = text.slice(pos, end);
      const syn = /SYNTAX\s+(.*)/s.exec(chunk);
      let syntax = syn ? (syn[1] as string) : "";
      syntax = splitFirst(syntax, /\n\s*\n|\nEND\b|\n[\w-]+\s*::=/);
      const base = splitFirst(syntax.trim(), /[\s({]/);
      const en: Record<string, number> = {};
      const em = /\{(.*)\}/s.exec(syntax);
      if (em && base === "INTEGER") {
        for (const lm of (em[1] as string).matchAll(/([\w-]+)\s*\(\s*(-?\d+)\s*\)/g)) en[lm[1] as string] = Number.parseInt(lm[2] as string, 10);
      }
      this.tcs.set(name, { name, module, base, enum: en });
    });
  }

  static descr(body: string): string {
    const m = /DESCRIPTION\s+"([^"]*)"/s.exec(body);
    return m ? ws(m[1] as string) : "";
  }

  resolve(): void {
    const res = (name: string, depth = 0): Oid | null => {
      const wk = WELL_KNOWN[name];
      if (wk) return wk;
      const obj = this.objects.get(name);
      if (obj === undefined || depth > 64) return null;
      if (obj.oid === null) {
        const parent = res(obj.parent, depth + 1);
        obj.oid = parent === null ? null : [...parent, obj.sub];
      }
      return obj.oid;
    };
    for (const [name, obj] of [...this.objects.entries()]) {
      if (res(name) === null) this.warnings.push(`unresolved parent '${obj.parent}' for ${name}`);
    }
    for (const obj of this.objects.values()) {
      if (obj.kind === "column") {
        const p = this.objects.get(obj.parent);
        if (!(p && p.kind === "row")) obj.kind = "scalar";
      }
      if (obj.oid !== null) this.byOid.set(oidStr(obj.oid), obj);
    }
  }

  oid(name: string): Oid {
    const s = SYS_OIDS[name];
    if (s) return s;
    const obj = this.objects.get(name);
    if (obj === undefined || obj.oid === null) throw new PyKeyError(`MIB object '${name}' not found`);
    return obj.oid;
  }

  tagFor(name: string): number {
    const s = SYS_TAGS[name];
    if (s !== undefined) return s;
    const obj = this.objects.get(name);
    if (!obj) throw new PyKeyError(name);
    let base = obj.syntax ? splitFirst(obj.syntax.trim(), /[\s({]/) : "INTEGER";
    const seen = new Set<string>();
    let tc = this.tcs.get(base);
    while (tc && !seen.has(base)) {
      seen.add(base);
      base = tc.base;
      tc = this.tcs.get(base);
    }
    const table: Record<string, number> = {
      Integer32: TAG_INT, INTEGER: TAG_INT, TruthValue: TAG_INT, OCTET: TAG_OCTSTR,
      DisplayString: TAG_OCTSTR, IpAddress: TAG_IPADDR, Counter32: TAG_COUNTER32,
      Gauge32: TAG_GAUGE32, Unsigned32: TAG_GAUGE32, TimeTicks: TAG_TIMETICKS,
      Counter64: TAG_COUNTER64, OBJECT: TAG_OID,
    };
    return table[base] ?? TAG_INT;
  }

  enumValue(tcName: string, label: string): number {
    const tc = this.tcs.get(tcName);
    if (!tc) throw new PyKeyError(tcName);
    const v = tc.enum[label];
    if (v === undefined) throw new PyKeyError(label);
    return v;
  }

  lookup(oid: Oid): string {
    for (let n = oid.length; n > 0; n--) {
      const obj = this.byOid.get(oidStr(oid.slice(0, n)));
      if (obj) {
        const rest = oid.slice(n);
        return obj.name + (rest.length ? "." + oidStr(rest) : "");
      }
    }
    for (const [name, o] of Object.entries(SYS_OIDS)) {
      if (oidStr(oid.slice(0, o.length)) === oidStr(o)) {
        const rest = oid.slice(o.length);
        return name + (rest.length ? "." + oidStr(rest) : "");
      }
    }
    return oidStr(oid);
  }

  /** is this OID string one of the system-group OIDs? */
  static isSysOid(s: string): boolean {
    return SYS_OID_STRS.has(s);
  }

  moduleMismatches(): [file: string, module: string][] {
    const out: [string, string][] = [];
    for (const [m, f] of this.modules) if (stem(f).toLowerCase() !== m.toLowerCase()) out.push([f, m]);
    return out;
  }
}

export { stem as splitextStem };
