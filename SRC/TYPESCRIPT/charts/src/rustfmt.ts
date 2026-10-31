// Rust std formatting semantics, reproduced byte-for-byte in TS so the ported
// renderers emit exactly what html.rs emits. Every difference between Rust's
// `format!` and JS `String()`/`toFixed()` that the charts can hit lives here.

/** Rust `f64::max`: NaN is ignored (JS `Math.max` propagates it). */
export function rustMax(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return Math.max(a, b);
}

/** Rust `f64::min`: NaN is ignored (JS `Math.min` propagates it). */
export function rustMin(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return Math.min(a, b);
}

/** Rust `f64::rem_euclid`. */
export function remEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
}

/** `x as u64`: truncates, saturates at 0 and 2^64-1, NaN -> 0. */
export function asU64(x: number): number {
  if (Number.isNaN(x) || x <= 0) return 0;
  if (x >= 18446744073709551615) return 18446744073709551615;
  return Math.trunc(x);
}

/** Expand JS exponent notation ("1e-7", "1.5e+21") into plain decimal digits. */
function expand(s: string): string {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const ei = body.indexOf("e");
  if (ei < 0) return s;
  const mant = body.slice(0, ei);
  const exp = Number(body.slice(ei + 1));
  const dot = mant.indexOf(".");
  const intLen = dot < 0 ? mant.length : dot;
  const digits = mant.replace(".", "");
  const point = intLen + exp;
  let out: string;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  return (neg ? "-" : "") + out;
}

/** Rust `{}` (Display) for f64: shortest round-trip digits, never exponent,
 * "-0" for negative zero, "inf"/"-inf"/"NaN". */
export function rustDisplay(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (Object.is(v, -0)) return "-0";
  return expand(String(v));
}

function incrementDecimal(s: string): string {
  const chars = s.split("");
  let i = chars.length - 1;
  for (; i >= 0; i--) {
    const c = chars[i];
    if (c === ".") continue;
    if (c === "9") {
      chars[i] = "0";
    } else {
      chars[i] = String(Number(c) + 1);
      return chars.join("");
    }
  }
  return "1" + chars.join("");
}

/** Rust `{:.p}` for f64: exact decimal value, ties round half to even
 * (JS `toFixed` rounds ties up and switches to exponent at 1e21). */
export function rustFixed(v: number, p: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  const neg = v < 0 || Object.is(v, -0);
  const a = Math.abs(v);
  let r: string;
  if (a >= 1e21) {
    r = BigInt(a).toString() + (p > 0 ? "." + "0".repeat(p) : "");
  } else {
    const full = a.toFixed(100);
    const dot = full.indexOf(".");
    const tail = full.slice(dot + 1 + p);
    if (tail[0] === "5" && /^0*$/.test(tail.slice(1))) {
      const truncated = p > 0 ? full.slice(0, dot + 1 + p) : full.slice(0, dot);
      const last = Number(truncated[truncated.length - 1]);
      r = last % 2 === 1 ? incrementDecimal(truncated) : truncated;
    } else {
      r = a.toFixed(p);
    }
  }
  return (neg ? "-" : "") + r;
}

/** Rust `{:0w}` for an unsigned integer. */
export function pad0(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

const ENCODER = new TextEncoder();
/** Rust `str::len()`: UTF-8 bytes, not UTF-16 units. */
export function utf8Len(s: string): number {
  return ENCODER.encode(s).length;
}

/** Rust `str::trim_end()`: Unicode White_Space (includes U+0085, excludes U+FEFF,
 * unlike JS `trimEnd`). */
export function rustTrimEnd(s: string): string {
  return s.replace(/[\t\n\v\f\r \u0085\u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}]+$/u, "");
}

/** Rust `str::lines()`: split on \n, strip one \r before each \n, no trailing empty line. */
export function rustLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  const endsWithNl = s.endsWith("\n");
  if (endsWithNl) parts.pop();
  return parts.map((line, i) => {
    const hadNl = i < parts.length - 1 || endsWithNl;
    return hadNl && line.endsWith("\r") ? line.slice(0, -1) : line;
  });
}

/** Rust `str` ordering (UTF-8 bytes == code points), unlike JS `<` (UTF-16 units). */
export function cmpRustStr(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) ?? 0;
    const cy = y.value.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}
