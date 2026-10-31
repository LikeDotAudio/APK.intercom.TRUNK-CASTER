import assert from "node:assert/strict";
import { test } from "node:test";
import { parity } from "../fixtures.ts";
import {
  buildPorts, capitalPorts, CONTINENT, DEFAULT_PLAN, generatePanels, hslHex, ISO2, parsePlan, type Plan, SMALL_PLAN, spawnConfig, SUBSITES,
  subsiteAlpha4, subsitePorts, WORLD_CAPITALS, worldConfig,
} from "./world.ts";

const fx = parity();

function panels(plan: Plan): Record<string, { alpha: string; type: string; keys: Record<string, number>; freq: number }> {
  const ports = buildPorts(plan);
  generatePanels(ports);
  const out: Record<string, { alpha: string; type: string; keys: Record<string, number>; freq: number }> = {};
  for (const [n, p] of ports) out[String(n)] = { alpha: p.alpha, type: p.ptype, keys: Object.fromEntries([...p.keys].map(([k, t]) => [String(k), t])), freq: p.freq };
  return out;
}

test("generated keypanels are identical to Python's random.Random(1234)", () => {
  assert.deepEqual(panels(DEFAULT_PLAN), fx.panels_default);
  assert.deepEqual(panels(SMALL_PLAN), fx.panels_small);
});

test("tables: 56 capitals, continents, flags, subsites", () => {
  assert.equal(WORLD_CAPITALS.length, 56);
  assert.equal(Object.keys(CONTINENT).length, 56);
  assert.equal(Object.keys(ISO2).length, 56);
  assert.equal(SUBSITES.length, 131);
  assert.equal(subsiteAlpha4("US-AL"), "U-AL");
  assert.equal(subsiteAlpha4("AU-NSW"), "A-NS");
});

test("port plan: capital i owns snmp 16100+i, console 17100+i, series 20000+256i; subsite k 36000+k / 37000+k / 43000+16k", () => {
  assert.deepEqual(capitalPorts("WASH"), { snmp_port: 16101, console_port: 17101, series: 20256 });
  assert.deepEqual(capitalPorts("LOND"), { snmp_port: 16109, console_port: 17109, series: 22304 });
  assert.deepEqual(capitalPorts("WELL"), { snmp_port: 16156, console_port: 17156, series: 34336 });
  assert.deepEqual(subsitePorts(1), { snmp_port: 36001, console_port: 37001, series: 43016 });
  assert.throws(() => capitalPorts("NOPE"));
});

test("hsl_hex matches", () => {
  for (const [h, s, l, hex] of fx.hsl) assert.equal(hslHex(h, s, l), hex, `${h},${s},${l}`);
});

test("world_config and spawn_config are identical to Python", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(worldConfig({ capitals: ["WASH", "LOND", "CANB"], chaos: 0.15, mapPort: 8181, vendor: "Riedel" }))), fx.world_config);
  assert.deepEqual(JSON.parse(JSON.stringify(spawnConfig("tm2000=1,adam=1,cronus=1,rvon16=2", 16100, "public", ["127.0.0.1:16200"], 0.0, [40.7128, -74.006], 8080))), fx.spawn_config);
});

test("parse_plan", () => {
  assert.deepEqual(parsePlan("panel=4, cam=2,IFB"), [["PANEL", 4], ["CAM", 2], ["IFB", 1]]);
  assert.throws(() => buildPorts([["NOPE", 1]]), /unknown port type/);
});
