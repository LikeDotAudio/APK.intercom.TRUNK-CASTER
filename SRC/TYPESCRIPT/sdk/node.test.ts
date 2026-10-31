import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ClientError, FileClient, HttpClient, WardBeckClient, findLayout } from "./node.ts";
import * as wb from "./wardbeck.ts";
import { makeReply, type Reply, type Request } from "./types.ts";

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}

test("HttpClient: request, rename returns dispatches, errors carry status", async () => {
  const seen: { method: string; url: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      if (req.url === "/api/request") {
        const r = JSON.parse(body) as Request;
        res.end(JSON.stringify(makeReply(r.id ?? "x", "granted", undefined, undefined, "now")));
      } else if (req.url === "/api/rename") {
        res.end(JSON.stringify([{ seq: 1, at: "now", frame: "dante-01", port: "U00", new_name: "Ann", vendor: "RTS", transport: "snmp", detail: "d", sent: false }]));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "nope" }));
      }
    });
  });
  const port = await listen(server);
  try {
    const c = new HttpClient(`127.0.0.1:${port}`);
    const reply = await c.request({ id: "r1", who: "Andrey", from: "relay-a", to: "sip-03" });
    assert.equal(reply.status, "granted");
    assert.equal(seen[0]?.method, "POST");
    const d = await c.rename({ frame: "dante-01", port: 0, name: "Ann" });
    assert.equal(d[0]?.transport, "snmp");
    await assert.rejects(c.status(), (e: unknown) => e instanceof ClientError && e.kind === "http" && e.status === 400 && e.body.includes("nope"));
  } finally {
    server.close();
  }
});

test("HttpClient: connection refused is an io error", async () => {
  const s = net.createServer();
  const port = await listen(s);
  s.close();
  await assert.rejects(new HttpClient(`127.0.0.1:${port}`).status(), (e: unknown) => e instanceof ClientError && e.kind === "io");
});

test("FileClient: drop request, runtime replies, release removes it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tc-sdk-"));
  try {
    const fc = new FileClient(root);
    fc.pollMs = 10;
    const iface = fc.layout.interface();
    // Fake runtime: answer the first request file it sees.
    const timer = setInterval(() => {
      try {
        for (const f of readdirSync(iface)) {
          if (f.endsWith(".json") && !f.endsWith(".reply.json")) {
            const req = JSON.parse(readFileSync(path.join(iface, f), "utf8")) as Request;
            const reply: Reply = makeReply(req.id ?? "", "granted", undefined, undefined, "now");
            writeFileSync(path.join(iface, `${req.id ?? ""}.reply.json`), JSON.stringify(reply));
          }
        }
      } catch {
        /* folder not there yet */
      }
    }, 5);
    const reply = await fc.request({ who: "Andrey", from: "relay-a", to: "sip-03" }, 2000);
    clearInterval(timer);
    assert.equal(reply.status, "granted");
    assert.match(reply.id, /^req-[0-9a-f]+-[0-9a-f]+$/);
    const written = JSON.parse(readFileSync(path.join(iface, `${reply.id}.json`), "utf8")) as Request;
    assert.equal(written.who, "Andrey");
    await fc.release(reply.id);
    await fc.release(reply.id); // missing is fine
    assert.ok(!readdirSync(iface).includes(`${reply.id}.json`));
    await assert.rejects(fc.request({ id: "never", who: "x", from: "a", to: "b" }, 50), (e: unknown) => e instanceof ClientError && e.kind === "timeout");
    // advertisements sorted, junk skipped
    mkdirSync(fc.layout.advertisement());
    writeFileSync(path.join(fc.layout.advertisement(), "b.json"), JSON.stringify({ id: "sip-02" }));
    writeFileSync(path.join(fc.layout.advertisement(), "a.json"), JSON.stringify({ id: "dante-01" }));
    writeFileSync(path.join(fc.layout.advertisement(), "c.json"), "{not json");
    assert.deepEqual((await fc.advertisements()).map((f) => f.id), ["dante-01", "sip-02"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findLayout walks up to KNOWN PROTOCOLS", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tc-sdk-"));
  try {
    mkdirSync(path.join(root, "KNOWN PROTOCOLS"));
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    assert.equal(findLayout(path.join(root, "a", "b"))?.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WardBeckClient: announce, adopt, echo acks, check in (wb.rs hub mock)", async () => {
  const received: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const text = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        received.push(text);
        const l = wb.parseOrThrow(text);
        if (wb.isCheckin(l) && l.frame === "dante-*") {
          // caster: CHECKIN per adopted frame, then its CLOSE lines; CRLF + a junk line to test framing
          sock.write(`${wb.format(wb.checkin("HQ", "dante-01", "now", 1))}\r\n`);
          sock.write("garbage\n");
          sock.write(`${wb.format(wb.local("HQ", "dante-01", "U00", "Ann", "CLOSE", "Bob", "C1"))}\n`);
        }
        if (received.length >= 4) resolveDone();
      }
    });
  });
  const port = await listen(server);
  const adopted: string[] = [];
  const closed: wb.WbLine[] = [];
  const bad: string[] = [];
  const c = new WardBeckClient({
    port,
    onLine: (l) => {
      if (wb.isCheckin(l)) {
        adopted.push(l.frame);
        return false;
      }
      closed.push(l);
      return true; // echo = ack
    },
    onBadLine: (t) => bad.push(t),
  });
  try {
    await c.connect();
    c.announce("HQ", "dante-*", "sim-dante", 0, "2026-10-21T00:00:00Z");
    // wait for the echo, then check in
    const until = Date.now() + 2000;
    while (closed.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    c.checkinFrame("HQ", "dante-01", "sim-dante", closed, "2026-10-21T00:00:20Z");
    await done;
    assert.deepEqual(adopted, ["dante-01"]);
    assert.deepEqual(bad, ["garbage"]);
    assert.equal(c.badLines, 1);
    assert.equal(received[0], "HQ,dante-*,CHECKIN,2026-10-21T00:00:00Z @sim-dante,OPEN,0 crosspoints,0,dante-*,HQ");
    assert.equal(received[1], "HQ,dante-01,U00,Ann,CLOSE,Bob,C1,dante-01,HQ"); // the ack
    assert.equal(received[2], "HQ,dante-01,CHECKIN,2026-10-21T00:00:20Z @sim-dante,CLOSE,1 crosspoints,1,dante-01,HQ");
    assert.equal(received[3], received[1]);
    assert.throws(() => c.send(wb.local("HQ", "f", "U0", "a\nb", "CLOSE", "x", "C0")), ClientError);
  } finally {
    await c.close();
    server.close();
  }
});
