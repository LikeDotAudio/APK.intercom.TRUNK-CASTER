// The one map engine: camera (globe/map/both panes), render loop, pointer
// and keyboard, telemetry hookup. Port of GLOBE_JS (html.rs) minus the
// pieces split into math.ts, layers.ts, panels.ts, toolbar.ts.
//
// Lifetime: one Globe per page load. refreshMain (shared client) keeps the
// <canvas id=globe>, #globe-tip and #mapbar elements and never re-runs this
// script, so the instance keeps drawing on the same canvas.

import { layers, type ArcHit, type Engine, type Hits, type MapView, type PaneSpec, type Scene } from './layer.ts';
import { DEFAULT_LAYERS, drawLand, drawSea, installDefaultLayers } from './layers.ts';
import { clamp, equirect, liftControl, nearX, orthographic, pairMidpoint, radiusFor, rotationAt, starField, tkey, TURN, type XY, type XYZ } from './math.ts';
import { continentTip, drawLegend, frameTip, renderSide, renderTrends, trunkTip } from './panels.ts';
import { Filter, pageKey, parseMode, parseView, Session } from './state.ts';
import { buildBar } from './toolbar.ts';
import type { ColourView, GlobeConfig, GlobeData, GlobeDelta, GlobeNode, Hub, LandRing, Projection, StatusMessage, TrunkHistory, ViewMode } from './types.ts';

/** GLOBE_JS's fallback when `data.config` is missing (zones are not read by the map). */
const FALLBACK_CONFIG: GlobeConfig = {
  rotate_deg_per_s: 2.5,
  tilt_deg: -18,
  show_capitals: true,
  show_provinces: true,
  show_cities: true,
  graticule_deg: 30,
  projection: 'both',
  zoom: 1,
  zones: [],
};

interface Drag {
  proj: Projection;
  x: number;
  y: number;
  off: number;
  tilt: number;
  pan: number;
  panx: number;
}

const isGlobeData = (d: unknown): d is GlobeData => !!d && typeof d === 'object' && Array.isArray((d as { nodes?: unknown }).nodes);
const isFormField = (t: EventTarget | null): boolean => !!t && /INPUT|SELECT|TEXTAREA/.test(String((t as Partial<Element>).tagName));

export class Globe implements Engine, MapView {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: MapView = this;
  readonly hits: Hits = { arcs: [], cont: [] };
  readonly session: Session;
  readonly filter: Filter;
  readonly layersOn: Set<string>;
  readonly land: readonly LandRing[];
  byId = new Map<string, GlobeNode>();
  histByKey = new Map<string, TrunkHistory>();

  data: GlobeData;
  hover: string | null = null;
  colour: ColourView;
  focus: string | null;

  // Camera.
  mode: ViewMode;
  projection: Projection;
  pane: PaneSpec;
  dragOff: number;
  tilt: number;
  zoom: number;
  panX: number;
  panY: number;
  speed: number;
  frozenRot: number | null = null;
  shiftX = 0;
  W = 1400;
  H = 820;
  dpr = 1;

  private dragging: Drag | null = null;
  private arcTip = false;
  private contTip = false;
  private downAt: [number, number] | null = null;
  private readonly stars = starField(160);

  constructor(
    readonly canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    readonly tip: HTMLElement,
  ) {
    installDefaultLayers();
    this.ctx = ctx;
    this.data = window.GLOBE_DATA;
    this.land = window.TC_LAND || [];
    this.session = new Session(pageKey(location.pathname));
    const s = this.session;
    this.dragOff = s.num('drag', 0);
    this.tilt = s.num('tilt', this.cfg().tilt_deg);
    this.zoom = s.num('zoom', this.cfg().zoom || 1);
    this.panY = s.num('pany', 0);
    this.panX = s.num('panx', 0);
    // Each page remembers its own view, layers and filter.
    this.mode = parseMode(s.mode() || window.GLOBE_DEFAULT_MODE || window.GLOBE_FORCE_PROJECTION || this.cfg().projection) ?? 'both';
    this.projection = this.mode === 'map' ? 'map' : 'globe';
    this.pane = { p: this.projection, x: 0, w: 1400 };
    this.layersOn = new Set(s.list('layers', window.GLOBE_LAYERS || DEFAULT_LAYERS));
    this.filter = new Filter(s);
    this.speed = this.cfg().rotate_deg_per_s;
    this.colour = parseView(new URLSearchParams(location.search).get('view') || s.get('view')) ?? 'uses';
    this.focus = s.get('focus') || null;
  }

