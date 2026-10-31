// Page-level constants. `REFRESH_MS` and `BUILD` are written by Rust `page()`
// (html.rs, the <script> in the <head>) as classic-script `const`s *before*
// the bundle, in the same <script> element:
//   <script>const REFRESH_MS=5000;const BUILD="abc";{JS}</script>
// Global lexical bindings are not properties of `window`, so they are read
// here as bare identifiers; esbuild leaves `declare`d names untouched.
declare const REFRESH_MS: number;
declare const BUILD: string;

/** Refresh period for `refreshMain`; 0 disables the timer. */
export function refreshMs(): number {
  return REFRESH_MS;
}

/** The build id the page was rendered with (`env!("TC_BUILD")`). */
export function build(): string {
  return BUILD;
}

/** Served over HTTP(S) by the runtime (vs. a static file:// snapshot). */
export const LIVE: boolean = location.protocol.startsWith('http');

/** Pop-out: `?pop=<section title>` shows that one section alone, still live. */
export const POP: string | null = new URLSearchParams(location.search).get('pop');
