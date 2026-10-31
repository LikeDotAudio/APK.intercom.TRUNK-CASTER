# Area 01 of 10: Web core runtime

## Verdict: Convert

The shared page client (the `JS` const in `RUST-RUNTIME/src/html.rs`) ports cleanly to typed ES modules and bundles to one 35 KB IIFE that `page()` can `include_str!` in place of the const. Behaviour is preserved line for line (four small, documented deviations, all on crash-only paths). The typing turned up one user-visible bug, two storage hazards and one error path that shows "undefined". The other inline scripts still call the core by bare name, so `globals.ts` republishes every original top-level name on `window` until those areas become modules.

## Scope (html.rs working tree, 2026-10-21)

| What | Lines | Notes |
|---|---|---|
| `CSS` const | L12–110 (99) | Read for context: the class contract the JS drives (`.cols/.col/.sash/.quads/.pane/.drag`, `.popped/.popsel/.pop`, `#topics/.tchart/.aurora/.melted`, `.zone/.ph-*`, `.event.on`). Not ported; it stays in Rust. |
| `JS` const | L112–392 (281) | Ported in full. Frozen copy: `source-snapshot.js.txt`. |
| `page()` | L412–467 (56) | Inlines `<script>const REFRESH_MS=…;const BUILD="…";{JS}</script>`. Wiring only; not ported (it is server-side). |
| Wire producers | runtime.rs `status_message`/`globe_message` (~L558–630), http.rs `/api/{request,rename,bookings/cancel,gpio,clock,fader/quick,topics,land}`, html.rs `topics()` (~L4370–4462), SDK types.rs `Status/Shape/Fader/Reply/GpioCommand/GpioEvent/Rename` | Used to type the JSON. |
| Consumers | GLOBE_JS, DISCOVERY_JS, EDITOR_JS, RELAY_JS, inline `on*=` handlers, page `<script>`s | Grepped to list the globals they need (see `src/globals.ts`). |

Note: the JS const changed **twice while this audit ran** (the heat aurora, then the `.melted` band). Both changes are ported. `src/core.test.ts` marks a TODO if the live const drifts from `source-snapshot.js.txt` again.

## Findings

1. **Bug: quadrant panes jump to the top on every refresh.** `refreshMain` saves and restores `scrollTop` only for `:scope>.cols>.col`. Quadrant mode is the default at ≥1200 px, and there `layoutCols` rebuilds `.quads>.pane` from scratch every `REFRESH_MS`, so each pane scrolls back to 0. That breaks the "no scroll jump" rule written in the code's own comment. Fix (not applied): also capture `main.querySelectorAll(':scope>.quads>.pane')` by `data-q` and restore it after `layoutCols()`. Original JS L~304–316; `src/refresh.ts`.
2. **`connect()` alerts "undefined" on errors.** `/api/request` answers `400 {"error":…}` to a malformed body, and `api()` never checks `r.ok`. The original then alerts `r.status`, which is `undefined`. The types made this visible: `api<T>()` returns `T | string`, and `ApiError` is separate. Kept as-is (marked `FIDELITY`); fix: `alert(r.error ?? …)`.
3. **The `main:` cache is write-only.** `refreshMain` writes the whole `<main>` HTML to `localStorage['tc:main:<path>']` on every refresh, and nothing reads it (grep over the whole repo). It grows per page until it hits the storage quota. After that every `cacheSet` (including `tc:status`) fails silently. Recommend deleting the write.
4. **A new build wipes the recent-tabs band.** `cacheFlush` deletes everything under `tc:`, and that includes `tc:topics` (the last four tabs), so the band under the header empties after every deploy. Move the key outside `tc:` or exempt it.
5. **Two full page reloads remain, against the refresh-in-place rule.** One is on a WebSocket `build` mismatch (intentional, commit d4a8497). The other is `toggleQuads()` (`location.reload()` on Q / ▦), which could clear `TC.colPlan` and call `layoutCols()` instead.
6. **Storage hazards.** The `details.frame` toggle listener calls `localStorage.setItem` with no try, so it throws when storage is blocked. The `open:*`, `cols:*`, `quads:*` and `layout.mode` keys are never flushed and grow per path × column count.
7. **`esc` does not escape `'`.** It is safe only inside double-quoted attributes. RELAY_JS defines its own local `esc` without null handling (`String(undefined)` gives "undefined").
8. **Per-frame layout cost.** `paintDay` calls `getComputedTextLength()` on every clock label 60 times a second. That forces a layout every frame for as long as the page is open. Label widths could be cached and re-measured only on resize or font load.
9. **Smaller items.**
   - `applyStatus` has a dead local `fmt` (a duplicate of `fmtH`).
   - The `layoutQuads` sash has a redundant ternary (`horizontal ? paneAtCell(i,0) : paneAtCell(i,0)`).
   - If the coastline fetch fails, `auroraLoad` leaves the land empty for the life of the page, with no retry.
   - `/api/land` repeats the `TC_LAND` that globe pages already inline, so it downloads twice on `/`.
