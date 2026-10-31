# Area 04 of 10: SDK wire types → TypeScript

## Verdict: CONVERT (types and pure logic) · KEEP the Rust crate as the source of truth

Every serde-serialized shape in `TRUNK-CASTER-SDK` now has an exact TypeScript twin. The pure
logic is ported too: the Ward-Beck line, the panel labels, sites, the folder contract, the day
schedule, the presets and the MQTT topics. `client.rs` is ported as typed Node clients, plus a
Ward-Beck TCP client for port 7879, which the Rust SDK does not have. The Rust crate must stay
the source of truth because the runtime is Rust. The TS side should stop being hand-written once
ts-rs is wired in (see below). The crate changed twice while this audit was running, which shows
why that matters.

`tsc -p sdk`: **pass**. Tests: **61/61 pass**. That includes conformance against the JSON and
Ward-Beck files the runtime really wrote to disk.

## Scope (read-only audit)

| File | Lines | Notes |
|---|---|---|
| `TRUNK-CASTER-SDK/src/types.rs` | 1-1879 | 66 serde types. It grew by 10 lines during the audit (`RemoteFrame.mqtt_acks/rejects`, `Status.mqtt`) and the port includes them |
| `TRUNK-CASTER-SDK/src/wardbeck.rs` | 1-236 | `Line`, `Switch`, parse/format, 3 tests |
| `TRUNK-CASTER-SDK/src/labels.rs` | 1-149 | `Label`, grapheme splitter, 3 tests |
| `TRUNK-CASTER-SDK/src/sites.rs` | 1-369 | `Tier`, `Site`, `Sites`, continent/ocean/slug, 179 default sites |
| `TRUNK-CASTER-SDK/src/folders.rs` | 1-209 | folder contract, `Layout` |
| `TRUNK-CASTER-SDK/src/client.rs` | 1-275 | `FileClient`, `HttpClient` (HTTP on 7878, **not** a protocol client) |
| `TRUNK-CASTER-SDK/src/lib.rs` | 1-29 | re-exports, `WIRE_VERSION = 1` |
| `TRUNK-CASTER-SDK/src/mqtt.rs` | 1-394 | **appeared mid-audit**. Only the topic contract and `LinkStats` are ported; the packet codec is not |
| `TRUNK-CASTER-SDK/README.md`, `plans/09-sdk.md` | 280, 14 | API table, plan |
| `RUST-RUNTIME/src/wb.rs` | 1-224 | read to port the 7879 protocol (announce, wildcard, `@host`, acks) |
| `RUST-RUNTIME/src/http.rs` | 84-116, 465-580 | error body shape, rename/release/gpio return types |
| `TRUNK-SIMULATOR/frame-sim/src/main.rs` | 120-260 | the reference remote-frame session |

That is 3,429 SDK lines plus about 500 lines of runtime and simulator context.

## Findings

### Bugs and latent issues in the Rust source

1. **`HttpClient::rename` can never succeed.** `client.rs:212-214` types the reply as
   `Result<Rename>`. The server returns `Vec<RenameDispatch>` (`http.rs:484-496` →
   `runtime.rs:1283`), as the README table says, so every call fails with a JSON error. The TS
   port returns `RenameDispatch[]`. The one-line Rust fix is `-> Result<Vec<RenameDispatch>>`.
2. **The overnight quiet never happens on a day that has newscasts.** In
   `DaySchedule::multiplier` (`types.rs:1333-1366`), every newscast outside its ±1 h window
   gives `v = 1.0` and then `m = m.max(v)`. That lifts the 0.3 overnight factor back to 1.0. The
   default schedule and every preset with a newscast lose their quiet nights, and only presets
   with `newscasts: []` (quiet-night, phone-in, telethon, …) keep them. The port is faithful and
   `types.test.ts` pins the current behaviour. Fix: compute the surge as
   `max(hourly, radio, newscast…)` and then multiply by overnight, or skip `v == 1.0`.
3. **Shapes change but `WIRE_VERSION` stays at 1.**
   - `capture-1792590498-smoke24h.json` has no `bookings_per_hour` or
     `in_building_calls_per_hour`.
   - `mqtt_acks`, `rejects` and `Status.mqtt` were added during this audit.

   Rust survives this through `#[serde(default)]`; a TS reader that trusts the interface gets
   `undefined`. The port adds `FaderInput`, `faderWithDefaults()` and `*_DEFAULTED` key lists for
   this.
