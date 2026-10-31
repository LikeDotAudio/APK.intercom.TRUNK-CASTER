// The TC store: telemetry state and hooks shared with page scripts.
// In the original it is `const TC = {...}` at script top level; GLOBE_JS,
// DISCOVERY_JS, the panels/overlord inline scripts push onto its hook arrays.
import type { GlobeDeltaMessage, StatusMessage } from './types.ts';

/** The columns/quadrants deal remembered across refreshMain (same page, same count). */
export interface ColPlan {
  key: string;
  /** Column (or pane) index per dealt item, in item order. */
  ids: number[];
}

export interface TCStore {
  /** Last status frame applied (from /ws or the cache). */
  status: StatusMessage | null;
  /** Called after every status frame, after the core applied it. */
  onStatus: Array<(m: StatusMessage) => void>;
  /** Called with every globe-delta frame. */
  onGlobe: Array<(m: GlobeDeltaMessage) => void>;
  /** Called after refreshMain swapped <main>. */
  onMain: Array<() => void>;
  ws: WebSocket | null;
  /** Date.now() of the last pointerdown/keydown/wheel. */
  interacting: number;
  // Day-strip prediction inputs, set by applyStatus and the strip scrub.
  // Absent until the first status frame (the original added them lazily).
  hour?: number;
  /** performance.now() when `hour` was taken. */
  at?: number;
  /** Fader speed: simulated seconds per wall second. */
  speed?: number;
  load?: number;
  colPlan?: ColPlan | null;
}

export const TC: TCStore = { status: null, onStatus: [], onGlobe: [], onMain: [], ws: null, interacting: 0 };
