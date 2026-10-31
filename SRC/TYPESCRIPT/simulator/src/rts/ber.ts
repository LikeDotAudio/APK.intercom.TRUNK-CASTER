/**
 * ber.ts -- BER / SNMP v1/v2c wire encoding (rts_intercom_sim.py lines 88-262).
 *
 * Python ints are unbounded; here every integer goes through BigInt on the way
 * in and out so Counter64 and negative INTEGERs encode byte-identically.
 * Decoded integers come back as `number` when they fit in a safe integer, else `bigint`.
 */
export const TAG_INT = 0x02, TAG_OCTSTR = 0x04, TAG_NULL = 0x05, TAG_OID = 0x06, TAG_SEQ = 0x30;
export const TAG_IPADDR = 0x40, TAG_COUNTER32 = 0x41, TAG_GAUGE32 = 0x42, TAG_TIMETICKS = 0x43, TAG_COUNTER64 = 0x46;
export const TAG_NOSUCHOBJ = 0x80, TAG_NOSUCHINST = 0x81, TAG_ENDOFMIB = 0x82;
export const PDU_GET = 0xa0, PDU_GETNEXT = 0xa1, PDU_RESPONSE = 0xa2, PDU_SET = 0xa3;
export const PDU_TRAPV1 = 0xa4, PDU_GETBULK = 0xa5, PDU_INFORM = 0xa6, PDU_TRAPV2 = 0xa7;

export const ERR_NOERROR = 0, ERR_TOOBIG = 1, ERR_NOSUCHNAME = 2, ERR_BADVALUE = 3, ERR_READONLY = 4, ERR_GENERR = 5;
export const ERR_NOACCESS = 6, ERR_WRONGTYPE = 7, ERR_NOTWRITABLE = 17;

export const TAG_NAMES: Readonly<Record<number, string>> = {
  [TAG_INT]: "INTEGER", [TAG_OCTSTR]: "STRING", [TAG_NULL]: "NULL", [TAG_OID]: "OID",
  [TAG_IPADDR]: "IpAddress", [TAG_COUNTER32]: "Counter32", [TAG_GAUGE32]: "Gauge32",
  [TAG_TIMETICKS]: "Timeticks", [TAG_COUNTER64]: "Counter64",
  [TAG_NOSUCHOBJ]: "noSuchObject", [TAG_NOSUCHINST]: "noSuchInstance", [TAG_ENDOFMIB]: "endOfMibView",
};

export type Oid = readonly number[];
/** int | bytes | str | OID tuple | None, as the Python store held them */
export type SnmpValue = number | bigint | string | Uint8Array | Oid | null;
export type VarBind = readonly [oid: Oid, tag: number, value: SnmpValue];

export interface SnmpMessage {
  version: number;
  community: string;
  pdu: number;
  reqId: number;
  f1: number;
  f2: number;
  varbinds: VarBind[];
}

// ----------------------------------------------------------------------------- helpers
function toBig(v: SnmpValue): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v.trim());
  throw new TypeError("int() argument must be a string or a number");
}

function bigToBytes(v: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = v;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function bitLength(v: bigint): number {
  let x = v < 0n ? -v : v;
  let n = 0;
  while (x > 0n) {
    x >>= 1n;
    n++;
  }
  return n;
}

export function berLen(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const b = bigToBytes(BigInt(n), Math.ceil(bitLength(BigInt(n)) / 8));
  return Uint8Array.of(0x80 | b.length, ...b);
}

export function tlv(tag: number, payload: Uint8Array): Buffer {
  return Buffer.concat([Uint8Array.of(tag), berLen(payload.length), payload]);
}

export function encInt(value: SnmpValue, tag = TAG_INT): Buffer {
  let v = toBig(value);
  if (tag === TAG_INT) {
    const n = Math.max(1, Math.floor((bitLength(v) + 8) / 8));
    let b = bigToBytes(v, n); // two's complement in n bytes (BigInt & is infinite two's complement)
    while (b.length > 1 && ((b[0] === 0x00 && (b[1] ?? 0) < 0x80) || (b[0] === 0xff && (b[1] ?? 0) >= 0x80))) b = b.subarray(1);
    return tlv(tag, b);
  }
  v &= tag === TAG_COUNTER64 ? 0xffffffffffffffffn : 0xffffffffn;
  let b = bigToBytes(v, Math.max(1, Math.ceil(bitLength(v) / 8)));
  if ((b[0] ?? 0) & 0x80) b = Uint8Array.of(0, ...b);
  return tlv(tag, b);
}

export function encOid(oidIn: Oid): Buffer {
  const oid = oidIn.length < 2 ? [...oidIn, ...new Array<number>(2 - oidIn.length).fill(0)] : [...oidIn];
  const first = 40 * (oid[0] ?? 0) + (oid[1] ?? 0);
  if (first > 255 || first < 0) throw new RangeError("bytes must be in range(0, 256)");
  const out: number[] = [first];
  for (let sub of oid.slice(2)) {
    if (sub < 0x80) out.push(sub);
    else {
      const chunk: number[] = [];
      while (sub) {
        chunk.push(sub % 128);
        sub = Math.floor(sub / 128);
      }
      chunk.reverse();
      for (let i = 0; i < chunk.length - 1; i++) out.push((chunk[i] ?? 0) | 0x80);
      out.push(chunk[chunk.length - 1] ?? 0);
    }
  }
  return tlv(TAG_OID, Uint8Array.from(out));
}

function ipAton(s: string): Uint8Array {
  const parts = s.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p) || Number(p) > 255)) throw new Error("illegal IP address string passed to inet_aton");
  return Uint8Array.from(parts.map(Number));
}

