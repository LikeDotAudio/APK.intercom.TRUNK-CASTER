// localStorage cache under the `tc:` prefix, flushed when a new build serves.
import { build } from './env.ts';

export function cacheGet<T = unknown>(k: string): T | null {
  try {
    // getItem's null parses to null, as in the original JSON.parse(null).
    return JSON.parse(localStorage.getItem('tc:' + k) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

export function cacheSet(k: string, v: unknown): void {
  try {
    localStorage.setItem('tc:' + k, JSON.stringify(v));
  } catch {
    /* quota or blocked storage: the cache is best effort */
  }
}

/** A new version is serving: drop everything cached under tc: and remember the build. */
export function cacheFlush(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tc:')) localStorage.removeItem(k);
    }
    localStorage.setItem('tc:build', JSON.stringify(build()));
  } catch {
    /* blocked storage */
  }
}