  get hub(): Hub | null {
    return window.GLOBE_HUB || null;
  }
  cfg(): GlobeConfig {
    return this.data.config || FALLBACK_CONFIG;
  }
  on(k: string): boolean {
    return this.layersOn.has(k);
  }

  // ------------------------------------------------------------ camera

  /** 'both' puts the round globe on the left and the flat map across the rest. */
  panes(): PaneSpec[] {
    if (this.mode !== 'both') return [{ p: this.mode, x: 0, w: this.W }];
    const gw = Math.round(Math.min(this.W * 0.45, this.H * 1.08));
    return [
      { p: 'globe', x: 0, w: gw },
      { p: 'map', x: gw, w: this.W - gw },
    ];
  }
  /** Select the pane under screen x (mutates pane/projection, as GLOBE_JS does). */
  paneAt(mx: number): PaneSpec {
    const l = this.panes();
    let q = l[l.length - 1]!;
    for (const c of l) {
      if (mx >= c.x && mx < c.x + c.w) {
        q = c;
        break;
      }
    }
    this.pane = q;
    this.projection = q.p;
    return q;
  }
  /** Pan moves the map; in 'both' the globe stays centred in its pane. */
  pans(): boolean {
    return this.mode !== 'both' || this.projection === 'map';
  }
  R(): number {
    return radiusFor(this.projection, this.pane.w, this.H, this.zoom);
  }
  CX(): number {
    return this.pane.x + this.pane.w / 2 + (this.pans() ? this.panX : 0) + this.shiftX;
  }
  CY(): number {
    return this.H / 2 + (this.pans() ? this.panY : 0);
  }
  mapW(): number {
    return this.R() * 3.8;
  }
  near(p: XYZ, q: XYZ): XYZ {
    if (this.projection !== 'map') return q;
    const x = nearX(p.x, q.x, this.mapW());
    return x === q.x ? q : { x, y: q.y, z: q.z };
  }
  rot(): number {
    if (this.frozenRot !== null) return this.frozenRot;
    return rotationAt(Date.now() / 1000, this.speed, this.dragOff);
  }
  proj(lat: number, lon: number): XYZ {
    if (this.projection === 'map') {
      const { u, v } = equirect(lat, lon, this.rot());
      return { x: this.CX() + u * this.R() * 1.9, y: this.CY() - v * this.R() * 0.95, z: 1 };
    }
    const o = orthographic(lat, lon, this.rot(), this.tilt);
    return { x: this.CX() + this.R() * o.x, y: this.CY() - this.R() * o.y, z: o.z };
  }
  lift(p: XY, q: XY, amount: number): XY {
    return liftControl(this.projection, p, q, amount, this.CX(), this.CY(), this.R());
  }

  // ------------------------------------------------------------ data

  index(): void {
    this.byId = new Map(this.data.nodes.map((n) => [n.id, n]));
  }
  indexHist(): void {
    this.histByKey = new Map();
    for (const h of this.data.history || []) this.histByKey.set(tkey(h.a, h.b), h);
  }
  siteOf = (id: string): string => this.byId.get(id)?.site || id;

  resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.W = Math.max(200, r.width);
    this.H = Math.max(200, r.height);
    this.canvas.width = this.W * this.dpr;
    this.canvas.height = this.H * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ------------------------------------------------------------ render

  private scene(t: number): void {
    drawSea(this);
    drawLand(this);
    const pos = new Map<string, XYZ>();
    for (const n of this.data.nodes) pos.set(n.id, this.proj(n.lat, n.lon));
    const s: Scene = { g: this, ctx: this.ctx, t, pos };
    for (const l of layers()) if (l.isOn ? l.isOn(this) : this.on(l.key)) l.draw(s);
  }

