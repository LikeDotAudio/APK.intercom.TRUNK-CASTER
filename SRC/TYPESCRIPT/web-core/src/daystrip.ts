// The broadcast day strip in the footer: "now", the world clocks riding on
// it, and which clock is at 6 am, noon and 6 pm. Painted every frame between
// telemetry updates, advancing the hour at the fader's speed, so it is smooth.
//
// DOM contract (html.rs day_timeline): <svg id="daystrip" data-offset data-anchor>
// with .now (line), .nowlabel, .whatis (text) and g.zone[data-offset][data-name]
// each holding text (one .clk). Elsewhere: .zoneclock[data-offset].
import { api } from './api.ts';
import { TC } from './store.ts';
import type { Status } from './types.ts';
import { fmtH, setText, wrap24 } from './util.ts';

/** viewBox width of the strip and its left/right pads (html.rs day_timeline). */
const W = 960;
const PAD_L = 28;
const PAD_R = 12;

type Mark = 0 | 6 | 12 | 18;
const MARKS: readonly Mark[] = [0, 6, 12, 18];
const WORD: Record<Mark, string> = { 0: 'midnight', 6: '6 am', 12: 'noon', 18: '6 pm' };
type Phase = 'night' | 'dawn' | 'day' | 'dusk';

/** The UTC hour now, extrapolated from the last status frame at the fader's speed. */
export function predictedHour(): number | null {
  if (typeof TC.hour !== 'number') return null;
  const dt = (performance.now() - (TC.at || 0)) / 1000;
  return wrap24(TC.hour + (dt * (TC.speed || 0)) / 3600);
}

/** x on the strip for a local hour. */
export function stripX(lh: number): number {
  return PAD_L + (wrap24(lh) / 24) * (W - PAD_L - PAD_R);
}

/** Phase of the day by local hour (labels colour). */
export function phaseOf(zl: number): Phase {
  return zl < 5 || zl >= 20.5 ? 'night' : zl < 8 ? 'dawn' : zl < 17 ? 'day' : 'dusk';
}

interface Label {
  z: SVGGElement;
  /** Where the dot is. */
  x: number;
  /** Label width + gap. */
  w: number;
  /** Where the label goes after pushing apart. */
  p: number;
}

/**
 * Cities close together on the day would print over each other: keep each
 * dot where it is but push the label centres apart, then back inside [0, W].
 * Mutates `p` of each label; `lab` must be sorted by x.
 */
export function spreadLabels(lab: Array<{ x: number; w: number; p: number }>): void {
  for (let i = 1; i < lab.length; i++) {
    const a = lab[i - 1]!, b = lab[i]!;
    b.p = Math.max(b.p, a.p + (a.w + b.w) / 2);
  }
  for (let i = lab.length - 1; i >= 0; i--) {
    const l = lab[i]!;
    const next = lab[i + 1];
    const hi = next === undefined ? W - l.w / 2 : next.p - (l.w + next.w) / 2;
    l.p = Math.min(l.p, hi);
  }
  for (const l of lab) l.p = Math.max(l.p, l.w / 2);
}

/** "6 am in X · noon in Y and Z · ..." from the clocks within 90 minutes of each mark. */
export function whatIs(at: Record<Mark, Array<[number, string | undefined]>>): string {
  const parts: string[] = [];
  for (const k of [6, 12, 18, 0] as const) {
    const v = at[k].sort((a, b) => a[0] - b[0]).map((a) => a[1]);
    if (v.length) parts.push(WORD[k] + ' in ' + v.join(' and '));
  }
  return parts.length ? parts.join(' · ') : 'no clock within 90 minutes of 6 am, noon or 6 pm';
}

