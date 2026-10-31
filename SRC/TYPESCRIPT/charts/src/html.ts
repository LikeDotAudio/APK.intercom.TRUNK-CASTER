// Auto-escaping HTML tagged template. Every interpolated value is escaped
// unless it is a SafeHtml (made by html`` itself or by raw()). This is the
// TS answer to the 1 000+ hand-written `format!`/`write!` sites in html.rs,
// where escaping is opt-in (`esc(..)`) and therefore easy to forget.

const SAFE: unique symbol = Symbol("SafeHtml");

/** A string that is already HTML. Only html`` and raw() make one. */
export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
  toString(): string;
}

function safe(value: string): SafeHtml {
  return { [SAFE]: true, value, toString: () => value };
}

export function isSafeHtml(v: unknown): v is SafeHtml {
  return typeof v === "object" && v !== null && (v as { [SAFE]?: unknown })[SAFE] === true;
}

/** Escape hatch: trust `s` as HTML. Grep for raw( in review. */
export function raw(s: string): SafeHtml {
  return safe(s);
}

/** Byte-for-byte `util::esc` from the Rust runtime: & < > " only.
 * Use only where output must equal the Rust output; it does NOT escape `'`,
 * so values inside onclick="f('{v}')" can break out of the JS string. */
export function escRust(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Safe default: escRust plus `'`, so values are safe in single-quoted
 * attributes and single-quoted JS strings inside attributes. */
export function esc(s: string): string {
  return escRust(s).replaceAll("'", "&#39;");
}

/** Anything a template hole accepts. Numbers are stringified with String();
 * format Rust-style numbers with rustFixed/rustDisplay before interpolating. */
export type Hole = SafeHtml | string | number | boolean | null | undefined | readonly Hole[];

function render(v: Hole, escape: (s: string) => string): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map((x: Hole) => render(x, escape)).join("");
  if (isSafeHtml(v)) return v.value;
  return escape(String(v));
}

export type HtmlTag = (strings: TemplateStringsArray, ...values: readonly Hole[]) => SafeHtml;

/** Build a tag with a given escaper. */
export function htmlWith(escape: (s: string) => string): HtmlTag {
  return (strings, ...values) => {
    let out = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) {
      out += render(values[i], escape) + (strings[i + 1] ?? "");
    }
    return safe(out);
  };
}

/** The tag new code should use: escapes & < > " '. */
export const html: HtmlTag = htmlWith(esc);

/** Parity tag: escapes exactly like Rust `esc` (no `'`). Only for byte-identical ports. */
export const htmlCompat: HtmlTag = htmlWith(escRust);

/** Join fragments. A string separator is escaped; pass raw() for markup. */
export function join(parts: readonly SafeHtml[], sep: SafeHtml | string = ""): SafeHtml {
  const s = typeof sep === "string" ? esc(sep) : sep.value;
  return safe(parts.map((p) => p.value).join(s));
}