export function encValue(tag: number, v: SnmpValue): Buffer {
  if (tag === TAG_INT || tag === TAG_COUNTER32 || tag === TAG_GAUGE32 || tag === TAG_TIMETICKS || tag === TAG_COUNTER64) return encInt(v, tag);
  if (tag === TAG_OCTSTR) {
    if (v instanceof Uint8Array) return tlv(TAG_OCTSTR, v);
    return tlv(TAG_OCTSTR, Buffer.from(v === null ? "None" : Array.isArray(v) ? `(${v.join(", ")})` : String(v), "utf-8"));
  }
  if (tag === TAG_IPADDR) {
    if (typeof v === "string") return tlv(TAG_IPADDR, ipAton(v));
    if (v instanceof Uint8Array) return tlv(TAG_IPADDR, v);
    throw new TypeError("cannot encode IpAddress from " + typeof v);
  }
  if (tag === TAG_OID) {
    if (!Array.isArray(v)) throw new TypeError("OID value must be a tuple");
    return encOid(v as Oid);
  }
  if (tag === TAG_NULL || tag === TAG_NOSUCHOBJ || tag === TAG_NOSUCHINST || tag === TAG_ENDOFMIB) return tlv(tag, new Uint8Array(0));
  throw new Error("cannot encode tag 0x" + tag.toString(16).padStart(2, "0"));
}

export function decTlv(buf: Uint8Array, pos = 0): [tag: number, body: Uint8Array, next: number] {
  if (pos + 1 >= buf.length) throw new RangeError("index out of range");
  const tag = buf[pos] as number;
  pos += 1;
  let length = buf[pos] as number;
  pos += 1;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (const b of buf.subarray(pos, pos + n)) length = length * 256 + b;
    pos += n;
  }
  return [tag, buf.subarray(pos, pos + length), pos + length];
}

export function decSeq(payload: Uint8Array): [number, Uint8Array][] {
  const items: [number, Uint8Array][] = [];
  let pos = 0;
  while (pos < payload.length) {
    const [tag, body, next] = decTlv(payload, pos);
    pos = next;
    items.push([tag, body]);
  }
  return items;
}

function narrow(v: bigint): number | bigint {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v;
}

export function decIntBig(payload: Uint8Array, signed = true): bigint {
  if (!payload.length) return 0n;
  let v = 0n;
  for (const b of payload) v = (v << 8n) | BigInt(b);
  if (signed && (payload[0] ?? 0) & 0x80) v -= 1n << BigInt(8 * payload.length);
  return v;
}

export function decInt(payload: Uint8Array, signed = true): number | bigint {
  return narrow(decIntBig(payload, signed));
}

/** decInt for header fields that are always small (version, request id, error status). */
function decSmall(payload: Uint8Array): number {
  return Number(decIntBig(payload, true));
}

export function decOid(payload: Uint8Array): number[] {
  if (!payload.length) return [];
  const first = payload[0] as number;
  const oid = first < 128 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  let v = 0;
  for (const b of payload.subarray(1)) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      oid.push(v);
      v = 0;
    }
  }
  return oid;
}

export function decValue(tag: number, body: Uint8Array): SnmpValue {
  if (tag === TAG_INT) return decInt(body, true);
  if (tag === TAG_COUNTER32 || tag === TAG_GAUGE32 || tag === TAG_TIMETICKS || tag === TAG_COUNTER64) return decInt(body, false);
  if (tag === TAG_OCTSTR) return Uint8Array.from(body);
  if (tag === TAG_OID) return decOid(body);
  if (tag === TAG_IPADDR) return body.length === 4 ? Array.from(body).join(".") : Uint8Array.from(body);
  return null;
}

