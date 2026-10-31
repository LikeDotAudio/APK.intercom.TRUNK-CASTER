// Continent aggregation: one bubble per continent, one link per continent
// pair, worked out from the same frames, trunks and calls as every layer.
// Pure (no DOM) so it can be tested; the continents layer caches it.

import type { ContinentLink, ContinentNode } from './layer.ts';
import type { GlobeData, GlobeNode } from './types.ts';

export const CONT_AT: Readonly<Record<string, readonly [number, number]>> = {
  Europe: [50, 15],
  'North America': [45, -100],
  'South America': [-15, -60],
  Africa: [5, 20],
  'Middle East': [29, 45],
  Asia: [40, 90],
  Oceania: [-25, 135],
  Antarctica: [-80, 0],
};

export interface ContinentAgg {
  nodes: ContinentNode[];
  links: ContinentLink[];
}

/**
 * GLOBE_JS contAgg(). Differences, all deliberate:
 *  - a call with no hops is skipped (the original threw a TypeError here and
 *    killed the render loop for good).
 */
export function aggregateContinents(
  data: Pick<GlobeData, 'nodes' | 'trunkList' | 'callList' | 'history'>,
  byId: ReadonlyMap<string, GlobeNode>,
  shown: (n: GlobeNode) => boolean,
): ContinentAgg {
  const cs = new Map<string, ContinentNode>();
  const links = new Map<string, ContinentLink>();
  const cOf = (id: string): string | null => {
    const n = byId.get(id);
    return n && shown(n) ? n.cont : null;
  };
  for (const n of data.nodes) {
    if (!n.cont || !shown(n)) continue;
    let c = cs.get(n.cont);
    if (!c) {
      c = { name: n.cont, frames: 0, live: 0, la: 0, sx: 0, sy: 0, n: 0, homeTrunks: 0, homeCalls: 0, sites: new Set(), lat: 0, lon: 0 };
      cs.set(n.cont, c);
    }
    c.frames++;
    c.live += n.live || 0;
    c.sites.add(n.site);
    c.la += n.lat;
    c.sx += Math.cos((n.lon * Math.PI) / 180);
    c.sy += Math.sin((n.lon * Math.PI) / 180);
    c.n++;
  }
  for (const c of cs.values()) {
    const at = CONT_AT[c.name];
    if (at) {
      c.lat = at[0];
      c.lon = at[1];
    } else {
      c.lat = c.la / c.n;
      c.lon = (Math.atan2(c.sy, c.sx) * 180) / Math.PI;
    }
  }
  const L = (x: string, y: string): ContinentLink => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = a + '|' + b;
    let l = links.get(k);
    if (!l) {
      l = { a, b, trunks: 0, used: 0, cap: 0, calls: 0, uses: 0 };
      links.set(k, l);
    }
    return l;
  };
  for (const t of data.trunkList) {
    const a = cOf(t.a),
      b = cOf(t.b);
    if (!a || !b) continue;
    if (a === b) {
      const c = cs.get(a);
      if (c) c.homeTrunks++;
      continue;
    }
    const l = L(a, b);
    l.trunks++;
    l.used += t.used || 0;
    l.cap += t.cap || 0;
  }
  for (const c of data.callList) {
    const first = c.hops[0],
      last = c.hops[c.hops.length - 1];
    if (!first || !last) continue;
    const a = cOf(first[0]),
      b = cOf(last[1]);
    if (!a || !b) continue;
    if (a === b) {
      const n = cs.get(a);
      if (n) n.homeCalls++;
      continue;
    }
    L(a, b).calls++;
  }
  for (const h of data.history || []) {
    const a = cOf(h.a),
      b = cOf(h.b);
    if (!a || !b || a === b) continue;
    L(a, b).uses += h.uses || 0;
  }
  return { nodes: [...cs.values()], links: [...links.values()] };
}
