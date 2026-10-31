// Small helpers shared by every page script (html.rs JS const, top lines).
// All of these are globals in the original; see globals.ts.

/** Elements that carry a `.value` the helpers read. */
type Valued = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Put text (or pretty JSON) into `#id`. */
export function show(id: string, v: unknown): void {
  const el = document.getElementById(id);
  if (el) el.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/** `#id`'s value as a number; undefined when missing or empty. */
export function num(id: string): number | undefined {
  const el = document.getElementById(id) as Valued | null;
  if (!el || el.value === '') return undefined;
  return Number(el.value);
}

/** `#id`'s value; undefined when the element is missing. */
export function val(id: string): string | undefined {
  const el = document.getElementById(id) as Valued | null;
  return el ? el.value : undefined;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/**
 * HTML-escape for text and double-quoted attributes. Single quotes are NOT
 * escaped (faithful to the original): never use in '...' attributes.
 */
export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ESC[c] ?? c);
}

/** Seconds as `42s`, `3m 07s` or `2h 05m`. */
export function dur(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
}

/** Fractional hour (any range) as `HH:MM:SS`, wrapped into the day. */
export function fmtH(h: number): string {
  const t = Math.round((((h % 24) + 24) % 24) * 3600) % 86400;
  return (
    String(Math.floor(t / 3600)).padStart(2, '0') +
    ':' +
    String(Math.floor((t % 3600) / 60)).padStart(2, '0') +
    ':' +
    String(t % 60).padStart(2, '0')
  );
}

/** Set `#id`'s text only when it changed (no needless reflow). */
export function setText(id: string, t: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== t) el.textContent = t;
}

/** Wrap an hour into [0, 24). */
export function wrap24(h: number): number {
  return ((h % 24) + 24) % 24;
}

/** True when the element is a form field the user may be typing in. */
export function isTypingTarget(el: Element | null | undefined): boolean {
  return !!el && /INPUT|SELECT|TEXTAREA/.test(el.tagName);
}
