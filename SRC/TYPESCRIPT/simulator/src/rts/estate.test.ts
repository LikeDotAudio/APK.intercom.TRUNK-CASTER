import assert from "node:assert/strict";
import * as dgram from "node:dgram";
import * as net from "node:net";
import { after, before, test } from "node:test";
import { world } from "../fixtures.ts";
import * as tcp from "../tc-protocol.ts";
import { fmtValue, oidStr, PDU_GET, PDU_GETBULK, PDU_GETNEXT, PDU_SET, TAG_ENDOFMIB, TAG_NOSUCHOBJ, TAG_NULL, TAG_OCTSTR } from "./ber.ts";
import { MatrixDevice, TrunkMasterDevice } from "./devices.ts";
import { Estate, snmpRequest } from "./estate.ts";
import { defaultMibFolder } from "./main.ts";
import { Mib } from "./mib.ts";
import { spawnConfig, worldConfig } from "./world.ts";

const mib = new Mib().loadFolder(defaultMibFolder());
const quiet = (): void => undefined;

test("world estate (56 capitals + 131 state frames + TM) matches Python, built without binding anything", () => {
  const fx = world();
  const w = new Estate(mib, worldConfig(), false, quiet);
  const st = w.state();
  assert.deepEqual(st.totals, fx.totals);
  assert.equal(w.devices.length, fx.ndevices);
  const tm = w.devices.find((d): d is TrunkMasterDevice => d instanceof TrunkMasterDevice);
  assert.ok(tm);
  assert.equal(tm.trunks.size, fx.trunks);
  assert.equal(tm.store.size, fx.tm_objects);
  const strip = (t: object): Record<string, unknown> => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "since"));
  assert.deepEqual(strip(tm.trunks.get(1) as object), fx.tm_trunk_1);
  assert.deepEqual(strip(tm.trunks.get(Math.max(...tm.trunks.keys())) as object), fx.tm_trunk_last);
  for (const d of w.devices.slice(0, 5)) assert.equal(d.store.size, fx.device_objects[d.name], d.name);
  st.devices.slice(0, 4).forEach((d, i) => {
    const rest: Record<string, unknown> = { ...d };
    delete rest.local_hour;
    assert.deepEqual(JSON.parse(JSON.stringify(rest)), fx.map_states[i]);
  });
  assert.equal(tm.summary().split("objects=")[1], fx.summary_tm_tail);
  const lond = w.matrix("LOND");
  assert.deepEqual(lond.sortedEntries().map((e) => oidStr(e.oid)), fx.matrix_lond_sorted_oids);
  assert.equal(lond.consoleCommand(["panel", "1"]), fx.lond_panel_1);
  assert.equal(lond.consoleCommand(["plan"]), fx.lond_plan);
  assert.equal(tm.consoleCommand(["trunks"]).split("\n").slice(0, 5).join("\n"), fx.tm_trunks_head);
  assert.equal(tm.consoleCommand(["icoms"]).split("\n").slice(0, 5).join("\n"), fx.tm_icoms_head);
});

// ---- a small live estate on high ports (nothing the running services use) --------------------
const SNMP = 47100, CON = 47200, SERIES = 47500;
let est: Estate;
let running: Promise<void>;
const lines: string[] = [];

before(async () => {
  const cfg = spawnConfig("tm2000=1,adam=2,rvon16=1", SNMP, "public", [], 0.0, [40.7, -74.0], 0);
  cfg.devices.forEach((d, i) => {
    d.console_port = CON + i;
    if (d.type === "matrix") d.series = SERIES + 256 * (i - 1);
  });
  est = new Estate(mib, cfg, true, (l) => lines.push(l));
  running = est.run();
  await new Promise((r) => setTimeout(r, 400));
});
after(async () => {
  await est.stop();
  await running;
});

test("SNMP agent: GET, GETNEXT, GETBULK, SET, bad community", async () => {
  const sysName = [1, 3, 6, 1, 2, 1, 1, 5, 0];
  const g = await snmpRequest("127.0.0.1", SNMP + 1, "public", PDU_GET, [[sysName, TAG_NULL, null], [[1, 3, 6, 1, 9, 9], TAG_NULL, null]]);
  assert.equal(fmtValue(TAG_OCTSTR, g.varbinds[0]?.[2] ?? null), '"ADM1"');
  assert.equal(g.varbinds[1]?.[1], TAG_NOSUCHOBJ);
  const v1 = await snmpRequest("127.0.0.1", SNMP + 1, "public", PDU_GET, [[[1, 3, 6, 1, 9, 9], TAG_NULL, null]], 0);
  assert.equal(v1.f1, 2); // noSuchName
  const n = await snmpRequest("127.0.0.1", SNMP + 1, "public", PDU_GETNEXT, [[[1, 3, 6, 1, 2, 1, 1], TAG_NULL, null]]);
  assert.equal(oidStr(n.varbinds[0]?.[0] ?? []), "1.3.6.1.2.1.1.1.0");
  const b = await snmpRequest("127.0.0.1", SNMP, "public", PDU_GETBULK, [[[1, 3, 6, 1, 2, 1, 1], TAG_NULL, null]], 1, 2, 0, 5);
  assert.equal(b.varbinds.length, 5);
  const end = await snmpRequest("127.0.0.1", SNMP + 1, "public", PDU_GETNEXT, [[[2], TAG_NULL, null]]);
  assert.equal(end.varbinds[0]?.[1], TAG_ENDOFMIB);
  const s = await snmpRequest("127.0.0.1", SNMP + 1, "public", PDU_SET, [[sysName, TAG_OCTSTR, Buffer.from("RENAMED")]]);
  assert.equal(s.f1, 0);
  const ro = await snmpRequest("127.0.0.1", SNMP + 1, "public", PDU_SET, [[[1, 3, 6, 1, 2, 1, 1, 1, 0], TAG_OCTSTR, Buffer.from("x")]]);
  assert.equal(ro.f1, 17); // notWritable
  await assert.rejects(snmpRequest("127.0.0.1", SNMP + 1, "private", PDU_GET, [[sysName, TAG_NULL, null]], 1, 0.3), /timed out/);
});

