// Run from TYPESCRIPT/: node --test --experimental-strip-types globe/src/math.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capRing,
  dayOfYear,
  destination,
  equirect,
  fmtN,
  greatCircleDeg,
  liftControl,
  mix,
  nearX,
  nightFraction,
  nightRGBA,
  orthographic,
  pairMidpoint,
  paintNightBuffer,
  parseClockHour,
  quadAt,
  radiusFor,
  rotationAt,
  solarAltitude,
  starField,
  streakColor,
  sunPosition,
  tkey,
  toRim,
  unwrapXs,
  useColor,
} from './math.ts';
import { aggregateContinents } from './continents.ts';
import type { GlobeNode } from './types.ts';

const close = (a: number, b: number, eps = 1e-9, msg?: string): void => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b}`);

test('orthographic: centre, poles, back side', () => {
  const c = orthographic(0, 0, 0, 0);
  close(c.x, 0);
  close(c.y, 0);
  close(c.z, 1);
  const n = orthographic(90, 0, 0, 0);
  close(n.y, 1);
  close(n.z, 0, 1e-12);
  const back = orthographic(0, 180, 0, 0);
  close(back.z, -1);
  const east = orthographic(0, 90, 0, 0);
  close(east.x, 1);
  // Rotation adds to longitude.
  const r = orthographic(10, 20, 30, 0),
    r2 = orthographic(10, 50, 0, 0);
  close(r.x, r2.x);
  close(r.y, r2.y);
  close(r.z, r2.z);
});

test('orthographic: always on the unit sphere, tilt included', () => {
  for (const [la, lo, rot, ti] of [
    [45, 10, 0, -18],
    [-60, 170, 33, 40],
    [0, -90, -200, 85],
  ] as const) {
    const p = orthographic(la, lo, rot, ti);
    close(p.x * p.x + p.y * p.y + p.z * p.z, 1, 1e-12);
  }
  // Tilt = latitude centres that latitude (focusTrunk relies on it), so positive
  // tilt shows the north and the default -18 shows more of the south. The Rust
  // doc ("negative looks slightly down on the globe") reads the other way.
  assert.ok(orthographic(90, 0, 0, 18).z > 0);
  assert.ok(orthographic(90, 0, 0, -18).z < 0);
  const c = orthographic(40, -25, 25, 40);
  close(c.x, 0, 1e-12);
  close(c.y, 0, 1e-12);
  close(c.z, 1, 1e-12);
});

test('equirect: wrap into [-1, 1)', () => {
  assert.deepEqual(equirect(0, 0, 0), { u: 0, v: 0 });
  assert.deepEqual(equirect(45, 90, 0), { u: 0.5, v: 0.5 });
  close(equirect(0, 180, 0).u, -1);
  close(equirect(0, 170, 20).u, equirect(0, -170, 0).u);
  close(equirect(-90, 0, 0).v, -1);
});

test('rotationAt keeps JS % semantics', () => {
  close(rotationAt(100, 2.5, 0), 250);
  close(rotationAt(200, 2.5, 0), 140);
  close(rotationAt(0, 2.5, -400), -40);
});

test('radiusFor and map width', () => {
  close(radiusFor('globe', 1000, 800, 1), 352);
  close(radiusFor('map', 1900, 950, 2), Math.min(1900 / 3.8, (950 / 1.9) * 0.96) * 2);
});

test('nearX picks the nearest copy', () => {
  assert.equal(nearX(0, 90, 100), -10);
  assert.equal(nearX(0, -90, 100), 10);
  assert.equal(nearX(0, 40, 100), 40);
  assert.equal(nearX(0, 260, 100), -40);
  assert.deepEqual(unwrapXs([90, -90, -80, 85], 200), [90, 110, 120, 85]);
});

test('liftControl: map lifts straight up, globe pushes out', () => {
  const m = liftControl('map', { x: 0, y: 0 }, { x: 100, y: 0 }, 1.12, 0, 0, 1000);
  assert.deepEqual(m, { x: 50, y: -35 });
  const capped = liftControl('map', { x: 0, y: 0 }, { x: 1000, y: 0 }, 1.12, 0, 0, 100);
  assert.deepEqual(capped, { x: 500, y: -50 });
  const g = liftControl('globe', { x: 10, y: 0 }, { x: 10, y: 0 }, 1.12, 0, 0, 100);
  close(g.x, 112);
  close(g.y, 0);
});

test('quadAt endpoints and midpoint', () => {
  const p = { x: 0, y: 0 },
    c = { x: 50, y: -100 },
    q = { x: 100, y: 0 };
  assert.deepEqual(quadAt(p, c, q, 0), p);
  assert.deepEqual(quadAt(p, c, q, 1), q);
  assert.deepEqual(quadAt(p, c, q, 0.5), { x: 50, y: -50 });
});

test('toRim lands on the circle', () => {
  const r = toRim(3, 4, 0, 0, 10);
  close(r.x, 6);
  close(r.y, 8);
  assert.deepEqual(toRim(0, 0, 0, 0, 10), { x: 0, y: 0 });
});

test('great circle: destination and capRing radius', () => {
  close(greatCircleDeg(0, 0, 0, 90), 90, 1e-9);
  close(greatCircleDeg(0, 0, 90, 0), 90, 1e-9);
  close(greatCircleDeg(51.5, 0, 51.5, 0), 0);
  const [la, lo] = destination(0, 0, 0, 30);
  close(la, 30, 1e-9);
  close(lo, 0, 1e-9);
  for (const [lat0, lon0, rho] of [
    [23, -45, 90],
    [-10, 170, 78],
    [60, 30, 12],
  ] as const) {
    const ring = capRing(lat0, lon0, rho);
    assert.equal(ring.length, 97);
    for (const [a, b] of ring) close(greatCircleDeg(lat0, lon0, a, b), rho, 1e-6);
  }
});

test('sun: sub-solar longitude follows UTC, declination follows the season', () => {
  close(sunPosition(80, 12).lon, 0);
  close(sunPosition(80, 18).lon, -90);
  close(sunPosition(80, 6).lon, 90);
  close(sunPosition(80, 0).lon, -180);
  close(sunPosition(172, 12).lat, 23.43, 0.02); // June solstice
  close(sunPosition(355, 12).lat, -23.44, 0.02); // December solstice
  assert.equal(dayOfYear(Date.UTC(2026, 0, 1, 12)), 1);
  assert.equal(dayOfYear(Date.UTC(2026, 11, 31, 23)), 365);
});

test('terminator: altitude, twilight band and pixels', () => {
  close(solarAltitude(20, 0, 20), 90, 1e-9);
  close(solarAltitude(0, 90, 0), 0, 1e-9);
  close(solarAltitude(0, 180, 0), -90, 1e-9);
  assert.equal(nightFraction(30), 0);
  assert.equal(nightFraction(1), 0);
  assert.equal(nightFraction(-12), 1);
  close(nightFraction(-5.5), 0.5);
  assert.deepEqual(nightRGBA(0), [255, 232, 170, 33]);
  assert.deepEqual(nightRGBA(1), [0, 4, 20, 173]);
  const buf = new Uint8ClampedArray(180 * 90 * 4);
  const sun = sunPosition(80, 12);
  paintNightBuffer(buf, sun, 0);
  // Column 90 is lon +1, row 45 is lat -1: daylight. Column 0 is lon -179: night.
  assert.equal(buf[(45 * 180 + 90) * 4 + 3], 33);
  assert.equal(buf[(45 * 180 + 0) * 4 + 3], 173);
});

test('parseClockHour', () => {
  assert.equal(parseClockHour('12:30:00'), 12.5);
  assert.equal(parseClockHour('06:15'), 6.25);
  assert.equal(parseClockHour(''), null);
  assert.equal(parseClockHour('day 3 · 01:00:36 UTC'), 1.01);
});

test('colours and formats', () => {
  assert.equal(useColor(0), 'rgb(42,74,138)');
  assert.equal(useColor(10), 'rgb(90,155,255)');
  assert.equal(useColor(1e9), 'rgb(255,107,107)'); // clamped to the last stop
  assert.equal(mix('#000000', '#ffffff', 0.5), 'rgb(128,128,128)');
  assert.equal(streakColor(0), '#9aa3ad');
  assert.equal(streakColor(4), '#ff8a3d');
  assert.equal(streakColor(30), '#ff4fd8');
  assert.equal(fmtN(999), '999');
  assert.equal(fmtN(1234), '1.2k');
  assert.equal(fmtN(12345), '12k');
  assert.equal(fmtN(1.5e6), '1.5M');
  assert.equal(tkey('b', 'a'), 'a|b');
  assert.equal(tkey('a', 'b'), 'a|b');
});

test('pairMidpoint goes the short way round', () => {
  assert.deepEqual(pairMidpoint({ lat: 0, lon: 170 }, { lat: 10, lon: -170 }), { lat: 5, lon: 180 });
  assert.deepEqual(pairMidpoint({ lat: 0, lon: -10 }, { lat: 0, lon: 30 }), { lat: 0, lon: 10 });
});

test('starField is deterministic', () => {
  assert.deepEqual(starField(3), starField(3));
  assert.equal(starField(160).length, 160);
});

test('continents aggregate: home vs crossing, empty hops ignored', () => {
  const node = (id: string, cont: string, lon = 0): GlobeNode => ({
    id, proto: 'p', protoName: 'P', site: id, fam: 'other', badge: null, lat: 0, lon, live: 1, cont,
    free: 0, cas: 0, ports: 0, since: null, sim: null, load: null, who: [],
  });
  const nodes = [node('a', 'Europe'), node('b', 'Europe'), node('c', 'Asia'), node('d', 'Atlantis', 10)];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trunk = (a: string, b: string) => ({ id: a + b, a, b, used: 2, cap: 8, gain: 0, uses: 1, streak: 0 });
  const call = (hops: Array<[string, string]>) => ({
    id: 'x', who: 'w', why: null, kind: 'direct' as const, muted: false, badge: null, toBadge: null, proto: null,
    from_site: null, to_site: null, hops, gpio: 0, for: '1s', gain: 0,
  });
  const agg = aggregateContinents(
    {
      nodes,
      trunkList: [trunk('a', 'b'), trunk('a', 'c')],
      callList: [call([['a', 'c']]), call([]), call([['a', 'b']])],
      history: [],
    },
    byId,
    () => true,
  );
  const eu = agg.nodes.find((n) => n.name === 'Europe')!;
  assert.equal(eu.frames, 2);
  assert.equal(eu.homeTrunks, 1);
  assert.equal(eu.homeCalls, 1);
  assert.deepEqual([eu.lat, eu.lon], [50, 15]);
  const at = agg.nodes.find((n) => n.name === 'Atlantis')!;
  close(at.lon, 10, 1e-9);
  assert.equal(agg.links.length, 1);
  assert.deepEqual({ ...agg.links[0] }, { a: 'Asia', b: 'Europe', trunks: 1, used: 2, cap: 8, calls: 1, uses: 0 });
});
