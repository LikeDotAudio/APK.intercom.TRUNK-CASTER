// The band under the header: the last four tabs opened, newest first, each
// with its top and bottom five; the Continents tab shows a heat aurora.
import { api } from './api.ts';
import { POP } from './env.ts';
import type { HeatPoint, LandRings, Topic, TopicItem, TopicsResponse } from './types.ts';
import { esc } from './util.ts';

export const TOPN = 5;
const RECENT_KEY = 'tc:topics';

/** Sub-pages map onto their tab. */
const TOPIC_ALIAS: Record<string, string> = { '/globe': '/', '/discovery': '/continents', '/lights': '/panels', '/about': '/home' };

export function topicPath(pathname: string = location.pathname): string {
  const p = pathname.replace(/\/$/, '') || '/';
  const alias = TOPIC_ALIAS[p];
  if (alias) return alias;
  if (p.startsWith('/panels')) return '/panels';
  return p;
}

export function recentTopics(): string[] {
  let r: unknown = [];
  try {
    r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? 'null') || [];
  } catch {
    /* corrupt */
  }
  // Element types are not checked (faithful); non-strings just miss in /api/topics.
  return Array.isArray(r) ? (r as string[]) : [];
}

/** Remember this tab (if it is a header tab) at the front of the last four. */
export function noteTopic(): void {
  if (POP) return;
  const p = topicPath();
  if (!document.querySelector('header nav.views a[href="' + p + '"]')) return;
  const r = recentTopics().filter((x) => x !== p);
  r.unshift(p);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(r.slice(0, 4)));
  } catch {
    /* blocked storage */
  }
}

export function topicChart(t: Topic, items: TopicItem[], kind: 'top' | 'bottom'): string {
  const max = Math.max(1e-9, ...items.map((i) => i[1]));
  const rows = items.length
    ? items
        .map(([n, v]) => '<div class="tr"><span title="' + esc(n) + '">' + esc(n) + '</span><i><u style="width:' + ((v / max) * 100).toFixed(1) + '%"></u></i><b>' + Math.round(v * 10) / 10 + '</b></div>')
        .join('')
    : '<div class="muted">nothing yet</div>';
  return '<div class="tchart" style="--tc:' + t.colour + '"><div class="th"><b style="background:' + t.colour + ';color:' + t.ink + '">' + esc(t.label) + '</b> ' + kind + ' ' + TOPN + ' <span class="muted">· ' + esc(t.metric) + '</span></div>' + rows + '</div>';
}

/** Top and bottom TOPN of one topic. Bottom skips zeros when more than TOPN are non-zero. */
export function topBottom(t: Topic): { top: TopicItem[]; bottom: TopicItem[] } {
  const all = t.items;
  const nz = all.filter((i) => i[1] > 0);
  const pool = nz.length > TOPN ? nz : all;
  return { top: all.slice(0, TOPN), bottom: pool.slice(-TOPN).reverse() };
}

// ---- The Continents band: a heat aurora over the flat world. Each site is a
// curtain of light, taller and brighter the more calls it carries, green at
// the edge through cyan to violet at the core, shimmering as it breathes.
let AURORA: HeatPoint[] | null = null;
let AURORA_LAND: LandRings | null = null;
let AURORA_RAF = 0;

export function auroraChart(t: Topic): string {
  const top = t.items
    .filter((i) => i[1] > 0)
    .slice(0, 3)
    .map(([n, v]) => esc(n) + ' ' + Math.round(v * 10) / 10)
    .join(' · ');
  return '<div class="aurora" style="--tc:' + t.colour + '"><div class="th"><b style="background:' + t.colour + ';color:' + t.ink + '">' + esc(t.label) + '</b> heat aurora <span class="muted">· live calls per site' + (top ? ' · ' + top : '') + '</span></div><canvas id="aurora-cv"></canvas></div>';
}

/** Fetch the coastline once. On failure it stays empty for the page's life. */
function auroraLoad(): void {
  if (AURORA_LAND) return;
  AURORA_LAND = [];
  fetch('/api/land')
    .then((r) => r.json() as Promise<LandRings>)
    .then((l) => {
      AURORA_LAND = l;
    })
    .catch(() => {});
}

