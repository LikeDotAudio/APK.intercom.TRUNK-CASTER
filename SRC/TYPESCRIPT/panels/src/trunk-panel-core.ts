/**
 * trunk-panel-core.ts -- the soft panel's model, without a window.
 *
 * Port of trunk_panel.py:216-302 (Key, KeyView.refresh) and 308-478 (Panel
 * behaviour). Tk widgets become plain snapshots (KeyFace / PanelView) that the
 * browser page in trunk-panel.ts renders; "views" become a single onChange.
 */
import type { ApiPort } from "./matrix-api.ts";
import type { AudioEngine } from "./audio.ts";
import type { LinkEvent, MatrixLink } from "./matrix-link.ts";
import * as tc from "./tc-protocol.ts";

export class Key {
  readonly panel: PanelModel;
  readonly kind: tc.KeyKind;
  readonly slot: number;
  /** port number */
  target: number | null = null;
  active = false;
  /** someone on this target is talking to me */
  incoming = false;

  constructor(panel: PanelModel, kind: tc.KeyKind, slot: number) {
    this.panel = panel;
    this.kind = kind;
    this.slot = slot;
  }

  get label(): string {
    return this.kind === tc.KEY_TALK ? `TALK ${this.slot}` : `LISTEN ${this.slot}`;
  }

  alpha(): string {
    if (!this.target) return "--";
    for (const p of this.panel.link.ports) if (p.n === this.target) return p.alpha;
    return `P${this.target}`;
  }

  setTarget(n: number | null): void {
    if (this.active && this.target) {
      this.panel.link.key(this.kind, this.target, false);
      this.active = false;
      // py 236-239 does NOT re-evaluate the mic gate here, so the mic stays open after retargeting
      // an active TALK key. Fixed in the port; see HANDOFF finding F1.
      if (this.kind === tc.KEY_TALK) this.panel.updateMicGate();
    }
    this.target = n;
    if (n) this.panel.rememberAssignments();
    this.panel.changed();
  }

  toggle(): void {
    if (!this.target) {
      this.panel.status("assign a port to this key first");
      return;
    }
    this.active = !this.active;
    this.panel.link.key(this.kind, this.target, this.active);
    if (this.kind === tc.KEY_TALK) this.panel.updateMicGate();
    this.panel.changed();
  }
}

export interface KeyFace {
  index: number;
  kind: "talk" | "listen";
  label: string;
  /** "n ALPHA TYPE" strings, as the combobox showed */
  choices: string[];
  selected: string;
  text: string;
  bg: string;
  fg: string;
  sunken: boolean;
}

/** py KeyView.refresh() (283-297) as a pure function. */
export function keyFace(k: Key, index: number): KeyFace {
  const link = k.panel.link;
  const choices = link.ports
    .filter((p) => p.n !== link.myPort && (k.kind === tc.KEY_LISTEN || p.type !== "WLESS"))
    .map((p) => `${p.n} ${p.alpha} ${p.type}`);
  const selected = k.target ? (choices.find((c) => c.startsWith(`${k.target} `)) ?? "--") : "--";
  const bg = k.kind === tc.KEY_TALK ? (k.active ? "#d9342b" : k.incoming ? "#f0b429" : "#e6e6e6") : k.active ? "#2e9e4f" : "#e6e6e6";
  const fg = k.active || k.incoming ? "white" : "black";
  let text = `${k.label}\n${k.alpha()}`;
  if (k.incoming && !k.active) text += "\n◄ CALLING";
  return { index, kind: k.kind === tc.KEY_TALK ? "talk" : "listen", label: k.label, choices, selected, text, bg, fg, sunken: k.active };
}

/** py KeyView._chosen: "12 CAM03 CAM" -> 12, "--" -> null */
export function parseChoice(txt: string): number | null {
  return /^\d/.test(txt) ? Number.parseInt(txt, 10) : null;
}

export interface PanelView {
  hdr: string;
  tz: string;
  status: string;
  incoming: string;
  counter: string;
  micMeter: number;
  spkMeter: number;
  audio: string;
  keys: KeyFace[];
}

export class PanelModel {
  readonly link: MatrixLink;
  readonly audio: AudioEngine;
  readonly name: string;
  readonly matrixAddr: string;
  readonly keys: Key[];
  state: tc.TcState = {};
  assignedOnce = false;
  hdr: string;
  tz = "";
  statusText = "";
  incomingText = "no incoming calls";
  counter = "USERS –\nCALLING –";
  onChange: () => void = () => undefined;
  private readonly now: () => number;

