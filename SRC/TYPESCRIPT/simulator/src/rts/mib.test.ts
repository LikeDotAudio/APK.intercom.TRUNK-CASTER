import assert from "node:assert/strict";
import { test } from "node:test";
import { parity } from "../fixtures.ts";
import { checkMibs, dumpOids } from "./estate.ts";
import { defaultMibFolder } from "./main.ts";
import { Mib, stripComments } from "./mib.ts";
import { TAG_OCTSTR } from "./ber.ts";

const fx = parity();
const mib = new Mib().loadFolder(defaultMibFolder());

test("--dump-oids output is identical to Python", () => {
  assert.equal(dumpOids(mib), fx.dump_oids);
});

test("--check-mibs output is identical to Python (modules found by content, Telex-Icom-MIB missing)", () => {
  assert.equal(checkMibs(mib), fx.check_mibs);
  assert.equal(mib.moduleMismatches().length, 7);
  assert.ok(!mib.modules.has("Telex-Icom-MIB"));
});

test("textual conventions and enums match", () => {
  const tcs: Record<string, { base: string; enum: Record<string, number> }> = {};
  for (const [k, v] of [...mib.tcs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) tcs[k] = { base: v.base, enum: v.enum };
  assert.deepEqual(tcs, fx.tcs);
  assert.equal(mib.enumValue("TrunkState", "idle") > 0, true);
});

test("tag_for / lookup", () => {
  assert.equal(mib.tagFor("sysDescr"), TAG_OCTSTR);
  assert.equal(mib.lookup([1, 3, 6, 1, 2, 1, 1, 5, 0]), "sysName.0");
  assert.equal(mib.lookup([...mib.oid("tkFromIcom"), 7]), "tkFromIcom.7");
  assert.throws(() => mib.oid("nope"), /not found/);
});

test("strip_comments keeps -- inside strings", () => {
  assert.equal(stripComments('a -- gone\n"x -- kept" -- gone'), 'a \n"x -- kept" ');
});
