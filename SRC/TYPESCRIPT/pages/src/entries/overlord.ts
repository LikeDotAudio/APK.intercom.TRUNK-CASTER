// Overlord page (html.rs overlord_page): the "Messages" lane and bucket.
// Each new call flies in from the left and lands in its protocol's column.
// Port of the format!-built `<script>(function(){{ … }})();</script>` block.

import type { CallJson, GlobeDelta } from '../wire.ts';

(function () {
  // LATENT (preserved): lane and bucket are captured once. The Overlord
  // refreshes <main> in place every 3 s and never re-runs this script, so
  // after the first refresh new calls fly into detached nodes and the
  // visible lane/bucket stay empty. Fix: mark both `data-keep` (refreshMain
  // already keeps `[data-keep][id]` elements) — see HANDOFF.md.
  const lane = document.getElementById('lane'),
    bucket = document.getElementById('bucket');
  if (!lane) return;
  const seen = new Set<string>();
  let first = true;

  // LATENT (preserved): `proto` is a server string spliced into a CSS
  // attribute selector; a protocol name containing `"` or `]` throws here.
  function col(proto: string): HTMLElement {
    let c = bucket!.querySelector<HTMLElement>('[data-proto="' + proto + '"]');
    if (!c) {
      c = document.createElement('div');
      c.className = 'col';
      c.dataset.proto = proto;
      c.innerHTML = '<h4>' + esc(proto) + ' <span class="n"></span></h4>';
      bucket!.appendChild(c);
    }
    return c;
  }

  // LATENT (preserved): `call.hops[0]![0]` throws when hops is empty and the
  // site is empty/null (a call that never left its frame on a site-less
  // frame). The types (noUncheckedIndexedAccess) surfaced this.
  const route = (call: CallJson): string =>
    (call.from_site || call.hops[0]![0]) + ' → ' + (call.to_site || call.hops[call.hops.length - 1]![1]);

  function land(call: CallJson): void {
    const c = col(call.proto || '?');
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.title = (call.why || '') + ' · ' + call.kind;
    chip.innerHTML = (call.badge ? call.badge.emoji + ' ' : '') + esc(call.who) + ' <span class="muted">' + esc(route(call)) + '</span>';
    c.insertBefore(chip, c.children[1] || null);
    while (c.children.length > 9) c.removeChild(c.lastChild!);
    setTimeout(() => chip.classList.add('old'), 20000);
    c.querySelector('.n')!.textContent = String(c.children.length - 1);
  }

  function fly(call: CallJson): void {
    const m = document.createElement('div');
    m.className = 'msg';
    m.innerHTML = (call.badge ? call.badge.emoji + ' ' : '') + esc(call.who) + ' · ' + esc(route(call)) + ' · <b>' + esc(call.proto || '') + '</b>';
    lane!.appendChild(m);
    requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('go')));
    setTimeout(() => {
      m.remove();
      land(call);
    }, 1500);
  }

  TC.onGlobe.push((m: GlobeDelta) => {
    let q = 0;
    for (const c of m.callList || []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (first) {
        land(c);
        continue;
      }
      if (q < 6) {
        setTimeout(() => fly(c), q * 220);
        q++;
      } else land(c);
    }
    first = false;
    if (seen.size > 5000) seen.clear();
  });
})();