10. **Telemetry contract.** Only `status` carries `build`. `globe-delta` is a full snapshot every 2 s, not a delta, and its inner shapes (`trunkList`, `callList`, `lights`…) belong to GLOBE_JS, so they are typed `unknown` here.

### Deliberate deviations (crash paths only)
- **`layoutQuads` drag:** checks that both panes exist *before* `preventDefault`/`setPointerCapture`/`.drag`. The original would throw after them and leave the sash stuck in `drag`. In practice this cannot happen.
- **`auroraFrame`:** returns if `getContext('2d')` is null. The original would throw.
- **`parseTelemetry`:** drops a JSON `null` frame. The original would throw on `m.build`.
- **`collectItems`:** deals HTML and SVG children, as the original did. Only MathML children are skipped.

## What was built (`TYPESCRIPT/web-core/`)

| File | Lines | Role |
|---|---|---|
| `src/env.ts` | 24 | `LIVE`, `POP`, and `BUILD`/`REFRESH_MS` read as bare globals (`declare const`) |
| `src/types.ts` | 209 | Wire types: `Status`, `Shape`, `Fader`, `Reply`, `RequestBody`, `GpioCommand/Event/Function`, `RenameBody`, `ApiError`, `StatusMessage`, `GlobeDeltaMessage`, `TelemetryMessage` union, `Topic/TopicsResponse/HeatPoint`, `LandRings` |
| `src/store.ts` | 36 | Typed `TC` store (`TCStore`, `ColPlan`) |
| `src/util.ts` | 70 | `show num val esc dur fmtH setText` (+ `wrap24`, `isTypingTarget`) |
| `src/api.ts` | 24 | `api<T>(): Promise<T \| string>` |
| `src/cache.ts` | 32 | `cacheGet/Set/Flush` under `tc:` |
| `src/daystrip.ts` | 196 | `predictedHour`, `paintDay` (split into pure `stripX/phaseOf/spreadLabels/whatIs`), `startDayLoop`, `fitStrip`, `wireStripScrub` |
| `src/telemetry.ts` | 110 | `applyStatus`, `parseTelemetry`, `dispatchGlobe`, `connectWs` |
| `src/layout.ts` | 404 | `quadMode/toggleQuads/layoutQuads/layoutCols`, pure `quadShape/quadCells/tracks`, `installLayoutSwitch` |
| `src/popout.ts` | 49 | `secKey/addPops/applyPop` |
| `src/refresh.ts` | 81 | `refreshMain`, `reload`, `userBusy` |
| `src/actions.ts` | 53 | `connect/rename/cancelBooking/gpio` (+ pure `gpioSummary`) |
| `src/topics.ts` | 201 | Recent-tabs band + heat aurora + melt |
| `src/globals.ts` | 62 | `exposeGlobals()`: `REQUIRED` (17 names with consumers) + `PARITY` (21 others) |
| `src/index.ts` | 80 | Entry: the original side effects in their original order (3× DOMContentLoaded, resize, visibilitychange, rAF loop) |
| `src/core.test.ts` | 159 | 14 tests, incl. **parity against the original** `esc/dur/fmtH/topicPath` run from html.rs in `node:vm`, and the drift check |
| `src/bundle.test.ts` | 56 | Runs `dist/web-core.js` in a sandbox exactly as `page()` inlines it, and checks the globals, the cache flush and the listener count |
| `build.ts` | 34 | esbuild → `dist/web-core.js` (35.9 KB) / `--minify` → `dist/web-core.min.js` (22.0 KB); fails if the output contains `</script` |
| `source-snapshot.js.txt` | 281 | The JS const that was ported |
| `tsconfig.json` | | Extends base; `lib: ES2022, DOM, DOM.Iterable`; `types: node` (for tests) |

