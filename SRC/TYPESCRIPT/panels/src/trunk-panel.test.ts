import { test } from "node:test";
import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { AudioEngine, ToneAudioDevice } from "./audio.ts";
import { MatrixLink, type LinkEvent } from "./matrix-link.ts";
import { PanelModel, keyFace, parseChoice } from "./trunk-panel-core.ts";
import { main, splitMatrix } from "./trunk-panel.ts";
import * as tc from "./tc-protocol.ts";

const PORTS = [
  { n: 1, alpha: "PNL01", type: "PANEL", user: true }, { n: 2, alpha: "PNL02", type: "PANEL", user: true },
  { n: 3, alpha: "PNL03", type: "PANEL", user: true }, { n: 5, alpha: "PNL05", type: "PANEL", user: true },
  { n: 25, alpha: "CAM01", type: "CAM", user: true }, { n: 26, alpha: "CAM02", type: "CAM", user: true },
  { n: 27, alpha: "CAM03", type: "CAM", user: true }, { n: 28, alpha: "CAM04", type: "CAM", user: true },
  { n: 63, alpha: "IFB01", type: "IFB", user: false }, { n: 64, alpha: "IFB02", type: "IFB", user: false },
  { n: 43, alpha: "AUD01", type: "AUDIO", user: true }, { n: 70, alpha: "WLS01", type: "WLESS", user: true },
];

interface Fake {
  series: Socket;
  own: Socket;
  seriesPort: number;
  ownPort: number;
  got: tc.TcMessage[];
  close(): void;
}

