import { test } from "node:test";
import assert from "node:assert/strict";
import { ackTopic, lineTopic, parseReject, parseTopic, rejectTopic } from "./mqtt.ts";

test("mqtt topics round-trip", () => {
  assert.equal(lineTopic("dante", "dante-01"), "trunk-caster/dante/dante-01/line");
  assert.deepEqual(parseTopic(ackTopic("sip", "sip-03")), { protocol: "sip", frame: "sip-03", kind: "ack" });
  assert.equal(parseTopic(rejectTopic("a", "b"))?.kind, "reject");
  assert.equal(parseTopic("other/a/b/line"), undefined);
  assert.equal(parseTopic("trunk-caster/a/b/line/extra"), undefined);
  assert.equal(parseTopic("trunk-caster/a/b"), undefined);
});

test("reject payload splits at the first bar", () => {
  assert.deepEqual(parseReject("only one transport|HQ,f,U0,A|B,CLOSE,x,C0,f,HQ"), { reason: "only one transport", line: "HQ,f,U0,A|B,CLOSE,x,C0,f,HQ" });
  assert.equal(parseReject("no bar"), undefined);
});
