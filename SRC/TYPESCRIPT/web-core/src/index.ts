// Entry: the side effects of the original JS const, in its order.
//   <script>const REFRESH_MS=...;const BUILD="...";{web-core bundle}</script>
import { api } from './api.ts';
import { cacheFlush, cacheGet } from './cache.ts';
import { fitStrip, startDayLoop, wireStripScrub } from './daystrip.ts';
import { build, LIVE, POP, refreshMs } from './env.ts';
import { exposeGlobals } from './globals.ts';
import { installLayoutSwitch, layoutCols } from './layout.ts';
import { refreshMain } from './refresh.ts';
import { TC } from './store.ts';
import { applyStatus, connectWs } from './telemetry.ts';
import { installAuroraResume, noteTopic, paintTopics } from './topics.ts';
import type { StatusMessage } from './types.ts';
import { setText } from './util.ts';

// 0. Globals first: page scripts later in the document call them while parsing.
exposeGlobals();

// 1. A new version is serving: drop the old cache.
if (LIVE && cacheGet('build') !== build()) cacheFlush();

// 2. Paint the day strip every frame.
startDayLoop();

// 3. DOMContentLoaded #1: the layout switch and Q.
document.addEventListener('DOMContentLoaded', installLayoutSwitch);

// 4. The strip follows the footer width.
window.addEventListener('resize', fitStrip);

// 5. DOMContentLoaded #2: deal the columns, wire the controls, go live.
document.addEventListener('DOMContentLoaded', () => {
  layoutCols();
  fitStrip();
  document.querySelectorAll<HTMLDetailsElement>('details.frame').forEach((d) => {
    try {
      if (localStorage.getItem('open:' + d.dataset.id) === '1') d.open = true;
      // FIDELITY: not wrapped in try in the original either; throws on blocked storage.
      d.addEventListener('toggle', () => localStorage.setItem('open:' + d.dataset.id, d.open ? '1' : '0'));
    } catch {
      /* blocked storage */
    }
  });
  if (!LIVE) {
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach((e) => (e.disabled = true));
    document.querySelectorAll<HTMLElement>('.live-only').forEach((e) => (e.style.display = 'block'));
    return;
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) {
    document.addEventListener(ev, () => (TC.interacting = Date.now()), { passive: true });
  }
  const cached = cacheGet<StatusMessage>('status');
  if (cached) applyStatus(cached);
  connectWs();
  const every = refreshMs();
  if (every > 0) setInterval(() => void refreshMain(false), every);
  wireStripScrub();
  // The fader, always ready to go.
  const sp = document.getElementById('qspeed') as HTMLInputElement | null;
  const run = document.getElementById('qrun');
  if (sp) {
    sp.addEventListener('input', () => setText('qspeedv', sp.value + '×'));
    sp.addEventListener('change', () => void api('/api/fader/quick', { speed: Number(sp.value) }));
  }
  if (run) run.addEventListener('click', () => void api('/api/fader/quick', { running: run.dataset.running !== 'true' }));
});

// 6. The heat aurora resumes when the tab is shown again.
installAuroraResume();

// 7. DOMContentLoaded #3: the recent-tabs band.
document.addEventListener('DOMContentLoaded', () => {
  noteTopic();
  if (LIVE && !POP) {
    void paintTopics();
    setInterval(() => {
      if (!document.hidden) void paintTopics();
    }, Math.max(4000, refreshMs() || 5000));
  }
});
