// What the page scripts consume from the shared client core (html.rs `JS`
// const, being ported by agent 01 into TYPESCRIPT/web-core/) and from the map
// engine (html.rs `GLOBE_JS`, agent 02). Declared here, not implemented:
// the page bundles run after the core <script> in <head> has defined them.
// DEDUP: swap for agent 01's exported declarations when web-core lands.

import type { GlobeDelta, LightsJson, RelayBinding, RelayMatrixLite, StatusMessage } from './wire.ts';

declare global {
  /** `const LIVE = location.protocol.startsWith('http')` */
  const LIVE: boolean;
  /** Injected by page(): `const REFRESH_MS={refresh_ms}` */
  const REFRESH_MS: number;
  /** Injected by page(): `const BUILD="{build}"` */
  const BUILD: string;

  interface TcCore {
    status: StatusMessage | null;
    onStatus: Array<(m: StatusMessage) => void>;
    onGlobe: Array<(m: GlobeDelta) => void>;
    onMain: Array<() => void>;
    ws: WebSocket | null;
    interacting: number;
  }
  const TC: TcCore;

  /** fetch JSON; GET without body, POST with. Returns the parsed body, or the raw text when it is not JSON. */
  function api(path: string, body?: unknown): Promise<unknown>;
  function show(id: string, v: unknown): void;
  function num(id: string): number | undefined;
  function val(id: string): string | undefined;
  function esc(s: unknown): string;
  function dur(s: number): string;
  function reload(ms?: number): void;
  function setText(id: string, t: string): void;
  function cacheGet(k: string): unknown;
  function cacheSet(k: string, v: unknown): void;
  function refreshMain(force?: boolean): Promise<void>;
  function connect(from: string, fromPort: number, who?: string): void;
  function rename(frame: string, port: number): void;

  interface Window {
    // --- server -> client injections (see HANDOFF.md "Injection catalogue") ---
    /** panels_page: `window.LIGHTS0 = lights_json(rt)` */
    LIGHTS0?: LightsJson;
    /** relay_page: `window.RELAY_THRESHOLD = rt.relay.over_threshold_dbfs` */
    RELAY_THRESHOLD?: number;
    /** relay_page: `window.RELAY_MATRICES = [{id,label,io}]` */
    RELAY_MATRICES?: RelayMatrixLite[];
    /** relay_page: `window.RELAY_BOUND = {"<matrix>:<port>": RelayBinding}` */
    RELAY_BOUND?: Record<string, RelayBinding>;
    /** map_block (agent 02 owns the engine; racks.ts writes it). */
    GLOBE_FILTER: Set<string>;
    /** Safari < 14.1 prefix used by RELAY_JS. */
    webkitAudioContext?: typeof AudioContext;

    // --- globals the panel editor exports for its inline handlers ---
    bookPort?: (frame: string, port: number) => void;
    renamePort?: (frame: string, port: number) => void;
    findInTree?: (q: string) => void;
  }
}

export {};
