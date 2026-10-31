import assert from "node:assert/strict";
import { test } from "node:test";
import { parity } from "../fixtures.ts";
import {
  buildMessage, decOid, encOid, encValue, fmtValue, oidCmp, parseMessage, PDU_GETBULK, TAG_IPADDR, TAG_NULL, TAG_OCTSTR, TAG_TIMETICKS,
} from "./ber.ts";

const fx = parity();

test("BER encodings are byte-identical to Python", () => {
  for (const s of fx.ber) {
    let got: Buffer;
    if (s.oid) got = encOid(s.oid);
    else if (s.s !== undefined) got = encValue(s.tag, s.s);
    else got = encValue(s.tag, BigInt(s.v as string));
    assert.equal(got.toString("hex"), s.hex, `tag 0x${s.tag.toString(16)} ${s.v ?? s.s ?? s.oid?.join(".")}`);
  }
});

test("build_message / parse_message round trip", () => {
  const msg = buildMessage(1, "public", PDU_GETBULK, 4242, 0, 10, [
    [[1, 3, 6, 1, 2, 1, 1], TAG_NULL, null],
    [[1, 3, 6, 1, 2, 1, 1, 5, 0], TAG_OCTSTR, Buffer.from("LOND")],
    [[1, 3, 6, 1, 2, 1, 1, 3, 0], TAG_TIMETICKS, 999],
  ]);
  assert.equal(msg.toString("hex"), fx.message_hex);
  const m = parseMessage(msg);
  assert.equal(m.version, 1);
  assert.equal(m.community, "public");
  assert.equal(m.pdu, PDU_GETBULK);
  assert.equal(m.reqId, 4242);
  assert.equal(m.f2, 10);
  assert.deepEqual(m.varbinds[1]?.[0], [1, 3, 6, 1, 2, 1, 1, 5, 0]);
  assert.equal(fmtValue(TAG_OCTSTR, m.varbinds[1]?.[2] ?? null), '"LOND"');
  assert.equal(m.varbinds[2]?.[2], 999);
  assert.throws(() => parseMessage(Buffer.from([0x30, 0x03, 0x02, 0x01])));
});

test("OID helpers", () => {
  assert.deepEqual(decOid(encOid([1, 3, 6, 1, 4, 1, 24287, 2 ** 31 + 5]).subarray(2)), [1, 3, 6, 1, 4, 1, 24287, 2 ** 31 + 5]);
  assert.ok(oidCmp([1, 3, 6], [1, 3, 6, 1]) < 0);
  assert.ok(oidCmp([1, 4], [1, 3, 6, 1]) > 0);
  assert.equal(fmtValue(TAG_TIMETICKS, 12345), "12345 (123.45 s)");
  assert.equal(fmtValue(TAG_OCTSTR, Buffer.from([0, 1, 255])), "hex:0001ff");
  assert.equal(encValue(TAG_IPADDR, "127.0.0.1").toString("hex"), "40047f000001");
});
