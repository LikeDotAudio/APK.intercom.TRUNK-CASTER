// Continents page (html.rs continents_page): the discovery tree
// (`<script>{disc}</script>`) followed by the format!-built status hook
// that paints the "Lines" and "Continent to continent (live)" side panels.
import { initDiscovery } from '../lib/discovery.ts';
import type { StatusMessage } from '../wire.ts';

initDiscovery();

// Looks its elements up on every frame, so it survives refreshMain().
TC.onStatus.push((m: StatusMessage) => {
  const ct = document.getElementById('side-continents');
  if (ct && m.continents)
    ct.innerHTML =
      '<tr><th>From</th><th>To</th><th>Ocean</th><th>Calls</th></tr>' +
      m.continents
        .filter((c) => c.crossing)
        .map((c) => '<tr><td>' + esc(c.from) + '</td><td>' + esc(c.to) + '</td><td class="muted">' + esc(c.ocean || '') + '</td><td><b>' + c.calls + '</b></td></tr>')
        .join('');
  const ln = document.getElementById('side-lines');
  if (ln && m.lines) {
    ln.innerHTML = m.lines
      .slice(0, 40)
      .map((l) => {
        const pct = Math.max(0, Math.min(100, (l.left / l.lease) * 100));
        const cls = l.state === 'red' ? 'red' : l.state === 'parked' ? 'parked' : 'green';
        return (
          '<div class="line ' + cls + '"><div class="lbar"><i style="width:' + pct + '%"></i></div><span>' + (l.badge ? l.badge.emoji + ' ' : '') + esc(l.who) +
          '</span><span class="muted">' + esc((l.from_site || l.from) + ' → ' + (l.to_site || l.to)) + '</span><b>' +
          (l.state === 'parked' ? 'parked' : l.state === 'red' ? 'may be dead' : dur(l.left)) + '</b></div>'
        );
      })
      .join('');
    setText('side-count', m.lines.length + ' lines');
  }
});
