/**
 * emulator-core.ts -- the Stream Deck emulator without a window.
 *
 * Faithful port of PANELS/streamdeck_emulator.py:41-230 (class Emulator) with
 * the Tk widgets replaced by a listener + a pure `faces()` snapshot so any
 * front end (the browser page in streamdeck-emulator.ts, a real Stream Deck
 * via @elgato-stream-deck/node, a test) can draw it.
 *
 * Python threads -> async functions; queue.Queue of GUI events -> onEvent().
 */
import { BUTTON_COLOR_DEFAULTS, PANEL_DEFAULTS, type ButtonColors, type Panel, type PanelButton } from "./panel-schema.ts";
import type { MatrixApi, PortState } from "./matrix-api.ts";

export type EmulatorEvent =
  | { kind: "hdr"; text: string }
  | { kind: "foot"; text: string }
  | { kind: "state"; state: PortState };

export interface KeyFace {
  row: number;
  col: number;
  label: string;
  bg: string;
  fg: string;
  action: PanelButton["action"];
}

export interface EmulatorOptions {
  api: MatrixApi;
  matrix?: string | undefined;
  port?: number | undefined;
  onEvent?: (e: EmulatorEvent) => void;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class EmulatorCore {
  readonly panel: Panel;
  readonly api: MatrixApi;
  readonly matrix: string;
  port: number;
  alpha = "";
  page = "main";
  state: PortState = {};
  hdr = "connecting…";
  foot = "";
  counter = "";
  readonly rows: number;
  readonly cols: number;
  readonly px: number;
  private readonly alphaToN = new Map<string, number>();
  private readonly nToAlpha = new Map<number, string>();
  private readonly latched = new Map<string, boolean>();
  private stopped = false;
  private readonly onEvent: (e: EmulatorEvent) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(panel: Panel, opts: EmulatorOptions) {
    this.panel = panel;
    this.api = opts.api;
    this.matrix = opts.matrix || panel.matrix;
    this.port = opts.port ?? panel.port ?? 0;
    this.rows = panel.device.rows;
    this.cols = panel.device.cols;
    this.px = panel.device.key_px ?? PANEL_DEFAULTS.key_px;
    this.onEvent = opts.onEvent ?? (() => undefined);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get title(): string {
    return `${this.panel.name}  ·  ${this.panel.device.model}  ·  ${this.matrix}`;
  }

  /** Python Emulator.poll(): apply one event to the visible state. */
  private emit(e: EmulatorEvent): void {
    if (e.kind === "hdr") this.hdr = e.text;
    else if (e.kind === "foot") this.foot = e.text;
    else {
      this.state = e.state;
      const inc = e.state.incoming ?? [];
      this.foot = inc.length ? "CALLING YOU: " + inc.map((c) => c.alpha).join(", ") : "";
      this.counter = `users ${e.state.users ?? "-"} · calling ${e.state.users_calling ?? "-"}`;
    }
    this.onEvent(e);
  }

  // ---- connect & feedback (py 77-94) ----------------------------------------
  /** Claim the port, then poll feedback until stop(). Resolves when stopped or on connect failure. */
  async run(): Promise<void> {
    try {
      for (const p of await this.api.ports(this.matrix)) {
        this.alphaToN.set(p.alpha.toUpperCase(), p.n);
        this.nToAlpha.set(p.n, p.alpha);
      }
      const info = await this.api.claim(this.matrix, this.port, this.panel.name_on_matrix ?? this.panel.name);
      this.port = info.port;
      this.alpha = info.alpha;
      this.emit({ kind: "hdr", text: `${this.panel.name}  ·  I am port ${this.port} ${this.alpha} on ${this.matrix}  ·  ${this.api.base}` });
      while (!this.stopped) {
        try {
          this.emit({ kind: "state", state: await this.api.port(this.matrix, this.port) });
        } catch (exc) {
          this.emit({ kind: "hdr", text: `feedback error: ${errText(exc)}` });
        }
        await this.sleep(Math.max(200, this.panel.poll_ms ?? PANEL_DEFAULTS.poll_ms));
      }
    } catch (exc) {
      this.emit({ kind: "hdr", text: `cannot connect: ${errText(exc)}` });
    }
  }

  targetN(target: string | undefined): number | undefined {
    if (target === undefined) return undefined;
    if (/^\d+$/.test(target)) return Number(target);
    return this.alphaToN.get(target.toUpperCase());
  }

  // ---- drawing (py 105-154) ---------------------------------------------------
  pageButtons(): PanelButton[] {
    if (this.page === "main") return this.panel.buttons;
    return this.panel.pages?.[this.page] ?? [];
  }

  /** Button definition at row,col of the current page (blank spacer if none). Last duplicate wins, as in the py dict. */
  buttonAt(row: number, col: number): PanelButton {
    let found: PanelButton | undefined;
    for (const b of this.pageButtons()) if (b.row === row && b.col === col) found = b;
    return found ?? { row, col, action: "none" };
  }

  colors(b: PanelButton): Required<ButtonColors> {
    const c: Required<ButtonColors> = { ...BUTTON_COLOR_DEFAULTS, ...definedOnly(b.colors) };
    if (b.action === "none") c.idle = "#161616";
    return c;
  }

  face(b: PanelButton): KeyFace {
    const talking = new Set(this.state.talking_to ?? []);
    const listening = new Set(this.state.listening ?? []);
    const incoming = new Set((this.state.incoming ?? []).map((c) => c.port));
    const remote = this.state.remote ?? [];
    const col = this.colors(b);
    const n = this.targetN(b.target);
    let bg = col.idle;
    if (b.action === "talk" && n !== undefined && talking.has(n)) bg = col.active;
    else if (b.action === "talk" && n !== undefined && incoming.has(n)) bg = col.incoming;
    // py 148-149: col.get("active", "#2e9e4f") -- the green fallback is dead because colors() always fills
    // "active" with red; kept faithful. Listen keys without colors.active light RED. See HANDOFF finding F3.
    else if (b.action === "listen" && n !== undefined && listening.has(n)) bg = col.active;
    else if (b.action === "call" && remote.length && remote.map((x) => x.toUpperCase()).includes((b.target ?? "").toUpperCase())) bg = col.active;
    else if (b.action === "reply" && incoming.size) bg = this.latched.get(latchKey("reply", undefined)) ? col.active : col.incoming;
    const label = b.label !== undefined ? b.label : (b.target ?? "");
    return { row: b.row, col: b.col, label, bg, fg: col.text, action: b.action };
  }

  /** The whole grid, row-major, as the device would show it now. */
  faces(): KeyFace[] {
    const out: KeyFace[] = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) out.push(this.face(this.buttonAt(r, c)));
    return out;
  }

  // ---- pressing (py 157-202) --------------------------------------------------
  /** Key down/up. Returns the in-flight send (or undefined if nothing is sent). */
  press(b: PanelButton, down: boolean): Promise<void> | undefined {
    const act = b.action;
    if (act === "none") return undefined;
    if (act === "page") {
      if (down) this.page = b.target ?? "main";
      return undefined;
    }
    const mode = b.mode ?? PANEL_DEFAULTS.mode;
    const key = latchKey(act, b.target);
    let state: boolean;
    if (mode === "latch") {
      if (!down) return undefined;
      state = !(this.latched.get(key) ?? false);
      this.latched.set(key, state);
    } else state = down;
    return this.send(b, state);
  }

  pressAt(row: number, col: number, down: boolean): Promise<void> | undefined {
    return this.press(this.buttonAt(row, col), down);
  }

  async send(b: PanelButton, state: boolean): Promise<void> {
    const { action: act, target } = b;
    const { api, matrix, port } = this;
    try {
      if (act === "talk" || act === "listen") await api.key(matrix, port, act, target, state);
      else if (act === "call") {
        if (state) {
          const t = String(target);
          const i = t.indexOf(":");
          const icom = i < 0 ? t : t.slice(0, i);
          const rport = i < 0 ? "" : t.slice(i + 1);
          const res = await api.trunkCall(matrix, port, icom, rport || "1");
          this.emit({ kind: "foot", text: JSON.stringify(res) });
        } else await api.hangup(matrix, port);
      } else if (act === "hangup") {
        if (state) this.emit({ kind: "foot", text: JSON.stringify(await api.hangup(matrix, port)) });
      } else if (act === "reply") {
        const first = (this.state.incoming ?? [])[0];
        if (first) {
          await api.key(matrix, port, "talk", first.port, state);
          this.latched.set(latchKey("reply", undefined), state);
        }
      }
      this.emit({ kind: "state", state: await api.port(matrix, port) });
    } catch (exc) {
      this.emit({ kind: "foot", text: `error: ${errText(exc)}` });
    }
  }

  /** py close(): let go of anything still keyed, release the port, stop polling. */
  async close(): Promise<void> {
    this.stopped = true;
    try {
      if (this.alpha) {
        for (const n of this.state.talking_to ?? []) await this.api.key(this.matrix, this.port, "talk", n, false);
        await this.api.release(this.matrix, this.port);
      }
    } catch {
      /* best effort, as in python */
    }
  }
}

function latchKey(action: string, target: string | undefined): string {
  return `${action}\u0000${target ?? ""}`;
}

function definedOnly(c: ButtonColors | undefined): ButtonColors {
  const out: ButtonColors = {};
  if (!c) return out;
  for (const k of ["idle", "active", "incoming", "text"] as const) {
    const v = c[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
