// Smoke test: run dist/web-core.js in a bare sandbox the way html.rs page()
// would inline it, and check every global page scripts rely on is there.
// Build first: node --experimental-strip-types web-core/build.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const bundle = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web-core.js');

test('bundle exposes the globals page scripts call by bare name', (t) => {
  if (!existsSync(bundle)) return t.skip('dist/web-core.js not built');
  const listeners: Record<string, Array<() => void>> = {};
  const store = new Map<string, string>([['tc:build', '"old"'], ['tc:status', '{}']]);
  const doc = {
    addEventListener: (ev: string, f: () => void) => (listeners[ev] ??= []).push(f),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    hidden: false,
  };
  const win: Record<string, unknown> = {
    addEventListener: () => {},
    innerWidth: 1400,
  };
  const ctx = vm.createContext({
    window: win,
    document: doc,
    location: { protocol: 'http:', search: '', pathname: '/', host: 'x' },
    localStorage: {
      get length() { return store.size; },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    requestAnimationFrame: () => 0,
    performance: { now: () => 0 },
    URLSearchParams,
  });
  // Exactly what page() emits: the two consts, then the bundle, one script.
  vm.runInContext('const REFRESH_MS=5000;const BUILD="new";\n' + readFileSync(bundle, 'utf8'), ctx);
  for (const k of ['LIVE', 'TC', 'api', 'show', 'num', 'val', 'esc', 'dur', 'reload', 'connect', 'rename', 'cancelBooking', 'gpio', 'setText', 'cacheGet', 'cacheSet', 'predictedHour', 'refreshMain', 'layoutCols']) {
    assert.ok(k in win, 'window.' + k);
  }
  assert.equal(win.LIVE, true);
  assert.equal((win.esc as (s: string) => string)('<'), '&lt;');
  // The build changed: the tc: cache was flushed and the new build stored.
  assert.equal(store.get('tc:build'), '"new"');
  assert.equal(store.has('tc:status'), false);
  // Three DOMContentLoaded handlers, as in the original.
  assert.equal(listeners['DOMContentLoaded']?.length, 3);
  assert.equal(listeners['visibilitychange']?.length, 1);
});
