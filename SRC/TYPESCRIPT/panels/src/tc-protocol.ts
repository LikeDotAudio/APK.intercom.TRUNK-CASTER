/**
 * tc-protocol.ts -- the Trunk-Caster common UDP language (port of TRUNK-SIMULATOR/tc_protocol.py).
 *
 * DEDUP NOTE: canonical wire types belong to agent 04 (TYPESCRIPT/sdk). This
 * is a local, byte-exact copy so the panel can run today; swap the import
 * once sdk exports pack/unpack.
 *
 * Header (big-endian, 10 bytes): "TC" | version u8 | type u8 | port u16 | seq u16 | flags u16 | payload
 */
import type { ApiPort, PortState } from "./matrix-api.ts";

export const MAGIC = "TC";
export const VERSION = 1;

export const TYPE_HELLO = 1;
export const TYPE_HELLO_ACK = 2;
export const TYPE_AUDIO = 3;
export const TYPE_KEY = 4;
export const TYPE_STATE = 5;
export const TYPE_BYE = 6;
export type MsgType = 1 | 2 | 3 | 4 | 5 | 6;
export const TYPE_NAMES: Record<MsgType, string> = { 1: "HELLO", 2: "HELLO_ACK", 3: "AUDIO", 4: "KEY", 5: "STATE", 6: "BYE" };

export const KEY_TALK = 0;
export const KEY_LISTEN = 1;
export type KeyKind = typeof KEY_TALK | typeof KEY_LISTEN;

export const SAMPLE_RATE = 8000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
export const FRAME_BYTES = FRAME_SAMPLES * 2;
/** seconds */
export const HELLO_INTERVAL = 3.0;
/** seconds */
export const ENDPOINT_TIMEOUT = 10.0;
export const HEADER_SIZE = 10;

/** HELLO_ACK payload. */
export interface HelloAck {
  port: number;
  alpha: string;
  matrix?: string;
  series?: number;
  socket?: number;
  ports?: (ApiPort & { socket?: number })[];
}

/** STATE payload == the HTTP /api/port shape. */
export type TcState = PortState;

export interface TcMessage {
  /** raw type byte; not narrowed to MsgType because unknown types pass through unpack() in the .py too */
  type: number;
  port: number;
  seq: number;
  flags: number;
  payload: Buffer;
}

export function pack(type: number, port: number, seq: number, payload: Uint8Array = new Uint8Array(0), flags = 0): Buffer {
  const b = Buffer.alloc(HEADER_SIZE + payload.length);
  b.write(MAGIC, 0, "latin1");
  b.writeUInt8(VERSION, 2);
  b.writeUInt8(type & 0xff, 3);
  b.writeUInt16BE(port & 0xffff, 4);
  b.writeUInt16BE(seq & 0xffff, 6);
  b.writeUInt16BE(flags & 0xffff, 8);
  b.set(payload, HEADER_SIZE);
  return b;
}

/** -> message, or undefined if not ours. */
export function unpack(data: Buffer): TcMessage | undefined {
  if (data.length < HEADER_SIZE) return undefined;
  if (data.toString("latin1", 0, 2) !== MAGIC || data.readUInt8(2) !== VERSION) return undefined;
  return {
    type: data.readUInt8(3),
    port: data.readUInt16BE(4),
    seq: data.readUInt16BE(6),
    flags: data.readUInt16BE(8),
    payload: data.subarray(HEADER_SIZE),
  };
}

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), "utf-8");

export const packHello = (port: number, seq: number, name: string): Buffer => pack(TYPE_HELLO, port, seq, Buffer.from(name, "utf-8"));
export const packHelloAck = (port: number, seq: number, info: HelloAck): Buffer => pack(TYPE_HELLO_ACK, port, seq, json(info));
export const packAudio = (port: number, seq: number, pcm: Uint8Array): Buffer => pack(TYPE_AUDIO, port, seq, pcm);
export const packState = (port: number, seq: number, state: TcState): Buffer => pack(TYPE_STATE, port, seq, json(state));
export const packBye = (port: number, seq: number): Buffer => pack(TYPE_BYE, port, seq);

export function packKey(port: number, seq: number, kind: KeyKind, target: number, state: boolean): Buffer {
  const p = Buffer.alloc(4);
  p.writeUInt8(kind, 0);
  p.writeUInt16BE(target & 0xffff, 1);
  p.writeUInt8(state ? 1 : 0, 3);
  return pack(TYPE_KEY, port, seq, p);
}

export function unpackKey(payload: Buffer): { kind: number; target: number; state: boolean } {
  if (payload.length < 4) throw new RangeError("KEY payload shorter than 4 bytes");
  return { kind: payload.readUInt8(0), target: payload.readUInt16BE(1), state: payload.readUInt8(3) !== 0 };
}

/** json.loads(payload) -- caller narrows. */
export function loads(payload: Buffer): unknown {
  return JSON.parse(payload.toString("utf-8"));
}
