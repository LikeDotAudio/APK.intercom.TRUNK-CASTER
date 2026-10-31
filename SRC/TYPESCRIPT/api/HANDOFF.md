# Area 05 — HTTP + WebSocket contract → TypeScript

**Verdict: CONVERT (the client side).** The contract is now fully typed in TS: 63 `/api/*` method+path pairs, 19 HTML pages, `/report.md` and the `/ws` telemetry stream. A live server returned shapes matching the types on 66 of 66 read-only checks. The Rust server (`http.rs`, `ws.rs`) stays. This area replaces nothing on the server; it gives every TS consumer (pages, simulators, tests) one typed client in place of hand-written `fetch` + `JSON.parse`.

> **Concurrent change:** while this audit ran, the Rust session added `GET /api/land` (http.rs:272). It is included here, and the catalogue line numbers after 272 were shifted +1 to match the working copy. Smoke re-run: **66/66 matched**. The first WS `status` came after 2.4 s that run and 8.4 s the run before, depending on tick length.

## Scope (read only, nothing outside `TYPESCRIPT/api/` edited)

| File | Lines | What |
|---|---|---|
| `RUST-RUNTIME/src/http.rs` | 1–637 (all) | request parsing, `respond`/`json`/`error`, every match arm 139–630 |
| `RUST-RUNTIME/src/ws.rs` | 1–201 (all) | handshake, broadcaster, client read loop |
| `RUST-RUNTIME/src/interface.rs` | 1–56 (all) | file-drop interface (not HTTP; see findings) |
| `RUST-RUNTIME/src/runtime.rs` | 319–360, 540–640, 712–850, 930–960, 1061–1075, 1283–1420, 1525–1570, 1672, 2044–2100, 2476–2719 | handler return shapes, `status_message`, `globe_message` |
| `RUST-RUNTIME/src/html.rs` | 150–185, 990–1128, 1856–1935, 4371–4462 | `globe_data`, `lights_json`, `topics`, page WS consumer |
| `RUST-RUNTIME/src/{bookings,routing,recorder,trends,analyzer,crosspoints}.rs` | struct defs | Booking, State, CrossCheck, Recorder, TrunkTrend, capture load |
| `TRUNK-CASTER-SDK/src/types.rs, labels.rs, sites.rs, client.rs` | struct defs, client 160–260 | serde wire types; Rust `HttpClient` |

## Findings

### Contract facts a TS client must know (all encoded in the types)
1. **No snapshot on WS connect** (`http.rs:125-137`, `runtime.rs:542`). The first frame comes at the next tick. Under the current load a tick takes about 8–20 s (`phase expire_simulated` around 600 ms, and others), so a new page waited **8.4 s for its first `status`** in the smoke run. The documented 500 ms / 2 s cadence is a floor, not a promise.
2. **`globe-delta` is not a diff.** It carries the full `trunkList`, `callList`, `history` and `clusters` again (**770 KB per frame** live), plus `live` and `parked` maps that **leave out zero entries**. Merging key by key leaves stale counts. You have to replace the maps (`telemetry.ts:mergeGlobe`). `nodes` are never streamed. The client refetches `/api/globe` when `delta.frames !== nodes.length`.
3. Only `status` carries `build`. A build change can only be detected on a `status` frame.
4. `status.log` and `status.wardbeck` are **newest first**. `GET /api/log` is oldest first, and `GET /api/wardbeck` is oldest first as plain text.
5. Path ids (`/api/analyze/:id`, `/api/capture/:id`, `/api/device/:id`) are **not percent-decoded** (`http.rs:242,253,277`), so an id that needs escaping can never be reached. `/panels/editor?frame=` **is** decoded (`query()`, l.90), but `/analyzer?id=` is **not** (l.211). That makes two query parsers that behave differently.
6. A trailing slash is trimmed (l.120): `/api/device/` becomes `/api/device`, which returns a generic 404 `not found` instead of `no frame`. The client refuses an empty param.