function auroraFrame(ts: number): void {
  AURORA_RAF = 0;
  const cv = document.getElementById('aurora-cv') as HTMLCanvasElement | null;
  if (!cv || !AURORA) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) {
    AURORA_RAF = requestAnimationFrame(auroraFrame);
    return;
  }
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d');
  if (!g) return; // original would throw on a null context
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#050914';
  g.fillRect(0, 0, W, H);
  const X = (lon: number): number => ((lon + 180) / 360) * W;
  const Y = (lat: number): number => ((84 - lat) / (84 + 58)) * H;
  g.fillStyle = '#14213d';
  g.strokeStyle = '#26385f';
  g.lineWidth = 0.6;
  for (const ring of AURORA_LAND || []) {
    g.beginPath();
    let prev: number | null = null;
    for (let i = 0; i < ring.length; i += 2) {
      const x = X(ring[i]!), y = Y(ring[i + 1]!);
      if (prev !== null && Math.abs(x - prev) > W / 2) g.moveTo(x, y);
      else if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
      prev = x;
    }
    g.fill();
    g.stroke();
  }
  const max = Math.max(1e-9, ...AURORA.map((h) => h[2]));
  const s = ts / 1000;
  g.globalCompositeOperation = 'lighter';
  for (const [lat, lon, v] of AURORA) {
    const k = v / max, x = X(lon), y = Y(lat), ph = (lon * 7.3 + lat * 3.1) % 6.283, wob = 0.75 + 0.25 * Math.sin(s * 1.7 + ph);
    const r = 4 + k * Math.min(W, H) * 0.55 * wob;
    if (v <= 0) {
      g.fillStyle = 'rgba(61,255,160,0.25)';
      g.fillRect(x - 1, y - 1, 2, 2);
      continue;
    }
    g.save();
    g.translate(x + Math.sin(s * 0.9 + ph) * 2, y);
    g.scale(0.55, 1.6);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, 'rgba(200,120,255,' + (0.55 * k + 0.25) + ')');
    gr.addColorStop(0.3, 'rgba(70,220,255,' + (0.45 * k + 0.15) + ')');
    gr.addColorStop(0.65, 'rgba(61,255,160,' + (0.3 * k + 0.08) + ')');
    gr.addColorStop(1, 'rgba(61,255,160,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, r, 0, 6.283);
    g.fill();
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
  if (!document.hidden) AURORA_RAF = requestAnimationFrame(auroraFrame);
}

/** Resume the aurora when the tab is shown again. Install once at startup. */
export function installAuroraResume(): void {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && AURORA && !AURORA_RAF) AURORA_RAF = requestAnimationFrame(auroraFrame);
  });
}

export async function paintTopics(): Promise<void> {
  const box = document.getElementById('topics');
  if (!box || POP) return;
  const recent = recentTopics();
  let d: TopicsResponse | string | null = null;
  try {
    d = await api<TopicsResponse>('/api/topics');
  } catch {
    /* offline */
  }
  if (!d) return;
  // FIDELITY: a text answer is indexed like the original (yields nothing).
  const topics = (typeof d === 'string' ? {} : d) as Partial<TopicsResponse>;
  let h = '';
  AURORA = null;
  for (const p of recent) {
    const t = topics[p];
    if (!t) continue;
    if (t.heat) {
      AURORA = t.heat;
      auroraLoad();
      h += auroraChart(t);
      continue;
    }
    const { top, bottom } = topBottom(t);
    h += topicChart(t, top, 'top') + topicChart(t, bottom, 'bottom');
  }
  box.innerHTML = h;
  box.style.display = h ? '' : 'none';
  // The band melts (CSS .melted) 4 s after it first shows; once per page.
  if (h && !box.dataset.melt) {
    box.dataset.melt = '1';
    setTimeout(() => box.classList.add('melted'), 4000);
  }
  if (AURORA && !AURORA_RAF) AURORA_RAF = requestAnimationFrame(auroraFrame);
}