export function paintDay(): void {
  const strip = document.getElementById('daystrip');
  const h = predictedHour();
  if (!strip || h == null) return;
  const off = Number(strip.dataset.offset || 0);
  const lh = wrap24(h + off);
  const x = stripX(lh);
  const n = strip.querySelector('.now');
  if (n) {
    n.setAttribute('x1', String(x));
    n.setAttribute('x2', String(x));
  }
  const t = strip.querySelector('.nowlabel');
  if (t) t.textContent = fmtH(lh) + ' ' + (strip.dataset.anchor || '') + ' · ' + fmtH(h) + ' UTC · ×' + Number(TC.load || 1).toFixed(1);
  const at: Record<Mark, Array<[number, string | undefined]>> = { 0: [], 6: [], 12: [], 18: [] };
  const lab: Label[] = [];
  strip.querySelectorAll<SVGGElement>('.zone').forEach((z) => {
    const zl = wrap24(h + Number(z.dataset.offset || 0));
    z.setAttribute('transform', 'translate(' + stripX(zl).toFixed(1) + ',0)');
    const c = z.querySelector('.clk');
    if (c) c.textContent = fmtH(zl).slice(0, 5);
    lab.push({ z, x: stripX(zl), w: 0, p: 0 });
    const ph = phaseOf(zl);
    if (z.dataset.ph !== ph) {
      z.classList.remove('ph-' + z.dataset.ph);
      z.classList.add('ph-' + ph);
      z.dataset.ph = ph;
    }
    for (const k of MARKS) {
      let d = Math.abs(zl - k);
      d = Math.min(d, 24 - d);
      if (d <= 1.5) at[k].push([d, z.dataset.name]);
    }
  });
  lab.sort((a, b) => a.x - b.x);
  for (const l of lab) {
    let w = 0;
    l.z.querySelectorAll<SVGTextContentElement>('text').forEach((e) => {
      try {
        w = Math.max(w, e.getComputedTextLength());
      } catch {
        /* not rendered yet */
      }
    });
    l.w = w + 8;
    l.p = l.x;
  }
  spreadLabels(lab);
  for (const l of lab) {
    l.z.querySelectorAll('text').forEach((e) => {
      e.setAttribute('text-anchor', 'middle');
      e.setAttribute('x', (l.p - l.x).toFixed(1));
    });
  }
  const w = strip.querySelector('.whatis');
  if (w) w.textContent = whatIs(at);
  document.querySelectorAll<HTMLElement>('.zoneclock').forEach((e) => {
    e.textContent = fmtH(h + Number(e.dataset.offset || 0));
  });
}

/** Repaint every animation frame, forever (errors swallowed per frame). */
export function startDayLoop(): void {
  (function dayLoop() {
    try {
      paintDay();
    } catch {
      /* keep looping */
    }
    requestAnimationFrame(dayLoop);
  })();
}

/** The day strip stretches to the footer's width; its labels do not. */
export function fitStrip(): void {
  const s = document.getElementById('daystrip');
  if (!s) return;
  const w = s.getBoundingClientRect().width || W;
  s.style.setProperty('--ix', (W / w).toFixed(4));
}

/** The broadcast day in the footer: drag or click to scrub the clock. */
export function wireStripScrub(): void {
  const strip = document.getElementById('daystrip');
  if (!strip) return;
  let down = false;
  let last = 0;
  // The strip is in the anchor zone's local time; the clock is set in UTC.
  const hourAt = (e: PointerEvent): number => {
    const r = strip.getBoundingClientRect();
    const pl = PAD_L / W, pr = PAD_R / W;
    const f = ((e.clientX - r.left) / r.width - pl) / (1 - pl - pr);
    return Math.min(24, Math.max(0, f * 24));
  };
  const send = (e: PointerEvent): void => {
    const lh = hourAt(e);
    const off = Number(strip.dataset.offset || 0);
    TC.hour = wrap24(lh - off);
    TC.at = performance.now();
    paintDay();
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    void api<Status>('/api/clock', { hour: wrap24(lh - off) }).then((s) => {
      if (s && typeof s !== 'string' && s.clock) setText('footclock', s.clock);
    });
  };
  strip.addEventListener('pointerdown', (e) => {
    down = true;
    send(e);
  });
  window.addEventListener('pointermove', (e) => {
    if (down) send(e);
  });
  window.addEventListener('pointerup', () => {
    down = false;
  });
}