4. **`sites.json` on disk leaves out `continent` on all 50 sites sampled.** It relies on
   `Sites::normalize`, so TS readers must call `normalizeSites()`.
5. **`slugify` keeps ASCII only.** "Brasília" → `bras-lia`, "São Paulo" → `s-o-paulo`, "Kraków" →
   `krak-w`. The frame id `bras-lia-01` is live in `TRUNK-SIMULATOR/fader.json`. The port is
   faithful. A fix would change frame ids, so it needs a migration.
6. **Ward-Beck quoting gaps** (`wardbeck.rs:181-187`). `q()` quotes only on `,` or `"`. A name
   with CR/LF splits the line on the 7879 port (`wb.rs` `read_loop` uses `lines()`), and
   leading or trailing spaces are lost to `trim` on parse. The TS port adds `roundTrips(line)`,
   and `WardBeckClient.send` refuses CR/LF.
7. **Acks are counted loosely.** `wb.rs` `drain` counts **any** non-CHECKIN line for a hosted
   frame as an ack. The ack is not matched against a line that was actually sent.
8. **Two defaults disagree.** `Sample::default()` gives `load_multiplier: 0.0`, but the serde
   default is `1.0` (`types.rs:1392-1424`).
9. **Numbers.**
   - u64 → `number`, which is exact only up to 2^53. `Fader.seed` is the only field a person
     could realistically push past that.
   - serde rejects a fractional or negative number in a `usize`/`u32`/`u64` field. `isUint()` is
     provided for writers.
   - NaN and ±Infinity serialize as `null` on both sides and then fail to deserialize into `f64`.
10. **The request file is written non-atomically** (`client.rs:92`, `fs::write`). The runtime
    can read a half-written request. The port keeps the Rust behaviour; the suggested fix is to
    write `<id>.json.tmp` and then rename it.
11. **`mqtt.rs` problems.** `put_str` does `len as u16`, which silently truncates strings over
    64 KiB. The reject payload `"<reason>|<line>"` is ambiguous if the reason contains `|`.
    `parseReject` splits at the first `|`.
12. **`vendor_badge` uses substring order.** "rts" is tested first, so "Clear-Com Arts" gets the
    RTS badge. It only affects colour, never addressing.

### Mapping facts other agents can rely on

- **No `null` on the wire for options.** Every `Option` field in the SDK has
  `skip_serializing_if = "Option::is_none"`, so it maps to `field?: T`. The one exception is
  `AllowedTrunk.trunks: (string | null)[]`.
- **No data-carrying enums.** Every enum is a unit enum (`kebab-case`, or `UPPERCASE` for
  `Switch`), so they map to string-literal unions plus `const` value arrays. No tag/content
  unions were needed.
- **`#[serde(flatten)]` appears once**, in `CrosspointEvent`, and is ported as an intersection.
- **`where_` is the only rename** (it serializes as `"where"`).
- **The 6/8/16 label splitter is the Rust heuristic, not `Intl.Segmenter`.** UAX #29 disagrees
  on Hangul and Indic text, and TS must cut names exactly as Rust does. The port also uses Rust
  trim semantics: a BOM is kept and NEL is trimmed.
- **The exact test command fails on this Node version.** `node --test --experimental-strip-types
  sdk/` gives *MODULE_NOT_FOUND* on Node 24.11 because a directory argument is no longer
  expanded. Use the glob form shown below.

## Files built (`TYPESCRIPT/sdk/`)

| File | Lines | What |
|---|---|---|
| `index.ts` | 23 | **Canonical, browser-safe export**: types, labels, sites, folders, schema, mqtt, plus `wardbeck` and `voice` as namespaces |
| `types.ts` | 1572 | All 78 `types.rs` shapes, `*Input` types for serde defaults, every pure method (badges, GPIO, trunk helpers, day schedule, Olympics, presets, defaults) |
| `wardbeck.ts` | 219 | `WbLine`/`Switch`, `local/between/checkin/flipped/parse/format`, `roundTrips` |
| `labels.ts` | 164 | `Label`, `graphemes`, `fit`, `width`, `makeLabel`, `labelWithOverrides`, `labelForWidth`, `rustTrim` |
| `sites.ts` | 427 | `Tier`, `Site`, `defaultSites()` (179), `continentOf`, `oceanBetween`, `slugify`, `normalizeSites`, `airportOf` |
| `folders.ts` | 110 | folder constants, `isReserved`, `Layout` (pure; injectable join) |
| `mqtt.ts` | 52 | topic builders, `parseTopic`, `parseReject`, `LinkStats` |
| `voice.ts` | 535 | Port of `voice.rs`: CRC-32, base64, WAV, resample, `Chunk` wire line, `cut`, `Reassembler`, accents, `spell`, `topic` (see "Voice port" below) |
| `schema.ts` | 263 | `KeySpec<T>`, which is **compiler-checked** to list exactly T's keys with the right req/opt; `checkKeys`; `*_DEFAULTED` lists |
| `node.ts` | 337 | Node only: `FileClient`, `HttpClient` (fetch), `WardBeckClient` (TCP 7879), `findLayout`, `ClientError` |
| `*.test.ts` (8 files) | 989 | Rust tests mirrored, round-trips, mock HTTP/TCP servers, on-disk conformance |
| `tsconfig.json` | | extends `../tsconfig.base.json`, lib ES2022, types node |

