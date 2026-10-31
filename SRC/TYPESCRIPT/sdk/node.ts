/**
 * Node-only clients — port of TRUNK-CASTER-SDK/src/client.rs, plus the
 * Ward-Beck TCP client the Rust SDK does not have (the remote-frame side of
 * RUST-RUNTIME/src/wb.rs, as spoken by TRUNK-SIMULATOR/frame-sim).
 *
 *  - FileClient     the folder contract: drop request files, wait for replies.
 *  - HttpClient     the runtime's HTTP port (default 127.0.0.1:7878; 8080 in Docker).
 *  - WardBeckClient the Ward-Beck TCP port (default 7879): newline-framed lines.
 *
 * Kept out of index.ts so browser bundles never pull in node:fs / node:net.
 */

import { promises as fs, statSync } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { Layout, KNOWN_PROTOCOLS } from "./folders.ts";
import type {
  CrosspointSettings,
  CrosspointSettingsInput,
  Fader,
  FaderInput,
  Frame,
  GpioCommand,
  GpioEvent,
  PanelOffer,
  PanelSeek,
  Rename,
  RenameDispatch,
  Reply,
  Request,
  Status,
} from "./types.ts";
import { format as formatLine, parse as parseLine, checkin, isCheckin, type WbLine } from "./wardbeck.ts";

export const DEFAULT_HTTP_ADDR = "127.0.0.1:7878";
export const DEFAULT_WB_PORT = 7879;

// ---------------------------------------------------------------------------
// Errors (client.rs:19-49)
// ---------------------------------------------------------------------------

export type ClientErrorKind = "io" | "json" | "timeout" | "http";

export class ClientError extends Error {
  readonly kind: ClientErrorKind;
  /** HTTP status for kind "http" (0 when the status line could not be read). */
  readonly status: number;
  /** Raw response body for kind "http". */
  readonly body: string;

  constructor(kind: ClientErrorKind, message: string, status = 0, body = "") {
    super(kind === "timeout" ? "timed out waiting for the runtime" : `${kind}: ${message}`);
    this.name = "ClientError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ClientError("json", e instanceof Error ? e.message : String(e));
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `unique_suffix`: `<nanos since epoch, hex>-<pid, hex>`. */
export function uniqueSuffix(): string {
  const nanos = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  return `${nanos.toString(16)}-${process.pid.toString(16)}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `Layout::find`: walk up from `start` until a directory containing KNOWN PROTOCOLS is found. */
export function findLayout(start: string): Layout | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (isDir(path.join(dir, KNOWN_PROTOCOLS))) return new Layout(dir, path.join);
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// FileClient (client.rs:53-159)
// ---------------------------------------------------------------------------

export class FileClient {
  readonly layout: Layout;
  /** Poll interval while waiting for a reply file, ms (Rust: 100). */
  pollMs = 100;

  constructor(root: string) {
    this.layout = new Layout(root, path.join);
  }

  /** Every frame currently advertised, sorted by id. Unparseable files are skipped. */
  async advertisements(): Promise<Frame[]> {
    const dir = this.layout.advertisement();
    if (!isDir(dir)) return [];
    const out: Frame[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const text = await fs.readFile(path.join(dir, name), "utf8").catch((e: unknown) => {
        throw new ClientError("io", errorMessage(e));
      });
      try {
        out.push(JSON.parse(text) as Frame);
      } catch {
        // Rust skips files that do not parse as a Frame.
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** Drop a request and wait up to `timeoutMs` for the reply. Fills in `id` when absent. */
  async request(req: Request, timeoutMs: number): Promise<Reply> {
    const id = req.id ?? `req-${uniqueSuffix()}`;
    const body: Request = { ...req, id };
    const dir = this.layout.interface();
    await fs.mkdir(dir, { recursive: true });
    const replyPath = path.join(dir, `${id}.reply.json`);
    await fs.rm(replyPath, { force: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(body, null, 2));
    return this.waitFor<Reply>(replyPath, timeoutMs);
  }

  /** Release by removing the request file. Missing file is fine. */
  async release(id: string): Promise<void> {
    await fs.rm(path.join(this.layout.interface(), `${id}.json`), { force: true });
  }

  async fader(): Promise<Fader> {
    return parseJson<Fader>(await fs.readFile(this.layout.fader(), "utf8"));
  }

  async setFader(fader: FaderInput): Promise<void> {
    await fs.mkdir(this.layout.simulator(), { recursive: true });
    await fs.writeFile(this.layout.fader(), JSON.stringify(fader, null, 2));
  }

  async seekPanel(seek: PanelSeek, timeoutMs: number): Promise<PanelOffer> {
    const id = seek.id ?? `seek-${uniqueSuffix()}`;
    const dir = this.layout.seeksDir();
    await fs.mkdir(dir, { recursive: true });
    const offerPath = path.join(dir, `${id}.offer.json`);
    await fs.rm(offerPath, { force: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ ...seek, id }, null, 2));
    return this.waitFor<PanelOffer>(offerPath, timeoutMs);
  }

  /** Poll until `file` exists and parses (a half-written file is retried), or time out. */
  private async waitFor<T>(file: string, timeoutMs: number): Promise<T> {
    const start = Date.now();
    for (;;) {
      try {
        return JSON.parse(await fs.readFile(file, "utf8")) as T;
      } catch {
        // not there yet, or partially written
      }
      if (Date.now() - start > timeoutMs) throw new ClientError("timeout", "");
      await sleep(this.pollMs);
    }
  }
}

// ---------------------------------------------------------------------------
// HttpClient (client.rs:161-254)
// ---------------------------------------------------------------------------

export class HttpClient {
  /** `host:port`, like the Rust client (no scheme). */
  readonly addr: string;
  /** Read timeout, ms (Rust: 10 s). */
  timeoutMs = 10_000;

  constructor(addr: string = DEFAULT_HTTP_ADDR) {
    this.addr = addr;
  }

  status(): Promise<Status> { return this.get("/api/status"); }
  advertisements(): Promise<Frame[]> { return this.get("/api/advertisements"); }
  request(req: Request): Promise<Reply> { return this.post("/api/request", req); }
  release(id: string): Promise<Reply> { return this.post("/api/release", { id }); }
  fader(): Promise<Fader> { return this.get("/api/fader"); }
  setFader(fader: FaderInput): Promise<Fader> { return this.post("/api/fader", fader); }
  seekPanel(seek: PanelSeek): Promise<PanelOffer> { return this.post("/api/panel-seek", seek); }
  crosspointSettings(s: CrosspointSettingsInput): Promise<CrosspointSettings> { return this.post("/api/crosspoints/settings", s); }
  /** Send a GPIO command down a live connection's trunk path. */
  gpio(cmd: GpioCommand): Promise<GpioEvent> { return this.post("/api/gpio", cmd); }
  /**
   * Rename a user port. The runtime answers with one dispatch per vendor
   * (http.rs:484 → runtime.rs `rename` → `Vec<RenameDispatch>`). The Rust
   * SDK types this as `Result<Rename>`, which can never deserialize — fixed here.
   */
  rename(r: Rename): Promise<RenameDispatch[]> { return this.post("/api/rename", r); }

  async get<T>(p: string): Promise<T> {
    const [code, body] = await this.send("GET", p);
    if (Math.floor(code / 100) !== 2) throw new ClientError("http", `${code}: ${body}`, code, body);
    return parseJson<T>(body);
  }

  async post<T>(p: string, payload: unknown): Promise<T> {
    const [code, body] = await this.send("POST", p, JSON.stringify(payload));
    if (Math.floor(code / 100) !== 2) throw new ClientError("http", `${code}: ${body}`, code, body);
    return parseJson<T>(body);
  }

  private async send(method: "GET" | "POST", p: string, body?: string): Promise<[number, string]> {
    try {
      const res = await fetch(`http://${this.addr}${p}`, {
        method,
        headers: { "Content-Type": "application/json", Connection: "close" },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return [res.status, await res.text()];
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new ClientError("timeout", "");
      throw new ClientError("io", errorMessage(e));
    }
  }
}