### Latent bugs / inconsistencies
- **Security: path traversal through request ids.** `POST /api/request {"id":"../../x"}` makes `users::record_path` write `TRUNK-USERS/../../x.json` (`runtime.rs:948`, `users.rs:10`). `POST /api/release` then `fs::remove_file`s `interface/<id>.json` (`runtime.rs:1066`). Neither the HTTP layer nor `handle_request` sanitises ids. Together with `Access-Control-Allow-Origin: *`, a server that accepts `text/plain` bodies (no preflight is needed), and Docker publishing `0.0.0.0:8080`, **any web page or LAN host can create and delete `.json` files** relative to the data dir. This was not exploited, only read from source.
- **The Rust SDK `HttpClient::rename` cannot work.** It deserialises the reply as `Rename` (`client.rs:53`), but the server returns `Vec<RenameDispatch>` (`http.rs:489`), so every call fails with a serde error.
- **Inconsistent validation:**
  - `/api/capture/start`, `/api/fader/quick` and `/api/fader/preset` use `unwrap_or_default()` on bad JSON, so a malformed body is accepted as `{}`.
  - `/api/release` returns 400 when `id` is missing.
  - `/api/bookings/cancel` turns a missing id into `""` and returns **404**.
  - `/api/relay/unbind` returns 400.
- **Inconsistent status codes for the same failure class:** `set_fader` I/O errors are 500 on `/api/fader` and `/api/fader/quick` but **400** on `/api/fader/preset` (via `map_err(to_string)`). Every `500` is sent with reason phrase `Error` (l.73).
- **Mixed content types:** 39 JSON GETs, plus `text/markdown` (`/api/report`, `/report.md`) and `text/plain` (`/api/wardbeck` is newline-joined lines, `/api/checkin` is a file or `""`). Errors are always JSON `{error}`, including on text routes.
- **Denials are 200.** `/api/request` with `status:"denied"` and `/api/release` of an unknown id both return 200 with `Reply.status:"denied"`. Clients must check the body, not the status.
- **Any non-GET to any unknown path returns 405, not 404** (l.629). That includes `OPTIONS`, so a CORS preflight always fails. The TS client sends `text/plain` so cross-origin POSTs stay "simple". The server ignores `Content-Type`.
- **Large bodies are silently truncated.** For `Content-Length` above 4 MiB, only 4 MiB is read (l.60) and the rest is left on the socket.
- `/api/state` serialises the private `next_trunk` field (`routing.rs:42`). It is internal state leaking into the API.
- **Telemetry broadcast runs inside the tick, under the runtime lock.** It uses an 800 ms write timeout per client (`ws.rs:19`), so one slow socket can add 0.8 s × N to every tick. Dead sockets are only pruned on the next failed write.
- `interface.rs:scan` filters only the *one* answer suffix it is given. A stray `x.offer.json` in `TRUNK-CASTER-INTERFACE` would be parsed as a `Request` and reported as bad.

## Added: TAPS and Mixes, voices, bandwidth (2026-10-21)

Eight routes, typed end to end (`types.ts` → `routes.ts` → `client.ts` → `openapi.json`, regenerated: 87 paths + `/ws`). Plan: `TRUNK-CASTER-SDK/plans/11-taps-voices-bandwidth.md`.

