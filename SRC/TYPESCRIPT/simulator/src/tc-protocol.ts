/**
 * tc-protocol.ts -- the Trunk-Caster common language (port of TRUNK-SIMULATOR/tc_protocol.py).
 *
 * One UDP socket per matrix port, fixed 20 ms frames of 8 kHz 16-bit mono PCM,
 * and a handful of control messages.  An intercom owns a SERIES of 256
 * consecutive UDP ports: series + 0 is the intercom's own socket (HELLO there to
 * be given a port), series + n is matrix port n's socket.
 *
 * Frame layout (big-endian):
 *     0  2   magic   "TC"
 *     2  1   version 1
 *     3  1   type    TYPE_*
 *     4  2   port    intercom port this frame is about (0 = unassigned)
 *     6  2   seq     sender sequence number (wraps)
 *     8  2   flags   reserved / per-type
 *    10  ..  payload
 *
 * Payloads: HELLO utf-8 name; HELLO_ACK JSON; AUDIO 160 int16 LE samples;
 * KEY ">BHB" kind/target/state; STATE JSON; BYE empty.
 *
 * NOTE for dedup with agent 04 (TYPESCRIPT/sdk): HelloAck / PortState shapes
 * below are defined locally; the canonical wire types belong to the SDK.
 */
import { pyJson } from "./py.ts";

export const MAGIC = "TC";
export const VERSION = 1;

export const TYPE_HELLO = 1;
export const TYPE_HELLO_ACK = 2;
export const TYPE_AUDIO = 3;
export const TYPE_KEY = 4;
export const TYPE_STATE = 5;
export const TYPE_BYE = 6;
export const TYPE_NAMES: Readonly<Record<number, string>> = { 1: "HELLO", 2: "HELLO_ACK", 3: "AUDIO", 4: "KEY", 5: "STATE", 6: "BYE" };

export const KEY_TALK = 0;
export const KEY_LISTEN = 1;

export const SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
export const FRAME_BYTES = FRAME_SAMPLES * 2;
export const HELLO_INTERVAL = 3.0;
export const ENDPOINT_TIMEOUT = 10.0;

export const HEADER_SIZE = 10; // struct ">2sBBHHH"
export const KEY_PAYLOAD_SIZE = 4; // struct ">BHB"

export interface HelloAckPort {
  n: number;
  alpha: string;
  type: string;
  user: boolean;
  socket: number;
}
export interface HelloAck {
  port: number;
  alpha: string;
  matrix: string;
  tz?: string;
  series: number;
  socket: number;
  ports: HelloAckPort[];
}
export interface IncomingCall {
  port: number;
  alpha: string;
  since: number;
}
export interface PortState {
  port: number;
  alpha: string;
  matrix: string;
  talking_to: number[];
  remote: string[];
  listening: number[];
  incoming: IncomingCall[];
  users: number;
  users_calling: number;
  time: string;
}

export interface Message {
  type: number;
  port: number;
  seq: number;
  flags: number;
  payload: Buffer;
}

export interface KeyMessage {
  kind: number;
  target: number;
  state: boolean;
}

export function pack(msgType: number, port: number, seq: number, payload: Uint8Array = Buffer.alloc(0), flags = 0): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  h.write(MAGIC, 0, "latin1");
  h.writeUInt8(VERSION, 2);
  h.writeUInt8(msgType & 0xff, 3);
  h.writeUInt16BE(port & 0xffff, 4);
  h.writeUInt16BE(seq & 0xffff, 6);
  h.writeUInt16BE(flags & 0xffff, 8);
  return Buffer.concat([h, payload]);
}

/** -> message, or null if not ours. */
export function unpack(data: Uint8Array): Message | null {
  if (data.length < HEADER_SIZE) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b[0] !== 0x54 || b[1] !== 0x43 || b[2] !== VERSION) return null;
  return { type: b.readUInt8(3), port: b.readUInt16BE(4), seq: b.readUInt16BE(6), flags: b.readUInt16BE(8), payload: b.subarray(HEADER_SIZE) };
}

export function packHello(port: number, seq: number, name: string): Buffer {
  return pack(TYPE_HELLO, port, seq, Buffer.from(name, "utf-8"));
}

/** JSON with separators (",", ":") and ensure_ascii, byte-identical to the Python encoder. */
function jsonBytes(v: unknown): Buffer {
  return Buffer.from(pyJson(v, { compact: true }), "utf-8");
}

export function packHelloAck(port: number, seq: number, info: HelloAck): Buffer {
  return pack(TYPE_HELLO_ACK, port, seq, jsonBytes(info));
}

export function packAudio(port: number, seq: number, pcm: Uint8Array): Buffer {
  return pack(TYPE_AUDIO, port, seq, pcm);
}

export function packKey(port: number, seq: number, kind: number, target: number, state: boolean): Buffer {
  const p = Buffer.alloc(KEY_PAYLOAD_SIZE);
  p.writeUInt8(kind & 0xff, 0);
  p.writeUInt16BE(target & 0xffff, 1);
  p.writeUInt8(state ? 1 : 0, 3);
  return pack(TYPE_KEY, port, seq, p);
}

/** Throws RangeError on a short payload (Python raises struct.error). */
export function unpackKey(payload: Uint8Array): KeyMessage {
  if (payload.length < KEY_PAYLOAD_SIZE) throw new RangeError("unpack_from requires a buffer of at least 4 bytes");
  const b = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return { kind: b.readUInt8(0), target: b.readUInt16BE(1), state: b.readUInt8(3) !== 0 };
}

export function packState(port: number, seq: number, state: PortState | Record<string, unknown>): Buffer {
  return pack(TYPE_STATE, port, seq, jsonBytes(state));
}

export function packBye(port: number, seq: number): Buffer {
  return pack(TYPE_BYE, port, seq);
}

export function loads(payload: Uint8Array): unknown {
  return JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf-8"));
}
