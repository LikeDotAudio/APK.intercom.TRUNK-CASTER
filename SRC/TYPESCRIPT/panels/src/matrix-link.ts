/**
 * matrix-link.ts -- UDP link to a matrix's audio series (port of trunk_panel.py:49-137, class MatrixLink).
 *
 * Python: a thread blocking on recvfrom(timeout=0.5) that also sends HELLO
 * every HELLO_INTERVAL and flags loss of contact after ENDPOINT_TIMEOUT.
 * Node: dgram 'message' events + a 500 ms tick doing the same bookkeeping.
 */
import { createSocket, type Socket } from "node:dgram";
import type { ApiPort } from "./matrix-api.ts";
import type { AudioLink } from "./audio.ts";
import * as tc from "./tc-protocol.ts";

export type LinkEvent =
  | { kind: "status"; text: string }
  | { kind: "joined"; info: tc.HelloAck }
  | { kind: "state"; state: tc.TcState };

const RX_QUEUE = 12; // deque(maxlen=12)

export class MatrixLink implements AudioLink {
  host: string;
  port: number;
  readonly wantPort: number;
  readonly name: string;
  seq = 0;
  myPort = 0;
  alpha = "";
  matrix = "";
  ports: ApiPort[] = [];
  connected = false;
  lastRx = 0;
  txFrames = 0;
  rxCount = 0;
  private readonly rxFrames: Buffer[] = [];
  private readonly sock: Socket;
  private tick: NodeJS.Timeout | undefined;
  private lastHello = 0;
  private readonly onEvent: (e: LinkEvent) => void;
  private readonly now: () => number;

  constructor(host: string, port: number, wantPort: number, name: string, onEvent: (e: LinkEvent) => void, now: () => number = () => Date.now() / 1000) {
    this.host = host;
    this.port = port;
    this.wantPort = wantPort;
    this.name = name;
    this.onEvent = onEvent;
    this.now = now;
    this.sock = createSocket("udp4");
    this.sock.on("message", (data) => this.onMessage(data));
    this.sock.on("error", () => undefined); // py: OSError on send is swallowed
  }

  nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  send(data: Buffer, done?: () => void): void {
    try {
      this.sock.send(data, this.port, this.host, () => done?.());
    } catch {
      done?.(); // socket closed
    }
  }

  hello(): void {
    this.send(tc.packHello(this.myPort || this.wantPort, this.nextSeq(), this.name));
  }

  sendAudio(pcm: Buffer): void {
    if (this.myPort) {
      this.txFrames += 1;
      this.send(tc.packAudio(this.myPort, this.nextSeq(), pcm));
    }
  }

  popRx(): Buffer | undefined {
    return this.rxFrames.shift();
  }

  key(kind: tc.KeyKind, target: number | null, state: boolean): void {
    if (this.myPort && target) this.send(tc.packKey(this.myPort, this.nextSeq(), kind, target, state));
  }

  /** Resolves once BYE has left the socket, so stop() right after does not drop it. */
  bye(): Promise<void> {
    return new Promise((resolve) => {
      if (this.myPort) this.send(tc.packBye(this.myPort, this.nextSeq()), resolve);
      else resolve();
    });
  }

  /** Bind an ephemeral local port and start the keepalive tick. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.sock.bind(0, () => {
        this.onTick();
        this.tick = setInterval(() => this.onTick(), 500);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }

  private onTick(): void {
    const now = this.now();
    if (now - this.lastHello > tc.HELLO_INTERVAL) {
      this.hello();
      this.lastHello = now;
    }
    if (this.connected && now - this.lastRx > tc.ENDPOINT_TIMEOUT) {
      this.connected = false;
      this.onEvent({ kind: "status", text: "lost contact with matrix" });
    }
  }

  /** Exposed for tests. */
  onMessage(data: Buffer): void {
    const msg = tc.unpack(data);
    if (!msg) return;
    this.lastRx = this.now();
    if (msg.type === tc.TYPE_HELLO_ACK) {
      const info = parseHelloAck(tc.loads(msg.payload));
      if (!info) return; // py would raise KeyError and kill the link thread; see HANDOFF finding
      this.myPort = info.port;
      this.alpha = info.alpha;
      this.matrix = info.matrix ?? "";
      if (info.ports?.length) this.ports = info.ports;
      const sock = info.socket;
      if (sock && sock !== this.port) {
        // the intercom told us which socket in its series is ours: move there and say hello on it
        this.port = sock;
        this.onEvent({ kind: "status", text: `assigned port ${this.myPort} ${this.alpha}, moving to socket udp/${sock}` });
        this.hello();
        this.lastHello = this.now();
        return;
      }
      const first = !this.connected;
      this.connected = true;
      if (first) this.onEvent({ kind: "joined", info });
    } else if (msg.type === tc.TYPE_AUDIO) {
      this.rxCount += 1;
      this.rxFrames.push(msg.payload.subarray(0, tc.FRAME_BYTES));
      if (this.rxFrames.length > RX_QUEUE) this.rxFrames.shift();
    } else if (msg.type === tc.TYPE_STATE) {
      const st = tc.loads(msg.payload);
      if (typeof st === "object" && st !== null) this.onEvent({ kind: "state", state: st as tc.TcState });
    }
  }
}

function parseHelloAck(v: unknown): tc.HelloAck | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Partial<Record<keyof tc.HelloAck, unknown>>;
  if (typeof o.port !== "number" || typeof o.alpha !== "string") return undefined;
  return v as tc.HelloAck;
}