| Route | Type | What |
|---|---|---|
| `GET /api/taps` | `Taps` | A strip per connected frame, a fader per closed crosspoint (gain, accent, live voice kbit/s). |
| `GET /api/taps/:frame` | `TapStrip` | One frame's strip; 404 for an unknown frame. |
| `POST /api/gain` | `GainSet` → `GainEvent` | `GainSet` gained `frame` + `input` + `output`: one crosspoint (a TAPS fader). |
| `POST /api/taps/unity` | `TapsUnity` → `TapsUnityResult` | Every crosspoint (of one frame, or of all on an empty body) back to 0 dB. |
| `GET /api/voices` | `VoiceSummary` | Chunk and correction counters, live rate, newest saying per frame and kind. |
| `GET /api/voices/:frame` | `FrameVoice` | Site, country, airport, accent, rate, newest ident and call, WAV paths. |
| `GET /voices/:file` | `Uint8Array` | `audio/wav`. New `Kind` `'audio'`: the client returns bytes, not text. |
| `GET /api/bandwidth` | `Bandwidth` | The bandwidth simulation: totals, by protocol, by frame (busiest first), by trunk. |
| `GET /api/airports` | `Airport[]` | Every site's IATA code and accent. |

`smoke.ts` covers all of them (the param routes with a live frame, the WAV checked for `RIFF`); `api.test.ts` adds two tests (WAV as bytes, a crosspoint `GainSet` and unity) and the new catalogue counts. The wave sender and re-assembler themselves are mirrored in `../sdk/voice.ts`.

## Files built (`TYPESCRIPT/api/`)

| File | Lines | Status | What |
|---|---|---|---|
| `types.ts` | 1134 | done | 80+ wire types. Each is tagged `@sdk` (replace with `../sdk` import), `@runtime` or `@adhoc` (a `json!` literal, so this file is its only schema). Includes input variants `FaderInput`, `GlobeConfigInput`, `RelayEventInput`, `BookingAsk`. |
| `routes.ts` | 286 | done | `GetRoutes` and `PostRoutes` type maps, `PathParams<>`, and the runtime catalogue `GET_META`/`POST_META`/`WS_META`. Mapped types keep the catalogue key-for-key with the type maps. |
| `client.ts` | 156 | done | `createClient()` / `tc`. `tc.get('/api/status')` returns `Status`; `get('/api/device/:id', {params:{id}})` checks its params; `post(path, body)` checks its body. Also has `TcHttpError` and a timeout. |
| `telemetry.ts` | 295 | done | `StatusMessage`, `GlobeDeltaMessage`, `parseTelemetry`, pure `mergeGlobe`, and `connectTelemetry()`: seed from `/api/globe`, merge the deltas, reseed when the fleet changes, warn on a build change, reconnect with 2 s→30 s backoff. |
| `openapi.ts` / `openapi.json` | 114 / 3160 | done | OpenAPI 3.1 catalogue generated from `routes.ts`: 79 paths + `/ws`, with `x-source` http.rs line, `x-ts-type`, and required keys. |
| `validate.ts` | 42 | done | Structural `checkShape` used by the smoke script and the tests. |
| `smoke.ts` | 148 | done | GET-only live check of every JSON/text route, the 3 param routes, the 404 error shape and both WS frames. `--pages` adds the 19 HTML routes. |
| `api.test.ts` | 201 | done | 12 tests, plus compile-time `@ts-expect-error` contract checks. |
| `tsconfig.json` | 10 | done | Extends `../tsconfig.base.json`, lib ES2022 + DOM. |

## Verification output

```
> node node_modules/typescript/bin/tsc -p api
(no output) exit 0

> node --test --experimental-strip-types api/api.test.ts
✔ buildPath fills params and refuses empty or escaped ids
✔ buildQuery encodes and skips undefined
✔ get parses JSON and infers path params
✔ text routes return the raw string
✔ post sends JSON body as text/plain (no CORS preflight)
✔ non-2xx throws TcHttpError carrying the {error} message
✔ catalogue counts: 63 /api endpoints + 19 pages + /report.md
✔ openapi has every path
✔ checkShape
✔ mergeGlobe: absent live means 0 (replace, not merge)
✔ parseTelemetry ignores junk and unknown types
✔ connectTelemetry: status, build change, seed+delta merge, reconnect with backoff
ℹ tests 12  pass 12  fail 0

> node --experimental-strip-types api/smoke.ts --pages --ws-seconds 45
server reachable at http://127.0.0.1:8080
ok   /  … /discovery  (19 HTML pages, 74 KB – 3.3 MB each; /racks 3.3 MB)
ok   /api/globe 248 ms · /api/advertisements 484 ms (710 items) · /api/lines 995 items · … (43 GET routes)
ok   /api/device/boston-01 · /api/analyze/capture-1792604137 · /api/capture/capture-1792604137
ok   /api/device/no-such-frame-smoke   404 {error:"no frame no-such-frame-smoke"}
ok   ws status        8400 ms  27512 bytes
ok   ws globe-delta   8751 ms  769650 bytes
66/66 matched
```
A deeper key-by-key comparison against live replies (status, globe node/cluster/call/history, device, tree levels, topics, state, captures, crosspoint events, relay) found no field missing from the types and no extra field.

