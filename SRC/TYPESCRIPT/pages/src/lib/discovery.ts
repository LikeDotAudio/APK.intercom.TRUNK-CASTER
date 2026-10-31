// Port of html.rs DISCOVERY_JS: the fold-out discovery tree
// (Global → continent → country → site → device) used by the Globe and
// Continents pages, and the device panel a device click opens.
//
// Faithful port. Non-null assertions (`!`) mark the places where the original
// would throw on a missing element; they compile to the same behaviour.

import type { ApiError, DeviceReply, TreeJson } from '../wire.ts';

/** Same test as the original `d.error` truthiness, as a type guard. */
const isApiError = (x: DeviceReply): x is ApiError => !!x.error;

export function initDiscovery(): void {
  // LATENT (preserved): `root` is looked up once. refreshMain() swaps <main>'s
  // innerHTML and never re-runs this script, so after the first in-place
  // refresh (Continents: every 8 s) render() paints a detached node and the
  // visible tree stays "loading…" with no click handlers. Fix: look up
  // #tree inside render(), or mark it `data-keep` (see HANDOFF.md).
  const root = document.getElementById('tree');
  if (!root) return;

  const st = (o: object, keys: readonly string[]): string => {
    const r = o as Record<string, unknown>;
    return (
      '<span class="st">' +
      keys
        .map((k) => (r[k] != null ? (k === 'load' ? '×' + Number(r[k]).toFixed(1) : String(r[k]) + ' ' + k.replace('_', ' ')) : ''))
        .filter(Boolean)
        .join(' · ') +
      '</span>'
    );
  };
  const openSet = new Set<string>(JSON.parse(sessionStorage.getItem('tree.open') || '[]') as string[]);
  const remember = (): void =>
    sessionStorage.setItem(
      'tree.open',
      JSON.stringify(Array.from(root.querySelectorAll<HTMLElement>('details[open]')).map((d) => d.dataset.k)),
    );
  const det = (k: string, title: string, stats: string, inner: string, open: boolean): string =>
    '<details data-k="' + esc(k) + '"' + (open ? ' open' : '') + '><summary><b>' + esc(title) + '</b>' + stats + '</summary>' + inner + '</details>';

  function render(t: TreeJson): void {
    let h =
      '<div class="note">Global · ' + t.global.sites + ' sites · ' + t.global.frames + ' frames · ' + t.global.calls + ' calls (' +
      t.global.parked + ' parked) · ' + t.global.trunks + ' trunks · ' + t.global.clock + ' UTC</div>';
    for (const c of t.continents) {
      const kc = 'c:' + c.continent;
      let inner = '';
      for (const k of c.children) {
        const kk = kc + '/' + k.country;
        let sinner = '';
        for (const s of k.children) {
          const ks = kk + '/' + s.site;
          const devs = s.devices
            .map(
              (d) =>
                '<a class="dev" data-id="' + esc(d.id) + '">' + (d.badge ? d.badge.emoji + ' ' : '') + esc(d.id) + ' <span class="muted">' +
                esc(d.protocol) + '</span>' + st(d, ['calls', 'parked', 'panels_live']) +
                (d.sim === true ? ' <span class="ok">●</span>' : d.sim === false ? ' <span class="warn">○</span>' : '') + '</a>',
            )
            .join('');
          sinner += det(ks, s.site + (s.tier ? ' (' + s.tier + ')' : ''), st(s, ['local_clock', 'load', 'frames', 'calls', 'parked']), devs, openSet.has(ks));
        }
        inner += det(kk, k.country, st(k, ['sites', 'frames', 'calls', 'parked']), sinner, openSet.has(kk));
      }
      h += det(kc, c.continent, st(c, ['countries', 'frames', 'calls', 'parked', 'panels_live']), inner, openSet.has(kc));
    }
    root!.innerHTML = h;
    root!.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', remember));
    root!.querySelectorAll<HTMLAnchorElement>('a.dev').forEach((a) => a.addEventListener('click', () => void showDevice(String(a.dataset.id))));
  }

  let selected = sessionStorage.getItem('tree.device');

  async function showDevice(id: string): Promise<void> {
    selected = id;
    sessionStorage.setItem('tree.device', id);
    // NOTE: http.rs does not percent-decode the path, so an id that
    // encodeURIComponent changes (space, '/', non-ASCII) would 404.
    const d = (await api('/api/device/' + encodeURIComponent(id))) as DeviceReply | null;
    if (!d || isApiError(d)) return;
    const p = document.getElementById('device-panel')!;
    const body = document.getElementById('device-body')!;
    p.style.display = 'block';
    document.getElementById('device-title')!.textContent = (d.frame.badge ? d.frame.badge.emoji + ' ' : '') + d.frame.id + ' · ' + d.frame.protocol_name;
    const f = d.frame;
    const tiles: [string, string][] = [
      ['site', f.site || '—'],
      ['local clock', d.local_clock || '—'],
      ['load', d.load ? '×' + d.load.toFixed(1) : '—'],
      ['casters free', f.free_casters + '/' + f.casters],
      ['panels live', Object.keys(f.live_ports || {}).length + '/' + f.user_ports],
      ['since last', f.seconds_since_last_connection != null ? dur(f.seconds_since_last_connection) + ' ago' : 'never'],
    ];
    let h = '<div class="tiles">' + tiles.map(([k, v]) => '<div class="tile"><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>';
    if (d.remote)
      h += '<p class="note">simulator ' + (d.remote.connected ? '● connected' : '○ gone') + ' · ' + d.remote.acks + ' acks · reports ' + d.remote.reported_closed + ' crosspoints</p>';
    h +=
      '<h3>Its lines</h3>' +
      (d.lines.length
        ? '<table>' +
          d.lines
            .map(
              (l) =>
                '<tr><td class="' + (l.state === 'red' ? 'bad' : l.state === 'parked' ? 'muted' : 'ok') + '">' + l.state + '</td><td>' + esc(l.who) +
                '</td><td class="muted">' + l.role + '</td><td>' + esc(l.from) + ' → ' + esc(l.to) + '</td><td>' + dur(l.connected_for) + '</td><td>' +
                (l.state === 'green' ? dur(l.left) + ' left' : '') + '</td></tr>',
            )
            .join('') +
          '</table>'
        : '<p class="muted">no lines</p>');
    h +=
      '<h3>Its trunks</h3>' +
      (d.trunks.length
        ? '<table>' +
          d.trunks
            .map(
              (t) =>
                // LATENT (preserved): caster is Option<usize>; null prints "Cnull".
                '<tr><td>C' + t.caster + '</td><td>→ ' + esc(t.peer) + '</td><td>' + t.used + '/' + t.capacity + ' ch</td><td>' +
                (t.gain ? t.gain.toFixed(1) + ' dB' : '') + '</td></tr>',
            )
            .join('') +
          '</table>'
        : '<p class="muted">no trunks up</p>');
    const labels = Object.entries(d.labels || {});
    if (labels.length)
      h +=
        '<h3>Panel names</h3><table>' +
        labels.map(([p, l]) => '<tr><td>' + p + '</td><td><code>' + esc(l.l6) + '</code></td><td><code>' + esc(l.l8) + '</code></td><td><code>' + esc(l.l16) + '</code></td></tr>').join('') +
        '</table>';
    h +=
      '<h3>Its timeline</h3>' +
      (d.events.length
        ? '<div class="scroll" style="max-height:220px"><table>' +
          d.events
            .map(
              (e) =>
                '<tr><td class="muted">' + esc(e.when.slice(11, 19)) + '</td><td>' + esc(e.who) + '</td><td>' + esc(e.from) + ' → ' + esc(e.whom) +
                '</td><td class="status-' + e.status + '">' + e.status + '</td><td>' + (e.lasted != null ? dur(e.lasted) : '') + '</td></tr>',
            )
            .join('') +
          '</table></div>'
        : '<p class="muted">nothing recorded yet</p>');
    body.innerHTML = h;
  }

  async function load(): Promise<void> {
    try {
      const t = (await api('/api/tree')) as TreeJson | null;
      if (t && t.continents) {
        cacheSet('tree', t);
        render(t);
      }
    } catch (e) {
      /* swallowed, as the original */
    }
    if (selected && document.getElementById('device-panel')!.style.display !== 'none') void showDevice(selected);
  }

  const cached = cacheGet('tree') as TreeJson | null;
  if (cached) render(cached);
  void load();
  setInterval(load, 6000);
  if (selected) void showDevice(selected);
}
