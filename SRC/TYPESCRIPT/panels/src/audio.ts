/**
 * audio.ts -- mic -> 8 kHz frames -> matrix ; matrix frames -> speaker.
 *
 * Port of trunk_panel.py:143-210 (class Audio). The numpy maths is reproduced
 * sample-for-sample in plain Float32Array loops (block-average decimation,
 * sample-repeat upsampling, clip to +-32767, truncate to int16 LE).
 *
 * What changed: sounddevice (PortAudio) has no Node equivalent in the
 * standard library, so the engine is device-agnostic and a *device* drives
 * it with duplex callbacks:
 *   - NullAudioDevice   no audio (the .py's "sounddevice/numpy not available")
 *   - ToneAudioDevice   a 1 kHz test tone on a 20 ms timer (scripted tests / demos)
 *   - the browser bridge in trunk-panel.ts (getUserMedia + AudioWorklet over a WebSocket)
 * A native PortAudio addon would be a fourth device; see HANDOFF "audio".
 */
import { FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE } from "./tc-protocol.ts";

/** What the engine needs from the matrix link. */
export interface AudioLink {
  sendAudio(pcm: Buffer): void;
  /** pop the oldest received frame (int16 LE), or undefined if the jitter queue is empty */
  popRx(): Buffer | undefined;
}

export function rms(x: Float32Array): number {
  if (x.length === 0) return 1e-9; // np.mean([]) is nan in numpy; avoid propagating NaN
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / x.length) + 1e-9;
}

/** mono[:usable].reshape(-1, factor).mean(axis=1) */
export function decimate(mono: Float32Array, factor: number): Float32Array {
  const n = Math.floor(mono.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += mono[i * factor + j] ?? 0;
    out[i] = s / factor;
  }
  return out;
}

/** np.clip(frame * 32767, -32767, 32767).astype("<i2").tobytes() -- astype truncates toward zero. */
export function floatToInt16LE(frame: Float32Array): Buffer {
  const b = Buffer.alloc(frame.length * 2);
  for (let i = 0; i < frame.length; i++) {
    const v = Math.max(-32767, Math.min(32767, Math.fround((frame[i] ?? 0) * 32767)));
    b.writeInt16LE(Math.trunc(v), i * 2);
  }
  return b;
}

/** np.repeat(int16/32768, factor)[:frames], zero-padded to `frames`. */
export function int16LEToUpsampled(pcm: Buffer, factor: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    for (let j = 0; j < factor; j++) {
      const k = i * factor + j;
      if (k >= frames) return out;
      out[k] = v;
    }
  }
  return out;
}

export class AudioEngine {
  readonly rate: number;
  readonly factor: number;
  /** device block size in samples at `rate` (one 20 ms frame) */
  readonly block: number;
  micLevel = 0;
  spkLevel = 0;
  muted = false;
  micOpen = false;
  error: string | null = null;
  private acc = new Float32Array(0);
  private readonly link: AudioLink;

  constructor(link: AudioLink, rate = 48000) {
    if (rate % SAMPLE_RATE) throw new RangeError(`rate must be a multiple of ${SAMPLE_RATE}`);
    this.link = link;
    this.rate = rate;
    this.factor = rate / SAMPLE_RATE;
    this.block = FRAME_SAMPLES * this.factor;
  }

  /** py _on_input: one block of mono float32 from the microphone. */
  onInput(mono: Float32Array): void {
    this.micLevel = rms(mono);
    if (this.muted) return;
    const down = decimate(mono, this.factor);
    const acc = new Float32Array(this.acc.length + down.length);
    acc.set(this.acc);
    acc.set(down, this.acc.length);
    let off = 0;
    while (acc.length - off >= FRAME_SAMPLES) {
      const frame = acc.subarray(off, off + FRAME_SAMPLES);
      off += FRAME_SAMPLES;
      if (this.micOpen) this.link.sendAudio(floatToInt16LE(frame));
    }
    this.acc = acc.slice(off);
  }

  /** py _on_output: fill `frames` samples for the speaker. */
  onOutput(frames: number): Float32Array {
    const pcm = this.link.popRx();
    if (pcm) {
      const up = int16LEToUpsampled(pcm.subarray(0, FRAME_BYTES), this.factor, frames);
      this.spkLevel = rms(up);
      return up;
    }
    this.spkLevel *= 0.8;
    return new Float32Array(frames);
  }
}

export interface AudioDevice {
  readonly name: string;
  /** resolve true if audio runs; on false the engine's .error says why */
  start(engine: AudioEngine): boolean;
  stop(): void;
}

export class NullAudioDevice implements AudioDevice {
  readonly name = "none";
  private readonly reason: string;
  constructor(reason = "no audio device in Node (use --audio browser or --audio tone)") {
    this.reason = reason;
  }
  start(engine: AudioEngine): boolean {
    engine.error = this.reason;
    return false;
  }
  stop(): void {}
}

/** 1 kHz tone at -12 dBFS as the "mic"; the speaker output is metered and discarded. */
export class ToneAudioDevice implements AudioDevice {
  readonly name = "tone";
  private timer: NodeJS.Timeout | undefined;
  private phase = 0;
  start(engine: AudioEngine): boolean {
    const step = (2 * Math.PI * 1000) / engine.rate;
    this.timer = setInterval(() => {
      const block = new Float32Array(engine.block);
      for (let i = 0; i < block.length; i++) block[i] = 0.25 * Math.sin((this.phase += step));
      this.phase %= 2 * Math.PI;
      engine.onInput(block);
      engine.onOutput(engine.block);
    }, 20);
    engine.error = null;
    return true;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