Note: a 2 s probe against `/api/status` once timed out. HTTP handlers block on the runtime mutex for the length of a tick, so the smoke script now allows 30 s.

## How to wire it in (NOT applied)
1. Once agent 04's `TYPESCRIPT/sdk/index.ts` lands, replace every `@sdk`-tagged interface in `api/types.ts` with `export type { … } from '../sdk/index.ts'`. Keep the `@runtime` and `@adhoc` types here, or move them to sdk if agent 04 takes them. Re-run `tsc -p api`.
2. Add `{ "path": "api" }` to the root `TYPESCRIPT/tsconfig.json` references (if the coordinator builds with `tsc -b`).
3. Pages: replace the inline `api(path, body)` helper and `connectWs()` (html.rs:174-182) with an esbuild bundle of `client.ts` + `telemetry.ts`:
   - `createClient({ baseUrl: '' })`;
   - `connectTelemetry({ url: (location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws', seed: () => tc.get('/api/globe'), onStatus: applyStatus, onBuildChange: () => { cacheFlush(); location.reload(); } })`.
   
   That belongs to the page-bundle agents; this area only provides the modules.
4. CI: `node --experimental-strip-types api/smoke.ts` exits 0 when no server is up and 1 on drift. Regenerate `openapi.json` with `node --experimental-strip-types api/openapi.ts > api/openapi.json` whenever routes change.
5. Rust-side follow-ups (owner: whoever holds `http.rs`):
   - sanitise request ids (`[A-Za-z0-9._-]`);
   - fix `HttpClient::rename`'s return type;
   - send one snapshot `status` frame on WS accept;
   - stop sending unchanged `history` and `trunkList` every 2 s;
   - answer `OPTIONS`, or drop `ACAO: *`.

## Risks
- `routes.ts` is hand-maintained against a hand-written `match`. A new arm in `http.rs` will not fail anything until someone adds it. Mitigation: the smoke test plus a grep of `("GET", "/api` in CI.
- `@adhoc` shapes (`globe_data`, `tree`, `device`, `topics`, the telemetry frames) have no Rust struct. Any edit to those `json!` literals silently changes the contract.
- Param routes refuse ids that need escaping. That matches what the server can serve today, but it will throw if frame ids ever get spaces or non-ASCII characters.
- `connectTelemetry` holds the last `GlobeData` in memory (about 1 MB live). Fine for one page, but watch it in long-running Node tools.

## Open questions
1. Should `/api/report` and `/report.md` stay duplicates? `/home` and `/about`, `/panels` and `/lights`, `/editor` and `/panels/editor`, `/continents` and `/discovery` are also aliases. Is the aliasing deliberate?
2. Should `globe-delta` be made a real delta, or should the docs stop calling it one?
3. Is 0.0.0.0 publishing in `docker-compose.yml` intentional? It turns the path-traversal finding from local-only into LAN-reachable.

## Next steps
- Swap the `@sdk` types for agent 04's imports.
- Add a CI grep that diffs `http.rs` match arms against `GET_META`/`POST_META` keys.
- Optionally, add a fuller JSON Schema to `openapi.json` with `ts-json-schema-generator` (no new deps were installed here).
