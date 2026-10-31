import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PyKeyError, PyValueError } from "./py.ts";
import { API_HELP, type EstateState, HTML, MapServer, toGeojson } from "./tc-map.ts";

const state: EstateState = {
  time: "t", tz: "z", totals: { users: 2, users_calling: 1, ports: 10, calls: 1, devices: 3 }, scenario: null,
  devices: [
    { name: "LOND", lat: 51.5, lon: -0.1, city: "London" },
    { name: "PARI", lat: 48.8, lon: 2.3 },
    { name: "NOWHERE", lat: null, lon: null },
  ],
  links: [
    { from_device: "LOND", from_port: "PNL01", to_device: "PARI", to_port: "P5", since: 1 },
    { from_device: "LOND", from_port: "PNL02", to_device: "NOWHERE", to_port: "P1", since: 1 },
  ],
};

test("to_geojson: points for placed devices, lines only between placed devices", () => {
  const gj = toGeojson(state);
  assert.equal(gj.features.length, 3);
  assert.deepEqual(gj.features[0]?.geometry, { type: "Point", coordinates: [-0.1, 51.5] });
  assert.deepEqual(gj.features[0]?.properties, { name: "LOND", city: "London" });
  assert.deepEqual(gj.features[2]?.geometry, { type: "LineString", coordinates: [[-0.1, 51.5], [2.3, 48.8]] });
  assert.equal(gj.features[2]?.properties.kind, "call");
  assert.deepEqual(gj.properties.totals, state.totals);
});

test("map page is the verbatim tc_map.HTML", () => {
  assert.ok(HTML.startsWith("<!doctype html>"));
  assert.ok(HTML.includes("Trunk-Caster map"));
  assert.ok(HTML.trimEnd().endsWith("</html>"));
});

let srv: MapServer;
let base = "";
before(async () => {
  srv = new MapServer(() => state, "127.0.0.1", 0, null, (name, p) => {
    if (name === "boom") throw new Error("kaput");
    if (name === "bad") throw new PyValueError("bad value");
    if (name === "missing") throw new PyKeyError("port");
    return { echo: p };
  });
  await srv.start();
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  await srv.stop();
});

test("GET / /geojson /state", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(await r.text(), HTML);
  const g = await fetch(base + "/geojson?x=1");
  assert.equal(g.headers.get("content-type"), "application/geo+json");
  assert.equal(((await g.json()) as { features: unknown[] }).features.length, 3);
  const s = await fetch(base + "/state");
  assert.deepEqual(await s.json(), state);
  assert.equal((await fetch(base + "/nope")).status, 404);
});

test("/api: help, ok, 400 for ValueError/KeyError, 500 otherwise, CORS preflight", async () => {
  assert.deepEqual(await (await fetch(base + "/api/help")).json(), API_HELP);
  assert.deepEqual(await (await fetch(base + "/api")).json(), API_HELP);
  const ok = await fetch(base + "/api/key?matrix=LOND&port=1&blank=&port=2");
  assert.deepEqual(await ok.json(), { ok: true, result: { echo: { matrix: "LOND", port: "2" } } });
  const bad = await fetch(base + "/api/bad");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { ok: false, error: "bad value" });
  const missing = await fetch(base + "/api/missing");
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { ok: false, error: "'port'" });
  const boom = await fetch(base + "/api/boom");
  assert.equal(boom.status, 500);
  assert.deepEqual(await boom.json(), { ok: false, error: "kaput" });
  const pre = await fetch(base + "/api/key", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
});

test("POST bodies: JSON values become str(), forms parse like parse_qs", async () => {
  const j = await fetch(base + "/api/key?matrix=LOND", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: 3, state: true, name: null }) });
  assert.deepEqual(await j.json(), { ok: true, result: { echo: { matrix: "LOND", port: "3", state: "True", name: "None" } } });
  const f = await fetch(base + "/api/key", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "port=4&target=25" });
  assert.deepEqual(await f.json(), { ok: true, result: { echo: { port: "4", target: "25" } } });
  assert.equal((await fetch(base + "/state", { method: "POST" })).status, 404);
});

test("start() rejects when the port is taken", async () => {
  const other = new MapServer(() => state, "127.0.0.1", srv.port);
  await assert.rejects(other.start(), /EADDRINUSE/);
});
