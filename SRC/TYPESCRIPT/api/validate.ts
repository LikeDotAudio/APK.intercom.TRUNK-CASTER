/** Structural checks for the catalogue's `check` entries (used by smoke.ts and tests). */
import type { Check } from './routes.ts';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function missing(v: unknown, keys: readonly string[] | undefined): string[] {
  if (!keys) return [];
  if (!isObj(v)) return ['<not an object>'];
  return keys.filter((k) => !(k in v));
}

/** Problems found; empty means the value matches the check. */
export function checkShape(v: unknown, c: Check): string[] {
  switch (c.type) {
    case 'string':
      return typeof v === 'string' ? [] : [`expected string, got ${typeof v}`];
    case 'object': {
      if (!isObj(v)) return [`expected object, got ${Array.isArray(v) ? 'array' : typeof v}`];
      return missing(v, c.keys).map((k) => `missing key ${k}`);
    }
    case 'array': {
      if (!Array.isArray(v)) return [`expected array, got ${typeof v}`];
      const first: unknown = v[0];
      if (first === undefined) return [];
      return missing(first, c.itemKeys).map((k) => `item[0] missing key ${k}`);
    }
    case 'record': {
      if (!isObj(v)) return [`expected object map, got ${typeof v}`];
      const first = Object.values(v)[0];
      if (first === undefined) return [];
      return missing(first, c.valueKeys).map((k) => `value missing key ${k}`);
    }
  }
}

/** Keys present on the value but not named by the check (drift the other way). */
export function extraKeys(v: unknown, c: Check): string[] {
  if (c.type === 'object' && isObj(v)) return Object.keys(v).filter((k) => !c.keys.includes(k));
  return [];
}
