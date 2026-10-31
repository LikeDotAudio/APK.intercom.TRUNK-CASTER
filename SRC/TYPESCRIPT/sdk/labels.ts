/**
 * Panel labels — port of TRUNK-CASTER-SDK/src/labels.rs.
 *
 * Intercom panels show a name in 6, 8 or 16 characters, so every person
 * gets all three cuts, with full emoji support: an emoji (with its skin
 * tone, variation selector, ZWJ sequence or flag pair) counts as one
 * character, never as several and never split in half.
 *
 * The splitter is a faithful copy of the Rust heuristic, NOT Intl.Segmenter:
 * the TS and Rust sides must cut names identically, and Intl.Segmenter
 * (full UAX #29) disagrees with labels.rs on e.g. Hangul jamo, Indic
 * spacing marks and prepend characters. Iteration is by code point
 * (`for…of`), matching Rust's `str::chars()`.
 */

/** Serialized as-is by serde (no rename): all fields always present. */
export interface Label {
  full: string;
  /** Six-character panels. */
  l6: string;
  /** Eight-character panels. */
  l8: string;
  /** Sixteen-character panels. */
  l16: string;
  /** Length of `full` in panel characters (grapheme clusters). Rust `usize`. */
  chars: number;
  /** True when a 6-character panel cannot show the whole name. */
  over6: boolean;
  over8: boolean;
  over16: boolean;
}

/** Panel widths the label set is cut for. */
export const PANEL_WIDTHS = [6, 8, 16] as const;
export type PanelWidth = (typeof PANEL_WIDTHS)[number];

/**
 * Rust `str::trim()` trims Unicode White_Space. JS `String.prototype.trim`
 * additionally trims U+FEFF (BOM). Use this to stay byte-identical.
 */
export function rustTrim(s: string): string {
  const cps = Array.from(s);
  let a = 0;
  let b = cps.length;
  while (a < b && isRustWhitespace(cps[a] ?? "")) a++;
  while (b > a && isRustWhitespace(cps[b - 1] ?? "")) b--;
  return a === 0 && b === cps.length ? s : cps.slice(a, b).join("");
}

/** Unicode White_Space (Rust `char::is_whitespace`). Excludes U+FEFF, unlike JS `trim`. */
function isRustWhitespace(c: string): boolean {
  const u = c.codePointAt(0) ?? -1;
  return (
    (u >= 0x09 && u <= 0x0d) ||
    u === 0x20 ||
    u === 0x85 ||
    u === 0xa0 ||
    u === 0x1680 ||
    (u >= 0x2000 && u <= 0x200a) ||
    u === 0x2028 ||
    u === 0x2029 ||
    u === 0x202f ||
    u === 0x205f ||
    u === 0x3000
  );
}

function isCombining(u: number): boolean {
  return (
    (u >= 0x0300 && u <= 0x036f) || // combining diacritics
    (u >= 0x1ab0 && u <= 0x1aff) ||
    (u >= 0x1dc0 && u <= 0x1dff) ||
    (u >= 0x20d0 && u <= 0x20ff) ||
    (u >= 0xfe00 && u <= 0xfe0f) || // variation selectors (emoji presentation)
    (u >= 0xfe20 && u <= 0xfe2f) ||
    (u >= 0x1f3fb && u <= 0x1f3ff) || // skin tone modifiers
    (u >= 0xe0020 && u <= 0xe007f) || // tag sequences (subdivision flags)
    u === 0x200c || // zero width non-joiner
    u === 0x200d // zero width joiner glues to the previous...
  );
}

function isRegionalIndicator(u: number): boolean {
  return u >= 0x1f1e6 && u <= 0x1f1ff;
}

/**
 * Split into grapheme clusters: good enough for names and emoji without a
 * Unicode database. Handles combining marks, variation selectors, skin
 * tones, ZWJ sequences (👨‍👩‍👧), flags (🇺🇸) and CRLF.
 */
export function graphemes(s: string): string[] {
  const out: string[] = [];
  let joinNext = false;
  let pendingFlag = false;
  for (const c of s) {
    const u = c.codePointAt(0) ?? 0;
    const glue: boolean =
      joinNext ||
      isCombining(u) ||
      (pendingFlag && isRegionalIndicator(u)) ||
      (c === "\n" && out.length > 0 && out[out.length - 1] === "\r");
    if (glue && out.length > 0) {
      out[out.length - 1] += c;
    } else {
      out.push(c);
    }
    joinNext = u === 0x200d; // ...and the character after it joins too
    pendingFlag = isRegionalIndicator(u) && !glue;
  }
  return out;
}

/** First `n` panel characters of `s` (trimmed first, like Rust `fit`). */
export function fit(s: string, n: number): string {
  return graphemes(rustTrim(s)).slice(0, n).join("");
}

/** Number of panel characters in `s` (not trimmed, like Rust `width`). */
export function width(s: string): number {
  return graphemes(s).length;
}

/** Derive every cut from the full name (`Label::new`). */
export function makeLabel(fullIn: string): Label {
  const full = rustTrim(fullIn);
  const g = graphemes(full);
  const cut = (n: number): string => g.slice(0, n).join("");
  return {
    full,
    l6: cut(6),
    l8: cut(8),
    l16: cut(16),
    chars: g.length,
    over6: g.length > 6,
    over8: g.length > 8,
    over16: g.length > 16,
  };
}

/**
 * Derive, then apply explicit overrides, each trimmed to its width
 * (`Label::with_overrides`). `null`/`undefined` = no override, mirroring
 * `Option<&str>`. Note: `over*` and `chars` still describe `full`.
 */
export function labelWithOverrides(
  full: string,
  l6?: string | null,
  l8?: string | null,
  l16?: string | null,
): Label {
  const l = makeLabel(full);
  if (l6 != null) l.l6 = fit(l6, 6);
  if (l8 != null) l.l8 = fit(l8, 8);
  if (l16 != null) l.l16 = fit(l16, 16);
  return l;
}

/** The label for a panel of `width` characters (`Label::for_width`). */
export function labelForWidth(label: Label, w: number): string {
  if (w <= 6) return label.l6;
  if (w <= 8) return label.l8;
  return label.l16;
}
