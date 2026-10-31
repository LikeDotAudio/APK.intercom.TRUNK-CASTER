// The toolbar every map carries (#mapbar, data-keep so it survives
// refreshMain): view, colour, layer chips, protocol and vendor filter.
// Built once per element (data-built); markup identical to GLOBE_JS.

import { chipList } from './layer.ts';
import { vendorOf, type Filter, type Session } from './state.ts';
import type { GlobeNode } from './types.ts';

export function buildBar(nodes: readonly GlobeNode[], layers: Set<string>, filter: Filter, session: Session): void {
  const bar = document.getElementById('mapbar');
  if (!bar || bar.dataset['built']) return;
  bar.dataset['built'] = '1';
  const { hidProto, hidVendor } = filter;
  const protos = [...new Set(nodes.map((n) => n.protoName))].sort(),
    vendors = [...new Set(nodes.map(vendorOf))].sort();
  const chip = (k: string, l: string): string => '<button type="button" class="chip' + (layers.has(k) ? ' on' : '') + '" data-layer="' + k + '">' + l + '</button>';
  const box = (set: Set<string>, kind: string, v: string): string =>
    '<label><input type="checkbox" data-' + kind + '="' + esc(v) + '"' + (set.has(v) ? '' : ' checked') + '> ' + esc(v) + '</label>';
  bar.innerHTML =
    '<label>View <select id="g_proj"><option value="both">globe and flat map</option><option value="globe">round</option><option value="map">flat</option></select></label>' +
    '<label>Colour <select id="g_view"><option value="uses">times used</option><option value="trend">trend: days locked</option><option value="live">live only</option></select></label>' +
    '<span class="chips">' +
    chipList()
      .filter((c) => !c.when || c.when())
      .map((c) => chip(c.key, c.label))
      .join('') +
    '</span>' +
    '<details class="mfilter"><summary>Filter <span id="mfilter-n"></span></summary><div class="mf">' +
    '<div><b>Protocols</b> <a data-all="proto">all</a> · <a data-none="proto">none</a>' + protos.map((v) => box(hidProto, 'proto', v)).join('') + '</div>' +
    '<div><b>Vendors</b> <a data-all="vendor">all</a> · <a data-none="vendor">none</a>' + vendors.map((v) => box(hidVendor, 'vendor', v)).join('') + '</div></div></details>';
  const save = (): void => {
    session.setList('layers', layers);
    session.setList('hideproto', hidProto);
    session.setList('hidevendor', hidVendor);
    const n = hidProto.size + hidVendor.size;
    setText('mfilter-n', n ? '· ' + n + ' hidden' : '');
  };
  bar.querySelectorAll<HTMLElement>('[data-layer]').forEach((el) =>
    el.addEventListener('click', () => {
      const k = el.dataset['layer'] ?? '';
      if (layers.has(k)) layers.delete(k);
      else layers.add(k);
      el.classList.toggle('on', layers.has(k));
      save();
    }),
  );
  for (const [kind, set] of [
    ['proto', hidProto],
    ['vendor', hidVendor],
  ] as const) {
    bar.querySelectorAll<HTMLInputElement>('input[data-' + kind + ']').forEach((c) =>
      c.addEventListener('change', () => {
        const v = c.dataset[kind] ?? '';
        if (c.checked) set.delete(v);
        else set.add(v);
        save();
      }),
    );
    bar.querySelectorAll<HTMLElement>('[data-all="' + kind + '"],[data-none="' + kind + '"]').forEach((el) =>
      el.addEventListener('click', () => {
        const none = !!el.dataset['none'];
        bar.querySelectorAll<HTMLInputElement>('input[data-' + kind + ']').forEach((c) => {
          c.checked = !none;
          const v = c.dataset[kind] ?? '';
          if (none) set.add(v);
          else set.delete(v);
        });
        save();
      }),
    );
  }
  save();
}
