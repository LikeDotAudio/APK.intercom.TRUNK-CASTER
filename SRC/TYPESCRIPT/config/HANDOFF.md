# Area 10 of 10: config, build and infra

## Verdict: CONVERT (config types and the build pipeline); KEEP rebuild.py in Python

**Typed config: convert.** Every hand-edited JSON config now has a TS type and a dependency-free validator that behaves like serde (missing required field: error; unknown field: warning, because serde silently ignores it; `null` for a defaulted `f64`: error). One CLI, `validate-config.ts`, checks the 8 configs, 5 cross-file rules and 7 JSONL logs. That matters because **three configs are overwritten with defaults by the runtime when they fail to parse** (sites.json, globe.json, relay.json). A hand-edit with a typo loses the whole file on the next boot.

**Build: convert, behind a cargo feature.** `build.ts` bundles the 5 browser entries that replace the 5 `const *_JS: &str` raw strings in html.rs, plus 4 extra page entries, into `TYPESCRIPT/dist/web/`. The patches gate an `include_str!` next to each const behind `--features ts-bundles`, so the inline JS stays the default until parity is signed off. Docker gets a node stage. Node is never in the final image and is never invoked from build.rs.

**rebuild.py: keep in Python.** It is 499 lines of subprocess orchestration (docker, cargo, gh, git, tasklist, `os.startfile` for Docker Desktop). It shares no types with the TS code, and Python stays in the toolchain for the vendor simulators anyway. It gets a 34-line `ts_build()` step instead (patch).

## Scope (audited, read-only)

