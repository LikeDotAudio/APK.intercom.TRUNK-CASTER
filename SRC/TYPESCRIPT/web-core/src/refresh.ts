// Refresh <main> in place from the server: no reload, no flash, no scroll
// jump, and never while you are typing, selecting or pressing something.
import { cacheSet } from './cache.ts';
import { LIVE } from './env.ts';
import { layoutCols } from './layout.ts';
import { TC } from './store.ts';
import { isTypingTarget } from './util.ts';

let refreshing = false;

/** How long after the last pointer/key/wheel a timed refresh holds off, ms. */
export const INTERACT_HOLD_MS = 1500;

/** A <details>' identity across refreshes: data-id, id, else its summary text. */
function detailsKey(d: HTMLDetailsElement): string | null | undefined {
  return d.dataset.id || d.id || d.querySelector('summary')?.textContent;
}

/** True when a timed (non-forced) refresh should wait. */
export function userBusy(): boolean {
  return (
    Date.now() - TC.interacting < INTERACT_HOLD_MS ||
    isTypingTarget(document.activeElement) ||
    (!!window.getSelection && String(window.getSelection()).length > 0)
  );
}

export async function refreshMain(force?: boolean): Promise<void> {
  if (!LIVE || refreshing || document.hidden) return;
  if (!force && userBusy()) return;
  refreshing = true;
  try {
    const r = await fetch(location.pathname + location.search, { cache: 'no-store' });
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nm = doc.querySelector('main');
    const main = document.querySelector('main');
    if (nm && main) {
      const open = new Set(Array.from(main.querySelectorAll('details[open]')).map((d) => detailsKey(d as HTMLDetailsElement)));
      const scrolls = Array.from(main.querySelectorAll('.scroll')).map((e) => e.scrollTop);
      // Columns only: quadrant panes (.quads>.pane) are not restored (see HANDOFF finding).
      const cs = Array.from(main.querySelectorAll(':scope>.cols>.col')).map((c) => c.scrollTop);
      // Live drawings (canvases and what draws on them) keep their element:
      // the script holding them never runs again, so a fresh one stays blank.
      const keep = Array.from(main.querySelectorAll('canvas[id],.tip[id],[data-keep][id]'));
      main.innerHTML = nm.innerHTML;
      keep.forEach((el) => {
        const fresh = document.getElementById(el.id);
        if (fresh && fresh !== el) fresh.replaceWith(el);
      });
      layoutCols();
      main.querySelectorAll(':scope>.cols>.col').forEach((c, i) => {
        const top = cs[i];
        if (top != null) c.scrollTop = top;
      });
      main.querySelectorAll('details').forEach((d) => {
        if (open.has(detailsKey(d))) d.open = true;
      });
      main.querySelectorAll('.scroll').forEach((e, i) => {
        const top = scrolls[i];
        if (top != null) e.scrollTop = top;
      });
      cacheSet('main:' + location.pathname, nm.innerHTML);
      TC.onMain.forEach((f) => {
        try {
          f();
        } catch {
          /* a page hook must not break the refresh */
        }
      });
    }
  } catch {
    /* network or parse failure: try again next tick */
  }
  refreshing = false;
}

/** A change made from a page: refresh the page in place shortly after. */
export function reload(ms?: number): void {
  setTimeout(() => void refreshMain(true), ms || 600);
}
