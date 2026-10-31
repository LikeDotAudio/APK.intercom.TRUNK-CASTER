import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Child, Launcher, parseLaunchArgs, type Registry, ROOT, TRUNK_SIM_DIR } from "./launch-all.ts";
import { PyKeyError, PyValueError } from "./py.ts";
import { MapServer } from "./tc-map.ts";

const realRegistry = JSON.parse(readFileSync(path.join(TRUNK_SIM_DIR, "emulators.json"), "utf-8")) as Registry;
const logs: string[] = [];
const log = (m: string): void => {
  logs.push(m);
};

test("plan from the real emulators.json: RTS runs itself, the other four vendors are stood in for by RTS", () => {
  const l = new Launcher(realRegistry, null, null, "node", log);
  assert.equal(l.children.length, 5);
  assert.deepEqual(l.children.map((c) => c.label), ["RTS", "Riedel (stand-in: RTS)", "Clear-Com (stand-in: RTS)", "Intracom (stand-in: RTS)", "Telos-Infinity (stand-in: RTS)"]);
  assert.equal(l.children.reduce((n, c) => n + c.capitals.length, 0), 56);
  const riedel = l.children[1] as Child;
  assert.deepEqual(riedel.args.slice(0, 2), ["--world", "--capitals"]);
  assert.ok(riedel.args.includes("--vendor") && riedel.args.includes("Riedel"));
  assert.equal(riedel.args[riedel.args.indexOf("--chaos") + 1], "0.15");
  const [cmd, argv] = riedel.command(true);
  assert.equal(cmd, process.execPath);
  assert.ok((argv[2] ?? "").endsWith(path.join("rts", "main.ts")));
  assert.equal(argv[argv.length - 1], "--quiet");
  const [pcmd, pargv] = new Launcher(realRegistry, "rts", 0.5, "python", log).children[0]?.command(false) ?? ["", []];
  assert.match(pcmd, /python/);
  assert.deepEqual(pargv.slice(0, 1), ["-u"]);
  assert.ok(pargv.includes("0.5"));
});

test("--only filters, dead emulators show as offline placeholders", () => {
  const l = new Launcher(realRegistry, "Intracom", null, "node", log);
  assert.equal(l.children.length, 1);
  const st = l.state();
  assert.equal(st.totals.emulators, 1);
  assert.equal(st.totals.emulators_up, 0);
  assert.deepEqual(st.devices.map((d) => d.name), ["DELH", "ISLA", "DHAK"]);
  assert.equal(st.devices[0]?.online, false);
  assert.equal(st.devices[0]?.vendor, "Intracom");
  assert.equal(st.devices[0]?.note, "emulator not answering: starting");
});

test("merges a live emulator's /state and forwards /api calls to the owner", async () => {
  const seen: string[] = [];
  const fake = new MapServer(
    () => ({ devices: [{ name: "US-AL", alpha: "U-AL", lat: 1, lon: 2, vendor: "RTS" }], links: [], totals: { users: 4, users_calling: 1, ports: 8, calls: 1, devices: 1 }, scenario: { name: "normal" } }),
    "127.0.0.1", 0, null,
    (name, p) => {
      seen.push(name + ":" + (p.matrix ?? ""));
      if (name === "port" && !p.port) throw new PyKeyError("port");
      if (name === "matrices") return [{ name: "WASH" }];
      return { name, p };
    });
  await fake.start();
  try {
    const reg: Registry = { stand_in: "RTS", vendors: [{ ...(realRegistry.vendors[0] as Registry["vendors"][number]), capitals: ["WASH"], map_port: fake.port }] };
    const l = new Launcher(reg, null, null, "node", log);
    const c = l.children[0] as Child;
    await c.refresh();
    const st = l.state();
    assert.equal(st.totals.emulators_up, 1);
    assert.equal(st.totals.users, 4);
    assert.equal(st.devices[0]?.emulator_map_port, fake.port);
    assert.equal(st.scenario && (st.scenario as { name: string }).name, "normal");
    assert.deepEqual(await l.action("key", { matrix: "wash", port: "1" }), { name: "key", p: { matrix: "wash", port: "1" } });
    assert.deepEqual(await l.action("key", { matrix: "u-al" }), { name: "key", p: { matrix: "u-al" } }); // found by device alpha
    assert.deepEqual(await l.action("matrices", {}), [{ name: "WASH" }]);
    assert.deepEqual(await l.action("scenario", { name: "quiet" }), { RTS: { name: "scenario", p: { name: "quiet" } } });
    await assert.rejects(l.action("key", { matrix: "NOPE" }), (e: unknown) => e instanceof PyKeyError);
    // Python quirk kept: an emulator's 400 surfaces as urllib's HTTPError text, i.e. a 500 on the combined map
    await assert.rejects(l.action("port", { matrix: "WASH" }), /HTTP Error 400/);
    assert.ok(seen.includes("key:wash"));
  } finally {
    await fake.stop();
  }
});

test("spawns a child process, pumps its output, polls it, stops it", async () => {
  const fixture = path.relative(ROOT, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake_emulator.py")).split(path.sep).join("/");
  const reg: Registry = { stand_in: "RTS", vendors: [{ vendor: "Fake", emulator: fixture, base_port: 1, map_port: 18997, capitals: ["LOND"] }] };
  const l = new Launcher(reg, null, 0, "node", log); // no TS port for this script: falls back to python
  const c = l.children[0] as Child;
  assert.match(c.command(false)[0], /python/);
  l.startAll(false);
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    await c.refresh();
    up = !!c.state;
  }
  assert.ok(up, "fake emulator answered /state");
  assert.equal(l.state().devices[0]?.name, "LOND");
  await l.stopAll();
  assert.ok(logs.some((m) => m.startsWith("started Fake")));
  assert.ok(logs.some((m) => m.includes("[Fake] fake emulator for Fake")));
  assert.ok(!logs.some((m) => m.includes("this DeprecationWarning line")));
});

test("argument parsing", () => {
  const a = parseLaunchArgs(["--only", "RTS,Riedel", "--chaos=0.3", "--map-port", "18999", "--list", "--runtime", "python"]);
  assert.equal(a.only, "RTS,Riedel");
  assert.equal(a.chaos, 0.3);
  assert.equal(a.mapPort, 18999);
  assert.equal(a.list, true);
  assert.equal(a.runtime, "python");
  assert.throws(() => parseLaunchArgs(["--runtime", "deno"]), PyValueError);
});
