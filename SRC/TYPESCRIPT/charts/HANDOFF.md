# Area 09 of 10: server-side rendering in html.rs (charts, helpers, page bodies)

**Verdict: PARTIAL.** Keep Rust SSR for the page chrome (`page()`), the static
snapshot files and first paint. Move the *pure* renderers (charts, md, time
formats) and page **bodies** to TS, rendered client-side from the JSON the
runtime already serves, through an auto-escaping `html` tagged template. The
ports here are byte-identical to the Rust (proved against the compiled Rust),
so the swap can be done one page at a time with no visual diff.

Independently of TS, html.rs has three escaping classes that should be fixed in
Rust now (see Findings 1 to 3), because they are exploitable through the public
`/api/request` and `/api/rename` endpoints.

## Scope

Audited against the working copy of `RUST-RUNTIME/src/html.rs` on 2026-10-21
(4482 lines; it is being edited concurrently, so lines drift by about 20
from the 4462-line version first read).

| Range (4482-line snapshot) | What |
|---|---|
| 412-467 | `page()` chrome: nav, header, footer, status |
| 469-471, 482-497, 563-570 | `tile`, `dur`, `dur_f`, `hm`, `hms` |
| 498-561 | `ago`, `route_str`, `connections_table` |
| 578-692 | `day_timeline` (footer strip SVG) |
| 703-841 | `index_page` |
| 842-1008 | `usage_page` |
| 1009-1570 | `globe_data`, `map_block` (JSON into `<script>`) |
| 1571-1976 | `globe_page`, `panels_page`, `light_of`, `lights_json` |
| 1977-2121 | `booking_local`, `booking_gantt`, `gantt_legend`, `bookings_table`, `timeline_dropdown` |
| 2122-2422 | `panel_editor_page`, `analyzer_page` |
| 2423-2935 | `continents_page`, `space_page`, `overlord_page` |
| 2936-3326 | `racks_page`, `relay_page` |
| 3327-3437 | `users_page` (ported as proof) |
| 3445-3826 | `global_crosspoint`, `crosspoints_page` |
| 3827-4171 | `simulator_page` |
| 4172-4384 | `md_html`, `line_chart`, `bar_chart`, `heat_matrix`, `nice_ceiling`, `fmt_num`, `TOPIC_COLOURS`, `topic_colour` (ported exactly) |
| `util.rs` 141-146 | `esc` |
| `TRUNK-CASTER-SDK/src/sites.rs` 117-144 | `ocean_between` (used by `heat_matrix`) |

## Site count (tools/count-html-sites.ts, string-aware lexer over html.rs)

```
format!/write! with a literal format string: 313 (format! 114, write! 199)
  ...that emit HTML/SVG markup: 223
interpolated holes in those: 1213
  escaped       348   (esc(..) somewhere in the expression)
  numeric-spec  188   ({:.1}, {:02}, ...)
  number-like    66
  html-helper   121   (tile(), bar_chart(), dur(), ... already-built HTML)
  literal        59
  unresolved    431   (raw, needs a human)
HTML sites with >= 1 unresolved raw hole: 149
```

Hand triage of the 431 unresolved: about 380 are numbers, SVG geometry
(`pl`, `top`, `w - pr`), pre-built fragments (`svg`, `cs`, `how`, `chart1`) or
compile-time constants (`CSS`, `GLOBE_JS`). The rest are the findings below.
Escaping is opt-in per hole; 348 of 1213 holes call `esc`, so the safety of the
remaining 865 rests on reviewers knowing each value's provenance.

## Findings

1. **HIGH: JSON embedded in `<script>` without `</` escaping (stored XSS).**
   `map_block` (line 1164) writes `window.GLOBE_DATA={data}` where `globe_data`
   (1071) carries `"who"` and (1130) `"who"`, `"why"` straight from
   `/api/request`. serde_json does not escape `<` or `/`, so
   `who = "</script><script>alert(1)</script>"` executes on every Globe /
   Continents / Space view. Same pattern: `window.LIGHTS0={}` (1732),
   `window.RELAY_MATRICES={matrices}` and `window.RELAY_BOUND={bound}` (3240;
   device labels come from the browser). 8 JSON-in-script holes in total.
   Fix in Rust: one `json_script(&Value) -> String` that replaces `<` with the
   JSON six-character escape for U+003C (and U+2028/U+2029 likewise), used at
   all 8 holes.