No `any` anywhere. The `!` non-null assertions are confined to indices that are in range by construction, each next to its loop bound.

## Typecheck and tests (actual output)

```
$ node node_modules/typescript/bin/tsc -p web-core ; echo "TSC exit $?"
TSC exit 0                       # (tsc prints nothing on success)

$ node --experimental-strip-types web-core/build.ts
  web-core\dist\web-core.js  35.1kb
ok ...\TYPESCRIPT\web-core\dist\web-core.js 35947 bytes

$ node --test --experimental-strip-types web-core/src/*.test.ts
ℹ pass 15
ℹ fail 0
ℹ todo 0
```

## How to wire it in (NOT applied)

1. Build from `TYPESCRIPT/`: `node --experimental-strip-types web-core/build.ts` (add `--minify` for the 22 KB build).
2. Before you swap, run the tests. If the drift test reports TODO, port the diff between `source-snapshot.js.txt` and the live const first.
3. In `RUST-RUNTIME/src/html.rs`, replace the whole `const JS: &str = r#" … "#;` (L112–392) with:
   ```rust
   const JS: &str = include_str!("../../TYPESCRIPT/web-core/dist/web-core.js");
   ```
   Leave `page()` exactly as it is. `{JS}` is a `format!` argument, not template text, so braces in the bundle are safe. The bundle must keep running in a classic `<script>` *after* `const REFRESH_MS=…;const BUILD="…";`, which is true today.
4. Cargo cannot rebuild TypeScript. Either commit `dist/web-core.js` (recommended: Rust builds then need no Node), with a CI step that rebuilds it and fails on a diff, or add `RUST-RUNTIME/build.rs` with `cargo:rerun-if-changed=../TYPESCRIPT/web-core/dist/web-core.js`.
5. Smoke-test every tab in a browser. Check that the console shows no `ReferenceError`. Then check the Q toggle, a sash drag plus double-click, `?pop=`, the footer strip scrub, a WebSocket reconnect after a runtime restart, and the build flush on rebuild.
6. Later, as GLOBE_JS, DISCOVERY_JS, EDITOR_JS and RELAY_JS (and the page scripts) become modules, import from `web-core/src/*` and shrink `REQUIRED` in `globals.ts` to zero.

## Risks

- **Moving target.** html.rs is being edited concurrently: the JS changed twice during this audit. Re-diff right before wiring.
- **Bare-name globals.** `const TC`/`const LIVE` used to be global *lexical* bindings and are now `window` properties. Bare-name reads behave the same. The difference shows only if another script declares the same name at top level; none does today (RELAY_JS's `esc` is function-scoped).
- **The bundle is about 20% larger unminified** (35.9 KB vs 29.3 KB source) because of the module wrappers. Minified it is 22 KB.
- **Build-time dependency.** Node and esbuild must be available, or `dist/` must be committed.

## Open questions

- Fix findings 1–4 in the TS port before wiring, or wire the faithful version first and fix afterwards? (Recommendation: wire faithful first, then fix with tests.)
- Should `toggleQuads` re-layout in place instead of reloading?
- Is the `tc:main:*` cache meant for an offline or first-paint feature that was never finished, or should it be deleted?
- Dedup with agent 04 (`TYPESCRIPT/sdk/`): `Status`, `Shape`, `Fader`, `Reply`, `RequestBody`, `GpioCommand`, `GpioEvent`, `GpioFunction`, `RenameBody`, `ApiError` are local copies here.
- Who owns the `GlobeDeltaMessage` inner shapes: the globe area or the SDK?

## Next steps

1. Agent 04: export the SDK types, and switch `src/types.ts` to re-export them.
2. Fix findings 1–4 behind tests (the quad scroll restore, `connect` error text, dropping the `main:` cache write, sparing `tc:topics`).
3. The CSS const could move to `web-core/core.css` and be `include_str!`'d the same way.
4. Each consumer area: replace bare-name calls with imports, then delete the matching `REQUIRED` entries.
