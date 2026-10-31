import assert from "node:assert/strict";
import { test } from "node:test";
import { parity } from "./fixtures.ts";
import * as tcp from "./tc-protocol.ts";

const fx = parity().tc;

test("constants match tc_protocol.py", () => {
  assert.equal(tcp.FRAME_SAMPLES, 160);
  assert.equal(tcp.FRAME_BYTES, 320);
  assert.equal(tcp.HEADER_SIZE, 10);
});

test("pack_* are byte-identical to Python", () => {
  assert.equal(tcp.packHello(0, 7, "Control room PC").toString("hex"), fx.hello);
  assert.equal(tcp.packHelloAck(5, 65537, { port: 5, alpha: "PNL05", matrix: "LOND", tz: "Zürich", series: 22304, socket: 22309, ports: [] }).toString("hex"), fx.hello_ack);
  assert.equal(tcp.packKey(5, 9, tcp.KEY_LISTEN, 70000, true).toString("hex"), fx.key);
  assert.equal(tcp.packBye(3, 2).toString("hex"), fx.bye);
  assert.equal(tcp.packState(1, 1, { talking_to: [2, 3], users: 56 }).toString("hex"), fx.state);
});

test("unpack round-trips and rejects foreign datagrams", () => {
  const m = tcp.unpack(tcp.packAudio(12, 0x1ffff, Buffer.alloc(tcp.FRAME_BYTES, 1)));
  assert.ok(m);
  assert.equal(m.type, tcp.TYPE_AUDIO);
  assert.equal(m.port, 12);
  assert.equal(m.seq, 0xffff);
  assert.equal(m.payload.length, tcp.FRAME_BYTES);
  assert.equal(tcp.unpack(Buffer.from("TC")), null);
  assert.equal(tcp.unpack(Buffer.from("XX\x01\x01\0\0\0\0\0\0")), null);
  assert.equal(tcp.unpack(Buffer.from("TC\x02\x01\0\0\0\0\0\0")), null);
  const k = tcp.unpack(tcp.packKey(1, 1, tcp.KEY_TALK, 25, false));
  assert.ok(k);
  assert.deepEqual(tcp.unpackKey(k.payload), { kind: tcp.KEY_TALK, target: 25, state: false });
  assert.throws(() => tcp.unpackKey(Buffer.alloc(2)), RangeError);
  const ack = tcp.unpack(tcp.packHelloAck(5, 1, { port: 5, alpha: "PNL05", matrix: "LOND", series: 1, socket: 6, ports: [] }));
  assert.ok(ack);
  assert.deepEqual(tcp.loads(ack.payload), { port: 5, alpha: "PNL05", matrix: "LOND", series: 1, socket: 6, ports: [] });
});
