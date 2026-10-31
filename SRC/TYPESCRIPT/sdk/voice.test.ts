import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUTS,
  RATE,
  Reassembler,
  accentBase,
  accentOf,
  b64Decode,
  b64Encode,
  chunkIntact,
  crc32,
  cut,
  decodeChunk,
  encodeChunk,
  pcmBytes,
  resample,
  spell,
  topic,
  wavDecode,
  wavEncode,
  type Chunk,
} from "./voice.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function tone(secs: number): Int16Array {
  const n = Math.floor(RATE * secs);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.trunc(Math.sin(i * 0.07) * 8000);
  return out;
}

test("crc32 check value", () => {
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("base64 and wav round trip", () => {
  for (const s of ["", "a", "ab", "abc", "hello world"]) {
    assert.deepEqual(b64Decode(b64Encode(bytes(s))), bytes(s));
  }
  assert.equal(b64Encode(bytes("hi")), "aGk=");
  assert.deepEqual(b64Decode("aG\r\nk="), bytes("hi")); // CR/LF skipped, as Rust
  assert.equal(b64Decode("a*"), undefined);
  const pcm = tone(0.3);
  const w = wavEncode(pcm, RATE);
  assert.equal(w.length, 44 + pcm.length * 2);
  assert.deepEqual(wavDecode(w), { pcm, rate: RATE });
  assert.equal(wavDecode(bytes("not a wav")), undefined);
});

test("wav decode mixes stereo down to mono", () => {
  // Hand-built 2-channel WAV: frames (100, 300), (-5, -2).
  const st = wavEncode(Int16Array.from([100, 300, -5, -2]), 8000);
  const v = new DataView(st.buffer);
  v.setUint16(22, 2, true);
  assert.deepEqual(wavDecode(st)?.pcm, Int16Array.from([200, -3]));
});

test("resample", () => {
  const pcm = Int16Array.from([0, 100, 200, 300]);
  assert.deepEqual(resample(pcm, 8000, 8000), pcm);
  assert.deepEqual(resample(pcm, 8000, 16000), Int16Array.from([0, 50, 100, 150, 200, 250, 300, 300]));
  assert.deepEqual(resample(pcm, 16000, 8000), Int16Array.from([0, 200]));
});

test("accents follow the country", () => {
  assert.ok(accentOf("France", "Paris", "paris-01").startsWith("fr-fr+"));
  assert.ok(accentOf("United Kingdom", "Glasgow", "glasgow-02").startsWith("en-gb-scotland+"));
  assert.ok(accentOf("China", "Beijing", "beijing-01").startsWith("cmn+"));
  assert.ok(accentOf("Atlantis", "Nowhere", "x").startsWith("en-gb+"));
  assert.ok(accentOf("Japan", "Tokyo", "tokyo-01").startsWith("en-us+"));
  assert.equal(accentBase("China", "Hong Kong"), "yue");
  assert.equal(accentBase("United States", "New York"), "en-us-nyc");
  assert.equal(accentBase("Türkiye", "Ankara"), "tr");
  assert.equal(accentBase("Romania", "Bucharest"), "ro"); // "oman" is checked later
  // The variant is picked by the frame id's CRC: stable, and from the list.
  assert.equal(accentOf("France", "Paris", "paris-01"), accentOf("France", "Paris", "paris-01"));
  assert.match(accentOf("France", "Paris", "paris-01"), /^fr-fr\+(m[1-7]|f[1-5])$/);
});

test("topic and spell", () => {
  assert.equal(topic("dante", "dante-01", 5), "trunk-caster/dante/dante-01/voice5");
  assert.deepEqual(CUTS, [1, 5]);
  assert.equal(spell("BOS"), "B O S");
});

test("chunk wire format matches Rust's", () => {
  // Written by hand from voice.rs's format string:
  //   V1|id|cut|index|total|rate|{crc:08x}|kind|b64(text)|b64(pcm LE)|sent_ms
  // pcm [1, -2, 300] = 01 00 FE FF 2C 01 → "AQD+/ywB"; "hi" → "aGk=";
  // CRC-32 of those six bytes = 0xec897c47.
  const fixture = "V1|m1|1|0|3|8000|ec897c47|ident|aGk=|AQD+/ywB|1234";
  const c = decodeChunk(fixture);
  assert.ok(c !== undefined);
  assert.deepEqual(c, { id: "m1", cut: 1, index: 0, total: 3, rate: 8000, crc: 0xec897c47, kind: "ident", text: "hi", pcm: Int16Array.from([1, -2, 300]), sent_ms: 1234 });
  assert.ok(chunkIntact(c));
  assert.equal(encodeChunk(c), fixture);
  // And a chunk built here encodes to the same line.
  const mine: Chunk = { ...cut("m1", "ident", "hi", Int16Array.from([1, -2, 300]), RATE, 1)[0]!, sent_ms: 1234 };
  assert.equal(encodeChunk(mine), fixture);
  // 10 fields (no sent_ms) still decode, with sent_ms 0; a small CRC is zero-padded.
  assert.equal(decodeChunk("V1|m1|1|0|3|8000|ec897c47|ident|aGk=|AQD+/ywB\n")?.sent_ms, 0);
  assert.equal(encodeChunk({ ...c, crc: 0xab }).split("|")[6], "000000ab");
  // Rejected: wrong version, wrong field count, bad numbers, bad base64.
  assert.equal(decodeChunk(fixture.replace("V1", "V2")), undefined);
  assert.equal(decodeChunk(fixture + "|x"), undefined);
  assert.equal(decodeChunk("V1|m1|1|0|3|8000|ec897c47|ident|aGk="), undefined);
  assert.equal(decodeChunk(fixture.replace("|8000|", "|-1|")), undefined);
  assert.equal(decodeChunk(fixture.replace("|ec897c47|", "|xyz|")), undefined);
  assert.equal(decodeChunk(fixture.replace("aGk=", "a*k=")), undefined);
  // An unparsable sent_ms is 0, as Rust's unwrap_or(0).
  assert.equal(decodeChunk(fixture.replace("|1234", "|soon"))?.sent_ms, 0);
});

test("cut sizes and CRCs", () => {
  const pcm = tone(7.4);
  const ones = cut("m1", "ident", "t", pcm, RATE, 1);
  const fives = cut("m1", "ident", "t", pcm, RATE, 5);
  assert.deepEqual([ones.length, fives.length], [8, 2]);
  assert.equal(ones[7]?.pcm.length, pcm.length - 7 * RATE);
  assert.ok([...ones, ...fives].every(chunkIntact));
  assert.equal(ones[3]?.crc, crc32(pcmBytes(pcm.subarray(3 * RATE, 4 * RATE))));
  assert.deepEqual(cut("e", "call", "", new Int16Array(0), RATE, 1), []);
});

test("both cuts reassemble and correct", () => {
  const pcm = tone(7.4);
  const r = new Reassembler(60_000);
  const ones = cut("m1", "ident", "frame dante-01", pcm, RATE, 1);
  const fives = cut("m1", "ident", "frame dante-01", pcm, RATE, 5);
  ones.forEach((c0, i) => {
    const c = { ...c0, pcm: c0.pcm.slice() };
    if (i === 2) c.pcm[10] = (c.pcm[10] ?? 0) ^ 0x55; // damaged on the 1 s cut
    if (i !== 6) assert.ok(r.offer("dante-01", encodeChunk(c))); // second 6 never arrives on the 1 s cut
  });
  assert.deepEqual(r.ready(), []);
  assert.equal(r.waiting(), 1);
  for (const c of fives) r.offer("dante-01", encodeChunk(c));
  const a0 = r.ready();
  // A late copy of a recording already handed back starts nothing new.
  assert.ok(r.offer("dante-01", encodeChunk(ones[6]!)));
  assert.deepEqual(r.ready(), []);
  assert.equal(r.waiting(), 0);
  assert.equal(a0.length, 1);
  const a = a0[0]!;
  assert.deepEqual([a.seconds, a.from_1s, a.corrected_from_5s, a.lost, a.damaged, a.chunks], [8, 6, 2, 0, 1, 9]);
  assert.deepEqual(a.pcm, pcm);
  assert.equal(a.text, "frame dante-01");
  assert.equal(a.frame, "dante-01");
  assert.equal(a.at, "");
});

test("lost on both cuts is silence", () => {
  const pcm = tone(2.0);
  let t = 0;
  const r = new Reassembler(0, () => t);
  r.offer("f", encodeChunk(cut("m2", "call", "x", pcm, RATE, 1)[0]!));
  t = 2;
  const out = r.ready();
  assert.equal(out.length, 1);
  const a = out[0]!;
  assert.deepEqual([a.from_1s, a.corrected_from_5s, a.lost], [1, 0, 1]);
  assert.deepEqual(a.pcm.subarray(0, RATE), pcm.subarray(0, RATE));
  assert.ok(a.pcm.subarray(RATE).every((s) => s === 0));
});

test("offer rejects junk and unknown cuts", () => {
  const r = new Reassembler(1000);
  assert.equal(r.offer("f", "nonsense"), false);
  const c = cut("m3", "ident", "x", tone(1), RATE, 1)[0]!;
  assert.equal(r.offer("f", encodeChunk({ ...c, cut: 2 })), false);
  assert.equal(r.offer("f", encodeChunk({ ...c, rate: 0 })), false);
  assert.equal(r.waiting(), 0);
});