2. **HIGH: `esc` does not escape `'`, but values are put inside single-quoted
   JS strings in `on*=` handlers.** 13 lines / 18 holes of the form
   `onclick="f('{id}')"`, plus `format!("connect('{}',{},'{}')", .., esc(name))`
   (racks, line 3115) where `name` is a port name set by `/api/rename`
   (user input): `x');alert(1);//` runs on click. Fix: `esc` adds
   `' -> &#39;` (html.ts `esc` does this; a no-op for every current page
   except the injected cases), better still pass data via `data-*` attributes.
3. **MEDIUM: config-sourced raw holes.** Badge emoji/colour (`{badge}`,
   `bd.emoji`, `bd.color`, `style="stroke:{col}"`), `serde_json::Value`
   Display holes (`r["frames"]`, `t["calls"]`, `t["muted"]`, about 12; a
   string there prints JSON-quoted and unescaped), chart `{color}`, nav labels.
   All trusted today; all one config edit from markup injection.
4. **`tile(label, value)` escapes the label but not the value** (`impl Display`).
   Every call passes numbers or runtime strings today.
5. **Formatting quirks the ports must (and do) reproduce:**
   - Rust `{:.N}` rounds exact ties half-to-even (`fmt_num(0.25)` = `0.2`,
     `fmt_num(2.25)` = `2.2`, `fmt_num(100.5)` = `100`); JS `toFixed` rounds up.
   - `fmt_num(99.95)` = `100.0` (the `>= 100` test runs before rounding);
     `fmt_num(-0.04)` = `-0.0`.
   - `hm(23.9999)` = `24:00`: `hm` lacks the `% 86_400` that `hms` has. A
     real bug in the footer world clocks at 23:59:30+.
   - Chart legends space labels by `label.len()` = UTF-8 **bytes**, so
     `load ×10` is 9 wide, not 8.
   - `str::lines`/`trim_end` differ from JS on CRLF, U+0085 and BOM; BTreeMap
     and `String` ordering is by code point, JS `<` is by UTF-16 unit (affects
     users-page sort with emoji names).
   - `f64::max/min` ignore NaN; `Math.max/min` propagate it.
6. **TS buys:** one escaping rule enforced by the type (`SafeHtml`), not by
   memory; charts become reusable in the WebSocket refresh path (today a
   refresh re-requests the whole server-rendered page); unit-testable pure
   renderers. **Rust SSR keeps:** no-JS static snapshots written to disk, first
   paint without a JSON round trip, a single source for `page()` chrome.

## Files built (TYPESCRIPT/charts/)

| File | Lines | What |
|---|---|---|
| `src/html.ts` | 75 | `html` auto-escaping tagged template, `raw()`, `esc` (adds `'`), `escRust` (byte-parity), `htmlCompat`, `join`, branded `SafeHtml` (unforgeable by shape) |
| `src/rustfmt.ts` | 145 | Rust `{}`/`{:.N}` float formatting, half-even ties, `-0`, `inf`, `rem_euclid`, `as u64`, UTF-8 length, `trim_end`, `lines`, code-point string order, NaN-ignoring max/min |
| `src/charts.ts` | 194 | `lineChart`, `barChart`, `heatMatrix`, `niceCeiling`, `fmtNum`, `oceanBetween`, `TOPIC_COLOURS`, `topicColour` |
| `src/text.ts` | 91 | `dur`, `durF`, `hm`, `hms`, `mdHtml` |
| `src/users-page.ts` | 182 | Proof page: `renderUsersBody(data)` from `/api/users` + `/api/state`, `mountUsersPage(root)` returning `refresh()` for the telemetry loop |
| `golden/cases.ts` | 122 | 116 shared inputs (incl. XSS strings, NaN, ties, emoji) |
| `golden/gen-golden.ts` | 200 | Extracts the 13 Rust functions **verbatim** from html.rs (+ `esc`, `ocean_between`), compiles them with rustc 1.95 in a shim, writes `golden.json` |
| `golden/golden.json` | | 116 outputs from the compiled Rust |
| `test/golden.test.ts` | 35 | Every port vs golden.json |
| `test/html.test.ts` | 96 | Template escaping, forged SafeHtml, rustfmt edge cases, mount/refresh |
| `tools/count-html-sites.ts` | 166 | The site counter above (`--list` prints every unresolved hole) |
| `tsconfig.json` | | extends `../tsconfig.base.json`, lib ES2022 + DOM |