  private prepare(pn: PaneSpec): void {
    for (const l of layers()) if (l.prepare && (l.isOn ? l.isOn(this) : this.on(l.key))) l.prepare(this, pn);
  }

  frame = (): void => {
    const ctx = this.ctx,
      W = this.W,
      H = this.H;
    const t = Date.now() / 1000;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, W, H);
    for (const s of this.stars) {
      ctx.globalAlpha = 0.25 + 0.45 * Math.abs(Math.sin(t * 0.7 + s.p));
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, TURN);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.hits.arcs.length = 0;
    this.hits.cont.length = 0;
    for (const pn of this.panes()) {
      this.pane = pn;
      this.projection = pn.p;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pn.x, 0, pn.w, H);
      ctx.clip();
      if (this.projection === 'map') {
        // Keep the pan inside one world-width, then draw every copy across the pane.
        const w = this.mapW();
        this.panX = (((this.panX + w / 2) % w) + w) % w - w / 2;
        this.prepare(pn);
        const c0 = pn.x + pn.w / 2 + this.panX,
          k0 = Math.floor((pn.x - c0 - w / 2) / w),
          k1 = Math.ceil((pn.x + pn.w - c0 + w / 2) / w);
        for (let k = k0; k <= k1; k++) {
          const c = c0 + k * w;
          if (c + w / 2 < pn.x || c - w / 2 > pn.x + pn.w) continue;
          this.shiftX = k * w;
          this.scene(t);
        }
        this.shiftX = 0;
      } else {
        this.prepare(pn);
        this.scene(t);
      }
      ctx.restore();
      if (pn.x > 0) {
        ctx.strokeStyle = '#2a3a60';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pn.x + 0.5, 10);
        ctx.lineTo(pn.x + 0.5, H - 10);
        ctx.stroke();
      }
    }
    if (this.on('trunks') || this.on('continents')) drawLegend(ctx, W, H, this.colour, this.data.lockHours);
    const hud = document.getElementById('globe-hud');
    const d = this.data;
    if (hud)
      hud.textContent =
        d.site + ' · ' + d.clock + ' UTC · ' + d.sites + ' sites · ' + d.frames + ' frames · ' + d.trunks + ' trunks · ' + d.calls + ' calls · ' + d.sims + ' simulators · ' +
        (this.mode === 'both' ? 'globe and flat map' : this.mode === 'map' ? 'flat map' : 'globe') + ' · zoom ' + this.zoom.toFixed(1) + '×';
    requestAnimationFrame(this.frame);
  };

  // ------------------------------------------------------------ trends

  renderTrends = (): void => {
    renderTrends(this.data.history || [], this.colour, this.focus, this.data.lockHours, this.siteOf, (k) => this.focusTrunk(k));
  };

  /** Follow a trunk: highlight it and turn the world to its midpoint. */
  focusTrunk(k: string): void {
    this.focus = this.focus === k ? null : k;
    if (this.focus) this.session.set('focus', this.focus);
    else this.session.remove('focus');
    const h = this.histByKey.get(k);
    const a = h && this.byId.get(h.a),
      b = h && this.byId.get(h.b);
    if (this.focus && h && a && b) {
      const mid = pairMidpoint(a, b);
      this.dragOff = -mid.lon - (Date.now() / 1000) * this.speed;
      this.frozenRot = null;
      this.hover = null;
      if (this.mode !== 'map') this.tilt = clamp(mid.lat, -85, 85);
      this.session.set('drag', this.dragOff);
      this.session.set('tilt', this.tilt);
    }
    this.renderTrends();
  }

  // ------------------------------------------------------------ input

  private showTip(e: PointerEvent | MouseEvent, html: string): void {
    this.tip.style.display = 'block';
    this.tip.style.left = e.clientX + 12 + 'px';
    this.tip.style.top = e.clientY + 12 + 'px';
    this.tip.innerHTML = html;
  }
  private hideTip(): void {
    this.tip.style.display = 'none';
  }
  /** Release a frozen hover: keep the world where it stopped. (frozenRot is set whenever hover is.) */
  private unfreeze(): void {
    this.dragOff = (this.frozenRot ?? 0) - (Date.now() / 1000) * this.speed;
  }

  private nearestArc(e: MouseEvent): ArcHit | null {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left,
      my = e.clientY - r.top;
    let best: ArcHit | null = null,
      bd = 64;
    for (const a of this.hits.arcs) {
      for (const [x, y] of a.pts) {
        const d = (x - mx) ** 2 + (y - my) ** 2;
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
    }
    return best;
  }

  /** Hover: nearest frame within 9 px; freezes rotation while held. */
  private onHoverFrame = (e: PointerEvent): void => {
    if (this.dragging) return;
    const r = this.canvas.getBoundingClientRect();
    let mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    this.paneAt(mx);
    if (this.projection === 'map') {
      const w = this.mapW();
      mx -= w * Math.round((mx - (this.pane.x + this.pane.w / 2 + this.panX)) / w);
    }
    let best: GlobeNode | null = null,
      bd = 81;
    if (this.on('frames'))
      for (const n of this.data.nodes) {
        const p = this.proj(n.lat, n.lon);
        if (p.z <= 0 || this.filter.hiddenByUser(n)) continue;
        const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
    if (best) {
      if (this.hover !== best.id) {
        this.hover = best.id;
        this.frozenRot = this.rot();
      }
      this.showTip(e, frameTip(best));
    } else if (this.hover) {
      this.hover = null;
      this.unfreeze();
      this.session.set('drag', this.dragOff);
      this.frozenRot = null;
      this.hideTip();
    }
  };

  private onHoverContinent = (e: PointerEvent): void => {
    if (this.dragging || this.hover || !this.on('continents')) {
      if (this.contTip && !this.hover) {
        this.contTip = false;
        this.hideTip();
      }
      return;
    }
    const r = this.canvas.getBoundingClientRect(),
      mx = e.clientX - r.left,
      my = e.clientY - r.top;
    let best = null,
      bd = Infinity;
    for (const h of this.hits.cont) {
      const d = Math.hypot(h.x - mx, h.y - my);
      if (d < h.r && d < bd) {
        bd = d;
        best = h;
      }
    }
    if (!best) {
      if (this.contTip) {
        this.contTip = false;
        this.hideTip();
      }
      return;
    }
    this.contTip = true;
    this.showTip(e, continentTip(best));
  };

  private onHoverArc = (e: PointerEvent): void => {
    if (this.dragging || this.hover) {
      this.arcTip = false;
      return;
    }
    const best = this.nearestArc(e);
    if (best) {
      this.arcTip = true;
      this.showTip(e, trunkTip(best.rec, this.siteOf));
    } else if (this.arcTip) {
      this.arcTip = false;
      this.hideTip();
    }
  };

  private onLeave = (): void => {
    if (this.hover) {
      this.unfreeze();
      this.frozenRot = null;
      this.hover = null;
    }
    this.hideTip();
  };

  /** Drag: sideways turns, up/down tilts (globe) or pans (map). */
  private onDown = (e: PointerEvent): void => {
    const rr = this.canvas.getBoundingClientRect();
    this.paneAt(e.clientX - rr.left);
    this.dragging = {
      proj: this.projection,
      x: e.clientX,
      y: e.clientY,
      off: this.hover ? (this.frozenRot ?? 0) - (Date.now() / 1000) * this.speed : this.dragOff,
      tilt: this.tilt,
      pan: this.panY,
      panx: this.panX,
    };
    if (this.hover) {
      this.hover = null;
      this.frozenRot = null;
      this.hideTip();
    }
    e.preventDefault();
  };

  private onDrag = (e: PointerEvent): void => {
    const d = this.dragging;
    if (!d) return;
    if (e.shiftKey || e.buttons === 4) {
      this.panX = (d.panx || 0) + (e.clientX - d.x);
      this.panY = d.pan + (e.clientY - d.y);
      this.session.set('panx', this.panX);
      this.session.set('pany', this.panY);
      return;
    }
    this.dragOff = d.off + ((e.clientX - d.x) * 0.35) / this.zoom;
    this.session.set('drag', this.dragOff);
    if (d.proj === 'map') {
      this.panY = d.pan + (e.clientY - d.y);
      this.session.set('pany', this.panY);
    } else {
      this.tilt = clamp(d.tilt - ((e.clientY - d.y) * 0.3) / this.zoom, -85, 85);
      this.session.set('tilt', this.tilt);
      const i = document.getElementById('g_tilt') as HTMLInputElement | null;
      if (i) i.value = String(Math.round(this.tilt));
    }
  };

  /** The wheel zooms about the cursor. Range 0.6–12 (keys and the form stop at 8: finding). */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left,
      my = e.clientY - r.top;
    const k = Math.pow(1.12, -e.deltaY / 100);
    const nz = clamp(this.zoom * k, 0.6, 12);
    const f = nz / this.zoom;
    this.paneAt(mx);
    if (this.pans()) {
      this.panX = mx - (mx - this.CX()) * f - (this.pane.x + this.pane.w / 2);
      this.panY = my - (my - this.CY()) * f - this.H / 2;
    }
    this.zoom = nz;
    if (this.zoom <= 1.02) {
      this.panX = 0;
      this.panY = 0;
    }
    this.session.set('zoom', this.zoom);
    this.session.set('panx', this.panX);
    this.session.set('pany', this.panY);
    const z = document.getElementById('g_zoom') as HTMLInputElement | null;
    if (z) z.value = this.zoom.toFixed(1);
  };

  private setMode(m: ViewMode): void {
    this.mode = m;
    this.projection = m === 'map' ? 'map' : 'globe';
    this.session.setMode(m);
  }

  private onKeyCamera = (e: KeyboardEvent): void => {
    if (isFormField(e.target)) return;
    if (e.key === 'ArrowUp') this.tilt = Math.min(85, this.tilt + 5);
    else if (e.key === 'ArrowDown') this.tilt = Math.max(-85, this.tilt - 5);
    else if (e.key === 'ArrowLeft') this.dragOff -= 10;
    else if (e.key === 'ArrowRight') this.dragOff += 10;
    else if (e.key === '+' || e.key === '=') this.zoom = Math.min(8, this.zoom * 1.2);
    else if (e.key === '-') this.zoom = Math.max(0.6, this.zoom / 1.2);
    else if (e.key === 'Home') {
      this.tilt = this.cfg().tilt_deg;
      this.zoom = this.cfg().zoom || 1;
      this.panY = 0;
      this.panX = 0;
      this.session.set('panx', 0);
      this.session.set('pany', 0);
    } else if (e.key === 'm' || e.key === 'M') {
      this.setMode(this.mode === 'both' ? 'globe' : this.mode === 'globe' ? 'map' : 'both');
      const sel = document.getElementById('g_proj') as HTMLSelectElement | null;
      if (sel) sel.value = this.mode;
    } else return;
    this.session.set('tilt', this.tilt);
    this.session.set('zoom', this.zoom);
    e.preventDefault();
  };

  private onKeyView = (e: KeyboardEvent): void => {
    if (isFormField(e.target)) return;
    if (e.key === 't' || e.key === 'T') {
      this.colour = this.colour === 'trend' ? 'uses' : 'trend';
      this.session.set('view', this.colour);
      const vs = document.getElementById('g_view') as HTMLSelectElement | null;
      if (vs) vs.value = this.colour;
      this.renderTrends();
    }
  };

  private onClick = (e: MouseEvent): void => {
    if (this.downAt && Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return;
    const best = this.nearestArc(e);
    if (!best) return;
    const rr = best.rec;
    const a = rr.live ? rr.live.a : rr.hist?.a,
      b = rr.live ? rr.live.b : rr.hist?.b;
    if (a === undefined || b === undefined) return;
    this.focusTrunk(tkey(a, b));
  };

  // ------------------------------------------------------------ telemetry

  /** Deltas: trunks, calls, live counts. A changed fleet triggers one full fetch. */
  private onDelta = (m: GlobeDelta): void => {
    const data = this.data;
    if (m.frames !== data.nodes.length) {
      void api('/api/globe').then((d) => {
        if (isGlobeData(d)) {
          this.data = d;
          this.index();
        }
      });
      return;
    }
    data.trunkList = m.trunkList;
    data.callList = m.callList;
    data.clusters = m.clusters || data.clusters;
    data.clock = m.clock;
    data.sites = m.sites;
    data.trunks = m.trunks;
    data.calls = m.calls;
    data.sims = m.sims;
    for (const n of data.nodes) n.live = (m.live && m.live[n.id]) || 0;
  };

  private onDeltaHistory = (m: GlobeDelta): void => {
    if (m.history) {
      this.data.history = m.history;
      this.data.today = m.today;
      this.indexHist();
      this.renderTrends();
    }
  };

  private onStatus = (m: StatusMessage): void => {
    const c = this.data.config;
    this.speed = c && c.rotate_deg_per_s != null ? c.rotate_deg_per_s : this.speed;
    renderSide(m);
  };

  // ------------------------------------------------------------ wiring

  /** Attach everything in GLOBE_JS's registration order (listener order matters for the shared tooltip). */
  start(): void {
    const canvas = this.canvas;
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.index();
    buildBar(this.data.nodes, this.layersOn, this.filter, this.session);
    this.indexHist();

    canvas.addEventListener('pointermove', this.onHoverFrame);
    canvas.addEventListener('pointermove', this.onHoverContinent);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onDrag);
    window.addEventListener('pointerup', () => (this.dragging = null));
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyCamera);

    const pb = document.getElementById('g_proj') as HTMLSelectElement | null;
    if (pb) {
      pb.value = this.mode;
      pb.addEventListener('change', () => this.setMode(parseMode(pb.value) ?? 'both'));
    }
    const gf = document.getElementById('globe-form');
    if (gf)
      gf.addEventListener('submit', (e) => {
        e.preventDefault();
        const checked = (id: string): boolean => !!(document.getElementById(id) as HTMLInputElement | null)?.checked;
        // Finding: no `zones` in the body, so serde's default_zones() replaces any
        // custom footer clocks on every save; an empty rotation/graticule field drops
        // the key, the server answers 400, and the form still says "saved".
        void api('/api/globe/config', {
          rotate_deg_per_s: num('g_rot'),
          tilt_deg: Math.round(this.tilt),
          show_capitals: checked('g_cap'),
          show_provinces: checked('g_prov'),
          show_cities: checked('g_city'),
          graticule_deg: num('g_grat'),
          projection: this.mode,
          zoom: Number(this.zoom.toFixed(2)),
        }).then(() => {
          setText('globe-saved', 'saved');
        });
      });

    TC.onGlobe.push(this.onDelta);
    TC.onStatus.push(this.onStatus);

    canvas.addEventListener('pointermove', this.onHoverArc);
    canvas.addEventListener('pointerdown', (e) => {
      this.downAt = [e.clientX, e.clientY];
    });
    canvas.addEventListener('click', this.onClick);
    const vs = document.getElementById('g_view') as HTMLSelectElement | null;
    if (vs) {
      vs.value = this.colour;
      vs.addEventListener('change', () => {
        this.colour = parseView(vs.value) ?? 'uses';
        this.session.set('view', this.colour);
        this.renderTrends();
      });
    }
    window.addEventListener('keydown', this.onKeyView);
    TC.onGlobe.push(this.onDeltaHistory);
    this.renderTrends();
    // The list sits after the map on the page: draw it once the page is in.
    document.addEventListener('DOMContentLoaded', this.renderTrends);
    const cached = cacheGet('status');
    if (cached && typeof cached === 'object') renderSide(cached as StatusMessage);
    requestAnimationFrame(this.frame);
  }
}

/** GLOBE_JS's IIFE: no-op without <canvas id=globe>. */
export function bootGlobe(): Globe | null {
  const canvas = document.getElementById('globe');
  if (!(canvas instanceof HTMLCanvasElement)) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // map_block always emits #globe-tip; a detached div keeps the engine total if a page forgets it.
  const tip = document.getElementById('globe-tip') ?? document.createElement('div');
  const g = new Globe(canvas, ctx, tip);
  g.start();
  return g;
}