  constructor(link: MatrixLink, audio: AudioEngine, name: string, matrixAddr: string, now: () => number = () => Date.now() / 1000) {
    this.link = link;
    this.audio = audio;
    this.name = name;
    this.matrixAddr = matrixAddr;
    this.now = now;
    this.hdr = `connecting to ${matrixAddr} ...`;
    this.keys = [
      ...Array.from({ length: 8 }, (_, i) => new Key(this, tc.KEY_TALK, i + 1)),
      ...Array.from({ length: 8 }, (_, i) => new Key(this, tc.KEY_LISTEN, i + 1)),
    ];
  }

  changed(): void {
    this.onChange();
  }

  status(txt: string): void {
    this.statusText = txt;
    this.changed();
  }

  setMuted(m: boolean): void {
    this.audio.muted = m;
  }

  updateMicGate(): void {
    this.audio.micOpen = this.keys.some((k) => k.kind === tc.KEY_TALK && k.active);
  }

  /** py: a stub (`pass`). Kept as an extension point. */
  rememberAssignments(): void {}

  /** First time we see the port list: put sensible things on the keys. */
  defaultAssignments(): void {
    const ports = this.link.ports.filter((p) => p.n !== this.link.myPort);
    if (!ports.length || this.assignedOnce) return;
    this.assignedOnce = true;
    const pick = (types: string[], count: number, exclude: Set<number>): number[] => {
      const out: number[] = [];
      for (const t of types)
        for (const p of ports)
          if (p.type === t && !exclude.has(p.n) && out.length < count) {
            out.push(p.n);
            exclude.add(p.n);
          }
      return out;
    };
    let used = new Set<number>();
    const tx = [...pick(["CAM"], 3, used), ...pick(["PANEL"], 2, used), ...pick(["IFB"], 2, used), ...pick(["AUDIO"], 1, used)];
    used = new Set<number>();
    const rx = [...pick(["PANEL"], 3, used), ...pick(["IFB"], 2, used), ...pick(["CAM"], 2, used), ...pick(["WLESS"], 1, used)];
    tx.slice(0, 8).forEach((n, i) => {
      const k = this.keys[i];
      if (k) k.target = n;
    });
    rx.slice(0, 8).forEach((n, i) => {
      const k = this.keys[8 + i];
      if (k) k.target = n;
    });
    this.changed();
  }

  onState(st: tc.TcState): void {
    this.state = st;
    const inc = st.incoming ?? [];
    const incPorts = new Set(inc.map((c) => c.port));
    for (const k of this.keys) k.incoming = k.kind === tc.KEY_TALK && k.target !== null && incPorts.has(k.target);
    this.incomingText = inc.length
      ? "CALLING YOU: " + inc.map((c) => `${c.alpha} (${Math.trunc(this.now() - c.since)}s)`).join(", ")
      : "no incoming calls";
    this.counter = `USERS ${st.users ?? "–"}\nCALLING ${st.users_calling ?? "–"}`;
    this.tz = st.time ?? "";
    this.changed();
  }

  /** py Panel.poll() event branch. */
  onLinkEvent(e: LinkEvent): void {
    if (e.kind === "joined") {
      this.hdr = `${this.name}  ·  I am port ${e.info.port} ${e.info.alpha} on ${e.info.matrix ?? ""}`;
      this.statusText = `joined; audio port ${this.matrixAddr}`;
      this.defaultAssignments();
      this.changed();
    } else if (e.kind === "state") this.onState(e.state);
    else this.status(e.text);
  }

  view(): PanelView {
    const a = this.audio;
    return {
      hdr: this.hdr,
      tz: this.tz,
      status: this.statusText,
      incoming: this.incomingText,
      counter: this.counter,
      micMeter: Math.min(1, a.micLevel * 6),
      spkMeter: Math.min(1, a.spkLevel * 6),
      audio: a.error ?? `${a.rate} Hz, mic ${a.micOpen ? "OPEN" : "closed"} · tx ${this.link.txFrames} rx ${this.link.rxCount} frames`,
      keys: this.keys.map((k, i) => keyFace(k, i)),
    };
  }

  /** py close() minus the window. */
  async close(): Promise<void> {
    for (const k of this.keys) if (k.active && k.target) this.link.key(k.kind, k.target, false);
    await this.link.bye();
    this.link.stop();
  }
}

export type { ApiPort };
