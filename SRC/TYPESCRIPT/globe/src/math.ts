// Pure math of the map engine: projections, the sun, small circles, arcs and
// the colour ramps. No DOM, no globals; unit-tested in math.test.ts.
// Every formula is lifted verbatim from GLOBE_JS (html.rs) so the port draws
// the same pixels.

export const DEG = Math.PI / 180;
/** GLOBE_JS writes a full turn as 6.283 in arc() calls; kept for pixel parity. */
export const TURN = 6.283;

export interface XY {
  x: number;
  y: number;
}
export interface XYZ extends XY {
  /** Depth: > 0 faces the viewer on the globe; always 1 on the flat map. */
  z: number;
}

/** Rotation in degrees at time `t` (seconds): `(t*speed + dragOff) % 360`. JS `%`, so it can be negative. */
export function rotationAt(tSec: number, speedDegPerS: number, dragOff: number): number {
  return (tSec * speedDegPerS + dragOff) % 360;
}

/**
 * Equirectangular, unit form. `u` in [-1, 1) is longitude/180 after turning by
 * `rot`; `v` is latitude/90. The screen map is `x = CX + u*R*1.9`, `y = CY - v*R*0.95`.
 */
export function equirect(lat: number, lon: number, rot: number): { u: number; v: number } {
  const lo = ((lon + rot + 540) % 360) - 180;
  return { u: lo / 180, v: lat / 90 };
}

/**
 * Orthographic on the unit sphere, turned by `rot` about the pole and tilted
 * by `tilt` about the screen x-axis. y is up; z > 0 faces the viewer.
 */
export function orthographic(lat: number, lon: number, rot: number, tilt: number): XYZ {
  const la = lat * DEG,
    lo = (lon + rot) * DEG,
    ti = tilt * DEG;
  const x = Math.cos(la) * Math.sin(lo),
    y = Math.sin(la),
    z = Math.cos(la) * Math.cos(lo);
  const y2 = y * Math.cos(ti) - z * Math.sin(ti),
    z2 = y * Math.sin(ti) + z * Math.cos(ti);
  return { x, y: y2, z: z2 };
}

/** The flat map's width for a radius: `R*3.8`. */
export const mapWidth = (r: number): number => r * 3.8;

/** Pixel radius: map fits 3.8R × 1.9R in the pane, the globe takes 44% of the short side. */
export function radiusFor(projection: 'globe' | 'map', paneW: number, h: number, zoom: number): number {
  return (projection === 'map' ? Math.min(paneW / 3.8, (h / 1.9) * 0.96) : Math.min(paneW, h) * 0.44) * zoom;
}

/** The x of q's copy nearest p on a map that repeats every `w` pixels. */
export function nearX(px: number, qx: number, w: number): number {
  let x = qx;
  while (x - px > w / 2) x -= w;
  while (px - x > w / 2) x += w;
  return x;
}

/** Unwrap a ring's x coordinates so no step jumps more than half a world (map land). */
export function unwrapXs(xs: readonly number[], w: number): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (const x0 of xs) {
    let x = x0;
    if (prev !== null) {
      while (x - prev > w / 2) x -= w;
      while (prev - x > w / 2) x += w;
    }
    out.push(x);
    prev = x;
  }
  return out;
}

/**
 * Control point that lifts a chord into an arc. On the map: straight up by
 * min(0.35·chord, R/2). On the globe: pushed out from the centre to at least
 * `amount·R` (and 1.08× the midpoint's distance).
 */
export function liftControl(projection: 'globe' | 'map', p: XY, q: XY, amount: number, cx: number, cy: number, r: number): XY {
  const mx = (p.x + q.x) / 2,
    my = (p.y + q.y) / 2;
  if (projection === 'map') {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    return { x: mx, y: my - Math.min(0.35 * d, r * 0.5) };
  }
  const dx = mx - cx,
    dy = my - cy,
    d = Math.hypot(dx, dy) || 1;
  const k = Math.max(amount * r, d * 1.08);
  return { x: cx + (dx / d) * k, y: cy + (dy / d) * k };
}

