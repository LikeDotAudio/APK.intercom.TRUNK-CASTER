// Text helpers ported from html.rs: dur (479-489), dur_f (491-493),
// hm/hms (560-567), md_html (4153-4214).

import { escRust } from "./html.ts";
import { asU64, pad0, remEuclid, rustLines, rustTrimEnd } from "./rustfmt.ts";

/** 95 -> "1m 35s", 3700 -> "1h 01m". `secs` is a u64 (non-negative integer). */
export function dur(secs: number): string {
  const s = asU64(secs);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad0(s % 60, 2)}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${pad0(Math.floor((s % 3600) / 60), 2)}m`;
  return `${Math.floor(s / 86_400)}d ${pad0(Math.floor((s % 86_400) / 3600), 2)}h`;
}

/** dur of a float, clamped at 0 and truncated like `as u64`. */
export function durF(secs: number): string {
  return dur(asU64(Math.max(secs, 0)));
}

/** Rust `f64::round`: half away from zero (JS Math.round is half up). */
function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Hours of a clock as "HH:MM". Note: like the Rust, 23:59:30 or later
 * rounds to "24:00" (hm, unlike hms, has no `% 86_400`). */
export function hm(hours: number): string {
  const t = asU64(roundHalfAway(remEuclid(hours, 24) * 3600));
  return `${pad0(Math.floor(t / 3600), 2)}:${pad0(Math.floor((t % 3600) / 60), 2)}`;
}

/** Hours of a clock as "HH:MM:SS". */
export function hms(hours: number): string {
  const t = asU64(roundHalfAway(remEuclid(hours, 24) * 3600)) % 86_400;
  return `${pad0(Math.floor(t / 3600), 2)}:${pad0(Math.floor((t % 3600) / 60), 2)}:${pad0(t % 60, 2)}`;
}

function inline(t: string): string {
  const e = escRust(t);
  let out = "";
  let bold = false;
  let code = false;
  let i = 0;
  while (i < e.length) {
    if (e.startsWith("**", i)) {
      out += bold ? "</b>" : "<b>";
      bold = !bold;
      i += 2;
    } else if (e[i] === "`") {
      out += code ? "</code>" : "<code>";
      code = !code;
      i += 1;
    } else {
      out += e[i];
      i += 1;
    }
  }
  if (bold) out += "</b>";
  if (code) out += "</code>";
  return out;
}

/** The report's Markdown as HTML: `## `/`### ` headings, `- ` bullets,
 * **bold**, `code`; `# ` titles are dropped; everything is escaped first. */
export function mdHtml(md: string): string {
  let h = "";
  let inList = false;
  for (const line of rustLines(md)) {
    const l = rustTrimEnd(line);
    if (l.startsWith("- ")) {
      if (!inList) {
        h += "<ul>";
        inList = true;
      }
      h += `<li>${inline(l.slice(2))}</li>`;
      continue;
    }
    if (inList) {
      h += "</ul>";
      inList = false;
    }
    if (l.startsWith("### ")) h += `<h4>${inline(l.slice(4))}</h4>`;
    else if (l.startsWith("## ")) h += `<h3>${inline(l.slice(3))}</h3>`;
    else if (l.startsWith("# ")) {
      // The page already has the heading.
    } else if (l !== "") h += `<p>${inline(l)}</p>`;
  }
  if (inList) h += "</ul>";
  return h;
}
