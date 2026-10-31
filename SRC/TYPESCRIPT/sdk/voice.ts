/**
 * Voice: every simulator says who it is and what it is connected to — port
 * of TRUNK-CASTER-SDK/src/voice.rs.
 *
 * A frame's announcement ("frame dante-01, Boston, United States, airport
 * B O S" or "connection from … to …") is spoken into a WAV and handed to
 * the wave sender. The sender cuts the same audio twice, into 1-second and
 * 5-second chunks, and sends both cuts at the same time:
 *
 *   trunk-caster/<protocol>/<frame>/voice1   1-second chunks
 *   trunk-caster/<protocol>/<frame>/voice5   5-second chunks
 *   payload: V1|<id>|<cut>|<index>|<total samples>|<rate>|<crc32>|<kind>|<text b64>|<pcm b64>|<sent ms>
 *
 * Each chunk carries a CRC-32 of its samples (16-bit little-endian PCM).
 * The receiver re-assembles second by second: from the 1-second chunk when
 * it arrived intact, else from that second's slice of the 5-second chunk. A
 * second is lost only when both copies are, so a damaged or dropped chunk on
 * one cut is corrected from the other. Every chunk also carries the
 * announcement's text, so any one chunk names what the recording says.
 *
 * Browser-safe: no `node:*` imports (TextEncoder/TextDecoder and
 * `performance.now()` are globals in Node and browsers).
 */

import { MQTT_ROOT } from "./mqtt.ts";
import type { F64, IsoTime, U32, U64, Usize } from "./types.ts";

/** The voice rate: telephone quality, as an intercom line carries it. */
export const RATE: U32 = 8000;
/** The two cuts, in seconds. */
export const CUTS: readonly [Usize, Usize] = [1, 5];

/** `trunk-caster/<protocol>/<frame>/voice<cut>`. */
export function topic(protocol: string, frame: string, cut: Usize): string {
  return `${MQTT_ROOT}/${protocol}/${frame}/voice${cut}`;
}

// ---------------------------------------------------------------------------
// CRC-32, base64, WAV
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE, reflected, as zlib). Unsigned. */
export function crc32(bytes: Uint8Array): U32 {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return ~c >>> 0;
}

const utf8 = new TextEncoder();

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

const VARIANTS = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "f1", "f2", "f3", "f4", "f5"] as const;

/**
 * The espeak-ng voice a frame speaks English in: the accent of its country
 * (its city, where a city has its own), plus a variant picked by the frame
 * id, so two frames on one site do not sound the same. Japanese and Hebrew
 * voices spell English out letter by letter, so those countries speak
 * plain English.
 */
export function accentOf(country: string, site: string, frame: string): string {
  const h = crc32(utf8.encode(frame));
  return `${accentBase(country, site)}+${VARIANTS[h % VARIANTS.length] ?? "m1"}`;
}

/** Country (substring, lowercased) → espeak-ng voice; first match wins, in this order. */
const BY_COUNTRY: readonly (readonly [readonly string[], string])[] = [
  [["united states", "canada", "philippines", "japan"], "en-us"],
  [["united kingdom", "ireland", "australia", "new zealand", "singapore", "nigeria", "ghana", "israel"], "en-gb-x-rp"],
  [["jamaica", "cuba", "caribbean"], "en-029"],
  [["france", "morocco", "tunisia", "algeria"], "fr-fr"],
  [["belgium"], "fr-be"],
  [["switzerland"], "fr-ch"],
  [["germany", "austria", "luxembourg"], "de"],
  [["spain"], "es"],
  [["mexico", "argentina", "chile", "colombia", "peru", "venezuela", "uruguay", "bolivia", "ecuador", "paraguay", "guatemala", "costa rica", "panama"], "es-419"],
  [["brazil"], "pt-br"],
  [["portugal"], "pt"],
  [["italy"], "it"],
  [["netherlands"], "nl"],
  [["sweden"], "sv"],
  [["norway"], "nb"],
  [["denmark"], "da"],
  [["finland"], "fi"],
  [["iceland"], "is"],
  [["poland"], "pl"],
  [["czech"], "cs"],
  [["hungary"], "hu"],
  [["greece"], "el"],
  [["romania"], "ro"],
  [["croatia", "serbia"], "hr"],
  [["ukraine"], "uk"],
  [["russia"], "ru"],
  [["türkiye", "turkey"], "tr"],
  [["iran"], "fa"],
  [["saudi", "emirates", "qatar", "iraq", "kuwait", "jordan", "lebanon", "oman", "bahrain", "syria", "yemen", "egypt"], "ar"],
  [["india"], "hi"],
  [["pakistan"], "ur"],
  [["bangladesh"], "bn"],
];

