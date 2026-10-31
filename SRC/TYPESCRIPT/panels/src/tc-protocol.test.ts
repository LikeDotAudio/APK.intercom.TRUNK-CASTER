import { test } from "node:test";
import assert from "node:assert/strict";
import * as tc from "./tc-protocol.ts";

// Vectors produced by TRUNK-SIMULATOR/tc_protocol.py (python -I, 2026-10-21).
test("pack_* is byte-identical to tc_protocol.py", () => {
  assert.equal(tc.packHello(5, 7, "PC é").toString("hex"), "54430101000500070000504320c3a9");
  assert.equal(tc.packKey(22, 65535, tc.KEY_LISTEN, 300, true).toString("hex"), "544301040016ffff000001012c01");
  assert.equal(tc.packHelloAck(0, 1, { port: 5, alpha: "PNL05" }).toString("hex"),
    "544301020000000100007b22706f7274223a352c22616c706861223a22504e4c3035227d");
  assert.equal(tc.packBye(65536 + 3, 2).toString("hex"), "54430106000300020000");
});

test("unpack round-trips and rejects foreign datagrams", () => {
  const m = tc.unpack(tc.packKey(9, 42, tc.KEY_TALK, 17, false));
  assert.ok(m);
  assert.deepEqual([m.type, m.port, m.seq, m.flags], [tc.TYPE_KEY, 9, 42, 0]);
  assert.deepEqual(tc.unpackKey(m.payload), { kind: 0, target: 17, state: false });
  assert.equal(tc.unpack(Buffer.from("TC")), undefined);
  assert.equal(tc.unpack(Buffer.from("XX0100000000000000", "hex")), undefined);
  const v2 = tc.packBye(1, 1);
  v2[2] = 2;
  assert.equal(tc.unpack(v2), undefined);
  assert.throws(() => tc.unpackKey(Buffer.alloc(3)));
});

test("frame constants", () => {
  assert.equal(tc.FRAME_SAMPLES, 160);
  assert.equal(tc.FRAME_BYTES, 320);
});