No `any` anywhere, and no `enum`, namespace or parameter properties, so the code runs under
`--experimental-strip-types`.

## Typecheck and tests

```
> node node_modules/typescript/bin/tsc -p sdk
(no output) exit 0

> node --test --experimental-strip-types "sdk/**/*.test.ts"
serde-defaulted fields absent in files on disk: {"site.continent":50,
  "capture-N-smokeNh.json fader.bookings_per_hour":1,"capture-N-smokeNh.json fader.in_building_calls_per_hour":1}
ℹ tests 74
ℹ pass 74
ℹ fail 0
ℹ skipped 0
```

Conformance checked these files on disk: `fader.json`, 40 advertisements, `crosspoints.json`,
`settings.json`, `deltas.jsonl`, `gpio.jsonl`, `renames.jsonl`, `TRUNK-USERS/*.json`, usage
`state.json` connections, `relay.json`, relay `state.json`, `globe.json`, `sites.json`,
`preferences.jsonl`, `vendor-policy.json`, `timeline.json`, runs and captures. It also parsed and
re-formatted the last 2,000 lines of `checkin.wb` and of `wardbeck.log` byte for byte. None of
them had an unknown key or a missing non-defaulted key.

## Voice port and the TAPS / voice / bandwidth types

`voice.ts` mirrors `TRUNK-CASTER-SDK/src/voice.rs` function for function; `voice.test.ts`
mirrors its four Rust tests and adds a hand-written wire fixture
(`V1|m1|1|0|3|8000|ec897c47|ident|aGk=|AQD+/ywB|1234`) that must decode to the same fields
and re-encode byte for byte. Samples are `Int16Array`, bytes `Uint8Array`, PCM little-endian.
Exported from `index.ts` as the `voice` namespace (plus `Assembled`, `AssembledRecording`,
`Chunk`, `Reassembler` at top level), because names like `cut`, `topic` and `RATE` are too
generic for the flat export.

Differences from Rust, all deliberate:
- `Chunk` methods are free functions: `chunkIntact`, `encodeChunk`, `decodeChunk`.
- `Assembled` is the JSON shape (no `pcm`, which is `#[serde(skip)]` in Rust).
  `Reassembler.ready()` returns `AssembledRecording` = `Assembled & { pcm }`.
- `new Reassembler(idleMs, now?)`: idle in milliseconds, and an injectable monotonic clock
  (default `performance.now()`) in place of `Instant`, so the idle test needs no sleep.
- `ready()` sorts pending keys with JS string order (UTF-16) where Rust's `BTreeMap` uses
  UTF-8 byte order. They differ only for astral-plane characters in frame ids.
- `decodeChunk` reproduces Rust's `parse::<uN>()` (optional `+`, digits, range) and
  `from_str_radix(16)`; an unparsable `sent_ms` is 0, as Rust's `unwrap_or(0)`.

`types.ts` gained `GainSet.frame/input/output` (one crosspoint inside a frame) and `TapFader`,
`TapStrip`, `Taps`, `TapsUnity`, `TapsUnityResult`, `FrameVoice`, `VoiceSummary`,
`ProtocolLoad`, `FrameLoad`, `TrunkLoad`, `Bandwidth`, `Airport`. `FrameVoice`'s four `Option`
fields and `VoiceSummary.link` have no `skip_serializing_if`, so they are `T | null`, not
optional. `schema.ts` has a `KeySpec` for each, and `conformance.test.ts` now checks
`TRUNK-USAGE/gains.jsonl` (`GainEvent`, `GainSet`), `TRUNK-USAGE/voices/voices.jsonl`
(`Assembled`) and decodes the voice WAVs there with `wavDecode`. `sites.ts` gained
`airportOf` (`airport_of`: longest matching prefix, else the first three ASCII letters
uppercased), with the same 179-entry table.