/** Checked after the "hong kong" site test, which must win over China. */
const BY_COUNTRY_EAST: readonly (readonly [readonly string[], string])[] = [
  [["china", "taiwan"], "cmn"],
  [["korea"], "ko"],
  [["vietnam"], "vi"],
  [["thailand"], "th"],
  [["indonesia"], "id"],
  [["malaysia"], "ms"],
  [["kenya", "tanzania"], "sw"],
  [["south africa"], "af"],
  [["ethiopia"], "am"],
];

/** The espeak-ng voice of a country (or of a city that has its own accent), without the per-frame variant. */
export function accentBase(country: string, site: string): string {
  const c = country.toLowerCase();
  const s = site.toLowerCase();
  const match = (table: readonly (readonly [readonly string[], string])[]): string | undefined =>
    table.find(([names]) => names.some((n) => c.includes(n)))?.[1];
  if (s.startsWith("new york")) return "en-us-nyc";
  if (s.startsWith("glasgow") || s.startsWith("scotland")) return "en-gb-scotland";
  if (s.startsWith("manchester")) return "en-gb-x-gbclan";
  if (s.startsWith("wales") || s.startsWith("northern ireland")) return "en-gb-x-gbcwmd";
  if (s.startsWith("hawaii")) return "haw";
  const west = match(BY_COUNTRY);
  if (west !== undefined) return west;
  if (s.startsWith("hong kong")) return "yue";
  return match(BY_COUNTRY_EAST) ?? "en-gb";
}

/** 16-bit samples → little-endian bytes. */
export function pcmBytes(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) v.setInt16(i * 2, pcm[i] ?? 0, true);
  return out;
}

/** Little-endian bytes → 16-bit samples; a trailing odd byte is dropped (`chunks_exact`). */
export function pcmOf(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard padded base64. */
export function b64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const len = Math.min(3, bytes.length - i);
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    for (let k = 0; k < 4; k++) out += k <= len ? B64[(n >>> (18 - 6 * k)) & 63] : "=";
  }
  return out;
}

