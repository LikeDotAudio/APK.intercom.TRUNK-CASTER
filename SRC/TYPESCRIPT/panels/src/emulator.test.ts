import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EmulatorCore } from "./emulator-core.ts";
import { MatrixApi, type PortState } from "./matrix-api.ts";
import { loadPanel, main } from "./streamdeck-emulator.ts";

const PANELS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "PANELS");

/** A fake of rts_intercom_sim.py's button API, enough for one matrix. */
function fakeMatrix(): Promise<{ server: Server; base: string; log: string[]; st: Required<Pick<PortState, "talking_to" | "listening" | "incoming" | "remote">> }> {
  const log: string[] = [];
  const st = { talking_to: [] as number[], listening: [] as number[], incoming: [] as PortState["incoming"] & object, remote: [] as string[] };
  const ports = [
    { n: 1, alpha: "PNL01", type: "PANEL", user: true },
    { n: 3, alpha: "PNL03", type: "PANEL", user: true },
    { n: 25, alpha: "CAM01", type: "CAM", user: true },
    { n: 63, alpha: "IFB01", type: "IFB", user: false },
    { n: 59, alpha: "FLD01", type: "PANEL", user: true },
  ];
  const byAlpha = (t: string): number => (/^\d+$/.test(t) ? Number(t) : ports.find((p) => p.alpha === t)?.n ?? -1);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const q = Object.fromEntries(u.searchParams);
    const action = u.pathname.replace("/api/", "");
    log.push(`${action} ${u.searchParams.toString()}`);
    const portState = { port: 59, alpha: "FLD01", matrix: "London", ...st, users: 40, users_calling: st.talking_to.length ? 1 : 0, time: "t" };
    let result: unknown;
    const on = q["state"] === "1";
    const edit = (arr: number[], n: number): void => {
      const i = arr.indexOf(n);
      if (on && i < 0) arr.push(n);
      if (!on && i >= 0) arr.splice(i, 1);
    };
    if (action === "ports") result = ports;
    else if (action === "claim") result = { port: Number(q["port"]) || 59, alpha: "FLD01", matrix: "London" };
    else if (action === "port") result = portState;
    else if (action === "key") {
      edit(q["kind"] === "talk" ? st.talking_to : st.listening, byAlpha(q["target"] ?? ""));
      result = portState;
    } else if (action === "call") {
      st.remote.push(`${q["icom"]}:${q["remote"]}`);
      result = { ok: "calling" };
    } else if (action === "hangup") {
      st.remote.length = 0;
      result = { hung: true };
    } else if (action === "release") result = { port: 59, released: true };
    else {
      res.end(JSON.stringify({ ok: false, error: `unknown action '${action}'` }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    r({ server, base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`, log, st });
  }));
}

test("emulator: claim, talk momentary, listen latch, call latch, reply, page, close", async () => {
  const m = await fakeMatrix();
  try {
    const panel = loadPanel(join(PANELS, "streamdeck-mini.json"));
    const emu = new EmulatorCore(panel, { api: new MatrixApi(m.base), sleep: () => new Promise((r) => setTimeout(r, 20)) });
    const running = emu.run();
    while (!emu.alpha) await new Promise((r) => setTimeout(r, 10));
    assert.equal(emu.port, 59);
    assert.match(emu.hdr, /I am port 59 FLD01 on LOND/);

    await emu.pressAt(0, 0, true); // DIR talk PNL01
    assert.deepEqual(emu.state.talking_to, [1]);
    assert.equal(emu.faces()[0]?.bg, "#d9342b");
    await emu.pressAt(0, 0, false);
    assert.deepEqual(emu.state.talking_to, []);

    await emu.pressAt(1, 1, true); // MON IFB1 latch
    assert.equal(emu.pressAt(1, 1, false), undefined, "latch ignores release");
    assert.deepEqual(emu.state.listening, [63]);
    assert.equal(emu.faces()[4]?.bg, "#2e9e4f");
    await emu.pressAt(1, 1, true);
    assert.deepEqual(emu.state.listening, []);

    await emu.pressAt(1, 2, true); // HOME PARIS call latch
    assert.ok(m.log.includes("call matrix=LOND&port=59&icom=PARI&remote=3"));
    assert.equal(emu.faces()[5]?.bg, "#d9342b");
    await emu.pressAt(1, 2, true);
    assert.ok(m.log.at(-2)?.startsWith("hangup"));

    m.st.incoming.push({ port: 3, alpha: "PNL03", since: 0 });
    await emu.pressAt(0, 1, false); // a momentary release refreshes state
    assert.equal(emu.foot, "CALLING YOU: PNL03");
    assert.equal(emu.faces()[1]?.bg, "#f0b429", "PROD key lights amber when PNL03 calls");
    assert.equal(emu.faces()[2]?.bg, "#f0b429", "REPLY lights amber");
    await emu.pressAt(0, 2, true);
    assert.ok(m.log.some((l) => l === "key matrix=LOND&port=59&kind=talk&target=3&state=1"));
    assert.equal(emu.faces()[2]?.bg, "#d9342b", "REPLY held lights red");

    await emu.close();
    await running;
    assert.ok(m.log.at(-1)?.startsWith("release"));
    assert.ok(m.log.includes("key matrix=LOND&port=59&kind=talk&target=3&state=0"), "close lets go of keyed talks");
  } finally {
    m.server.close();
  }
});

test("emulator: listen key with no colors.active lights RED, not green (faithful py bug F3)", async () => {
  const m = await fakeMatrix();
  try {
    const panel = loadPanel(join(PANELS, "streamdeck-mini.json"));
    const b = panel.buttons[4];
    assert.ok(b);
    delete b.colors;
    const emu = new EmulatorCore(panel, { api: new MatrixApi(m.base) });
    emu.state = { listening: [63] };
    // alpha map is filled by run(); use a numeric target instead
    b.target = "63";
    assert.equal(emu.face(b).bg, "#d9342b");
  } finally {
    m.server.close();
  }
});

test("emulator: page switching on the XL", () => {
  const emu = new EmulatorCore(loadPanel(join(PANELS, "streamdeck-xl.json")), { api: new MatrixApi("http://127.0.0.1:1") });
  assert.equal(emu.faces().length, 32);
  emu.pressAt(3, 7, true);
  assert.equal(emu.page, "cams2");
  assert.equal(emu.faces()[0]?.label, "CAM 7");
  assert.equal(emu.faces()[5]?.action, "none", "unset keys are blank spacers");
  emu.pressAt(3, 7, true);
  assert.equal(emu.page, "main");
});

test("emulator CLI: --test-seconds --auto-press prints the .py test lines", async () => {
  const m = await fakeMatrix();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await main([join(PANELS, "streamdeck-mini.json"), "--api", m.base, "--test-seconds", "1", "--auto-press", "0,0"]);
  } finally {
    console.log = orig;
    m.server.close();
  }
  assert.match(lines[0] ?? "", /^test: port=59 alpha=FLD01 matrix=LOND state=.*"talking_to":\[1\]/);
  assert.match(lines[1] ?? "", /^test: header=Field mini {2}· {2}I am port 59/);
});
