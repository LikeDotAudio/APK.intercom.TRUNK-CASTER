// HTML and overlay text around the map: tooltips, the legend, the trend list
// (#side-trends) and the side tables (#side-continents, #side-lines).
// Strings are byte-for-byte what GLOBE_JS builds; esc/dur/setText are the
// page's globals.

import type { ContHit, TrunkRec } from './layer.ts';
import { fmtN, streakColor, tkey, useColor } from './math.ts';
import type { ColourView, GlobeNode, StatusMessage, TrunkHistory } from './types.ts';


/** Frame tooltip. */
export function frameTip(n: GlobeNode): string {
  const b = n.badge ? n.badge.emoji + ' ' + n.badge.vendor + ' · ' : '';
  return (
    '<b>' +
    esc(b + n.id) +
    '</b><br>' +
    esc(n.protoName + (n.site ? ' · ' + n.site : '')) +
    '<br>' +
    esc(n.ports + '+' + n.cas + ' ports · ' + n.free + ' casters free · ' + n.live + ' panels live') +
    (n.load ? '<br>load ×' + n.load.toFixed(1) : '') +
    (n.sim === true ? '<br>simulator ●' : n.sim === false ? '<br>simulator ○' : '') +
    (n.who && n.who.length ? '<br>' + n.who.map(esc).join('<br>') : '')
  );
}

/** Trunk tooltip: uses, live channels, lock streak, usual lock hours. */
export function trunkTip(r: TrunkRec, siteOf: (id: string) => string): string {
  const h: Partial<TrunkHistory> = r.hist || {},
    lv = r.live;
  const a = lv ? lv.a : h.a,
    b = lv ? lv.b : h.b;
  const uses = (lv && lv.uses) || h.uses || 0;
  let s =
    '<b>' +
    esc(siteOf(a as string)) +
    ' ↔ ' +
    esc(siteOf(b as string)) +
    '</b><br><span class="muted">' +
    esc(a) +
    ' ↔ ' +
    esc(b) +
    '</span><br>used <b>' +
    uses.toLocaleString() +
    '</b> time' +
    (uses === 1 ? '' : 's');
  if (lv) s += '<br>up now · ' + lv.used + '/' + lv.cap + ' channels';
  if (h.streak) s += '<br>locked <b>' + h.streak + ' day' + (h.streak > 1 ? 's' : '') + ' running</b>' + (h.lt ? ' (today too)' : '');
  else if (h.ld) s += '<br>locked ' + h.ld + ' of the last ' + (h.d ? h.d.length : 0) + ' days';
  if (h.longest) s += '<br>longest hold ' + dur(h.longest);
  if (h.lh) {
    const hrs = h.lh
      .map((c, i) => [c, i] as const)
      .filter((x) => x[0] > 0)
      .sort((x, y) => y[0] - x[0])
      .slice(0, 3)
      .map((x) => String(x[1]).padStart(2, '0') + ':00');
    if (hrs.length) s += '<br>usually locked at ' + hrs.join(', ');
  }
  return s + '<br><span class="muted">click to follow it</span>';
}

/** Continent bubble or continent-pair link tooltip. */
export function continentTip(best: ContHit): string {
  if (best.kind === 'node') {
    const c = best.c,
      out = best.links.filter((l) => l.a === c.name || l.b === c.name).sort((x, y) => y.trunks - x.trunks);
    return (
      '<b>' +
      esc(c.name) +
      '</b><br>' +
      c.sites.size +
      ' sites · ' +
      c.frames +
      ' frames · ' +
      c.live +
      ' panels live<br>at home: ' +
      c.homeTrunks +
      ' trunks · ' +
      c.homeCalls +
      ' calls' +
      (out.length
        ? '<br><br>trunks out:<br>' +
          out.map((l) => esc(l.a === c.name ? l.b : l.a) + ': <b>' + l.trunks + '</b> up · ' + l.calls + ' calls · used ' + Number(l.uses).toLocaleString() + '×').join('<br>')
        : '<br>no trunks to other continents')
    );
  }
  const l = best.l;
  return '<b>' + esc(l.a) + ' ↔ ' + esc(l.b) + '</b><br>' + l.trunks + ' trunks up · ' + l.used + '/' + l.cap + ' channels<br>' + l.calls + ' calls<br>used <b>' + Number(l.uses).toLocaleString() + '</b> times';
}

