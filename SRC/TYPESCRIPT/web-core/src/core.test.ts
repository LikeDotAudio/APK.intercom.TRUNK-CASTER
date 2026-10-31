// Pure-function tests, plus a parity check against the original JS pulled
// out of RUST-RUNTIME/src/html.rs. Run from TYPESCRIPT/:
//   node --test --experimental-strip-types web-core/src/core.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// env.ts reads `location` at import: stub it before loading modules that need it.
(globalThis as Record<string, unknown>).location = { protocol: 'http:', search: '', pathname: '/' };

const util = await import('./util.ts');
const day = await import('./daystrip.ts');
const layout = await import('./layout.ts');
const topics = await import('./topics.ts');
const actions = await import('./actions.ts');

/** The original JS const, or null when html.rs is not where we expect. */
function originalJs(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const rs = readFileSync(join(here, '..', '..', '..', 'RUST-RUNTIME', 'src', 'html.rs'), 'utf8').replace(/\r\n/g, '\n');
    const m = /\nconst JS: &str = r#"\n([\s\S]*?)\n"#;/.exec(rs);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Evaluate the named one-line declarations of the original in a sandbox. */
function originalFns(names: string[]): Record<string, (...a: unknown[]) => unknown> | null {
  const js = originalJs();
  if (!js) return null;
  const lines = js.split('\n').filter((l) => names.some((n) => l.startsWith('function ' + n + '(') || l.startsWith('const ' + n + ' =')));
  const ctx = vm.createContext({ location: { pathname: '/' } });
  vm.runInContext(lines.join('\n') + '\n;globalThis.__out={' + names.join(',') + '}', ctx);
  return (ctx as { __out: Record<string, (...a: unknown[]) => unknown> }).__out;
}

test('esc escapes & < > " but not single quotes; null -> empty', () => {
  assert.equal(util.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;\'&lt;/a&gt;');
  assert.equal(util.esc(null), '');
  assert.equal(util.esc(undefined), '');
  assert.equal(util.esc(0), '0');
});

test('dur formats', () => {
  assert.equal(util.dur(-5), '0s');
  assert.equal(util.dur(59.9), '59s');
  assert.equal(util.dur(187), '3m 07s');
  assert.equal(util.dur(7500), '2h 05m');
});

test('fmtH wraps and rounds', () => {
  assert.equal(util.fmtH(0), '00:00:00');
  assert.equal(util.fmtH(25.5), '01:30:00');
  assert.equal(util.fmtH(-1), '23:00:00');
  assert.equal(util.fmtH(23.99999), '00:00:00');
});

test('parity with the original esc/dur/fmtH/topicPath', (t) => {
  const o = originalFns(['esc', 'dur', 'fmtH', 'topicPath']);
  if (!o) return t.skip('html.rs JS const not found');
  for (const s of ['', 'a<b>"c"&\'d', null, undefined, 42, '🎙️ <x>']) assert.equal(util.esc(s), o.esc!(s));
  for (let s = -3; s < 20000; s += 37.3) assert.equal(util.dur(s), o.dur!(s));
  for (let h = -30; h < 50; h += 0.0371) assert.equal(util.fmtH(h), o.fmtH!(h));
  for (const p of ['/', '/globe', '/globe/', '/discovery', '/lights', '/about', '/panels/editor', '/usage', '']) {
    const ctx = vm.createContext({ location: { pathname: p } });
    const js = originalJs()!.split('\n').find((l) => l.startsWith('function topicPath('))!;
    const orig = vm.runInContext(js + ';topicPath()', ctx) as string;
    assert.equal(topics.topicPath(p), orig, p);
  }
});

test('phaseOf boundaries', () => {
  assert.equal(day.phaseOf(4.99), 'night');
  assert.equal(day.phaseOf(5), 'dawn');
  assert.equal(day.phaseOf(8), 'day');
  assert.equal(day.phaseOf(17), 'dusk');
  assert.equal(day.phaseOf(20.5), 'night');
});

test('stripX spans the padded strip', () => {
  assert.equal(day.stripX(0), 28);
  assert.equal(day.stripX(24), 28);
  assert.equal(day.stripX(12), 28 + 0.5 * (960 - 40));
});

test('spreadLabels pushes overlapping labels apart and keeps them on the strip', () => {
  const lab = [
    { x: 100, w: 40, p: 100 },
    { x: 105, w: 40, p: 105 },
    { x: 950, w: 60, p: 950 },
  ];
  day.spreadLabels(lab);
  assert.equal(lab[0]!.p, 100);
  assert.equal(lab[1]!.p, 140);
  assert.equal(lab[2]!.p, 930);
});

test('whatIs orders 6 am, noon, 6 pm, midnight and nearest first', () => {
  assert.equal(
    day.whatIs({ 0: [[0.2, 'Tokyo']], 6: [], 12: [[1, 'B'], [0.1, 'A']], 18: [] }),
    'noon in A and B · midnight in Tokyo',
  );
  assert.equal(day.whatIs({ 0: [], 6: [], 12: [], 18: [] }), 'no clock within 90 minutes of 6 am, noon or 6 pm');
});

test('quadShape and quadCells fill exactly n cells for 4..8 sections', () => {
  for (let n = 1; n <= 12; n++) {
    const { C, T } = layout.quadShape(n);
    const tall = new Set(Array.from({ length: T }, (_, k) => k));
    const { cells } = layout.quadCells(C, tall, n);
    const expect = n >= 8 ? 8 : n;
    assert.equal(cells.length, expect, 'n=' + n);
  }
});

test('tracks clamps and joins with 5px sashes', () => {
  assert.equal(layout.tracks([1, 0, 2]), '1.000fr 5px 0.050fr 5px 2.000fr');
});

test('topBottom: bottom skips zeros only when more than TOPN are non-zero', () => {
  const t = { label: 'L', metric: 'm', colour: '#000', ink: '#fff', items: [['a', 9], ['b', 8], ['c', 7], ['d', 6], ['e', 5], ['f', 4], ['z', 0]] as [string, number][] };
  const { top, bottom } = topics.topBottom(t);
  assert.deepEqual(top.map((i) => i[0]), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(bottom.map((i) => i[0]), ['f', 'e', 'd', 'c', 'b']);
  const few = { ...t, items: t.items.slice(4) };
  assert.deepEqual(topics.topBottom(few).bottom.map((i) => i[0]), ['z', 'f', 'e']);
});

test('topicChart escapes names and scales bars to the max', () => {
  const t = { label: 'Globe', metric: 'calls <x>', colour: '#7b4a26', ink: '#fff', items: [] };
  const h = topics.topicChart(t, [['<b>', 2], ['y', 1]], 'top');
  assert.match(h, /&lt;b&gt;/);
  assert.match(h, /width:100\.0%/);
  assert.match(h, /width:50\.0%/);
  assert.match(h, /calls &lt;x&gt;/);
  assert.match(topics.topicChart(t, [], 'bottom'), /nothing yet/);
});

test('gpioSummary matches the original alert text', () => {
  assert.equal(actions.gpioSummary('plain'), 'plain');
  assert.equal(actions.gpioSummary({ error: 'no such connection' }), 'no such connection');
  const ev = { seq: 1, at: '', connection: 'c1', who: 'w', pin: 2, state: true, from_frame: 'a', to_frame: 'b', path: [], trunks: ['t1', 't2'], function: 'check-lights' as const, result: { a: 1 } };
  assert.equal(actions.gpioSummary(ev), 'pin 2 check-lights via t1,t2\n{\n "a": 1\n}');
});

test('html.rs JS const unchanged since this port (source-snapshot.js.txt)', (t) => {
  const js = originalJs();
  if (!js) return t.skip('html.rs JS const not found');
  const here = dirname(fileURLToPath(import.meta.url));
  const snap = readFileSync(join(here, '..', 'source-snapshot.js.txt'), 'utf8').replace(/\r\n/g, '\n');
  const body = /^const JS: &str = r#"\n([\s\S]*?)\n"#;/.exec(snap)?.[1];
  // Drift is a TODO, not a failure: another session edits html.rs; re-port the diff.
  if (body !== js) t.todo('JS const drifted from source-snapshot.js.txt: re-port the diff before wiring');
});