| File | Lines | What |
|---|---|---|
| `TRUNK-CASTER-SDK/src/folders.rs` | 95-210 | every config/log path |
| `TRUNK-CASTER-SDK/src/sites.rs` | 1-80, 146-160 | `Tier`, `Site`, `Sites`, `normalize`, `slugify` |
| `TRUNK-CASTER-SDK/src/labels.rs` | 1-40 | `Label` (6/8/16 grapheme cuts) |
| `TRUNK-CASTER-SDK/src/types.rs` | 285-330, 376-476, 478-570, 708-736, 819-866, 905-1315, 1438-1480, 1590-1680 | GpioFunction/GpioEvent, LabelEvent, RelayBinding/RelayEvent, VendorPolicy/RenameTransport/RenameDispatch, GainSet/GainEvent, Crosspoint/CrosspointEvent/CrosspointSettings, Fader/Production/DaySchedule/Blackout/Newscast/Olympics, RelayMatrix/RelayConfig, GlobeConfig/Zone/Preference |
| `RUST-RUNTIME/src/runtime.rs` | 120-175, 196-280, 300-325, 1130-1160, 1236-1270, 1300-1325, 1376-1382, 1480-1500 | boot-time reads, defaults written, every `append_line_capped` |
| `RUST-RUNTIME/src/relay.rs` | 10-30 | relay.json load/overwrite |
| `RUST-RUNTIME/src/crosspoints.rs` | 40-80 | settings.json, deltas.jsonl replay |
| `RUST-RUNTIME/src/util.rs` | 118-138 | `append_line_capped`, `LOG_CAP` |
| `RUST-RUNTIME/src/simulate.rs` | 1-60 | config copied into a scratch root |
| `RUST-RUNTIME/src/html.rs` | the 5 JS consts (JS 112-392, GLOBE_JS 1171-1569, DISCOVERY_JS 1620-1668, EDITOR_JS 1962-1974, RELAY_JS 3163-3221 in today's working copy) and their `format!` sites | what the bundles replace |
| `TRUNK-SIMULATOR/launch_all.py` | 90-112, 216-226 | the only reader of emulators.json |
| `Dockerfile` (55), `.dockerignore` (9), `RUST-RUNTIME/build.rs` (12), `RUST-RUNTIME/Cargo.toml` (15), `docker-compose.yml` (48), `docker-compose.sims.yml` (453, generated), `rebuild.py` (499) | all | build and infra |
| Data | | `TRUNK-GLOBAL/{sites,globe}.json`, `TRUNK-SIMULATOR/{fader,emulators}.json`, `TRUNK-CASTER-SDK/vendor-policy.json`, `TRUNK-RELAY/relay.json`, `TRUNK-CROSS POINTS/settings.json`, `PANELS/connect.json`, 5 JSONL logs on disk (preferences, labels, renames, gpio, deltas: 263 MB, 722,792 lines) |

Not in scope: `PANELS/streamdeck-*.json` and `panel.schema.json` belong to panels (agent 07). `regions.json`, `trends.json`, `runs.json`, `timeline.json`, `TRUNK-RELAY/state.json` and `TRUNK-USAGE/*.json` are runtime outputs, not hand-edited.

## Findings

### Config handling in the original

1. **Hand-edits are destroyed on a parse error (HIGH).** `runtime.rs:134-149` (sites, globe) and `relay.rs:16-26` (relay) do `match read_json { Err(_) => { write_json(default) } }`. One trailing comma in sites.json replaces 179 sites with the built-in default list, with nothing logged. `validate-config` flags these files "(on invalid: overwritten)". **Fix:** on `Err`, log the error and run on defaults, but do not write; or rename the bad file to `.bad`.
2. **The other configs silently fall back to defaults (MEDIUM).** fader.json (`runtime.rs:167`, and every tick at `:635`), vendor-policy.json (`:170`) and crosspoint settings.json (`crosspoints.rs:63`) use `unwrap_or_default()`. A typo means "the fader ignores me". It is worse for fader: the next POST `/api/fader` writes the in-memory defaults back (`runtime.rs:860`).
3. **Unknown fields are ignored (MEDIUM).** No struct has `deny_unknown_fields`, so `"show_capital": false` is accepted and does nothing. The validator warns on every unknown key. Real files today have none.
4. **Two capital lists disagree (MEDIUM, real data).** emulators.json and the Python world table (`rts_intercom_sim.py:477-511`) have 56 capitals. sites.json has 54 `capital`-tier sites, and **11 emulator capitals have no site**: Abuja, Pretoria, Addis Ababa, Accra, Rabat, Abu Dhabi, Doha, Tehran, Baghdad, Islamabad, Dhaka. Conversely, sites.json tiers Lagos, Johannesburg, Dubai, Mumbai, Shanghai, Sydney, Hong Kong and Tel Aviv as capitals.
5. **Slugs from accented names are mangled (LOW, real data).** `sites.rs:146` `slugify` maps non-ASCII to `-`. Real frame ids are `bras-lia-01`, `bogot-01`, `krak-w-01`, `medell-n-01`, `s-o-paulo-01`. fader.json already references `bras-lia-01`. Fixing this is a data migration.
6. **4 of 5 emulator scripts do not exist (INFO).** Riedel, Clear-Com, Intracom and Telos-Infinity run on the RTS stand-in, as the `_comment` says. The validator reports it so the day one lands it gets noticed.
7. **vendor-policy RTS OID is a placeholder (INFO).** It is enterprise `99999` with no `target`. Every RTS rename builds an SNMP PDU that is never sent: 511k such lines sit in renames.jsonl.
8. **Doc drift (LOW).** `GlobeConfig.projection` is documented `"globe" or "map"` (`types.rs:1607`), but the default is `"both"` and GLOBE_JS treats anything except `"map"` as globe. `Preference.kind` (`types.rs:1672`) omits `capture-start`, `capture-stop` and `daily-reset`, which are on disk. The `sites.rs:3` comment says the file lives in TRUNK-CASTER-SDK, but it lives in TRUNK-GLOBAL.

### JSONL logs (real results)

9. **Concurrent appenders glue records together (HIGH, real data).** There are 3,989 lines with two records glued: labels 69, renames 3,865, gpio 55. Example: `{"seq":3243,…}{"seq":1852407,…}` comes from two runtime boots (connection epochs 1792588761 and 1792533571) writing the same file at once. Cause: `util.rs:133` `writeln!(f, "{line}")` on an unbuffered `File` issues the text and the `\n` as **separate writes**. Fix: one `write_all(line + "\n")` (`patches/util.rs.patch`). Also find out why two runtimes shared one TRUNK root (Docker caster plus a local `cargo run`?).
10. **`LOG_CAP` did not hold (MEDIUM).** renames.jsonl is 206 MB against a 100 MB cap, with no `.1`. The rotate is `let _ = fs::rename(...)`, so on the Windows/OneDrive bind mount a failed rename is swallowed and appending continues.
11. **About 260 MB of stale simulated lines (LOW).** The current runtime filters simulated traffic out of labels, renames and gpio (`runtime.rs:1136`, `:1262`, `:1496`), but 99.8-99.9% of the lines on disk are `sim-`/`bldg-`/`origin:"simulator"` from before that filter (last write 2026-10-21 14:28Z). They are safe to archive.
12. **`seq` restarts at 1 on every boot (LOW).** `pref_seq`, `label_seq`, `rename_seq` and `gpio_seq` start at 0 (`runtime.rs:202-253`). preferences.jsonl has 15 resets and renames 29,902. `seq` is not a key. Readers must use `(at, seq)` or the file offset.

### Build and infra

13. **The bundles must be classic-script IIFEs.** `JS` shares global lexical bindings (`TC`, `api`, `esc`, `LIVE`) with GLOBE_JS, DISCOVERY_JS, RELAY_JS and inline `onclick=`. web-core (agent 01) already publishes these on `window` (`web-core/src/globals.ts`). Rust injects `const REFRESH_MS=…;const BUILD="…";` in the same `<script>` (html.rs `page()`), and the IIFE reads them as globals. `build.ts` uses `format:"iife"` and refuses output containing `</script`.
14. **build.rs and `rerun-if-changed`.** Watching a *missing* directory makes cargo re-run the build script every time, which re-stamps `TC_BUILD` and forces every open page to reload. The patch watches the 5 named files only when the feature is on, and panics with "run npm run build" if one is missing. It does not invoke node from build.rs: the rust image has no node, and the Docker stage already builds the bundles.
15. **Inconsistent `tsBuildInfoFile` (LOW).** globe (`globe/dist/.tsbuildinfo`), simulator, panels and charts drop `.tsbuildinfo` inside their source folders. The others use `node_modules/.cache/tsbuildinfo/`. Unify these before promoting the solution file. `.dockerignore.patch` excludes `**/*.tsbuildinfo` meanwhile.

## What was built (all under `TYPESCRIPT/config/`)

| File | Lines | Status |
|---|---|---|
| `tsconfig.json` | 10 | extends `../tsconfig.base.json`, types `["node"]` |
| `src/check.ts` | 231 | validator combinators: `str/num/int/bool/oneOf/pattern/arr/record/opt/obj/refine`, serde semantics, one cast total |
| `src/types.ts` | 356 | TS types for 8 configs + 7 JSONL line shapes, each annotated with its Rust file:line |
| `src/schemas.ts` | 511 | one validator per file/line shape + semantic rules (unique slugs/ids, one anchor zone, 56 capitals, port collisions, grapheme cuts via `Intl.Segmenter`, path endpoints, SNMP sanity) |
| `src/jsonl.ts` | 119 | streaming JSONL scan (206 MB in ~4.5 s), issues folded into counted patterns, seq resets, simulated share, glued-record diagnosis |
| `src/registry.ts` | 59 | every file: path, check, reader file:line, behaviour on invalid |
| `validate-config.ts` | 209 | the CLI (`--no-logs`, `--quick`, `--json`, `--strict`, `--root`) + 5 cross-file rules |
| `build.ts` | 129 | esbuild: 5 fixed entries (one per html.rs const) + discovered `pages/src/entries/*`, IIFE, inline-safety check, `manifest.json` (bytes, sha256) |
| `src/config.test.ts`, `src/build.test.ts` | 156 | 18 tests |
| `tsconfig.solution.json` | 19 | references all 10 areas; **paths relative to TYPESCRIPT/**: promote to `TYPESCRIPT/tsconfig.json` |
| `patches/*.patch` (8) | 255 | html.rs, Cargo.toml, build.rs, util.rs, Dockerfile, .dockerignore, rebuild.py, package.json. **All 8 pass `git apply --check` against today's working tree** |

### Typecheck and tests (pasted)

```
$ node node_modules/typescript/bin/tsc -p config
(no output, exit 0)

$ node --test --experimental-strip-types config/src/*.test.ts
✔ every html.rs JS const has exactly one bundle
✔ assertInlineSafe refuses </script in any case
✔ buildAll bundles IIFEs that are inline-safe, with a manifest
✔ obj: missing required field is an error, unknown field a warning (serde ignores it)
✔ int rejects fractions and negatives like serde u64
✔ validateText reports JSON syntax at the root and tolerates a BOM
✔ globe: real file shape passes; zero anchors warns; bad projection warns
✔ globe: `null` for a #[serde(default)] f64 is refused (serde only defaults when absent)
✔ fader: seed must be an integer; productions optional
✔ sites: duplicate slugs are errors; slugify matches sites.rs
✔ relay: port_names outside io warn; duplicate matrix ids error
✔ vendor-policy: snmp without oid is an error, without target a warning
✔ label: cuts are graphemes, emoji count as one
✔ labels.jsonl line from disk validates; wrong `over` is an error
✔ deltas/gpio/renames lines from disk validate
✔ jsonl folding: one bad field over many lines is one counted pattern; seq resets counted
✔ capital codes cover the emulator naming
✔ cross: production studio must be a site frame
ℹ tests 18  pass 18  fail 0

$ tsc -b <solution with all 10 references>        (run from a scratch copy; nothing written to TYPESCRIPT/)
exit 0   (sdk api web-core globe charts pages routing panels simulator config: 0 errors each)

$ node --experimental-strip-types config/build.ts --outdir <scratch> [--minify]
built core.js 35,978 B (22,023 min)  <- web-core/src/index.ts       replaces JS          (inline today 29,396 B)
built globe.js 67,291 B (39,504)     <- globe/src/main.ts           replaces GLOBE_JS    (45,243 B)
built page-globe.js 6,284 B (4,398)  <- pages/src/entries/globe.ts  replaces DISCOVERY_JS (5,076 B)
built page-panel-editor.js 1,582 B (1,054)                          replaces EDITOR_JS   (1,128 B)
built page-relay.js 9,186 B (6,065)                                 replaces RELAY_JS    (6,880 B)
+ page-continents / overlord / panels / racks; 9/9 bundles, ~450 ms
```

### validate-config on the real tree (exit 0: configs pass; logs fail, which is a finding)

```
CONFIG FILES
  OK*  TRUNK-GLOBAL/sites.json              0 errors, 5 warnings (on invalid: overwritten)
       w slugs krak-w, medell-n, bras-lia, bogot, s-o-paulo: ASCII-only slugify of accented names
  OK   TRUNK-GLOBAL/globe.json              (on invalid: overwritten)
  OK   TRUNK-SIMULATOR/fader.json           (on invalid: default)
  OK   TRUNK-SIMULATOR/emulators.json       (on invalid: crash)
  OK*  TRUNK-CASTER-SDK/vendor-policy.json  2 warnings: RTS no target; OID enterprise 99999 placeholder
  OK   TRUNK-RELAY/relay.json               (on invalid: overwritten)
  OK   TRUNK-CROSS POINTS/settings.json     (on invalid: default)
  OK   PANELS/connect.json                  (on invalid: unread)
CROSS-FILE
  w 11 emulator capitals have no capital-tier site in sites.json (54 there): ABUJ PRET ADDI ACCR RABA ABUD DOHA TEHR BAGH ISLA DHAK
  w 4 emulator scripts missing (Riedel, Clear-Com, Intracom, Telos-Infinity): RTS stand-in
JSONL LOGS
  OK       preferences.jsonl   244 lines, 15 seq resets
  INVALID  labels.jsonl        41.0 MB, 148,696 lines, 69 glued, 99.9% simulated (stale)
  INVALID  renames.jsonl      206.4 MB, 519,234 lines, 3,865 glued, 29,902 seq resets, over LOG_CAP, 98.5% simulated
  INVALID  gpio.jsonl          14.4 MB, 53,618 lines, 55 glued, 99.8% simulated
  OK       deltas.jsonl         1,000 lines
  ABSENT   TRUNK-RELAY/events.jsonl, TRUNK-USAGE/gains.jsonl
full run ~11 s; --no-logs is instant
```

## How to wire it in (NOT applied)

1. Promote `config/tsconfig.solution.json` to `TYPESCRIPT/tsconfig.json`. Strip the leading comment if a tool objects; tsc accepts it.
2. `git apply TYPESCRIPT/config/patches/package.json.patch`. This adds `build`, `build:min`, `validate-config` and `validate-logs`.
3. `npm run build` (from TYPESCRIPT/) writes `TYPESCRIPT/dist/web/*.js` and `manifest.json`. Add `TYPESCRIPT/dist/` to `.gitignore`.
4. `git apply` the Cargo.toml, build.rs and html.rs patches. `cargo build` is unchanged. `cargo build --features ts-bundles` serves the TS bundles. Compare pages A/B, then flip one const at a time if preferred: each `#[cfg]` pair is independent.
5. `git apply` the Dockerfile and dockerignore patches. They add a `node:24-bookworm-slim` web stage (`npm ci && npm run typecheck && npm run build`) and build cargo with `--features ts-bundles`.
6. `git apply rebuild.py.patch`. `ts_build()` runs `npm run typecheck`, `npm run validate-config` and `npm run build` before `cargo check --features ts-bundles`. It skips TS if npm is absent, and `--no-check` skips both.
7. Independently and urgently: `git apply util.rs.patch` (glued records). Then change the overwrite-on-parse-error paths in `runtime.rs:134-149` and `relay.rs:16-26`. No patch for those: that is runtime behaviour, and another session is editing runtime.rs.
8. Optional: archive the stale `renames.jsonl`, `labels.jsonl` and `gpio.jsonl` (~260 MB) out of the OneDrive folder.

Patches were generated against the 2026-10-21 working tree, with uncommitted edits to html.rs and runtime.rs from another session. If `git apply --check` fails later, regenerate with `config/tools/mkpatch.cjs` (usage in its header) (anchors are const names, not line numbers), or re-apply the 5 `#[cfg]` pairs by hand. html.rs is CRLF in the working copy, so use `git apply --ignore-whitespace`.

## Risks

- **Parity.** The bundles are only as faithful as areas 01-03. The feature flag keeps the inline JS as the default until a page-by-page A/B passes. Bundles are larger unminified (core 36 KB vs 29 KB inline). Use `build:min` for the Docker stage if page weight matters.
- **Docker context grows.** `.dockerignore` now admits `TYPESCRIPT/` minus node_modules, dist and tsbuildinfo. golden/fixture folders in charts, routing and simulator come along and are harmless.
- **`node:24-bookworm-slim` is a new base image to pull.** It matches the local Node 24.11, so `--experimental-strip-types` behaves the same.
- **Validator drift.** `types.ts` mirrors Rust by hand. When agent 04's `sdk/` exports these types, re-export from there. A golden test that round-trips `Fader::default()` JSON from Rust would catch drift.
- **`crossChecks` casts.** It reads validated values as `Sites`/`Fader` with `as`. That is safe because they come only from passing validators, but it is the one place the types are asserted, not proved.

## Open questions

1. Overwrite-on-error for sites, globe and relay: keep defaults in memory but never write? Or move the bad file aside? (Recommended: move aside as `.bad-<ts>`, log it, run on defaults.)
2. Which capital list is canonical: sites.json (54, includes non-capital metros) or the emulators/Python table (56)? Memory says "56 users", the 56-capital plan.
3. Fix the accented slugs now (a data migration of frame ids in logs and state) or freeze them?
4. Should `validate-config --no-logs` gate `docker compose up` (it takes milliseconds), or only rebuild.py?
5. Why did two runtimes append to the same TRUNK-* folder on 2026-10-21 13:23Z?

## Next steps

- Apply util.rs.patch first (data integrity), then the package.json and build patches behind the feature.
- Dedup `src/types.ts` against `TYPESCRIPT/sdk/` once agent 04 publishes Fader, GlobeConfig, RelayConfig, Label, GpioEvent, etc.
- Add `"validate-config"` to the Docker web stage once the configs are mounted rather than baked. Today they are runtime-mounted at `/data`, so validation belongs in rebuild.py and in the runtime, not in the image build.
- Port the validator rules into Rust (`deny_unknown_fields` warnings, no overwrite), or serve `/api/config/validate` from the runtime using the same rules.
