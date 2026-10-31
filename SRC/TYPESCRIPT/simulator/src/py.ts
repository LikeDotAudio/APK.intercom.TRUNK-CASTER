/**
 * py.ts -- the small pieces of Python behaviour the simulators lean on, so the
 * TypeScript ports produce the same bytes, strings and errors.
 *
 *   PyError / PyValueError / PyKeyError   ValueError / KeyError (the map API maps both to 400)
 *   pyRepr                                 repr(str), which is what str(KeyError(x)) prints
 *   pyInt / pyFloat                        int(x) / float(x) that throw like Python
 *   pyJson                                 json.dumps (ensure_ascii, default separators, indent)
 *   PyRandom                               random.Random(seed): MT19937 + randint / random
 *   fmt helpers                            %-8s / %4d style padding
 *   isoNow / localTzLabel / clock          tc_map.iso_now, tc_map.local_tz_label, time.strftime("%H:%M:%S ")
 */

/** Base of the errors that Python code raised as ValueError / KeyError. */
export class PyError extends Error {
  /** what `str(exc)` would print in Python */
  get pyStr(): string {
    return this.message;
  }
}

export class PyValueError extends PyError {
  override name = "ValueError";
}

export class PyKeyError extends PyError {
  override name = "KeyError";
  private readonly numeric: boolean;
  constructor(key: string | number) {
    super(String(key));
    this.numeric = typeof key === "number";
  }
  /** str(KeyError("x")) is "'x'" (Python prints the repr of the key); str(KeyError(5)) is "5". */
  override get pyStr(): string {
    return this.numeric ? this.message : pyRepr(this.message);
  }
}

/** p["key"] on a params dict: raises KeyError('key') when missing. */
export function req(p: Readonly<Record<string, string>>, key: string): string {
  const v = p[key];
  if (v === undefined) throw new PyKeyError(key);
  return v;
}

/** repr() of a flat dict of str -> int, e.g. "{'idle': 3}" */
export function pyDictRepr(d: ReadonlyMap<string, number> | Readonly<Record<string, number>>): string {
  const ents = d instanceof Map ? [...d.entries()] : Object.entries(d);
  return "{" + ents.map(([k, v]) => `${pyRepr(String(k))}: ${String(v)}`).join(", ") + "}";
}

/** str(bool) */
export function pyBool(b: boolean): string {
  return b ? "True" : "False";
}

/** "%.Nf" with Python's round-half-even on the binary value (toFixed is close enough except exact .5 ties). */
export function fixed(v: number, n: number): string {
  return v.toFixed(n);
}

/** str(exc) for anything thrown. */
export function errStr(e: unknown): string {
  if (e instanceof PyError) return e.pyStr;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** repr() of a Python str. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/** int(x) for a string or number; throws PyValueError like Python. */
export function pyInt(x: string | number | undefined | null): number {
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new PyValueError("cannot convert float " + String(x) + " to integer");
    return Math.trunc(x);
  }
  if (x === undefined || x === null) throw new PyValueError("int() argument must be a string or a number, not 'NoneType'");
  const t = x.trim().replace(/_/g, "");
  if (!/^[+-]?\d+$/.test(t)) throw new PyValueError("invalid literal for int() with base 10: " + pyRepr(x));
  return Number.parseInt(t, 10);
}

/** float(x); throws PyValueError like Python. */
export function pyFloat(x: string | number | undefined | null): number {
  if (typeof x === "number") return x;
  if (x === undefined || x === null) throw new PyValueError("float() argument must be a string or a real number, not 'NoneType'");
  const t = x.trim();
  const lower = t.toLowerCase();
  if (lower === "inf" || lower === "+inf" || lower === "infinity") return Infinity;
  if (lower === "-inf" || lower === "-infinity") return -Infinity;
  if (lower === "nan") return NaN;
  if (t === "" || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) throw new PyValueError("could not convert string to float: " + pyRepr(x));
  return Number(t);
}

/** Lexicographic tuple-style string comparison is not needed; numbers compare like Python. */
export function ljust(s: string | number, n: number): string {
  return String(s).padEnd(n, " ");
}
export function rjust(s: string | number, n: number): string {
  return String(s).padStart(n, " ");
}

// ----------------------------------------------------------------------------- json.dumps
export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json | undefined };

function jsonStr(s: string, ensureAscii: boolean): string {
  const raw = JSON.stringify(s);
  if (!ensureAscii) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    out += c > 0x7e ? "\\u" + c.toString(16).padStart(4, "0") : raw[i];
  }
  return out;
}

function jsonNum(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  return JSON.stringify(n);
}

/**
 * json.dumps(value, separators=..., indent=..., ensure_ascii=True).
 * compact=true is separators=(",", ":"); otherwise Python's default (", ", ": ").
 * Known gap: a Python float with an integral value prints "1.0"; JS numbers print "1".
 */