/** A matrix: series socket assigns port 5 and points at its own socket, which answers with ports + STATE + AUDIO. */
async function fakeMatrix(): Promise<Fake> {
  const bind = (s: Socket): Promise<number> => new Promise((r) => s.bind(0, "127.0.0.1", () => r(s.address().port)));
  const series = createSocket("udp4");
  const own = createSocket("udp4");
  const seriesPort = await bind(series);
  const ownPort = await bind(own);
  const got: tc.TcMessage[] = [];
  series.on("message", (d, r) => {
    const m = tc.unpack(d);
    if (m?.type === tc.TYPE_HELLO) series.send(tc.packHelloAck(5, 1, { port: 5, alpha: "PNL05", matrix: "London", series: seriesPort, socket: ownPort }), r.port, r.address);
  });
  own.on("message", (d, r) => {
    const m = tc.unpack(d);
    if (!m) return;
    got.push(m);
    if (m.type === tc.TYPE_HELLO) {
      own.send(tc.packHelloAck(5, 2, { port: 5, alpha: "PNL05", matrix: "London", socket: ownPort, ports: PORTS }), r.port, r.address);
      own.send(tc.packState(5, 3, { talking_to: [], listening: [], incoming: [{ port: 25, alpha: "CAM01", since: Date.now() / 1000 - 4 }], users: 40, users_calling: 3, time: "12:00" }), r.port, r.address);
      own.send(tc.packAudio(5, 4, Buffer.alloc(tc.FRAME_BYTES)), r.port, r.address);
    }
  });
  return { series, own, seriesPort, ownPort, got, close: () => { series.close(); own.close(); } };
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("link: HELLO on series, move to own socket, join, defaults, STATE, keys, mic gate, BYE", async () => {
  const f = await fakeMatrix();
  const events: LinkEvent[] = [];
  let panel: PanelModel | undefined;
  const link = new MatrixLink("127.0.0.1", f.seriesPort, 0, "test PC", (e) => { events.push(e); panel?.onLinkEvent(e); });
  const engine = new AudioEngine(link, 48000);
  panel = new PanelModel(link, engine, "test PC", `127.0.0.1:${f.seriesPort}`);
  try {
    await link.start();
    await until(() => link.connected && panel.state.users === 40);
    assert.equal(link.port, f.ownPort, "moved to the socket the matrix assigned");
    assert.equal(events[0]?.kind, "status");
    assert.match(panel.hdr, /I am port 5 PNL05 on London/);
    // py default_assignments: TX = 3 CAM + 2 PANEL + 2 IFB + 1 AUDIO ; RX = 3 PANEL + 2 IFB + 2 CAM + 1 WLESS
    assert.deepEqual(panel.keys.slice(0, 8).map((k) => k.target), [25, 26, 27, 1, 2, 63, 64, 43]);
    assert.deepEqual(panel.keys.slice(8).map((k) => k.target), [1, 2, 3, 63, 64, 25, 26, 70]);
    assert.ok(panel.keys[0]?.incoming, "TALK 1 (CAM01) is calling me");
    assert.match(panel.incomingText, /CALLING YOU: CAM01 \([45]s\)/);
    assert.equal(panel.counter, "USERS 40\nCALLING 3");
    const face = keyFace(panel.keys[0]!, 0);
    assert.equal(face.bg, "#f0b429");
    assert.ok(face.text.endsWith("◄ CALLING"));
    assert.ok(!face.choices.some((c) => c.includes("WLESS")), "talk keys cannot target wireless");
    assert.ok(!face.choices.some((c) => c.startsWith("5 ")), "never my own port");
    assert.ok(keyFace(panel.keys[15]!, 15).choices.some((c) => c.includes("WLESS")));
    await until(() => link.rxCount >= 1);

    panel.keys[0]!.toggle();
    assert.equal(engine.micOpen, true);
    await until(() => f.got.some((m) => m.type === tc.TYPE_KEY));
    const k = f.got.find((m) => m.type === tc.TYPE_KEY)!;
    assert.deepEqual(tc.unpackKey(k.payload), { kind: tc.KEY_TALK, target: 25, state: true });
    assert.equal(k.port, 5);

    // F1: retargeting an active TALK key must close the mic gate (py leaves it open)
    panel.keys[0]!.setTarget(parseChoice("27 CAM03 CAM"));
    assert.equal(panel.keys[0]!.active, false);
    assert.equal(engine.micOpen, false);
    assert.equal(parseChoice("--"), null);

    panel.keys[8]!.toggle();
    panel.keys[0]!.toggle();
    await panel.close();
    await until(() => f.got.some((m) => m.type === tc.TYPE_BYE));
    const keys = f.got.filter((m) => m.type === tc.TYPE_KEY).map((m) => tc.unpackKey(m.payload));
    assert.deepEqual(keys.slice(-2).map((x) => x.state), [false, false], "close releases every active key before BYE");
  } finally {
    f.close();
  }
});

test("tone device streams 20 ms frames only while a talk key is latched", async () => {
  const f = await fakeMatrix();
  const link = new MatrixLink("127.0.0.1", f.seriesPort, 0, "tone", () => undefined);
  const engine = new AudioEngine(link, 16000);
  const dev = new ToneAudioDevice();
  try {
    await link.start();
    await until(() => link.connected);
    assert.ok(dev.start(engine));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(link.txFrames, 0);
    engine.micOpen = true;
    await until(() => f.got.filter((m) => m.type === tc.TYPE_AUDIO).length >= 3);
    const a = f.got.find((m) => m.type === tc.TYPE_AUDIO)!;
    assert.equal(a.payload.length, tc.FRAME_BYTES);
    assert.ok(engine.micLevel > 0.17 && engine.micLevel < 0.18, `tone rms ${engine.micLevel}`);
  } finally {
    dev.stop();
    link.stop();
    f.close();
  }
});

test("splitMatrix keeps the .py defaults", () => {
  assert.deepEqual(splitMatrix("10.0.0.2:22309"), ["10.0.0.2", 22309]);
  assert.deepEqual(splitMatrix(":22304"), ["127.0.0.1", 22304]);
  assert.deepEqual(splitMatrix("myhost"), ["127.0.0.1", 18100], "py rpartition puts a bare host in the port slot");
});

test("trunk-panel CLI: --test-seconds --auto-talk --audio tone", async () => {
  const f = await fakeMatrix();
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await main(["--matrix", `127.0.0.1:${f.seriesPort}`, "--name", "cli", "--test-seconds", "1", "--auto-talk", "27", "--audio", "tone"]);
  } finally {
    console.log = orig;
    f.close();
  }
  assert.match(lines[0] ?? "", /^test: connected=True port=5 alpha=PNL05 tx_frames=[1-9]\d* rx_frames=1 audio=ok 48000 Hz$/);
  assert.match(lines[1] ?? "", /^test: state=\{"talking_to":\[\]/);
});
