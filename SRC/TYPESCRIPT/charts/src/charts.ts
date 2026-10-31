// Inline SVG charts ported from html.rs 4216-4368: line_chart, bar_chart,
// heat_matrix, nice_ceiling, fmt_num, topic_colour. Pure functions; output is
// byte-identical to the Rust for the same inputs (see test/charts.test.ts and
// golden/golden.json, produced by compiling the Rust functions themselves).
//
// One deliberate difference: the series colour is escaped here; Rust
// interpolates `{color}` raw. Identical for every colour the runtime passes
// ("var(--used)", "#hex").

import { escRust as e } from "./html.ts";
import { rustDisplay as d, rustFixed as f, rustMax, rustMin, utf8Len } from "./rustfmt.ts";

/** (label, css colour, values) — the Rust `(&str, &str, Vec<f64>)`. */
export type Series = readonly [label: string, color: string, values: readonly number[]];

/** Round up to 1, 2, 5 x 10^n. */
export function niceCeiling(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** Whole numbers and anything >= 100 without decimals, otherwise one decimal. */
export function fmtNum(v: number): string {
  const fract = v - Math.trunc(v);
  return fract === 0 || v >= 100 ? f(v, 0) : f(v, 1);
}

function foldMax(values: Iterable<number>): number {
  let m = 0;
  for (const v of values) m = rustMax(m, v);
  return m;
}

function* allValues(series: readonly Series[]): Generator<number> {
  for (const s of series) yield* s[2];
}

/** Inline SVG line chart. `xs` are seconds; `yMaxFixed` pins the y axis. */
export function lineChart(title: string, xs: readonly number[], series: readonly Series[], yMaxFixed?: number | null): string {
  const [w, h, pl, pr, pt, pb] = [960, 240, 48, 16, 28, 28];
  let out = `<svg viewBox="0 0 ${d(w)} ${d(h)}" width="100%" style="max-width:${d(w)}px;display:block;margin:8px 0" role="img" aria-label="${e(title)}">`;
  out += `<text x="${d(pl)}" y="16" style="font-weight:600">${e(title)}</text>`;
  const x0 = xs[0];
  const xl = xs[xs.length - 1];
  if (xs.length < 2 || x0 === undefined || xl === undefined) {
    return out + `<text x="${d(w / 2)}" y="${d(h / 2)}" text-anchor="middle">waiting for samples…</text></svg>`;
  }
  const x1 = rustMax(xl, x0 + 1e-9);
  const fixed = yMaxFixed ?? null;
  const y1 = fixed !== null ? fixed : niceCeiling(rustMax(foldMax(allValues(series)), 1));
  const sx = (x: number): number => pl + ((x - x0) / (x1 - x0)) * (w - pl - pr);
  const sy = (y: number): number => h - pb - rustMin(y / y1, 1) * (h - pt - pb);

  for (let i = 0; i <= 4; i++) {
    const yv = (y1 * i) / 4;
    const y = sy(yv);
    out += `<line class="grid" x1="${d(pl)}" x2="${d(w - pr)}" y1="${f(y, 1)}" y2="${f(y, 1)}"/><text x="${d(pl - 6)}" y="${f(y + 4, 1)}" text-anchor="end">${fmtNum(yv)}</text>`;
  }
  for (let i = 0; i <= 6; i++) {
    const xv = x0 + ((x1 - x0) * i) / 6;
    out += `<text x="${f(sx(xv), 1)}" y="${d(h - 8)}" text-anchor="middle">${fmtNum(xv)}s</text>`;
  }
  for (const [label, color, values] of series) {
    let path = "";
    const n = Math.min(xs.length, values.length);
    for (let i = 0; i < n; i++) {
      path += `${i === 0 ? "M" : "L"}${f(sx(xs[i] ?? 0), 1)},${f(sy(values[i] ?? 0), 1)} `;
    }
    out += `<path d="${path}" fill="none" stroke="${e(color)}" stroke-width="1.8" stroke-linejoin="round"><title>${e(label)}</title></path>`;
  }
  let lx = pl;
  for (const [label, color] of series) {
    out += `<rect x="${d(lx)}" y="${d(pt - 20)}" width="10" height="10" fill="${e(color)}"/><text x="${d(lx + 14)}" y="${d(pt - 11)}">${e(label)}</text>`;
    lx += 14 + utf8Len(label) * 6.5 + 18;
  }
  return out + "</svg>";
}

/** Grouped bars: one group per category, one bar per series. */
export function barChart(title: string, cats: readonly string[], series: readonly Series[]): string {
  const [w, h, pl, pr, pt, pb] = [960, 260, 48, 16, 28, 44];
  let out = `<svg viewBox="0 0 ${d(w)} ${d(h)}" width="100%" style="max-width:${d(w)}px;display:block;margin:8px 0" role="img" aria-label="${e(title)}">`;
  out += `<text x="${d(pl)}" y="16" style="font-weight:600">${e(title)}</text>`;
  if (cats.length === 0 || series.length === 0) {
    return out + `<text x="${d(w / 2)}" y="${d(h / 2)}" text-anchor="middle">nothing yet</text></svg>`;
  }
  const ymax = niceCeiling(rustMax(foldMax(allValues(series)), 1));
  const sy = (v: number): number => h - pb - rustMin(v / ymax, 1) * (h - pt - pb);
  for (let i = 0; i <= 4; i++) {
    const yv = (ymax * i) / 4;
    const y = sy(yv);
    out += `<line class="grid" x1="${d(pl)}" x2="${d(w - pr)}" y1="${f(y, 1)}" y2="${f(y, 1)}"/><text x="${d(pl - 6)}" y="${f(y + 4, 1)}" text-anchor="end">${fmtNum(yv)}</text>`;
  }
  const gw = (w - pl - pr) / cats.length;
  const bw = (gw * 0.8) / series.length;
  cats.forEach((cat, ci) => {
    const gx = pl + gw * ci + gw * 0.1;
    series.forEach(([label, color, vals], si) => {
      const v = vals[ci] ?? 0;
      const x = gx + bw * si;
      const y = sy(v);
      out += `<rect x="${f(x, 1)}" y="${f(y, 1)}" width="${f(rustMax(bw - 1.5, 1), 1)}" height="${f(rustMax(h - pb - y, 0), 1)}" fill="${e(color)}" rx="2"><title>${e(cat)}: ${fmtNum(v)} ${e(label)}</title></rect>`;
    });
    out += `<text x="${f(gx + gw * 0.4, 1)}" y="${d(h - 26)}" text-anchor="middle">${e(cat)}</text>`;
  });
  let lx = pl;
  for (const [label, color] of series) {
    out += `<rect x="${d(lx)}" y="${d(h - 14)}" width="10" height="10" fill="${e(color)}"/><text x="${d(lx + 14)}" y="${d(h - 5)}">${e(label)}</text>`;
    lx += 14 + utf8Len(label) * 6.5 + 18;
  }
  return out + "</svg>";
}

/** Local copy of TRUNK-CASTER-SDK/src/sites.rs:117 `ocean_between`
 * (dedup with agent 04's sdk once it lands). */
export function oceanBetween(a: string, b: string): string | null {
  if (a === b) return null;
  const [x, y] = a < b ? [a, b] : [b, a];
  const k = `${x}|${y}`;
  const table: Record<string, string> = {
    "Europe|North America": "North Atlantic",
    "North America|South America": "Caribbean",
    "Europe|South America": "South Atlantic",
    "Africa|South America": "South Atlantic",
    "Africa|Europe": "Mediterranean",
    "Africa|North America": "Atlantic",
    "Asia|North America": "North Pacific",
    "Asia|Europe": "Eurasian landline",
    "Africa|Asia": "Red Sea / Indian Ocean",
    "Asia|Oceania": "Pacific / Timor Sea",
    "North America|Oceania": "South Pacific",
    "Europe|Oceania": "Indian Ocean",
    "Africa|Oceania": "Indian Ocean",
    "Oceania|South America": "South Pacific",
    "Asia|South America": "Pacific",
    "Europe|Middle East": "Mediterranean / Black Sea",
    "Africa|Middle East": "Red Sea",
    "Asia|Middle East": "Arabian Sea",
    "Middle East|North America": "North Atlantic",
    "Middle East|Oceania": "Indian Ocean",
    "Middle East|South America": "South Atlantic",
  };
  return table[k] ?? "open ocean";
}

/** A symmetric heat matrix over the same labels on both axes. */
export function heatMatrix(title: string, labels: readonly string[], value: (a: string, b: string) => number): string {
  const n = Math.max(labels.length, 1);
  const [cell, left, top] = [54, 120, 110];
  const [w, h] = [left + cell * n + 12, top + cell * n + 12];
  let out = `<svg viewBox="0 0 ${f(w, 0)} ${f(h, 0)}" width="100%" style="max-width:${f(w, 0)}px;display:block;margin:8px 0" role="img" aria-label="${e(title)}">`;
  out += `<text x="8" y="16" style="font-weight:600">${e(title)}</text>`;
  let max = 0;
  for (const a of labels) for (const b of labels) max = rustMax(max, value(a, b));
  max = rustMax(max, 1);
  labels.forEach((a, i) => {
    out += `<text x="${f(left - 6, 0)}" y="${f(top + cell * i + cell / 2 + 4, 0)}" text-anchor="end">${e(a)}</text>`;
    const cx = f(left + cell * i + cell / 2, 0);
    const cy = f(top - 8, 0);
    out += `<text x="${cx}" y="${cy}" text-anchor="end" transform="rotate(-55 ${cx} ${cy})">${e(a)}</text>`;
    labels.forEach((b, j) => {
      const v = value(a, b);
      const alpha = v <= 0 ? 0.06 : 0.15 + 0.85 * (v / max);
      const ocean = oceanBetween(a, b) ?? "home";
      out += `<rect x="${f(left + cell * j + 2, 0)}" y="${f(top + cell * i + 2, 0)}" width="${f(cell - 4, 0)}" height="${f(cell - 4, 0)}" rx="4" fill="var(--used)" fill-opacity="${f(alpha, 2)}"><title>${e(a)} ↔ ${e(b)}: ${fmtNum(v)} calls · ${e(ocean)}</title></rect><text x="${f(left + cell * j + cell / 2, 0)}" y="${f(top + cell * i + cell / 2 + 4, 0)}" text-anchor="middle" style="fill:var(--ink);font-weight:600">${v > 0 ? fmtNum(v) : ""}</text>`;
    });
  });
  return out + "</svg>";
}

/** The header tabs in resistor-code order: [background, ink]. html.rs 4351-4364. */
export const TOPIC_COLOURS: readonly (readonly [bg: string, ink: string])[] = [
  ["#7b4a26", "#fff"], // brown
  ["#d32f2f", "#fff"], // red
  ["#f57c00", "#fff"], // orange
  ["#fbc02d", "#1b1f24"], // yellow
  ["#388e3c", "#fff"], // green
  ["#1976d2", "#fff"], // blue
  ["#7b1fa2", "#fff"], // violet
  ["#757575", "#fff"], // grey
  ["#f5f5f5", "#1b1f24"], // white
  ["#212121", "#fff"], // black
  ["#c9a227", "#1b1f24"], // gold
  ["#b0b6bc", "#1b1f24"], // silver
];

export function topicColour(i: number): readonly [bg: string, ink: string] {
  const c = TOPIC_COLOURS[i % TOPIC_COLOURS.length];
  if (!c) throw new RangeError(`topicColour(${i})`);
  return c;
}
