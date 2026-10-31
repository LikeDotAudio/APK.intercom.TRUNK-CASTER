// What the map remembers (sessionStorage) and the protocol/vendor filter.
// Keys are byte-identical to GLOBE_JS so a page switched to the TS bundle
// keeps the view a visitor already set.
//
//   global : globe.drag  globe.tilt  globe.zoom  globe.panx  globe.pany
//            globe.view  globe.focus
//   per page (suffix = pathname without trailing slash):
//            globe.mode<PAGE>  globe.layers<PAGE>  globe.hideproto<PAGE>  globe.hidevendor<PAGE>

import type { ColourView, GlobeNode, ViewMode } from './types.ts';

export const pageKey = (pathname: string): string => pathname.replace(/\/$/, '') || '/';

export class Session {
  constructor(
    readonly page: string,
    private readonly ss: Storage = sessionStorage,
  ) {}

  /** `sget`: a number, or `d` when unset. (Number('x') is NaN, as in the original.) */
  num(k: string, d: number): number {
    const v = this.ss.getItem('globe.' + k);
    return v === null ? d : Number(v);
  }
  /** Stores String(v): sessionStorage.setItem coerces numbers the same way. */
  set(k: string, v: string | number): void {
    this.ss.setItem('globe.' + k, String(v));
  }
  get(k: string): string | null {
    return this.ss.getItem('globe.' + k);
  }
  remove(k: string): void {
    this.ss.removeItem('globe.' + k);
  }
  /** `lget`: a per-page JSON array, else `d`. */
  list(k: string, d: readonly string[]): string[] {
    try {
      const v: unknown = JSON.parse(this.ss.getItem('globe.' + k + this.page) as string);
      return Array.isArray(v) ? (v as string[]) : [...d];
    } catch {
      return [...d];
    }
  }
  setList(k: string, v: Iterable<string>): void {
    this.ss.setItem('globe.' + k + this.page, JSON.stringify([...v]));
  }
  mode(): string | null {
    return this.ss.getItem('globe.mode' + this.page);
  }
  setMode(m: ViewMode): void {
    this.ss.setItem('globe.mode' + this.page, m);
  }
}

/**
 * GLOBE_JS keeps `mode` as whatever string it read. Every consumer treats a
 * non-'both', non-'map' value as the globe, so normalising is equivalent
 * except that the <select> now shows "round" instead of a blank option.
 */
export function parseMode(v: string | null | undefined): ViewMode | null {
  if (!v) return null;
  return v === 'both' || v === 'map' ? v : 'globe';
}

/**
 * GLOBE_JS keeps `view` as any string (from ?view=). An unknown value drew
 * the "uses" arcs under the "live" legend; normalised to 'uses' here.
 */
export function parseView(v: string | null | undefined): ColourView | null {
  if (!v) return null;
  return v === 'trend' || v === 'live' ? v : 'uses';
}

export const vendorOf = (n: GlobeNode): string => (n.badge && n.badge.vendor) || 'other';

/** The two filters: the page's GLOBE_FILTER (protocol ids) and the toolbar's hidden protocol names and vendors. */
export class Filter {
  readonly hidProto: Set<string>;
  readonly hidVendor: Set<string>;
  constructor(session: Session) {
    this.hidProto = new Set(session.list('hideproto', []));
    this.hidVendor = new Set(session.list('hidevendor', []));
  }
  hiddenByUser(n: GlobeNode): boolean {
    return this.hidProto.has(n.protoName) || this.hidVendor.has(vendorOf(n));
  }
  /** Read live every call: the aggregator page swaps window.GLOBE_FILTER on hover. */
  shown(n: GlobeNode): boolean {
    const f = window.GLOBE_FILTER;
    return !(f && f.size && !f.has(n.proto)) && !this.hiddenByUser(n);
  }
  /** Contributes to the continents cache key (by size only, as the original). */
  signature(): string {
    return this.hidProto.size + '|' + this.hidVendor.size + '|' + ((window.GLOBE_FILTER && window.GLOBE_FILTER.size) || 0);
  }
}