## How to wire it in (NOT applied)

1. Other areas import wire types only from the SDK:
   - Browser code: `import type { Frame, Status } from "../sdk/index.ts"` and
     `import { wardbeck, makeLabel } from "../sdk/index.ts"`.
   - Node code: `import { HttpClient, WardBeckClient } from "../sdk/node.ts"`.
   - Nobody re-declares a shape.
2. Add `{ "path": "./sdk" }` to the `references` of a root `TYPESCRIPT/tsconfig.json`, and
   `"references": [{ "path": "../sdk" }]` to each consumer's tsconfig, so `tsc -b` builds the SDK
   first.
3. Agent 06 (simulator): `WardBeckClient` is a drop-in for frame-sim's session. It handles the
   announce of `<proto>-*`, adopting a frame on CHECKIN, the echo-ack, and periodic
   `checkinFrame`. For the double validation, add an MQTT client that publishes on
   `ackTopic()`.
4. **Generate the types from Rust so they never drift: ts-rs.** Nothing in `Cargo.toml` was
   changed.

   Add to `TRUNK-CASTER-SDK/Cargo.toml`:
   ```toml
   [dependencies]
   ts-rs = { version = "10", optional = true, features = ["serde-json-impl", "no-serde-warnings"] }
   [features]
   ts = ["dep:ts-rs"]
   ```

   Then annotate each serde type, for example:
   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize)]
   #[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "../../TYPESCRIPT/sdk/generated/"))]
   pub struct Frame {
       #[cfg_attr(feature = "ts", ts(type = "number"))]   // u64 → number, not bigint
       pub wire_version: u32,
       #[serde(default, skip_serializing_if = "Option::is_none")]
       #[cfg_attr(feature = "ts", ts(optional))]          // emits `country?: string`, not `string | null`
       pub country: Option<String>,
       …
   }
   ```

   Generate with `TS_RS_LARGE_INT=number cargo test --features ts` (ts-rs writes the files
   during `cargo test`). Then add `sdk/generated.check.ts` with
   `type Eq<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;`
   and one `const _frame: Eq<Gen.Frame, Frame> = true;` per type. `tsc` will then fail the moment
   the Rust and TS shapes disagree. Once those checks are green, have `types.ts` re-export the
   generated interfaces and keep only the functions.

   Caveats:
   - Every `Option` + `skip_serializing_if` field needs `#[ts(optional)]`, or ts-rs ≥10.1's
     struct-level `#[ts(optional_fields)]`. Without it ts-rs emits `T | null`, which is wrong
     for this crate.
   - `BTreeMap` is emitted as `{ [key in string]?: T }`.
   - Check the exact attribute names against the ts-rs version you pin.

   specta is the alternative if a JSON-Schema export (plan 09's "Next") is also wanted.

## Risks

- The types are hand-written until ts-rs lands. The crate is being edited right now (`mqtt.rs`
  and new fields arrived during this audit), and `schema.ts` with the conformance tests is the
  only guard against drift.
- `HttpClient` uses `fetch` (Node 18+), not raw TCP. Behaviour is the same for the runtime's
  `Content-Length` responses.
- `WardBeckClient` has been tested against a mock hub, not the live caster.
- The integer types (usize, u32, u64) are plain `number` with no brand, so nothing stops a
  writer sending `1.5`.

## Open questions

1. Should `WIRE_VERSION` be bumped for the MQTT fields and the Fader additions, or is
   "additive with serde defaults" the stated policy? If it is the policy, write it into
   `plans/09-sdk.md`.
2. Should the overnight quiet bug (finding 2) be fixed in Rust? The fix changes simulated load
   curves and existing captures.
3. Should slugs transliterate accents (`brasilia`)? That changes frame ids on disk.
4. Should the Ward-Beck line escape CR/LF and quote whitespace-edged fields? That is a wire
   format change.

## Next steps

1. Land ts-rs behind the `ts` feature, generate into `sdk/generated/`, and add the
   `generated.check.ts` equality file.
2. Fix `HttpClient::rename`'s return type in Rust.
3. Add a typed WebSocket `/ws` message union. It belongs to agent 05 (api), but the payload
   types should be added to `types.ts` here.
4. Add a `RemoteFrame` and `Status` `KeySpec` once a live `/api/status` sample is captured.
