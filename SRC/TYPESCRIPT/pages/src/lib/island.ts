// Data islands: the server writes `<script type="application/json" id="…">`
// instead of splicing values into JS (`window.X = {rust value}`). During the
// transition each reader falls back to the legacy window global, so a page
// works with either the old or the new Rust.

/** Parse a JSON data island; undefined when absent or malformed. */
export function readIsland<T>(id: string): T | undefined {
  const el = document.getElementById(id);
  if (!el || el.getAttribute('type') !== 'application/json') return undefined;
  try {
    return JSON.parse(el.textContent ?? '') as T;
  } catch {
    return undefined;
  }
}

/** The island if present, else the legacy global the Rust used to inject. */
export function island<T>(id: string, legacy: T | undefined): T | undefined {
  const v = readIsland<T>(id);
  return v === undefined ? legacy : v;
}

/** Island ids, one place, so the Rust side and the TS side agree. */
export const ISLANDS = {
  lights0: 'tc-lights0',
  relayThreshold: 'tc-relay-threshold',
  relayMatrices: 'tc-relay-matrices',
  relayBound: 'tc-relay-bound',
} as const;