function consoleSay(port: number, cmds: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, "127.0.0.1");
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("utf-8");
    });
    c.on("connect", () => c.write(cmds.map((x) => x + "\n").join("") + "quit\n"));
    c.on("close", () => resolve(buf));
    c.on("error", reject);
  });
}

test("console: talk, calls, walk (Python crashed on str values here), unknown, error text", async () => {
  const out = await consoleSay(CON + 1, ["talk 1 25", "calls", "", "walk 1.3.6.1.2.1.1", "frobnicate", "panel 999"]);
  assert.match(out, /pretend RTS console/);
  assert.match(out, /talk 1 -> 25/);
  assert.match(out, /PNL01 {4}-> CAM01/);
  assert.match(out, /sysDescr\.0 +STRING +"Pretend RTS ADAM matrix frame/);
  assert.match(out, /unknown command 'frobnicate'/);
  assert.match(out, /error: 999/);
  assert.match(out, /ADM1> bye\r\n$/);
});

test("audio series: HELLO on +0 hands out a port, HELLO on the port socket gets the plan, KEY changes STATE, mixer sends AUDIO", async () => {
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  const inbox: tcp.Message[] = [];
  sock.on("message", (d) => {
    const m = tcp.unpack(d);
    if (m) inbox.push(m);
  });
  const wait = async (pred: (m: tcp.Message) => boolean, ms = 2000): Promise<tcp.Message> => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0] as tcp.Message;
      if (Date.now() - t0 > ms) throw new Error("timeout waiting for message");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  sock.send(tcp.packHello(0, 1, "test-pc"), SERIES, "127.0.0.1");
  const ack = await wait((m) => m.type === tcp.TYPE_HELLO_ACK);
  const info = tcp.loads(ack.payload) as tcp.HelloAck;
  assert.equal(info.port, 1);
  assert.equal(info.socket, SERIES + 1);
  assert.equal(info.ports.length, 0);
  sock.send(tcp.packHello(1, 2, "test-pc"), info.socket, "127.0.0.1");
  const ack2 = await wait((m) => m.type === tcp.TYPE_HELLO_ACK);
  assert.equal((tcp.loads(ack2.payload) as tcp.HelloAck).ports.length, 106);
  await wait((m) => m.type === tcp.TYPE_STATE);
  const adm1 = est.matrix("ADM1");
  adm1.talk(2, 1, true); // a pretend panel calls us: its tone is in our mix
  sock.send(tcp.packKey(1, 3, tcp.KEY_TALK, 25, true), info.socket, "127.0.0.1");
  const st = await wait((m) => m.type === tcp.TYPE_STATE && (tcp.loads(m.payload) as tcp.PortState).talking_to.includes(25));
  const ps = tcp.loads(st.payload) as tcp.PortState;
  assert.deepEqual(ps.incoming.map((x) => x.port), [2]);
  const audio = await wait((m) => m.type === tcp.TYPE_AUDIO && m.payload.readInt16LE(20) !== 0, 3000);
  assert.equal(audio.payload.length, tcp.FRAME_BYTES);
  assert.match(adm1.consoleCommand(["endpoints"]), /port 1 PNL01 {2}test-pc/);
  sock.send(tcp.packBye(1, 4), info.socket, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(adm1.audio?.endpoints.size, 0);
  sock.close();
});

test("button API: claim, key, port, trunk call through the Trunk Master, hangup, release, scenario, errors", () => {
  const claim = est.action("claim", { matrix: "ADM2", port: "0", name: "deck" }) as { port: number };
  assert.equal(claim.port, 1);
  const st = est.action("key", { matrix: "ADM2", port: "PNL01", target: "CAM01", kind: "talk" }) as tcp.PortState;
  assert.deepEqual(st.talking_to, [25]);
  const text = est.action("call", { matrix: "ADM2", port: "3", icom: "ADM1", remote: "5" }) as string;
  assert.match(text, /^trunk \d+ allocated: ADM2 port 3 -> ADM1 port 5/);
  const s = est.state();
  assert.ok(s.links.some((l) => l.from_device === "ADM2" && l.to_device === "ADM1" && l.to_port === "P5"));
  assert.match(est.action("hangup", { matrix: "ADM2", port: "3" }) as string, /-> allocd/);
  assert.deepEqual(est.action("release", { matrix: "ADM2", port: "1" }), { port: 1, released: true });
  const sc = est.action("scenario", { name: "olympics", level: "0.4", host: "ADM1" }) as { host: string; level: number };
  assert.equal(sc.host, "ADM1");
  assert.equal(sc.level, 0.4);
  assert.throws(() => est.action("port", { matrix: "ADM1" }), (e: Error & { pyStr?: string }) => e.pyStr === "'port'");
  assert.throws(() => est.action("ports", { matrix: "ZZZ" }), /no matrix 'ZZZ'/);
  assert.throws(() => est.action("key", { matrix: "ADM1", port: "IFB01", target: "1" }), /cannot talk/);
  assert.equal((est.action("matrices", {}) as unknown[]).length, 2);
  const tm = est.devices.find((d) => d instanceof TrunkMasterDevice) as TrunkMasterDevice;
  assert.equal(tm.trunks.size, 4); // trunks_per_pair 4 x one pair
  assert.ok(est.devices.find((d) => d instanceof MatrixDevice));
});
