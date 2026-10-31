/**
 * Typed client for the `/ws` telemetry stream (ws.rs + runtime.rs:540-640).
 *
 * What the server actually does (read from source, confirmed live):
 *  - No snapshot on connect. Frames start at the next tick: a `status`
 *    frame every >= 500 ms and a `globe-delta` frame every >= 2000 ms, and
 *    only while at least one socket is registered (runtime.rs:542).
 *  - `status` is self-contained: apply it by replacing.
 *  - `globe-delta` is NOT a diff. It is a full copy of the volatile parts of
 *    `GET /api/globe` (trunkList, callList, history, clusters, counts) plus
 *    maps that OMIT zero entries (`live`, `parked`). A frame missing from
 *    `live` means 0, so maps must be replaced, never merged key-by-key.
 *  - `nodes` (frame positions) are never streamed. The page seeds them from
 *    the HTML (`window.GLOBE_DATA`) or `GET /api/globe`, and refetches when
 *    `delta.frames` no longer equals the node count (fleet changed).
 *  - Only `status` carries `build`; the pages reload on a new build.
 *
 * So the "first frame" is a seed you fetch (`seed()` below, GET /api/globe),
 * and the "deltas" are the stream. This client does both, plus reconnect.
 */
import type { ContinentTotal, GlobeCall, GlobeCluster, GlobeData, GlobeHistory, GlobeTrunk, LeaseLine, Lights, ProductionSample, RunSummary, Status } from './types.ts';

/** @adhoc runtime.rs:559 `status_message()` */
export interface StatusMessage {
  type: 'status';
  /** `env!("TC_BUILD")`: changes on every rebuild. */
  build: string;
  status: Status;
  clock: string;
  /** Simulated hour of day, 0..24. */
  hour: number;
  load: number;
  fader: { speed: number; running: boolean; preset: string };
  productions: Record<string, ProductionSample>;
  blackout: boolean;
  muted: number;
  /** Newest FIRST, at most 12 (GET /api/log is oldest first). */
  log: string[];
  /** Newest FIRST, at most 8 (GET /api/wardbeck is oldest first, as text). */
  wardbeck: string[];
  continents: ContinentTotal[];
  /** The 60 soonest-to-expire lines (GET /api/lines has all). */
  lines: LeaseLine[];
  run: { id: string; summary: RunSummary };
  dirty: boolean;
}

/** @adhoc runtime.rs:583 `globe_message()` */
export interface GlobeDeltaMessage {
  type: 'globe-delta';
  /** Frame COUNT (GlobeData.frames is also a count; `nodes` is the list). */
  frames: number;
  clock: string;
  trunkList: GlobeTrunk[];
  history: GlobeHistory[];
  today: number;
  callList: GlobeCall[];
  /** Live port count per frame; frames with 0 are absent. */
  live: Record<string, number>;
  /** Frames touched by a call whose lease ran out. */
  red: string[];
  /** Parked (muted) calls per frame; frames with 0 are absent. */
  parked: Record<string, number>;
  blink: string[];
  /** Last caller per frame. */
  last: Record<string, string>;
  lights: Lights;
  clusters: GlobeCluster[];
  sites: number;
  trunks: number;
  calls: number;
  sims: number;
}

export type TelemetryMessage = StatusMessage | GlobeDeltaMessage;

/** Parse one text frame. Unknown `type`s and bad JSON yield null (the pages ignore them too). */
export function parseTelemetry(text: string): TelemetryMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || !('type' in v)) return null;
  const t = (v as { type: unknown }).type;
  if (t === 'status' || t === 'globe-delta') return v as TelemetryMessage;
  return null;
}

/**
 * Apply a globe-delta to a seeded GlobeData. Pure. Replaces every streamed
 * field and rewrites each node's `live` from the delta (absent -> 0).
 * `fleetChanged` is true when the seed's nodes no longer describe the fleet.
 */
export function mergeGlobe(seed: GlobeData, d: GlobeDeltaMessage): { globe: GlobeData; fleetChanged: boolean } {
  const nodes = seed.nodes.map((n) => {
    const live = d.live[n.id] ?? 0;
    return live === n.live ? n : { ...n, live };
  });
  const globe: GlobeData = {
    ...seed,
    clock: d.clock,
    frames: d.frames,
    sites: d.sites,
    trunks: d.trunks,
    calls: d.calls,
    sims: d.sims,
    trunkList: d.trunkList,
    callList: d.callList,
    history: d.history,
    today: d.today,
    clusters: d.clusters,
    nodes,
  };
  return { globe, fleetChanged: d.frames !== seed.nodes.length };
}