/** Quadratic Bézier at u. */
export function quadAt(p: XY, c: XY, q: XY, u: number): XY {
  const v = 1 - u;
  return { x: v * v * p.x + 2 * v * u * c.x + u * u * q.x, y: v * v * p.y + 2 * v * u * c.y + u * u * q.y };
}

/** Push a back-side point out to the rim so a shape turning away closes along the horizon. */
export function toRim(x: number, y: number, cx: number, cy: number, r: number): XY {
  const dx = x - cx,
    dy = y - cy,
    d = Math.hypot(dx, dy) || 1;
  return { x: cx + (dx / d) * r, y: cy + (dy / d) * r };
}

/**
 * The point `distDeg` of great circle from (lat, lon) along `bearingRad`
 * (measured as capRing measures it: atan2(sinθ·sinρ·cosφ, …)). Degrees out.
 */
export function destination(latDeg: number, lonDeg: number, bearingRad: number, distDeg: number): [lat: number, lon: number] {
  const p1 = latDeg * DEG,
    l1 = lonDeg * DEG,
    r = distDeg * DEG,
    th = bearingRad;
  const la = Math.asin(Math.sin(p1) * Math.cos(r) + Math.cos(p1) * Math.sin(r) * Math.cos(th));
  const lo = l1 + Math.atan2(Math.sin(th) * Math.sin(r) * Math.cos(p1), Math.cos(r) - Math.sin(p1) * Math.sin(la));
  return [la / DEG, lo / DEG];
}

/** A small circle of angular radius `rho` about (lat0, lon0): 97 points, closed. */
export function capRing(lat0: number, lon0: number, rho: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 96; i++) pts.push(destination(lat0, lon0, (i / 96) * 2 * Math.PI, rho));
  return pts;
}

/** Great-circle angle between two points, degrees (haversine). */
export function greatCircleDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG,
    p2 = lat2 * DEG,
    dp = p2 - p1,
    dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / DEG;
}

/** Day of year as GLOBE_JS counts it: days since 0 Jan UTC, so 1 Jan = 1. */
export function dayOfYear(nowMs: number): number {
  const y = new Date(nowMs).getUTCFullYear();
  return Math.floor((nowMs - Date.UTC(y, 0, 0)) / 864e5);
}

/** "HH:MM" or "HH:MM:SS" anywhere in the string → fractional hours, else null. */
export function parseClockHour(clock: string): number | null {
  const m = /(\d+):(\d+)(?::(\d+))?/.exec(clock || '');
  if (!m) return null;
  return +(m[1] ?? 0) + +(m[2] ?? 0) / 60 + +(m[3] || 0) / 3600;
}

/** Sub-solar point: declination by a cosine of the day, longitude from UTC hour. */
export function sunPosition(doy: number, utcHour: number): { lat: number; lon: number } {
  return {
    lat: -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10)),
    lon: ((((-(utcHour - 12) * 15) % 360) + 540) % 360) - 180,
  };
}

/** Solar altitude in degrees at latitude `latDeg`, hour angle `hourAngleDeg`, sun declination `decDeg`. */
export function solarAltitude(latDeg: number, hourAngleDeg: number, decDeg: number): number {
  const d = decDeg * DEG,
    la = latDeg * DEG;
  const v = Math.sin(la) * Math.sin(d) + Math.cos(la) * Math.cos(d) * Math.cos(hourAngleDeg * DEG);
  return Math.asin(Math.max(-1, Math.min(1, v))) / DEG;
}

/** Night fraction: 0 above +1° altitude, 1 below −12°, smoothstep between. */
export function nightFraction(altDeg: number): number {
  let f = Math.max(0, Math.min(1, (1 - altDeg) / 13));
  return f * f * (3 - 2 * f);
}

/** RGBA of one terminator pixel for a night fraction: warm day wash to blue-black. */
export function nightRGBA(f: number): [number, number, number, number] {
  return [Math.round(255 - 255 * f), Math.round(232 - 228 * f), Math.round(170 - 150 * f), Math.round(255 * (0.13 + 0.55 * f))];
}

/**
 * Fill a 180×90 RGBA buffer (2° per pixel) with the terminator as the map
 * sits on screen: column i is screen longitude −179+2i, already turned by `rot`.
 */
