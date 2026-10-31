// The built-in layers, in GLOBE_JS draw order:
//   (base: sea, land) → sun → grid → trunks → ports → frames → calls → hub → continents → labels
// Each block is the matching slice of GLOBE_JS scene()/frame(), unchanged.

import { aggregateContinents, type ContinentAgg } from './continents.ts';
import { defineChips, registerLayer, type Engine, type Layer, type PaneSpec, type Scene, type TrunkRec, type ArcMid } from './layer.ts';
import {
  capRing,
  dayOfYear,
  famColor,
  paintNightBuffer,
  parseClockHour,
  quadAt,
  streakColor,
  sunPosition,
  tkey,
  toRim,
  TURN,
  useColor,
  type XYZ,
} from './math.ts';
import type { ClusterTier, GlobeNode, LiveTrunk } from './types.ts';

// ---------------------------------------------------------------- base

/** Sea disc or rectangle (and the globe's rim). Always drawn. */
export function drawSea(g: Engine): void {
  const { ctx, view: v } = g;
  ctx.fillStyle = '#0e1a33';
  ctx.strokeStyle = '#2a3a60';
  ctx.lineWidth = 1.5;
  if (v.projection === 'map') {
    ctx.beginPath();
    ctx.rect(v.CX() - v.R() * 1.9, v.CY() - v.R() * 0.95, v.R() * 3.8, v.R() * 1.9);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(v.CX(), v.CY(), v.R(), 0, TURN);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * The land. On the globe, points round the back are pushed out to the
 * horizon so a coast that turns away closes along the rim. On the map a coast
 * that crosses the date line is unwrapped and drawn again a world-width over.
 */
export function drawLand(g: Engine): void {
  const { ctx, view: v, land } = g;
  ctx.save();
  ctx.fillStyle = '#29446f';
  ctx.strokeStyle = '#6a8cc4';
  ctx.lineWidth = 0.8;
  ctx.lineJoin = 'round';
  const cx = v.CX(),
    cy = v.CY(),
    r = v.R();
  if (v.projection === 'map') {
    const w = r * 3.8,
      x0 = cx - r * 1.9;
    ctx.beginPath();
    ctx.rect(x0, cy - r * 0.95, w, r * 1.9);
    ctx.clip();
    for (const ring of land) {
      const xs: number[] = [],
        ys: number[] = [];
      let prev: number | null = null,
        lo = Infinity,
        hi = -Infinity;
      for (let i = 0; i + 1 < ring.length; i += 2) {
        const p = v.proj(ring[i + 1]!, ring[i]!);
        let x = p.x;
        if (prev !== null) {
          while (x - prev > w / 2) x -= w;
          while (prev - x > w / 2) x += w;
        }
        xs.push(x);
        ys.push(p.y);
        prev = x;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      for (const shift of [0, w, -w]) {
        if (shift && !(lo + shift < x0 + w && hi + shift > x0)) continue;
        ctx.beginPath();
        for (let i = 0; i < xs.length; i++) {
          if (i) ctx.lineTo(xs[i]! + shift, ys[i]!);
          else ctx.moveTo(xs[i]! + shift, ys[i]!);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  } else {
    for (const ring of land) {
      let seen = false;
      ctx.beginPath();
      for (let i = 0; i + 1 < ring.length; i += 2) {
        const p = v.proj(ring[i + 1]!, ring[i]!);
        let x = p.x,
          y = p.y;
        if (p.z > 0) seen = true;
        else ({ x, y } = toRim(x, y, cx, cy, r));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      if (!seen) continue;
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- sun

/** UTC hour: the shared client's prediction, else the data clock, else the wall clock. */
export function utcHour(clock: string): number {
  const h = typeof predictedHour === 'function' ? predictedHour() : null;
  if (h != null) return h;
  const c = parseClockHour(clock);
  if (c !== null) return c;
  const d = new Date();
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

/**
 * Sunlight: the sun from the simulated UTC clock and today's declination.
 * NOTE (finding): the hour is simulated but the declination uses the
 * wall-clock date, so the season never follows the simulated calendar.
 */
export class SunLayer implements Layer {
  readonly key = 'sun';
  private sun: { lat: number; lon: number } | null = null;
  private readonly night: HTMLCanvasElement;
  private readonly nctx: CanvasRenderingContext2D | null;
  private readonly nimg: ImageData | null;
  constructor() {
    this.night = document.createElement('canvas');
    this.night.width = 180;
    this.night.height = 90;
    this.nctx = this.night.getContext('2d');
    this.nimg = this.nctx ? this.nctx.createImageData(180, 90) : null;
  }
  prepare(g: Engine, pane: PaneSpec): void {
    this.sun = sunPosition(dayOfYear(Date.now()), utcHour(g.data.clock || ''));
    // One pixel per 2° of the map as it sits on screen (already turned by rot()).
    if (pane.p === 'map' && this.nctx && this.nimg) {
      paintNightBuffer(this.nimg.data, this.sun, g.view.rot());
      this.nctx.putImageData(this.nimg, 0, 0);
    }
  }
  draw(s: Scene): void {
    const sun = this.sun;
    if (!sun) return;
    if (s.g.view.projection === 'map') this.drawMap(s, sun);
    else this.drawGlobe(s, sun);
  }
  private drawMap({ ctx, g }: Scene, sun: { lat: number; lon: number }): void {
    const v = g.view,
      r = v.R(),
      w = v.mapW(),
      h = r * 1.9,
      x0 = v.CX() - w / 2,
      y0 = v.CY() - h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.night, x0, y0, w, h);
    const p = v.proj(sun.lat, sun.lon),
      gr = r * 0.3;
    for (const q of [p, { x: p.x - w, y: p.y }, { x: p.x + w, y: p.y }]) {
      const grad = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, gr);
      grad.addColorStop(0, 'rgba(255,214,102,0.30)');
      grad.addColorStop(1, 'rgba(255,214,102,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(q.x, q.y, gr, 0, TURN);
      ctx.fill();
    }
    ctx.fillStyle = '#ffd666';
    ctx.strokeStyle = 'rgba(255,214,102,.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, TURN);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, TURN);
    ctx.stroke();
    ctx.restore();
  }
  /** Night on the round globe: the dark cap opposite the sun in three steps. */
  private drawGlobe({ ctx, g }: Scene, sun: { lat: number; lon: number }): void {
    const v = g.view,
      cx = v.CX(),
      cy = v.CY(),
      r = v.R(),
      alat = -sun.lat,
      alon = sun.lon + 180;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TURN);
    ctx.clip();
    for (const [rho, al] of [
      [90, 0.22],
      [84, 0.2],
      [78, 0.24],
    ] as const) {
      let seen = false;
      ctx.beginPath();
      capRing(alat, alon, rho).forEach(([la, lo], i) => {
        const p = v.proj(la, lo);
        let x = p.x,
          y = p.y;
        if (p.z > 0) seen = true;
        else ({ x, y } = toRim(x, y, cx, cy, r));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (!seen) continue;
      ctx.closePath();
      ctx.fillStyle = 'rgba(2,5,20,' + al + ')';
      ctx.fill();
    }
    const p = v.proj(sun.lat, sun.lon);
    if (p.z > 0) {
      const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 0.35);
      gr.addColorStop(0, 'rgba(255,214,102,0.28)');
      gr.addColorStop(1, 'rgba(255,214,102,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.35, 0, TURN);
      ctx.fill();
      ctx.fillStyle = '#ffd666';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, TURN);
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- graticule

export const gridLayer: Layer = {
  key: 'grid',
  draw({ ctx, g }) {
    const v = g.view;
    const step = Math.max(10, g.cfg().graticule_deg || 30);
    ctx.lineWidth = 0.6;
    for (let lo = -180; lo < 180; lo += step) {
      ctx.beginPath();
      let pen = false;
      for (let s = 0; s <= 72; s++) {
        const p = v.proj(-90 + (180 * s) / 72, lo);
        if (p.z > 0.02) {
          if (pen) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
          pen = true;
        } else pen = false;
      }
      ctx.stroke();
    }
    for (let la = -90 + step; la < 90; la += step) {
      ctx.beginPath();
      ctx.strokeStyle = la === 0 ? '#3b4f80' : '#2a3a60';
      ctx.lineWidth = la === 0 ? 1 : 0.6;
      let pen = false,
        last: XYZ | null = null;
      for (let s = 0; s <= 144; s++) {
        const p = v.proj(la, -180 + (360 * s) / 144);
        if (p.z > 0.02 && !(v.projection === 'map' && last && Math.abs(p.x - last.x) > v.R())) {
          if (pen) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
          pen = true;
        } else pen = false;
        last = p;
      }
      ctx.stroke();
    }
  },
};

// ---------------------------------------------------------------- trunks

/**
 * Every trunk that ever carried a call, coloured by how many times it was
 * used (or, in the trend view, by days running it was locked an hour or
 * more). Live trunks are bright. Records hit-test arcs into g.hits.arcs.
 */
export const trunksLayer: Layer = {
  key: 'trunks',
  draw({ ctx, g, t, pos }) {
    const v = g.view,
      data = g.data,
      focus = g.focus;
    const liveKey = new Map<string, LiveTrunk>();
    for (const tr of data.trunkList) liveKey.set(tkey(tr.a, tr.b), tr);
    const drawArc = (a: string, b: string, color: string, alpha: number, width: number, rec: TrunkRec | null): ArcMid | null => {
      const p = pos.get(a);
      let q = pos.get(b);
      if (!p || !q) return null;
      const na = g.byId.get(a),
        nb = g.byId.get(b);
      if (na && nb && !g.filter.shown(na) && !g.filter.shown(nb)) return null;
      q = v.near(p, q);
      if (!(p.z > -0.05 || q.z > -0.05)) return null;
      const c = v.lift(p, q, 1.12);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(c.x, c.y, q.x, q.y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha * (p.z > 0 && q.z > 0 ? 1 : 0.35);
      ctx.lineWidth = width;
      ctx.stroke();
      const pts: Array<[number, number]> = [];
      for (let k = 1; k < 10; k++) {
        const pt = quadAt(p, c, q, k / 10);
        pts.push([pt.x, pt.y]);
      }
      const m: ArcMid = { x: 0.25 * p.x + 0.5 * c.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * c.y + 0.25 * q.y, front: p.z > 0 && q.z > 0 };
      if (rec) g.hits.arcs.push({ pts, rec, m });
      return m;
    };
    const pulse = 0.55 + 0.45 * Math.sin(t * 3);
    if (g.colour === 'live') {
      for (const tr of data.trunkList) drawArc(tr.a, tr.b, '#5a9bff', 0.6, 0.7 + tr.used * 0.45, { live: tr, hist: g.histByKey.get(tkey(tr.a, tr.b)) });
    } else if (g.colour === 'trend') {
      let labels = 0;
      for (const h of data.history || []) {
        if (!h.ld) continue;
        const k = tkey(h.a, h.b),
          lv = liveKey.get(k),
          foc = focus === k;
        const m = drawArc(
          h.a,
          h.b,
          foc ? '#ffffff' : streakColor(h.streak || 0.5),
          h.lt ? 0.55 + 0.45 * pulse : h.streak ? 0.75 : 0.35,
          (foc ? 2 : 0) + 1 + Math.min(8, (h.streak || 0) * 0.9) + (lv ? 1 : 0),
          { live: lv, hist: h },
        );
        if (m && m.front && (foc || (h.streak >= 3 && labels < 24))) {
          labels++;
          ctx.globalAlpha = 1;
          ctx.font = '600 11px system-ui';
          ctx.textAlign = 'center';
          const lab = h.streak + ' days';
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#0b1020';
          ctx.strokeText(lab, m.x, m.y - 4);
          ctx.fillStyle = streakColor(h.streak);
          ctx.fillText(lab, m.x, m.y - 4);
        }
      }
      for (const tr of data.trunkList) {
        const h = g.histByKey.get(tkey(tr.a, tr.b));
        if (h && h.ld) continue;
        drawArc(tr.a, tr.b, '#5a9bff', 0.18, 0.7, { live: tr, hist: h });
      }
    } else {
      for (const h of data.history || []) {
        const k = tkey(h.a, h.b);
        if (liveKey.get(k)) continue;
        drawArc(h.a, h.b, focus === k ? '#ffffff' : useColor(h.uses), focus === k ? 1 : 0.22, focus === k ? 2.5 : 0.7, { hist: h });
      }
      for (const tr of data.trunkList) {
        const k = tkey(tr.a, tr.b);
        const h = g.histByKey.get(k);
        const m = drawArc(tr.a, tr.b, focus === k ? '#ffffff' : useColor(tr.uses || (h && h.uses) || 1), 0.9, 1 + tr.used * 0.5 + (focus === k ? 2 : 0), { live: tr, hist: h });
        if (m && m.front && (tr.streak || 0) >= 2) {
          ctx.globalAlpha = 0.5 + 0.5 * pulse;
          ctx.beginPath();
          ctx.arc(m.x, m.y, 4 + Math.min(6, tr.streak), 0, TURN);
          ctx.strokeStyle = streakColor(tr.streak);
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  },
};

// ---------------------------------------------------------------- data ports

/** Each frame to the page's aggregator (only when the page names a hub). */
export const portsLayer: Layer = {
  key: 'ports',
  isOn: (g) => !!g.hub && g.on('ports'),
  draw({ ctx, g, t, pos }) {
    const hub = g.hub;
    if (!hub) return;
    const v = g.view;
    const hp = v.proj(hub.lat, hub.lon);
    const filt = window.GLOBE_FILTER && window.GLOBE_FILTER.size;
    for (const n of g.data.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      if (p.z <= 0 && hp.z <= 0) continue;
      if (!g.filter.shown(n)) continue;
      const hq = v.near(p, hp);
      const c = v.lift(p, hq, 1.04);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(c.x, c.y, hq.x, hq.y);
      if (n.sim === true) {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#3fb950';
        ctx.globalAlpha = filt ? 0.8 : 0.45;
      } else if (n.sim === false) {
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = '#e3a35a';
        ctx.globalAlpha = filt ? 0.9 : 0.6;
      } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#5a9bff';
        ctx.globalAlpha = filt ? 0.45 : 0.12;
      }
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.setLineDash([]);
      if (n.sim === true) {
        const k = (((t * 0.4 + (n.lat + n.lon) * 0.013) % 1) + 1) % 1;
        const pt = quadAt(p, c, hq, k);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#7ee787';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 1.6, 0, TURN);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  },
};

/** The aggregator diamond. Drawn after calls, only while the ports layer is on. */
export const hubLayer: Layer = {
  key: 'hub',
  isOn: (g) => !!g.hub && g.on('ports'),
  draw({ ctx, g }) {
    const hub = g.hub;
    if (!hub) return;
    const hp = g.view.proj(hub.lat, hub.lon);
    if (hp.z <= 0) return;
    const s = 7;
    ctx.beginPath();
    ctx.moveTo(hp.x, hp.y - s);
    ctx.lineTo(hp.x + s, hp.y);
    ctx.lineTo(hp.x, hp.y + s);
    ctx.lineTo(hp.x - s, hp.y);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#5a9bff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '600 12px system-ui';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6edf7';
    ctx.fillText('◆ ' + hub.name + ' aggregator', hp.x + 10, hp.y + 4);
    ctx.textAlign = 'center';
  },
};

// ---------------------------------------------------------------- frames

export const nodeColor = (n: GlobeNode): string => (n.badge && n.badge.color) || famColor(n.fam);

export const framesLayer: Layer = {
  key: 'frames',
  draw({ ctx, g, pos }) {
    for (const n of g.data.nodes) {
      const p = pos.get(n.id);
      if (!p || p.z <= 0 || g.filter.hiddenByUser(n)) continue;
      const r = 3.2 + Math.sqrt(n.live || 0) * 2.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TURN);
      ctx.fillStyle = nodeColor(n);
      ctx.globalAlpha = !g.filter.shown(n) ? 0.1 : n.live > 0 ? 1 : 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (n.live > 0 || g.hover === n.id) {
        ctx.strokeStyle = 'rgba(255,255,255,.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  },
};

// ---------------------------------------------------------------- calls

/** Calls in flight, coloured by the caller's vendor; parked lines dimmer. */
export const callsLayer: Layer = {
  key: 'calls',
  draw({ ctx, g, t, pos }) {
    const v = g.view,
      list = g.data.callList;
    for (let i = 0; i < list.length; i++) {
      const c = list[i]!;
      // Deviation: GLOBE_JS indexed hops[NaN] for a call with no hops and threw, stopping the loop.
      if (!c.hops.length) continue;
      const hop = c.hops[Math.floor((t * 0.25 + i * 0.37) % c.hops.length)]!;
      const p = pos.get(hop[0]);
      let q = pos.get(hop[1]);
      if (!p || !q) continue;
      q = v.near(p, q);
      const first = g.byId.get(c.hops[0]![0]),
        last = g.byId.get(c.hops[c.hops.length - 1]![1]);
      if (first && !g.filter.shown(first) && last && !g.filter.shown(last)) continue;
      if (!(p.z > -0.05 || q.z > -0.05)) continue;
      const u = (t * 0.25 + i * 0.37) % 1;
      const k = v.lift(p, q, 1.12);
      const pt = quadAt(p, k, q, u);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, c.muted ? 2 : 2.8, 0, TURN);
      ctx.fillStyle = (c.badge && c.badge.color) || (c.kind === 'via' ? '#b48cff' : '#fff');
      ctx.globalAlpha = c.muted ? 0.35 : p.z > 0 && q.z > 0 ? 1 : 0.35;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
};

// ---------------------------------------------------------------- continents

/**
 * One bubble per continent, sized by its frames, and an arc to every
 * continent it trunks with (width: trunks up now, colour: times used,
 * dashed when none is up). Records hit-test targets into g.hits.cont.
 */
export class ContinentsLayer implements Layer {
  readonly key = 'continents';
  private cache: ContinentAgg | null = null;
  private cacheKey = '';
  /**
   * Cache key as GLOBE_JS builds it. Finding: it counts hidden protocols and
   * vendors by size only, so swapping one hidden item for another keeps a
   * stale aggregate until the clock ticks (≤2 s later, with the next delta).
   */
  agg(g: Engine): ContinentAgg {
    const d = g.data;
    const key = d.nodes.length + '|' + d.trunkList.length + '|' + d.callList.length + '|' + (d.history || []).length + '|' + d.clock + '|' + g.filter.signature();
    if (this.cache && key === this.cacheKey) return this.cache;
    this.cacheKey = key;
    return (this.cache = aggregateContinents(d, g.byId, (n) => g.filter.shown(n)));
  }
  draw({ ctx, g, t }: Scene): void {
    const v = g.view;
    const gg = this.agg(g),
      maxT = Math.max(1, ...gg.links.map((l) => l.trunks)),
      maxF = Math.max(1, ...gg.nodes.map((n) => n.frames));
    const P = new Map<string, XYZ>();
    for (const c of gg.nodes) P.set(c.name, v.proj(c.lat, c.lon));
    ctx.lineCap = 'round';
    for (const l of gg.links.slice().sort((x, y) => x.trunks - y.trunks)) {
      const p = P.get(l.a);
      let q = P.get(l.b);
      if (!p || !q) continue;
      q = v.near(p, q);
      if (!(p.z > -0.05 || q.z > -0.05)) continue;
      const c = v.lift(p, q, 1.25),
        w = l.trunks ? 1.5 + 7 * Math.sqrt(l.trunks / maxT) : 1,
        front = p.z > 0 && q.z > 0;
      ctx.globalAlpha = front ? 0.9 : 0.3;
      ctx.strokeStyle = l.trunks ? useColor(l.uses || l.trunks) : '#5a6b8f';
      ctx.lineWidth = w;
      if (!l.trunks) ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(c.x, c.y, q.x, q.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const n = Math.min(12, l.calls);
      for (let k = 0; k < n; k++) {
        let u = (t * 0.18 + k / n) % 1;
        if (k % 2) u = 1 - u;
        const pt = quadAt(p, c, q, u);
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.4, 0, TURN);
        ctx.fill();
      }
      const mx = 0.25 * p.x + 0.5 * c.x + 0.25 * q.x,
        my = 0.25 * p.y + 0.5 * c.y + 0.25 * q.y;
      if (front) {
        const lab = (l.trunks ? l.trunks + ' trunk' + (l.trunks > 1 ? 's' : '') : 'idle') + (l.calls ? ' · ' + l.calls + ' call' + (l.calls > 1 ? 's' : '') : '');
        ctx.globalAlpha = 1;
        ctx.font = '600 12px system-ui';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#0b1020';
        ctx.strokeText(lab, mx, my - 6);
        ctx.fillStyle = l.trunks ? '#e6edf7' : '#7f8ba3';
        ctx.fillText(lab, mx, my - 6);
      }
      g.hits.cont.push({ kind: 'link', l, x: mx, y: my, r: 14 });
    }
    for (const c of gg.nodes) {
      const p = P.get(c.name)!;
      if (p.z <= -0.05) continue;
      const r = 8 + 18 * Math.sqrt(c.frames / maxF);
      ctx.globalAlpha = p.z > 0 ? 1 : 0.3;
      const gr = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, r * 1.8);
      gr.addColorStop(0, 'rgba(90,155,255,.55)');
      gr.addColorStop(1, 'rgba(90,155,255,0)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 1.8, 0, TURN);
      ctx.fill();
      ctx.fillStyle = '#5a9bff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.55, 0, TURN);
      ctx.fill();
      ctx.strokeStyle = '#cfe0ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = '700 14px system-ui';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#0b1020';
      ctx.strokeText(c.name, p.x, p.y - r - 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(c.name, p.x, p.y - r - 6);
      ctx.font = '11px system-ui';
      const sub = c.frames + ' frames · ' + c.homeTrunks + ' home trunks · ' + c.homeCalls + ' home calls';
      ctx.strokeText(sub, p.x, p.y + r + 14);
      ctx.fillStyle = '#9fb0cc';
      ctx.fillText(sub, p.x, p.y + r + 14);
      if (p.z > 0) g.hits.cont.push({ kind: 'node', c, links: gg.links, x: p.x, y: p.y, r: Math.max(14, r) });
    }
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- labels

const tierShown = (g: Engine, t: ClusterTier): boolean => {
  const c = g.cfg();
  return t === 'protocol' || (t === 'capital' && c.show_capitals) || (t === 'province' && c.show_provinces) || (t === 'city' && c.show_cities);
};

/** Capitals always, provinces and cities when zoomed in or asked. */
export const labelsLayer: Layer = {
  key: 'labels',
  draw({ ctx, g }) {
    const v = g.view;
    ctx.textAlign = 'center';
    for (const k of g.data.clusters) {
      if (!tierShown(g, k.tier)) continue;
      const big = k.tier === 'capital' || k.tier === 'protocol';
      if (!big && v.zoom < 1.4 && k.tier !== 'province') continue;
      const p = v.proj(k.lat, k.lon);
      if (p.z <= 0.15) continue;
      ctx.globalAlpha = Math.min(big ? 1 : k.tier === 'city' ? 0.6 : 0.75, (p.z - 0.15) * 3);
      ctx.fillStyle = big ? '#8fa3c7' : '#9fb0cc';
      ctx.font = big ? '600 12px system-ui' : '10px system-ui';
      const local = 'local' in k ? k.local : '';
      ctx.fillText(k.name + (local ? ' ' + local : ''), p.x, p.y - (big ? 14 : 9));
    }
    ctx.globalAlpha = 1;
  },
};

// ---------------------------------------------------------------- registry

let installed = false;
/** Register the built-in layers once, in draw order, and the toolbar chips in ALL_LAYERS order. */
export function installDefaultLayers(): void {
  if (installed) return;
  installed = true;
  for (const l of [new SunLayer(), gridLayer, trunksLayer, portsLayer, framesLayer, callsLayer, hubLayer, new ContinentsLayer(), labelsLayer]) registerLayer(l);
  defineChips([
    { key: 'sun', label: 'Sunlight' },
    { key: 'trunks', label: 'Trunks' },
    { key: 'calls', label: 'Calls' },
    { key: 'frames', label: 'Frames' },
    { key: 'ports', label: 'Data ports', when: () => !!window.GLOBE_HUB },
    { key: 'continents', label: 'Continents' },
    { key: 'labels', label: 'Labels' },
    { key: 'grid', label: 'Graticule' },
  ]);
}

export const DEFAULT_LAYERS: readonly string[] = ['sun', 'trunks', 'calls', 'frames', 'ports', 'labels', 'grid'];
