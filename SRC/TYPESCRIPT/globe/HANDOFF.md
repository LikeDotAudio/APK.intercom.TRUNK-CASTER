# Area 02 of 10: the map engine (GLOBE_JS) in TypeScript

## Verdict: **Convert**

GLOBE_JS is about 400 lines of untyped, dense, stateful canvas code that every map page depends on (the one-map-engine rule). It splits cleanly into pure math, a layer registry, panels and an engine. The port typechecks under strict + `noUncheckedIndexedAccess`, bundles to a 38.7 KB IIFE, and keeps every sessionStorage key, DOM id, HTML string and draw call in the same order, so it can replace the `<script>{GLOBE_JS}</script>` without touching `map_block()`, `MAP_CSS` or `globe_data()`. The types also turned up a crash path, a config-wipe bug and stale-telemetry gaps (see Findings).

## Scope (audited)

Line numbers are for the working tree on 2026-10-21. html.rs is moving under concurrent edits. GLOBE_JS itself was unchanged by those edits; I checked this with `git diff`.

| What | Where |
|---|---|
| `globe_data()`, which defines the data shape | `RUST-RUNTIME/src/html.rs:1009-1147` |
| `LAND_JSON` (now `pub`, also served at `GET /api/land`, http.rs:272) | `html.rs:1151`, `RUST-RUNTIME/src/land.json` (126 rings, 5,114 points) |
| `MAP_CSS` | `html.rs:1153-1155` |
| `map_block()` | `html.rs:1161-1169`. Callers: `:1602` (globe page), `:2474` (continents view), `:3147` (aggregator page with hub) |
| `GLOBE_JS` | `html.rs:1171-1569` |
| `globe-delta` telemetry frame | `RUST-RUNTIME/src/runtime.rs:582-632` (`globe_message`) |
| Status fields the map side panels read | `runtime.rs:559-580`, `continent_totals` ~2510-2537, `lines()` ~2662-2685 |
| Wire structs | `TRUNK-CASTER-SDK/src/types.rs` (`Family` 18-50, `Badge` 151-177, `Frame` 194+, `Connection`/`Hop` 590-640, `GlobeConfig`/`Zone` 1585-1665); `sites.rs` (`Tier`); `RUST-RUNTIME/src/trends.rs` (`TrunkTrend` 64-87) |
| Shared client globals consumed | `html.rs` `JS` const: `api` 111, `num` 116, `esc` 118, `dur` 119, `TC` 128, `cacheGet` 129, `setText` 134, `predictedHour` 138, ws dispatch 177, `refreshMain` 298-324 |

## Findings

### Bugs and hazards the types exposed

1. **A call with no hops crashes the map for good.** The calls layer does `c.hops[Math.floor(x % 0)]`, which is `hops[NaN]`, then `undefined[0]`, which throws. `contAgg()` does `c.hops[0][0]`, which also throws. `requestAnimationFrame(frame)` is the last line of `frame()`, so one throw stops all drawing until reload. The server's crosscheck already flags "no hops" (`routing.rs:722`), so the state can occur. **This is the port's only behavioural change:** such a call is skipped. More broadly, any exception in `frame()` stops the loop. Consider `try { … } finally { requestAnimationFrame(frame) }`. I have not applied that.
2. **Saving the globe form wipes custom footer clocks.** `POST /api/globe/config` sends no `zones`. Serde fills in `default_zones()` and `set_globe` replaces the whole config. If `g_rot` or `g_grat` is empty, `num()` returns `undefined`, the key is dropped, the server returns 400, and the form still shows "saved" because `.then` ignores the response. I preserved this and marked it in `engine.ts`.
3. **A rotation-speed change never reaches an open page.** `TC.onStatus` re-reads `data.config.rotate_deg_per_s`, but `data.config` is only replaced when the fleet size changes and triggers a full refetch.
4. **Deltas leave node fields stale.** `globe-delta` refreshes only `live`. `who`, `free`, `since`, `sim` and `load` stay as they were at page load, so the frame tooltips and the Data-ports colours (`sim` true/false/null) drift. A refetch runs only when the frame *count* changes. A fleet that swaps ids at the same size is never refetched. After a refetch, `buildBar` does not rebuild (`data-built`), so new protocols and vendors are missing from the filter.
5. **The continents cache key counts filter sizes, not contents.** Hiding protocol X and then showing Y while hiding Z keeps a stale aggregate until the clock changes (at most 2 s). I preserved this and documented it.
6. **Mixed time sources for the sun.** The hour comes from the simulated clock (`predictedHour`, then `data.clock`). The solar declination comes from the wall-clock date. The season never follows the simulated calendar.
7. **Zoom limits disagree.** The wheel allows 0.6–12, the `+`/`-` keys 0.6–8, and the `g_zoom` input has max 8.
8. **The tilt sign is documented backwards.** `GlobeConfig.tilt_deg` says "negative looks slightly down on the globe". The maths (unit-tested) shows tilt = latitude centres that latitude, so the default −18 shows more of the south.
9. **Dead or loose inputs.** `window.GLOBE_FORCE_PROJECTION` is read but set nowhere. `cfg().projection` is unreachable because `map_block` always sets a non-empty `GLOBE_DEFAULT_MODE`. An unknown `?view=foo` drew the *uses* arcs under the *live* legend. The port normalises it to `uses`, and an unknown stored mode to `globe`. That is equivalent except for the blank `<select>`.
10. **Session keys mix scopes.** `globe.view` and `globe.focus` are global, while `globe.mode/layers/hideproto/hidevendor` are per page. A trunk focused on one page stays focused on every other map. Preserved.
11. **`LAND_JSON` (56 KB) is inlined into every map page.** `GET /api/land` now exists (http.rs:272), so the land could be fetched once and cached.

