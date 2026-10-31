import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioEngine, decimate, floatToInt16LE, int16LEToUpsampled, rms, type AudioLink } from "./audio.ts";

test("int16 conversion clips to +-32767 and truncates toward zero like numpy astype", () => {
  const b = floatToInt16LE(new Float32Array([0.1, -0.5, 1.5, -2.0, -0.0001, 0]));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => b.readInt16LE(i * 2)), [3276, -16383, 32767, -32767, -3, 0]);
});

test("decimate averages blocks and drops the remainder", () => {
  assert.deepEqual(Array.from(decimate(new Float32Array([1, 3, 5, 7, 9]), 2)), [2, 6]);
});

test("upsample repeats samples and zero-pads", () => {
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(16384, 0);
  pcm.writeInt16LE(-32768, 2);
  assert.deepEqual(Array.from(int16LEToUpsampled(pcm, 3, 8)), [0.5, 0.5, 0.5, -1, -1, -1, 0, 0]);
});

test("engine: 48 kHz blocks become 160-sample frames only while the mic is open and unmuted", () => {
  const sent: Buffer[] = [];
  const rx: Buffer[] = [Buffer.alloc(320, 0x10)];
  const link: AudioLink = { sendAudio: (b) => sent.push(b), popRx: () => rx.shift() };
  const e = new AudioEngine(link, 48000);
  assert.equal(e.block, 960);
  const block = new Float32Array(960).fill(0.5);
  e.onInput(block);
  assert.equal(sent.length, 0, "mic closed: frames are dropped");
  e.micOpen = true;
  e.onInput(new Float32Array(480).fill(0.5));
  e.onInput(new Float32Array(480).fill(0.5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.length, 320);
  assert.equal(sent[0]?.readInt16LE(0), 16383);
  e.muted = true;
  e.onInput(block);
  assert.equal(sent.length, 1, "muted: nothing sent");
  assert.ok(Math.abs(e.micLevel - 0.5) < 1e-6, "level is still metered while muted");
  const out = e.onOutput(960);
  assert.equal(out.length, 960);
  assert.ok(e.spkLevel > 0);
  const silent = e.onOutput(960);
  assert.equal(rms(silent), 1e-9);
  assert.throws(() => new AudioEngine(link, 44100));
});
