// Ambient declarations for what the map engine consumes from the page.
//  - The shared client (`JS` const in html.rs, ported by agent 01 in
//    TYPESCRIPT/web-core/): TC, api, esc, setText, dur, num, cacheGet,
//    predictedHour. Declared here, never imported, so the bundle keeps
//    using the page's globals. Dedup against web-core's own .d.ts later.
//  - The inline <script> map_block() writes before GLOBE_JS: GLOBE_DATA,
//    GLOBE_DEFAULT_MODE, GLOBE_LAYERS, GLOBE_HUB, GLOBE_FILTER, TC_LAND.
import type { GlobeData, GlobeDelta, Hub, LandRing, StatusMessage } from './src/types.ts';

declare global {
  interface Window {
    GLOBE_DATA: GlobeData;
    /** map_block's `mode` argument: 'both' | 'globe' | 'map'. */
    GLOBE_DEFAULT_MODE?: string;
    /** Read by GLOBE_JS but never set anywhere in the repo (dead fallback). */
    GLOBE_FORCE_PROJECTION?: string;
    /** map_block's layer list, or null for the default set. */
    GLOBE_LAYERS?: string[] | null;
    GLOBE_HUB?: Hub | null;
    /** Protocol ids (GlobeNode.proto) to show; empty = all. Replaced wholesale by the aggregator page's hover. */
    GLOBE_FILTER?: Set<string>;
    TC_LAND?: LandRing[];
  }

  /** The telemetry hub (html.rs `const TC`). Only the members the map uses. */
  const TC: {
    status: unknown;
    onStatus: Array<(m: StatusMessage) => void>;
    onGlobe: Array<(m: GlobeDelta) => void>;
    onMain: Array<() => void>;
    hour?: number;
    at?: number;
    speed?: number;
  };

  /** GET when body is undefined, else POST JSON. Resolves parsed JSON, or the raw text if it is not JSON. */
  function api(path: string, body?: unknown): Promise<unknown>;
  function esc(s: unknown): string;
  function setText(id: string, t: string): void;
  function dur(s: number): string;
  function num(id: string): number | undefined;
  function cacheGet(k: string): unknown;
  /** Defined by the shared client; GLOBE_JS guards with `typeof predictedHour === 'function'`. */
  // eslint-disable-next-line no-var
  var predictedHour: (() => number | null) | undefined;
}

export {};