/** The colour key, bottom left. */
export function drawLegend(ctx: CanvasRenderingContext2D, W: number, H: number, view: ColourView, lockHours: number): void {
  const x0 = 14,
    y0 = H - 58,
    w = Math.min(300, W * 0.3);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(x0 - 8, y0 - 20, w + 16, 62);
  ctx.globalAlpha = 1;
  ctx.font = '600 11px system-ui';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#cfd8e6';
  if (view === 'trend') {
    ctx.fillText('Days in a row a trunk was locked (' + (lockHours || 1) + ' h or more)', x0, y0 - 6);
    const steps = [1, 2, 3, 5, 7];
    const sw = w / steps.length;
    steps.forEach((s, i) => {
      ctx.fillStyle = streakColor(s);
      ctx.fillRect(x0 + i * sw, y0, sw - 2, 10);
      ctx.fillStyle = '#9fb0cc';
      ctx.font = '10px system-ui';
      ctx.fillText(s + (i === steps.length - 1 ? '+ days' : s === 1 ? ' day' : ''), x0 + i * sw, y0 + 24);
    });
    ctx.fillText('pulsing: locked today · label: days running', x0, y0 + 36);
  } else if (view === 'uses') {
    ctx.fillText('Times each trunk was used', x0, y0 - 6);
    const g = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    for (let i = 0; i <= 20; i++) g.addColorStop(i / 20, useColor(Math.pow(10, i / 4)));
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, w, 10);
    ctx.fillStyle = '#9fb0cc';
    ctx.font = '10px system-ui';
    ['1', '10', '100', '1k', '10k', '100k'].forEach((l, i) => {
      ctx.textAlign = i === 0 ? 'left' : i === 5 ? 'right' : 'center';
      ctx.fillText(l, x0 + (w * i) / 5, y0 + 24);
    });
    ctx.textAlign = 'left';
    ctx.fillText('bright: up now · faint: used before · ring: locked days running', x0, y0 + 36);
  } else {
    ctx.fillText('Trunks up now, width by channels in use', x0, y0 - 6);
  }
}

/** The trend list beside the map (#side-trends): the habits first. */
export function renderTrends(
  history: readonly TrunkHistory[],
  view: ColourView,
  focus: string | null,
  lockHours: number,
  siteOf: (id: string) => string,
  onPick: (k: string) => void,
): void {
  const el = document.getElementById('side-trends');
  if (!el) return;
  const all = history;
  const rows = (view === 'trend' ? all.filter((h) => h.ld > 0) : all.slice().sort((a, b) => b.uses - a.uses)).slice(0, 30);
  setText('trend-count', all.filter((h) => h.ld > 0).length + ' locked · ' + all.length + ' trunks used');
  if (!rows.length) {
    el.innerHTML =
      '<p class="muted">' +
      (view === 'trend' ? 'No trunk locked yet. ' : 'No trunk history yet. ') +
      'Every call that rides a trunk is counted; a call held ' +
      (lockHours || 1) +
      ' h or more locks it for the day.</p>';
    return;
  }
  el.innerHTML = rows
    .map((h) => {
      const k = tkey(h.a, h.b);
      const mx = Math.max(1, ...h.d);
      const bw = 100 / h.d.length;
      const spark =
        '<svg viewBox="0 0 100 22" preserveAspectRatio="none" class="spark">' +
        h.d
          .map((v, i) => {
            const hgt = Math.max(v ? 2 : 0.6, (v / mx) * 20);
            const locked = h.l[i];
            const held = h.hh && h.hh[i];
            return (
              '<rect x="' + (i * bw + 0.4).toFixed(1) + '" y="' + (22 - hgt).toFixed(1) + '" width="' + (bw - 0.8).toFixed(1) + '" height="' + hgt.toFixed(1) +
              '" fill="' + (locked ? streakColor(Math.max(1, h.streak)) : '#5a9bff') + '" opacity="' + (locked ? 1 : 0.55) + '"><title>' +
              (h.d.length - 1 - i === 0 ? 'today' : h.d.length - 1 - i + ' days ago') + ': ' + v + ' uses' +
              (held ? ' · ' + held + ' h held' : '') + (locked ? ' · locked' : '') + '</title></rect>'
            );
          })
          .join('') +
        '</svg>';
      const clock =
        '<div class="lockclock" title="Hours of the day it was locked, over the last ' + h.d.length + ' days">' +
        h.lh
          .map(
            (c, i) =>
              '<i style="opacity:' + (c ? 0.25 + (0.75 * c) / h.d.length : 0.08) + ';background:' + (c ? streakColor(Math.max(1, h.streak)) : 'var(--muted)') +
              '" title="' + String(i).padStart(2, '0') + ':00 · locked ' + c + ' of ' + h.d.length + ' days"></i>',
          )
          .join('') +
        '</div>';
      return (
        '<div class="trend' + (focus === k ? ' on' : '') + '" data-k="' + esc(k) + '"><div class="tt"><b>' + esc(siteOf(h.a)) + '</b> ↔ <b>' + esc(siteOf(h.b)) +
        '</b> <span class="muted">' + esc(h.a) + ' · ' + esc(h.b) + '</span></div><div class="tn"><span class="uses" style="background:' + useColor(h.uses) + '">' +
        fmtN(h.uses) + '×</span>' +
        (h.streak
          ? '<span class="streak" style="background:' + streakColor(h.streak) + '">' + (h.lt ? '🔒 ' : '') + h.streak + ' day' + (h.streak > 1 ? 's' : '') + ' locked</span>'
          : h.ld
            ? '<span class="muted">' + h.ld + ' of ' + h.d.length + ' days locked</span>'
            : '') +
        '</div>' + spark + clock + '</div>'
      );
    })
    .join('');
  el.querySelectorAll<HTMLElement>('.trend').forEach((d) => d.addEventListener('click', () => onPick(d.dataset['k'] ?? '')));
}

