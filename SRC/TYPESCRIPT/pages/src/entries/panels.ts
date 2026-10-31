// Panels page (html.rs panels_page): the light board. One light per frame;
// between stream frames, lengths count up and leases count down every second.
// Port of the format!-built `<script>(function(){{ … }})();</script>` block,
// with the server value window.LIGHTS0 read from a JSON data island first.

import { ISLANDS, island } from '../lib/island.ts';
import type { GlobeDelta, LightConnJson, LightsJson } from '../wire.ts';

(function () {
  if (!document.getElementById('lights')) return;
  // The page refresh swaps the board, so look it up each time.
  const board = {
    querySelectorAll: (q: string): NodeListOf<HTMLElement> => (document.getElementById('lights') || document.createElement('div')).querySelectorAll<HTMLElement>(q),
  };
  const L0: Partial<LightsJson> = island<LightsJson>(ISLANDS.lights0, window.LIGHTS0) || {};
  const prev: Record<string, number> = {};
  let conns: Record<string, LightConnJson> = L0.conn || {};
  let got = Date.now() / 1000;
  let lease = L0.lease || 900;
  let skew = L0.now ? L0.now - Date.now() / 1000 : 0;
  const fmt = (s: number): string => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      x = s % 60;
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m ? m + 'm ' + String(x).padStart(2, '0') + 's' : x + 's';
  };
  // Every second: lengths count up, leases count down, between stream updates.
  function tick(): void {
    const now = Date.now() / 1000,
      el0 = now - got;
    board.querySelectorAll('.light').forEach((el) => {
      const c = conns[el.dataset.id ?? ''];
      const len = el.querySelector<HTMLElement>('.len'),
        cd = el.querySelector<HTMLElement>('.cd'),
        dest = el.querySelector<HTMLElement>('.dest');
      if (!len) return;
      if (!c) {
        len.textContent = '';
        if (dest) dest.textContent = 'ready';
        return;
      }
      len.textContent = fmt(now + skew - c.since);
      if (dest) dest.textContent = '→ ' + c.to + (c.more ? ' +' + c.more : '');
      const left = c.left - el0;
      if (cd) {
        cd.querySelector('em')!.textContent = left <= 0 ? 'ran out' : fmt(left);
        cd.querySelector<HTMLElement>('b')!.style.width = Math.max(0, Math.min(100, (left / lease) * 100)).toFixed(0) + '%';
      }
    });
  }
  setInterval(tick, 1000);
  TC.onGlobe.push((m: GlobeDelta) => {
    if (!m.lights) return;
    const L = m.lights;
    const gp = new Set(m.blink || []);
    conns = L.conn || {};
    got = Date.now() / 1000;
    lease = L.lease || lease;
    if (L.now) skew = L.now - got;
    const hot = new Set(L.hot || []),
      stale = new Set(L.stale || []),
      parked = new Set(L.parked || []),
      live = L.live || {},
      cas = L.casters || {};
    let on = 0,
      blink = 0,
      reds = 0,
      ambers = 0;
    board.querySelectorAll('.light').forEach((el) => {
      // `dataset.id` is always rendered; '' keeps the lookups total.
      const id = el.dataset.id ?? '';
      const n = live[id] || 0;
      const was = prev[id] || 0;
      const st = hot.has(id) ? 'red' : stale.has(id) ? 'stale' : parked.has(id) ? 'parked' : n > 0 ? 'on' : 'idle';
      ['on', 'idle', 'red', 'stale', 'parked'].forEach((k) => el.classList.toggle(k, k === st));
      el.classList.toggle('gpio', gp.has(id));
      if (n !== was) {
        el.classList.remove('blink');
        void el.offsetWidth;
        el.classList.add('blink');
        blink++;
      }
      if (n > 0) on++;
      if (st === 'red') reds++;
      if (st === 'stale') ambers++;
      const ck = el.querySelector('.ck');
      const bits = cas[id];
      if (ck && bits) {
        const us = ck.children;
        for (let i = 0; i < us.length; i++) us[i]!.classList.toggle('on', bits.charAt(i) === '1');
      }
      el.dataset.live = String(n);
      prev[id] = n;
    });
    tick();
    setText('lights-summary', on + ' connected · ' + reds + ' high capacity · ' + ambers + ' lease ran out · ' + blink + ' changed · ' + gp.size + ' blinking by GPIO');
  });
})();
