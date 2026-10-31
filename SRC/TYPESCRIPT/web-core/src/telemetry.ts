// Telemetry: streamed over a WebSocket (/ws), cached locally, applied in place.
// runtime.rs broadcasts `status` every 500 ms and `globe-delta` every 2 s.
import { cacheFlush, cacheSet } from './cache.ts';
import { paintDay } from './daystrip.ts';
import { build, LIVE } from './env.ts';
import { TC } from './store.ts';
import type { GlobeDeltaMessage, StatusMessage, TelemetryMessage } from './types.ts';
import { setText } from './util.ts';

/** Apply a status frame to the shared chrome (footer, header stats, fader, banner), then the hooks. */
export function applyStatus(m: StatusMessage): void {
  TC.status = m;
  cacheSet('status', m);
  // `|| {}` kept: a cached frame from an older build may lack `status`.
  const s: Partial<StatusMessage['status']> = m.status || {};
  setText('footclock', m.clock);
  setText('hdr-clock', m.clock);
  setText(
    'hdr-stats',
    (s.frames || 0) + ' frames · ' + (s.trunks || 0) + ' trunks · ' + (s.connections || 0) + ' live' +
      (m.muted ? ' · ' + m.muted + ' parked' : '') + ' · load ×' + Number(m.load || 1).toFixed(1),
  );
  // (The original also defined an unused local `fmt` here, identical to fmtH.)
  if (typeof m.hour === 'number') {
    TC.hour = m.hour;
    TC.at = performance.now();
    TC.speed = m.fader && typeof m.fader.speed === 'number' ? m.fader.speed : 0;
    TC.load = Number(m.load || 1);
    paintDay();
  }
  if (m.fader && typeof m.fader.preset === 'string') {
    const preset = m.fader.preset;
    document.querySelectorAll<HTMLElement>('.event').forEach((e) => e.classList.toggle('on', e.dataset.id === preset));
  }
  const sp = document.getElementById('qspeed') as HTMLInputElement | null;
  if (sp && m.fader && document.activeElement !== sp) {
    sp.value = String(m.fader.speed);
    setText('qspeedv', Math.round(m.fader.speed) + '×');
  }
  const run = document.getElementById('qrun');
  if (run && m.fader) {
    run.dataset.running = String(m.fader.running);
    run.textContent = m.fader.running ? '⏸ pause load' : '▶ run load';
    run.className = 'small ' + (m.fader.running ? 'secondary' : '');
  }
  const bb = document.getElementById('blackout-banner');
  if (bb) bb.style.display = m.blackout ? 'block' : 'none';
  TC.onStatus.forEach((f) => {
    try {
      f(m);
    } catch {
      /* a page hook must not break the stream */
    }
  });
}

/** Parse one /ws text frame; null when it is not JSON. Shape is trusted (server-authored). */
export function parseTelemetry(data: unknown): (TelemetryMessage & { build?: string }) | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as TelemetryMessage & { build?: string };
  } catch {
    return null;
  }
}

export function dispatchGlobe(m: GlobeDeltaMessage): void {
  TC.onGlobe.forEach((f) => {
    try {
      f(m);
    } catch {
      /* a page hook must not break the stream */
    }
  });
}

/** Connect /ws; reconnect 2 s after a close (5 s if the constructor threw). */
export function connectWs(): void {
  if (!LIVE || !('WebSocket' in window)) return;
  try {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = (e: MessageEvent) => {
      const m = parseTelemetry(e.data);
      if (!m) return;
      // A new build is serving: flush the cache and reload the whole page.
      if (m.build && m.build !== build()) {
        cacheFlush();
        ws.onclose = null;
        location.reload();
        return;
      }
      if (m.type === 'status') applyStatus(m);
      else if (m.type === 'globe-delta') dispatchGlobe(m);
    };
    ws.onclose = () => {
      TC.ws = null;
      setTimeout(connectWs, 2000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    TC.ws = ws;
  } catch {
    setTimeout(connectWs, 5000);
  }
}