/** Lenient as Rust: skips `=`, CR and LF anywhere; any other non-alphabet byte → `undefined`. */
export function b64Decode(s: string): Uint8Array | undefined {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let v: number;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 97 + 26;
    else if (c >= 48 && c <= 57) v = c - 48 + 52;
    else if (c === 43) v = 62;
    else if (c === 47) v = 63;
    else if (c === 61 || c === 13 || c === 10) continue;
    else return undefined;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const tag = (w: Uint8Array, at: number, s: string): boolean => [...s].every((ch, k) => w[at + k] === ch.charCodeAt(0));

/** A 16-bit mono PCM WAV. */
export function wavEncode(pcm: Int16Array, rate: U32): Uint8Array {
  const data = pcmBytes(pcm);
  const w = new Uint8Array(44 + data.length);
  const v = new DataView(w.buffer);
  w.set(ascii("RIFF"), 0);
  v.setUint32(4, 36 + data.length, true);
  w.set(ascii("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, (rate * 2) >>> 0, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w.set(ascii("data"), 36);
  v.setUint32(40, data.length, true);
  w.set(data, 44);
  return w;
}

/**
 * Read a 16-bit PCM WAV (any rate, channels mixed down to mono). Tolerates
 * the 0xFFFFFFFF sizes a WAV streamed to stdout carries.
 */
export function wavDecode(w: Uint8Array): { pcm: Int16Array; rate: U32 } | undefined {
  if (w.length < 12 || !tag(w, 0, "RIFF") || !tag(w, 8, "WAVE")) return undefined;
  const v = new DataView(w.buffer, w.byteOffset, w.byteLength);
  let i = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (i + 8 <= w.length) {
    const len = v.getUint32(i + 4, true);
    const body = i + 8;
    const bodyLen = w.length - body;
    if (tag(w, i, "fmt ") && bodyLen >= 16) {
      channels = Math.max(1, v.getUint16(body + 2, true));
      rate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (tag(w, i, "data")) {
      if (bits !== 16 || rate === 0) return undefined;
      const all = pcmOf(w.subarray(body, body + (Math.min(len, bodyLen) & ~1)));
      const mono = new Int16Array(Math.ceil(all.length / channels));
      for (let f = 0; f < mono.length; f++) {
        const frame = all.subarray(f * channels, (f + 1) * channels);
        let sum = 0;
        for (const s of frame) sum += s;
        mono[f] = Math.trunc(sum / frame.length);
      }
      return { pcm: mono, rate };
    }
    i += 8 + len + (len & 1);
  }
  return undefined;
}

/** Linear resampling to `to` Hz. */
export function resample(pcm: Int16Array, from: U32, to: U32): Int16Array {
  if (from === to || pcm.length === 0) return pcm.slice();
  const n = Math.floor((pcm.length * to) / from);
  const out = new Int16Array(n);
  const last = pcm.length - 1;
  for (let j = 0; j < n; j++) {
    const x = (j * from) / to;
    const k = Math.floor(x);
    const f = x - k;
    const a = pcm[Math.min(k, last)] ?? 0;
    const b = pcm[Math.min(k + 1, last)] ?? 0;
    out[j] = Math.max(-32768, Math.min(32767, Math.trunc(a + (b - a) * f)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chunks: the wave sender's cuts
// ---------------------------------------------------------------------------

/** One chunk of one cut (`voice::Chunk`). Not JSON: it travels as the `V1|…` line. */
export interface Chunk {
  id: string;
  /** 1 or 5: the cut's length in seconds. */
  cut: Usize;
  index: Usize;
  /** Samples in the whole recording. */
  total: Usize;
  rate: U32;
  crc: U32;
  /** "ident" or "call". */
  kind: "ident" | "call" | (string & {});
  text: string;
  pcm: Int16Array;
  /** When the sender sent it, in ms from the start of the recording's transmission. */
  sent_ms: U64;
}

/** `Chunk::intact`: the samples match their CRC. */
export function chunkIntact(c: Chunk): boolean {
  return crc32(pcmBytes(c.pcm)) === c.crc;
}

/** `Chunk::encode`: the 11-field `V1|…` line. */
export function encodeChunk(c: Chunk): string {
  const crc = (c.crc >>> 0).toString(16).padStart(8, "0");
  return `V1|${c.id}|${c.cut}|${c.index}|${c.total}|${c.rate}|${crc}|${c.kind}|${b64Encode(utf8.encode(c.text))}|${b64Encode(pcmBytes(c.pcm))}|${c.sent_ms}`;
}

/** Rust `str::parse::<uN>()`: optional `+`, decimal digits, in range. */
function parseUint(s: string, max: number): number | undefined {
  if (!/^\+?[0-9]+$/.test(s)) return undefined;
  const n = Number(s);
  return n <= max ? n : undefined;
}
const U32_MAX = 0xffffffff;

/** `Chunk::decode`: 10 fields (older senders, no `sent_ms` → 0) or 11. */
export function decodeChunk(s: string): Chunk | undefined {
  const p = s.trim().split("|");
  if (p.length < 10 || p.length > 11 || p[0] !== "V1") return undefined;
  const cut = parseUint(p[2] ?? "", Number.MAX_SAFE_INTEGER);
  const index = parseUint(p[3] ?? "", Number.MAX_SAFE_INTEGER);
  const total = parseUint(p[4] ?? "", Number.MAX_SAFE_INTEGER);
  const rate = parseUint(p[5] ?? "", U32_MAX);
  const crcStr = p[6] ?? "";
  const crc = /^\+?[0-9a-fA-F]+$/.test(crcStr) ? parseInt(crcStr, 16) : undefined;
  if (cut === undefined || index === undefined || total === undefined || rate === undefined || crc === undefined || crc > U32_MAX) return undefined;
  const textBytes = b64Decode(p[8] ?? "");
  const pcmB = b64Decode(p[9] ?? "");
  if (textBytes === undefined || pcmB === undefined) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(textBytes);
  } catch {
    return undefined;
  }
  const sent = p[10] === undefined ? undefined : parseUint(p[10], Number.MAX_SAFE_INTEGER);
  return { id: p[1] ?? "", cut, index, total, rate, crc, kind: p[7] ?? "", text, pcm: pcmOf(pcmB), sent_ms: sent ?? 0 };
}

/** Cut one recording into `secs`-second chunks (`sent_ms` 0; the sender stamps it). */
export function cut(id: string, kind: string, text: string, pcm: Int16Array, rate: U32, secs: Usize): Chunk[] {
  const step = Math.max(1, rate * secs);
  const out: Chunk[] = [];
  for (let a = 0, index = 0; a < pcm.length; a += step, index++) {
    const s = pcm.slice(a, a + step);
    out.push({ id, cut: secs, index, total: pcm.length, rate, crc: crc32(pcmBytes(s)), kind, text, pcm: s, sent_ms: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-assembly with error correction
// ---------------------------------------------------------------------------

/**
 * A recording put back together, with how each second was recovered — the
 * JSON shape (`GET /api/voices`). Rust's `pcm` is `#[serde(skip)]`, so it is
 * not here; see `AssembledRecording`.
 */
export interface Assembled {
  id: string;
  frame: string;
  kind: string;
  text: string;
  rate: U32;
  seconds: Usize;
  /** Seconds taken from their 1-second chunk. */
  from_1s: Usize;
  /** Seconds corrected from the 5-second cut (their 1-second chunk was damaged or never came). */
  corrected_from_5s: Usize;
  /** Seconds lost on both cuts, filled with silence. */
  lost: Usize;
  /** Chunks that failed their CRC. */
  damaged: Usize;
  chunks: Usize;
  /** How long the sender took over both cuts (the last chunk's send time). */
  transmit_s: F64;
  /** Empty from the reassembler; the runtime stamps it. */
  at: IsoTime;
}

/** What `Reassembler.ready` hands back: `Assembled` plus the samples. */
export interface AssembledRecording extends Assembled {
  pcm: Int16Array;
}

interface Pending {
  frame: string;
  last: number;
  /** `"<cut>:<index>"` → the chunk and whether it passed its CRC (checked once, on arrival). */
  chunks: Map<string, { c: Chunk; ok: boolean }>;
  damaged: Usize;
  meta: Chunk;
  /** A chunk arrived since `recoverable` was last asked. */
  fresh: boolean;
}

const ck = (cut: Usize, index: Usize): string => `${cut}:${index}`;
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b);

function expected(p: Pending, cutSecs: Usize): Usize {
  return ceilDiv(p.meta.total, p.meta.rate * cutSecs);
}

/** Every second can be had from an intact copy on one cut or the other. */
function recoverable(p: Pending): boolean {
  const good = (cutSecs: Usize, i: Usize): boolean => p.chunks.get(ck(cutSecs, i))?.ok === true;
  if (!CUTS.every((c) => expected(p, c) > 0)) return false;
  const seconds = ceilDiv(p.meta.total, p.meta.rate);
  for (let s = 0; s < seconds; s++) if (!good(1, s) && !good(5, Math.floor(s / 5))) return false;
  return true;
}

function assemble(p: Pending): AssembledRecording {
  const rate = p.meta.rate;
  const total = p.meta.total;
  const seconds = ceilDiv(total, rate);
  const pcm = new Int16Array(total);
  let from1s = 0;
  let corrected = 0;
  let lost = 0;
  for (let s = 0; s < seconds; s++) {
    const a = s * rate;
    const b = Math.min((s + 1) * rate, total);
    const one = p.chunks.get(ck(1, s));
    if (one !== undefined && one.ok && one.c.pcm.length === b - a) {
      pcm.set(one.c.pcm, a);
      from1s++;
      continue;
    }
    const off = a - Math.floor(s / 5) * rate * 5;
    const five = p.chunks.get(ck(5, Math.floor(s / 5)));
    if (five !== undefined && five.ok && five.c.pcm.length >= off + (b - a)) {
      pcm.set(five.c.pcm.subarray(off, off + (b - a)), a);
      corrected++;
    } else {
      lost++;
    }
  }
  let maxSent = 0;
  for (const { c } of p.chunks.values()) maxSent = Math.max(maxSent, c.sent_ms);
  return {
    id: p.meta.id,
    frame: p.frame,
    kind: p.meta.kind,
    text: p.meta.text,
    rate: p.meta.rate,
    seconds,
    from_1s: from1s,
    corrected_from_5s: corrected,
    lost,
    damaged: p.damaged,
    chunks: p.chunks.size,
    transmit_s: maxSent / 1000,
    at: "",
    pcm,
  };
}

/**
 * Collects chunks from both cuts and hands back whole recordings: as soon
 * as every second can be recovered, or `idleMs` after the last chunk
 * arrived (the seconds still missing are then silence). Late chunks of a
 * recording already handed back are ignored.
 *
 * `now` is a monotonic millisecond clock (Rust `Instant`); injectable for tests.
 */
export class Reassembler {
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly done: string[] = [];

  constructor(idleMs: number, now: () => number = () => performance.now()) {
    this.idleMs = idleMs;
    this.now = now;
  }

  /** Offer one chunk's payload, heard for `frame`. False when it does not parse. */
  offer(frame: string, payload: string): boolean {
    const c = decodeChunk(payload);
    if (c === undefined || c.rate === 0 || !CUTS.includes(c.cut)) return false;
    const now = this.now();
    const key = `${frame}|${c.id}`;
    if (this.done.includes(key)) return true;
    let p = this.pending.get(key);
    if (p === undefined) {
      p = { frame, last: now, chunks: new Map(), damaged: 0, meta: { ...c, pcm: new Int16Array(0) }, fresh: false };
      this.pending.set(key, p);
    }
    p.last = now;
    p.fresh = true;
    const ok = chunkIntact(c);
    if (!ok) p.damaged++;
    p.chunks.set(ck(c.cut, c.index), { c, ok });
    return true;
  }

  /** Recordings that are whole, or have waited long enough (in key order, as Rust's BTreeMap). */
  ready(): AssembledRecording[] {
    const now = this.now();
    const keys = [...this.pending.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const doneNow: string[] = [];
    for (const k of keys) {
      const p = this.pending.get(k);
      if (p === undefined) continue;
      const fresh = p.fresh;
      p.fresh = false;
      if ((fresh && recoverable(p)) || now - p.last > this.idleMs) doneNow.push(k);
    }
    const out: AssembledRecording[] = [];
    for (const k of doneNow) {
      this.done.push(k);
      if (this.done.length > 512) this.done.shift();
      const p = this.pending.get(k);
      if (p !== undefined) {
        this.pending.delete(k);
        out.push(assemble(p));
      }
    }
    return out;
  }

  /** Recordings still waiting for chunks. */
  waiting(): Usize {
    return this.pending.size;
  }
}

/** Spell a code letter by letter so a speech engine says "B O S". */
export function spell(code: string): string {
  return [...code].join(" ");
}
