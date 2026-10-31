// Migration shim: the original JS const was a classic <script>, so every
// top-level function became a `window` property and every top-level const a
// global lexical binding. Inline onclick= handlers and the other page scripts
// (GLOBE_JS, DISCOVERY_JS, EDITOR_JS, RELAY_JS, page-inline <script>s) call
// them by bare name, so the bundle publishes them on window.
//
// Consumers in RUST-RUNTIME/src/html.rs (working tree, 2026-10-21):
//   api            GLOBE_JS, DISCOVERY_JS, EDITOR_JS, RELAY_JS, onclick= x10, page scripts
//   show/num/val   EDITOR_JS, simulator/analyzer/users/racks page scripts
//   esc            GLOBE_JS (18), DISCOVERY_JS (5); RELAY_JS shadows it locally
//   dur            GLOBE_JS
//   reload         EDITOR_JS, RELAY_JS, page scripts and onclick= handlers
//   connect        racks/relay/users onclick= and scripts
//   rename         panels/racks/users onclick= and scripts
//   gpio           connections_table onclick=, overlord script
//   cancelBooking  bookings_table onclick=
//   setText        GLOBE_JS, DISCOVERY_JS, overlord/simulator scripts, one onclick=
//   cacheGet/Set   GLOBE_JS, DISCOVERY_JS
//   predictedHour  GLOBE_JS (sun position)
//   TC             GLOBE_JS (onGlobe, onStatus), DISCOVERY_JS (onGlobe),
//                  overlord (onGlobe, onStatus), crosspoints (onMain)
//   LIVE           RELAY_JS
// The rest are exported for parity (nothing outside the core uses them today).
import { cancelBooking, connect, gpio, rename } from './actions.ts';
import { api } from './api.ts';
import { cacheFlush, cacheGet, cacheSet } from './cache.ts';
import { fitStrip, paintDay, predictedHour } from './daystrip.ts';
import { LIVE, POP } from './env.ts';
import { layoutCols, layoutQuads, quadMode, toggleQuads } from './layout.ts';
import { addPops, applyPop, secKey } from './popout.ts';
import { refreshMain, reload } from './refresh.ts';
import { TC } from './store.ts';
import { applyStatus, connectWs } from './telemetry.ts';
import { noteTopic, paintTopics, recentTopics, topicChart, topicPath, TOPN } from './topics.ts';
import { dur, esc, fmtH, num, setText, show, val } from './util.ts';

/** Names other scripts depend on. Keep until every consumer is a module. */
export const REQUIRED = {
  LIVE, TC, api, show, num, val, esc, dur, reload, connect, rename, cancelBooking, gpio,
  setText, cacheGet, cacheSet, predictedHour,
} as const;

/** Original top-level names nothing else uses yet; published for parity. */
export const PARITY = {
  POP, TOPN, fmtH, cacheFlush, paintDay, applyStatus, connectWs, quadMode, toggleQuads,
  layoutQuads, layoutCols, fitStrip, refreshMain, secKey, addPops, applyPop, topicPath,
  recentTopics, noteTopic, topicChart, paintTopics,
} as const;

export type WebCoreGlobals = typeof REQUIRED & typeof PARITY;

declare global {
  // `var` so the names type-check as bare globals in other TS that migrates later.
  // eslint-disable-next-line no-var
  var TC: WebCoreGlobals['TC'];
  // eslint-disable-next-line no-var
  var LIVE: boolean;
}

export function exposeGlobals(target: Record<string, unknown> = window as unknown as Record<string, unknown>): void {
  Object.assign(target, PARITY, REQUIRED);
}