/** The subset of the DOM WebSocket this client uses (Node 22+ has it global). */
export interface WebSocketLike {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface TelemetryOptions {
  /** `ws://127.0.0.1:8080/ws` by default. */
  url?: string;
  WebSocket?: WebSocketCtor;
  /** Fetch the seed (GET /api/globe). Called at start and when the fleet changes. */
  seed?: () => Promise<GlobeData>;
  onStatus?: (m: StatusMessage) => void;
  /** Raw delta, always delivered. */
  onGlobeDelta?: (m: GlobeDeltaMessage) => void;
  /** Seed merged with the latest delta (only when `seed` is given). */
  onGlobe?: (g: GlobeData) => void;
  /** First `build` seen differs from a later one (the pages reload here). */
  onBuildChange?: (from: string, to: string) => void;
  onState?: (s: ConnectionState) => void;
  /** Reconnect delay: starts here (2000 ms, as the pages), doubles to `maxDelayMs`. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Override for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'stopped';

export interface Telemetry {
  readonly state: ConnectionState;
  readonly lastStatus: StatusMessage | null;
  readonly globe: GlobeData | null;
  stop(): void;
}

export function connectTelemetry(opts: TelemetryOptions = {}): Telemetry {
  const url = opts.url ?? 'ws://127.0.0.1:8080/ws';
  const Ctor: WebSocketCtor | undefined = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!Ctor) throw new Error('no WebSocket implementation; pass opts.WebSocket (e.g. from the "ws" package)');
  const minDelay = opts.minDelayMs ?? 2000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let state: ConnectionState = 'connecting';
  let ws: WebSocketLike | null = null;
  let timer: unknown = null;
  let delay = minDelay;
  let build: string | null = null;
  let lastStatus: StatusMessage | null = null;
  let globe: GlobeData | null = null;
  let seeding: Promise<void> | null = null;
  let pendingDelta: GlobeDeltaMessage | null = null;

  const setState = (s: ConnectionState) => {
    state = s;
    opts.onState?.(s);
  };

  function reseed(): void {
    if (!opts.seed || seeding) return;
    seeding = opts
      .seed()
      .then((g) => {
        globe = g;
        if (pendingDelta) applyDelta(pendingDelta);
        else opts.onGlobe?.(g);
      })
      .catch(() => {
        /* keep the old seed; the next fleet check retries */
      })
      .finally(() => {
        seeding = null;
      });
  }

  function applyDelta(d: GlobeDeltaMessage): void {
    pendingDelta = null;
    if (!globe) {
      pendingDelta = d;
      return;
    }
    const r = mergeGlobe(globe, d);
    globe = r.globe;
    opts.onGlobe?.(globe);
    if (r.fleetChanged) reseed();
  }

  function onMessage(text: string): void {
    const m = parseTelemetry(text);
    if (!m) return;
    if (m.type === 'status') {
      if (build !== null && m.build !== build) opts.onBuildChange?.(build, m.build);
      build = m.build;
      lastStatus = m;
      opts.onStatus?.(m);
    } else {
      opts.onGlobeDelta?.(m);
      if (opts.seed) applyDelta(m);
    }
  }

  function schedule(): void {
    if (state === 'stopped') return;
    setState('closed');
    timer = setTimer(open, delay);
    delay = Math.min(delay * 2, maxDelay);
  }

  function open(): void {
    timer = null;
    if (state === 'stopped') return;
    setState('connecting');
    let sock: WebSocketLike;
    try {
      sock = new Ctor!(url);
    } catch {
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      delay = minDelay;
      setState('open');
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') onMessage(ev.data);
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {
        /* already closing */
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      schedule();
    };
  }

  reseed();
  open();

  return {
    get state() {
      return state;
    },
    get lastStatus() {
      return lastStatus;
    },
    get globe() {
      return globe;
    },
    stop() {
      setState('stopped');
      if (timer !== null) clearTimer(timer);
      timer = null;
      const s = ws;
      ws = null;
      if (s) {
        s.onclose = null;
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