function item(items: [number, Uint8Array][], i: number): [number, Uint8Array] {
  const it = items[i];
  if (!it) throw new RangeError("list index out of range");
  return it;
}

/** -> version, community, pdu tag, request id, f1, f2, varbinds */
export function parseMessage(data: Uint8Array): SnmpMessage {
  const [, body] = decTlv(data);
  const items = decSeq(body);
  const version = decSmall(item(items, 0)[1]);
  const community = Buffer.from(item(items, 1)[1]).toString("latin1");
  const [pdu, pduBody] = item(items, 2);
  const f = decSeq(pduBody);
  const reqId = decSmall(item(f, 0)[1]);
  const f1 = decSmall(item(f, 1)[1]);
  const f2 = decSmall(item(f, 2)[1]);
  const varbinds: VarBind[] = [];
  for (const [, vb] of decSeq(item(f, 3)[1])) {
    const parts = decSeq(vb);
    const oid = decOid(item(parts, 0)[1]);
    const [vtag, vbody] = item(parts, 1);
    varbinds.push([oid, vtag, decValue(vtag, vbody)]);
  }
  return { version, community, pdu, reqId, f1, f2, varbinds };
}

export function buildMessage(version: number, community: string, pduTag: number, reqId: number, f1: number, f2: number, varbinds: readonly VarBind[]): Buffer {
  const vbs = Buffer.concat(varbinds.map(([o, t, v]) => tlv(TAG_SEQ, Buffer.concat([encOid(o), encValue(t, v)]))));
  const pdu = tlv(pduTag, Buffer.concat([encInt(reqId), encInt(f1), encInt(f2), tlv(TAG_SEQ, vbs)]));
  return tlv(TAG_SEQ, Buffer.concat([encInt(version), tlv(TAG_OCTSTR, Buffer.from(community, "latin1")), pdu]));
}

// ----------------------------------------------------------------------------- OIDs as keys
export function oidStr(oid: Oid): string {
  return oid.join(".");
}

export function oidParse(s: string): number[] {
  const t = s.trim().replace(/^\.+/, "");
  if (!t) return [];
  return t.split(".").map((x) => {
    if (!/^\s*[+-]?\d+\s*$/.test(x)) throw new Error("invalid literal for int() with base 10: '" + x + "'");
    return Number.parseInt(x, 10);
  });
}

/** Python tuple ordering. */
export function oidCmp(a: Oid, b: Oid): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d) return d < 0 ? -1 : 1;
  }
  return a.length - b.length;
}

export function oidStartsWith(oid: Oid, prefix: Oid): boolean {
  if (prefix.length > oid.length) return false;
  for (let i = 0; i < prefix.length; i++) if (oid[i] !== prefix[i]) return false;
  return true;
}

/** fmt_value: how the console and the client print a value. */
export function fmtValue(tag: number, v: SnmpValue): string {
  if (tag === TAG_OCTSTR && v instanceof Uint8Array) {
    try {
      const txt = new TextDecoder("utf-8", { fatal: true }).decode(v);
      if ([...txt].every((c) => (c.codePointAt(0) ?? 0) >= 32 && (c.codePointAt(0) ?? 0) < 127)) return `"${txt}"`;
    } catch {
      // not utf-8
    }
    return "hex:" + Buffer.from(v).toString("hex");
  }
  if (tag === TAG_OCTSTR && typeof v === "string") {
    // Python: str.decode raises AttributeError, caught, then v.hex() raises too; the store only holds str for
    // values the device itself put (sysDescr etc.) and fmt_value on those would have crashed the walk line.
    // Print it the way it would look once encoded.
    return fmtValue(tag, Buffer.from(v, "utf-8"));
  }
  if (tag === TAG_OID && Array.isArray(v)) return oidStr(v as Oid);
  if (tag === TAG_TIMETICKS && (typeof v === "number" || typeof v === "bigint")) {
    const n = Number(v);
    return `${String(v)} (${(n / 100).toFixed(2)} s)`;
  }
  if (v === null) return "None";
  if (v instanceof Uint8Array) return "b'" + Buffer.from(v).toString("latin1") + "'";
  if (Array.isArray(v)) return "(" + v.join(", ") + (v.length === 1 ? ",)" : ")");
  return String(v);
}