// ---------------------------------------------------------------------------
// WardBeckClient: a remote frame on the caster's Ward-Beck port (wb.rs)
// ---------------------------------------------------------------------------

export interface WardBeckClientOptions {
  host?: string;
  port?: number;
  /** Called for every parsed line from the caster. Return true to echo it back (the ack). */
  onLine?: (line: WbLine) => boolean | void;
  /** Called for lines that fail to parse (the caster counts these as `bad_lines`). */
  onBadLine?: (text: string, error: string) => void;
  onClose?: () => void;
}

/**
 * Speaks the Ward-Beck port the way frame-sim does:
 *  1. `announce()` sends a CHECKIN (frame may be `<protocol>-*`, `when` is `"<iso> @<host>"`).
 *  2. The caster answers with a CHECKIN per adopted frame then its CLOSE lines.
 *  3. Every CLOSE/OPEN applied is echoed back verbatim — that is the ack.
 *  4. Periodic `checkinFrame()` restates state (CHECKIN header + one CLOSE per crosspoint).
 * Lines are `\n`-terminated; a trailing `\r` is stripped (Rust `BufRead::lines`).
 */
export class WardBeckClient {
  private socket: net.Socket | undefined;
  private buf = "";
  private readonly opts: WardBeckClientOptions;
  linesIn = 0;
  linesOut = 0;
  badLines = 0;

  constructor(opts: WardBeckClientOptions = {}) {
    this.opts = opts;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.opts.host ?? "127.0.0.1", port: this.opts.port ?? DEFAULT_WB_PORT });
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.socket = s;
        resolve();
      });
      s.once("error", (e) => reject(new ClientError("io", e.message)));
      s.on("data", (chunk: string) => this.feed(chunk));
      s.on("close", () => {
        this.socket = undefined;
        this.opts.onClose?.();
      });
    });
  }

  private feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let text = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (text.endsWith("\r")) text = text.slice(0, -1);
      if (text.trim() === "") continue;
      const r = parseLine(text);
      if (!r.ok) {
        this.badLines++;
        this.opts.onBadLine?.(text, r.error);
        continue;
      }
      this.linesIn++;
      if (this.opts.onLine?.(r.line) === true && !isCheckin(r.line)) this.send(r.line);
    }
  }

  /** Write one line. Throws if the formatted line would break newline framing. */
  send(line: WbLine): void {
    const text = formatLine(line);
    if (/[\r\n]/.test(text)) throw new ClientError("io", "Ward-Beck field contains CR/LF; it would split the line");
    if (!this.socket) throw new ClientError("io", "not connected");
    this.socket.write(`${text}\n`);
    this.linesOut++;
  }

  /** Announce a frame (or `<protocol>-*`) with a CHECKIN line carrying `@host`. */
  announce(site: string, frame: string, host: string, closed = 0, when: string = new Date().toISOString()): void {
    this.send(checkin(site, frame, `${when} @${host}`, closed));
  }

  /** Full-state check-in for one frame: header then one CLOSE line per crosspoint. */
  checkinFrame(site: string, frame: string, host: string, closedLines: WbLine[], when: string = new Date().toISOString()): void {
    this.send(checkin(site, frame, `${when} @${host}`, closedLines.length));
    for (const l of closedLines) this.send(l);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve();
      this.socket.end(() => resolve());
    });
  }
}
