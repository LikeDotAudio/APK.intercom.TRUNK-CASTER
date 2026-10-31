import assert from "node:assert/strict";
import { test } from "node:test";
import { errStr, pyDictRepr, pyFloat, pyInt, pyJson, PyKeyError, PyRandom, pyRepr, PyValueError } from "./py.ts";

test("PyRandom(1234) reproduces CPython's stream", () => {
  // python -c "import random; r=random.Random(1234); print([r.randint(0,2) for _ in range(12)], r.random())"
  const r = new PyRandom(1234);
  assert.deepEqual(Array.from({ length: 12 }, () => r.randint(0, 2)), [1, 0, 0, 0, 2, 0, 2, 2, 0, 0, 1, 0]);
  assert.equal(r.random(), 0.017428048184618405);
  assert.equal(r.getrandbits(32), 4237793703);
});

test("KeyError / ValueError strings match str(exc)", () => {
  assert.equal(errStr(new PyKeyError("port")), "'port'");
  assert.equal(errStr(new PyKeyError("no matrix 'X' (have: A)")), `"no matrix 'X' (have: A)"`);
  assert.equal(errStr(new PyKeyError(5)), "5");
  assert.equal(errStr(new PyValueError("kind must be talk or listen")), "kind must be talk or listen");
  assert.equal(pyRepr("a\nb"), "'a\\nb'");
});

test("int() / float() conversions throw like Python", () => {
  assert.equal(pyInt(" 42 "), 42);
  assert.equal(pyInt(3.9), 3);
  assert.throws(() => pyInt("4x"), PyValueError);
  assert.throws(() => pyInt(""), PyValueError);
  assert.equal(pyFloat("0.15"), 0.15);
  assert.equal(pyFloat("1e3"), 1000);
  assert.throws(() => pyFloat("abc"), PyValueError);
});

test("json.dumps formatting", () => {
  assert.equal(pyJson({ a: 1, b: [1, "é"] }), '{"a": 1, "b": [1, "\\u00e9"]}');
  assert.equal(pyJson({ a: 1, b: [1, 2] }, { compact: true }), '{"a":1,"b":[1,2]}');
  assert.equal(pyJson({ a: [1] }, { indent: 1 }), '{\n "a": [\n  1\n ]\n}');
  assert.equal(pyJson({ x: undefined, y: null }), '{"y": null}');
  assert.equal(pyDictRepr(new Map([["idle", 3], ["inUse", 1]])), "{'idle': 3, 'inUse': 1}");
});