### What TypeScript buys here
- A precise `GlobeData` / `GlobeDelta` contract (`src/types.ts`). I checked it against the live server (`GET /api/globe`, 710 nodes): the key sets of top level, config, node, site cluster, protocol cluster, trunk, call and history **all match exactly**. Every family and tier value seen is in the unions.
- A `Layer` interface and registry (`src/layer.ts`). A new layer is `registerLayer({ key, draw(scene) }, { before, chip })`. It gets a toolbar chip and per-page persistence with no engine edits.
- Pure, unit-tested maths (`src/math.ts`): orthographic and equirect, wrap and nearest copy, arc lift, Bézier, great-circle destination and small-circle cap, sub-solar point, solar altitude, the twilight smoothstep, the terminator raster, and the colour ramps.

## What was built (`TYPESCRIPT/globe/`)

| File | Lines | What |
|---|---:|---|
| `tsconfig.json` | 10 | extends `../tsconfig.base.json`; DOM libs + node types (for tests) |
| `globals.d.ts` | 48 | ambient `TC`, `api`, `esc`, `setText`, `dur`, `num`, `cacheGet`, `predictedHour`; `window.GLOBE_*`, `TC_LAND` |
| `src/types.ts` | 271 | `GlobeData`, `GlobeNode`, `GlobeCluster`, `LiveTrunk`, `LiveCall`, `TrunkHistory`, `GlobeConfig`, `Zone`, `Badge`, `Family`, `Tier`, `GlobeDelta`, `StatusMessage`, `ContinentTotal`, `LeaseLine`, `Hub`, `LandRing` |
| `src/math.ts` | 291 | pure maths and colours (no DOM) |
| `src/layer.ts` | 156 | `Layer`, `Scene`, `Engine`, `MapView`, hit types, registry, chips |
| `src/layers.ts` | 692 | sea, land, sun/night (map raster and globe caps), graticule, trunks, data ports, hub, frames, calls, continents, labels |
| `src/continents.ts` | 110 | pure continent aggregation |
| `src/panels.ts` | 241 | frame, trunk and continent tooltips; legend; `#side-trends`; `#side-continents` and `#side-lines` |
| `src/toolbar.ts` | 73 | `#mapbar`: view, colour, layer chips, protocol and vendor filter |
| `src/state.ts` | 96 | sessionStorage (same keys), `Filter` (GLOBE_FILTER plus the toolbar's hidden sets) |
| `src/engine.ts` | 682 | `Globe`: panes and camera, render loop, pointer, wheel and keys, focus, telemetry hooks, form |
| `src/main.ts` | 5 | bundle entry: `bootGlobe()` |
| `src/math.test.ts` | 241 | 17 tests: projections, wrap, lift, great circle, cap radius, sun, terminator, colours, aggregation |
| `dist/globe.js`, `dist/globe.min.js` | | esbuild IIFE: 65.8 KB and 38.7 KB |

### Typecheck, tests and build (actual output, run from `TYPESCRIPT/`)

```
$ node node_modules/typescript/bin/tsc -p globe; echo EXIT $?
EXIT 0

$ node --test --experimental-strip-types globe/src/math.test.ts
ℹ tests 17
ℹ pass 17
ℹ fail 0

$ node_modules/.bin/esbuild globe/src/main.ts --bundle --format=iife --target=es2020 --minify --outfile=globe/dist/globe.min.js
  globe\dist\globe.min.js  38.7kb
```

## How to wire it in (NOT applied)

1. Build: from `TYPESCRIPT/`, run `node_modules/.bin/esbuild globe/src/main.ts --bundle --format=iife --target=es2020 --minify --outfile=globe/dist/globe.min.js`.
2. The Docker build context only admits `RUST-RUNTIME/`, `TRUNK-CASTER-SDK/` and `TRUNK-SIMULATOR/frame-sim/` (`.dockerignore`). Copy the bundle to `RUST-RUNTIME/src/web/globe.min.js` and add that copy step to `rebuild.py` before `cargo build`. Alternatively, admit `TYPESCRIPT/*/dist/` in `.dockerignore` and add a `COPY`. This needs a project-wide decision shared with the other agents.
3. In `html.rs`, replace the whole `const GLOBE_JS: &str = r#" … "#;` (currently 1171-1569) with
   `const GLOBE_JS: &str = include_str!("web/globe.min.js");`
   Nothing else changes: `map_block()` still writes `GLOBE_DEFAULT_MODE`, `GLOBE_LAYERS`, `GLOBE_HUB`, `GLOBE_FILTER`, `GLOBE_DATA` and `TC_LAND`, then `<script>{GLOBE_JS}</script>`. The bundle contains no `</script`. It is a `format!` argument, so braces need no escaping.
4. Keep `MAP_CSS`, `map_block()`, `globe_data()` and `LAND_JSON` as they are. The shared client (`JS`) must still load first, as it does today.
5. Check by hand on `/` (both panes), the continents page (`globe` + sun, continents, grid) and the aggregator page (hub plus Data ports chip). Check drag, shift-drag pan, wheel zoom, the `m`/`t`/arrow/Home keys, hover tips (frame, arc, continent), click-to-focus from both arc and list, the filter, and that refreshMain keeps drawing.

## Risks

- **No browser run yet.** Fidelity rests on a line-by-line port, tsc, the unit tests and the live JSON shape check. A side-by-side visual diff (old vs new on the same seed) is the missing proof.
- **One intentional behaviour change:** calls with empty `hops` are skipped instead of crashing (Finding 1). Two cosmetic normalisations: unknown `?view=` and unknown stored mode.
- `api`'s return type is `unknown`. A full refetch is accepted only if it has a `nodes` array, the same check as `d && d.nodes`.
- `globals.d.ts` duplicates agent 01's surface, and `types.ts` duplicates agent 04's. They can drift until deduplicated.
- The bundle adds a build step (esbuild) to a Rust-only Docker build.

## Open questions

1. Should a trunk be hidden when **either** end is filtered out? Today it is hidden only when **both** ends are (`drawArc`, the calls layer). Calls follow the same rule.
2. Should the globe form send `zones` (or should the server merge), and should "saved" depend on a 2xx? (Finding 2)
3. Should `globe-delta` carry `who`/`sim`/`free`, or should the page refetch on a slower cadence? (Finding 4)
4. Should the declination use the simulated day (`data.today`)? (Finding 6)
5. Should the land be fetched from `/api/land` (cacheable) instead of inlined per page? (Finding 11)

## Next steps

1. Dedup `src/types.ts` against `TYPESCRIPT/sdk/` (agent 04) and `globals.d.ts` against `TYPESCRIPT/web-core/` (agent 01).
2. Run a visual parity check in a browser, then apply the wiring steps behind one commit.
3. Decide the fixes for Findings 2–4 server-side (Rust), then drop the "preserved" comments.
4. Wrap `frame()` so an exception cannot stop the loop.