export function paintNightBuffer(out: Uint8ClampedArray, sun: { lat: number; lon: number }, rot: number): void {
  const d = sun.lat * DEG,
    sd = Math.sin(d),
    cd = Math.cos(d);
  for (let j = 0; j < 90; j++) {
    const la = (89 - j * 2) * DEG,
      a = Math.sin(la) * sd,
      b = Math.cos(la) * cd;
    for (let i = 0; i < 180; i++) {
      const H = (-179 + i * 2 - rot - sun.lon) * DEG;
      const alt = (Math.asin(Math.max(-1, Math.min(1, a + b * Math.cos(H)))) * 180) / Math.PI;
      const [r, g, bl, al] = nightRGBA(nightFraction(alt));
      const k = (j * 180 + i) * 4;
      out[k] = r;
      out[k + 1] = g;
      out[k + 2] = bl;
      out[k + 3] = al;
    }
  }
}

/** Order-free key for a frame pair. */
export const tkey = (a: string, b: string): string => (a <= b ? a + '|' + b : b + '|' + a);

/** "#rrggbb" → [r, g, b]. */
export const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Linear mix of two hex colours → "rgb(r,g,b)". */
export function mix(a: string, b: string, f: number): string {
  const x = hex(a),
    y = hex(b);
  return 'rgb(' + x.map((v, i) => Math.round(v + ((y[i] ?? 0) - v) * f)).join(',') + ')';
}

const USE_STOPS: ReadonlyArray<readonly [number, string]> = [
  [0, '#2a4a8a'],
  [1, '#5a9bff'],
  [2, '#2bb3c0'],
  [3, '#3fb950'],
  [4, '#f6c343'],
  [5, '#ff6b6b'],
];
/** Colour for a use count on a log10 ramp, 1 … 100k. */
export function useColor(n: number | null | undefined): string {
  const v = Math.max(0, Math.min(5, Math.log10(Math.max(1, n || 0))));
  for (let i = 1; i < USE_STOPS.length; i++) {
    const hi = USE_STOPS[i]!;
    if (v <= hi[0]) {
      const lo = USE_STOPS[i - 1]!;
      return mix(lo[1], hi[1], (v - lo[0]) / (hi[0] - lo[0]));
    }
  }
  return USE_STOPS[USE_STOPS.length - 1]![1];
}

const STREAK_STOPS: ReadonlyArray<readonly [number, string]> = [
  [1, '#f6c343'],
  [2, '#e3a35a'],
  [3, '#ff8a3d'],
  [5, '#ff6b6b'],
  [7, '#ff4fd8'],
];
/** Colour for days-in-a-row locked; grey below 1. */
export function streakColor(s: number | null | undefined): string {
  if (!s || s < 1) return '#9aa3ad';
  let c = STREAK_STOPS[0]![1];
  for (const [k, v] of STREAK_STOPS) if (s >= k) c = v;
  return c;
}

/** 1234 → "1.2k", 12345 → "12k", 1.5e6 → "1.5M". */
export const fmtN = (n: number): string =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

const FAMILY_COLOURS: Readonly<Record<string, string>> = {
  'analog-audio': '#f6c343',
  'audio-over-ip': '#5a9bff',
  telephony: '#3fb950',
  control: '#e3a35a',
  wireless: '#b48cff',
  'media-transport': '#ff6b6b',
};
export const famColor = (f: string): string => FAMILY_COLOURS[f] || '#9aa3ad';

/** Park–Miller PRNG seeded at 7: the star field is the same on every page. */
export function starField(count: number): Array<{ x: number; y: number; r: number; p: number }> {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: count }, () => ({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 1.3, p: rnd() * 6 }));
}

/** focusTrunk: the midpoint the view turns to, the short way round the date line. */
export function pairMidpoint(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { lat: number; lon: number } {
  let dl = b.lon - a.lon;
  if (dl > 180) dl -= 360;
  if (dl < -180) dl += 360;
  return { lat: (a.lat + b.lat) / 2, lon: a.lon + dl / 2 };
}

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