/** Totals beside the map: continent to continent, and every line's lease. */
export function renderSide(m: StatusMessage): void {
  const ct = document.getElementById('side-continents');
  if (ct && m.continents) {
    const cross = m.continents.filter((c) => c.crossing),
      home = m.continents.filter((c) => !c.crossing);
    ct.innerHTML =
      '<tr><th>From</th><th>To</th><th>Ocean</th><th>Calls</th></tr>' +
      cross
        .map(
          (c) =>
            '<tr><td>' + esc(c.from) + '</td><td>' + esc(c.to) + '</td><td class="muted">' + esc(c.ocean || '') + '</td><td><b>' + c.calls + '</b>' +
            (c.muted ? ' <span class="muted">(' + c.muted + ' parked)</span>' : '') + '</td></tr>',
        )
        .join('') +
      (home.length
        ? '<tr><th colspan=4 style="padding-top:8px">Within a continent</th></tr>' + home.map((c) => '<tr><td colspan=3>' + esc(c.from) + '</td><td><b>' + c.calls + '</b></td></tr>').join('')
        : '');
  }
  const ln = document.getElementById('side-lines');
  if (ln && m.lines) {
    ln.innerHTML = m.lines
      .slice(0, 40)
      .map((l) => {
        const pct = Math.max(0, Math.min(100, (l.left / l.lease) * 100));
        const cls = l.state === 'red' ? 'red' : l.state === 'parked' ? 'parked' : 'green';
        return (
          '<div class="line ' + cls + '" title="' + esc(l.id) + '"><div class="lbar"><i style="width:' + pct + '%"></i></div><span>' + (l.badge ? l.badge.emoji + ' ' : '') +
          esc(l.who) + '</span><span class="muted">' + esc((l.from_site || l.from) + ' → ' + (l.to_site || l.to)) + '</span><b>' +
          (l.state === 'parked' ? 'parked' : l.state === 'red' ? 'may be dead' : dur(l.left)) + '</b></div>'
        );
      })
      .join('');
    setText('side-count', m.lines.length + (m.status && m.status.connections > m.lines.length ? ' of ' + m.status.connections : '') + ' lines');
  }
  if (m.run) setText('side-run', m.run.id + ' · ' + m.run.summary.granted + ' granted · ' + m.run.summary.denied + ' denied · peak ' + m.run.summary.peak_live);
}