export function pyJson(value: unknown, opts: { compact?: boolean; indent?: number; ensureAscii?: boolean } = {}): string {
  const ensureAscii = opts.ensureAscii ?? true;
  const indent = opts.indent;
  const itemSep = opts.compact ? "," : indent !== undefined ? "," : ", ";
  const keySep = opts.compact ? ":" : ": ";
  const enc = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return jsonNum(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return jsonStr(v, ensureAscii);
    if (typeof v === "function") return "null";
    const nl = indent !== undefined ? "\n" + " ".repeat(indent * (depth + 1)) : "";
    const end = indent !== undefined ? "\n" + " ".repeat(indent * depth) : "";
    if (Array.isArray(v) || v instanceof Set) {
      const arr = Array.isArray(v) ? (v as unknown[]) : [...(v as Set<unknown>)];
      if (!arr.length) return "[]";
      return "[" + nl + arr.map((x) => enc(x, depth + 1)).join(itemSep + nl) + end + "]";
    }
    if (v instanceof Map) {
      const ents = [...v.entries()];
      if (!ents.length) return "{}";
      return "{" + nl + ents.map(([k, x]) => jsonStr(String(k), ensureAscii) + keySep + enc(x, depth + 1)).join(itemSep + nl) + end + "}";
    }
    const ents = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!ents.length) return "{}";
    return "{" + nl + ents.map(([k, x]) => jsonStr(k, ensureAscii) + keySep + enc(x, depth + 1)).join(itemSep + nl) + end + "}";
  };
  return enc(value, 0);
}

// ----------------------------------------------------------------------------- random.Random
/** CPython's random.Random: MT19937 seeded by init_by_array, randint via getrandbits. */
export class PyRandom {
  private mt = new Uint32Array(624);
  private mti = 625;

  constructor(seed: number) {
    // CPython seeds an int by its absolute value split into 32-bit words (little-endian)
    let n = Math.abs(Math.trunc(seed));
    const key: number[] = [];
    do {
      key.push(n % 0x100000000 >>> 0);
      n = Math.floor(n / 0x100000000);
    } while (n > 0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1] ?? 0;
      const x = prev ^ (prev >>> 30);
      mt[i] = (Math.imul(1812433253, x) + i) >>> 0;
    }
    this.mti = 624;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const len = key.length;
    for (let k = Math.max(624, len); k > 0; k--) {
      const prev = mt[i - 1] ?? 0;
      const x = prev ^ (prev >>> 30);
      mt[i] = ((mt[i] ?? 0) ^ Math.imul(x, 1664525)) + (key[j] ?? 0) + j >>> 0;
      i++;
      j++;
      if (i >= 624) {
        mt[0] = mt[623] ?? 0;
        i = 1;
      }
      if (j >= len) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      const prev = mt[i - 1] ?? 0;
      const x = prev ^ (prev >>> 30);
      mt[i] = ((mt[i] ?? 0) ^ Math.imul(x, 1566083941)) - i >>> 0;
      i++;
      if (i >= 624) {
        mt[0] = mt[623] ?? 0;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32 */
  uint32(): number {
    const mt = this.mt;
    if (this.mti >= 624) {
      for (let kk = 0; kk < 624; kk++) {
        const y = ((mt[kk] ?? 0) & 0x80000000) | ((mt[(kk + 1) % 624] ?? 0) & 0x7fffffff);
        mt[kk] = ((mt[(kk + 397) % 624] ?? 0) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.mti = 0;
    }
    let y = mt[this.mti++] ?? 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.random(): 53-bit float in [0, 1) */
  random(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** getrandbits(k) for 0 < k <= 32 */
  getrandbits(k: number): number {
    return this.uint32() >>> (32 - k);
  }

  /** randbelow(n) for 0 < n < 2**32 */
  randbelow(n: number): number {
    const k = Math.floor(Math.log2(n)) + 1; // n.bit_length()
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randint(a: number, b: number): number {
    return a + this.randbelow(b - a + 1);
  }
}

// ----------------------------------------------------------------------------- unseeded random (module-level `random.*`)
export function rnd(): number {
  return Math.random();
}
export function choice<T>(xs: readonly T[]): T {
  if (!xs.length) throw new Error("Cannot choose from an empty sequence");
  return xs[Math.floor(Math.random() * xs.length)] as T;
}
export function uniform(a: number, b: number): number {
  return a + (b - a) * Math.random();
}
export function randint(a: number, b: number): number {
  return a + Math.floor(Math.random() * (b - a + 1));
}
export function sample<T>(xs: readonly T[], k: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  for (let i = 0; i < k && pool.length; i++) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0] as T);
  return out;
}

// ----------------------------------------------------------------------------- time
const p2 = (n: number): string => String(n).padStart(2, "0");

/** time.time() */
export function now(): number {
  return Date.now() / 1000;
}

/** time.strftime("%H:%M:%S") */
export function clock(d = new Date()): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function offsetText(d: Date, colon: boolean): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return sign + p2(Math.floor(a / 60)) + (colon ? ":" : "") + p2(a % 60);
}

/** tc_map.iso_now: local time with numeric offset, e.g. 2026-10-20T15:02:11-04:00 */
export function isoNow(d = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${offsetText(d, true)}`;
}

/**
 * tc_map.local_tz_label: "Eastern Daylight Time (UTC-04:00)".
 * Python's %Z is the long Windows name on Windows and the abbreviation elsewhere; mirror that.
 */
export function localTzLabel(d = new Date()): string {
  const style = process.platform === "win32" ? "long" : "short";
  let name = "";
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZoneName: style }).formatToParts(d).find((p) => p.type === "timeZoneName");
    name = part ? part.value : "";
  } catch {
    name = "";
  }
  return `${name} (UTC${offsetText(d, true)})`;
}

/** log line the way the Python tools print one: "HH:MM:SS msg" */
export function stamp(msg: string): string {
  return clock() + " " + msg;
}