## Typecheck and tests

```
> node node_modules/typescript/bin/tsc -p charts
tsc exit 0

> node --test --experimental-strip-types charts/test/*.test.ts
✔ dur ✔ dur_f ✔ hm ✔ hms ✔ nice_ceiling ✔ fmt_num ✔ md_html
✔ line_chart ✔ bar_chart ✔ heat_matrix ✔ users_page body (compat escaping)
✔ html`` escapes every hole, including '
✔ htmlCompat matches Rust esc (leaves ')
✔ nested fragments, arrays, raw, null/false
✔ a fake SafeHtml-shaped object is still escaped
✔ rustFixed: half-to-even ties, -0, inf, big
✔ utf8Len, trimEnd, lines, str order follow Rust
✔ users body: default escaping neutralises ' and markup
✔ mountUsersPage fetches both endpoints and renders into root
✔ mountUsersPage rejects on HTTP error and bad shape
ℹ tests 20  ℹ pass 20  ℹ fail 0
```

`users_page` parity: the Rust `users_page` body for 3 runtimes (empty; 6
records with direct/via/denied/released and live connections; hostile strings
plus emoji/fullwidth sort order) equals `renderUsersBody(.., {compat:true})`
byte for byte. Default mode differs only by `'` becoming `&#39;`.

## How to wire it in (NOT applied)

1. **Rust hot-fixes first (independent of TS):** add `'` to `util::esc`; add a
   `json_script()` helper for the 8 `window.X={..}` holes; escape badge
   emoji/colour and Value Display holes.
2. **Bundle:** add `charts/src/users-page.ts` (and later other page bodies) as
   an entry in agent 01's web-core esbuild config; it has no globals.
3. **Rust `users_page`:** wrap the body in `<div id="users-root">..</div>`; keep
   SSR as first paint and for the static snapshot file.
4. **Client:** `const p = mountUsersPage(document.getElementById("users-root")!)`;
   call `p.refresh()` from web-core's telemetry handler instead of
   `reload()`. Swap `root.innerHTML` for web-core's DOM morph if it has one
   (keeps scroll and focus inside the sash columns).
5. **CI:** run `node --experimental-strip-types charts/golden/gen-golden.ts`
   then the tests; a diff in golden.json means html.rs changed a renderer.
6. **Dedup:** `UserRecord`, `How`, `ConnectionLite`, `Series` to agent 04's
   `sdk/`; `oceanBetween` to sdk (it mirrors `sites.rs`); `TOPIC_COLOURS` /
   `topicColour` to web-core (agent 01) for the resistor tabs.
7. Repeat per page: usage (charts already ported), continents (line + bar +
   heat), simulator (md + line), analyzer (line + bar).

## Risks

- html.rs is being edited by another session; line numbers above are from
  the 4482-line snapshot. The golden generator extracts by function name, so
  it survives drift and will flag real changes.
- Client rendering removes the no-JS static snapshot unless SSR is kept for
  first paint (recommended).
- Charts keep Rust-parity escaping (`'` left as is). Safe: they only put
  text in text nodes and double-quoted attributes. Chart colours are escaped
  in TS but raw in Rust; identical for every colour used today.
- `innerHTML` replacement loses scroll position in the scroll tables without
  a morph step.
- The users proof does not add the data-terminal sash columns or pop-outs;
  that layout belongs to web-core/pages (agents 01/03).

## Open questions

- Is `/api/request` / `/api/rename` reachable by anyone but operators? If so,
  Findings 1 and 2 are remotely exploitable today.
- Should the static snapshot files (written to each folder) keep full HTML,
  or can they become JSON plus a shared shell?
- Should `hm` gain `% 86_400` (fixes `24:00`)? The TS port reproduces the bug
  for parity; flip both together.

## Next steps

1. Land the three Rust escaping fixes.
2. Port `usage_page` and `continents_page` bodies on top of `charts.ts` (all
   their charts are already ported and proved).
3. Port `day_timeline` (footer strip) once web-core owns the footer.
4. Extend the golden generator to `connections_table` and `bookings_table`.
