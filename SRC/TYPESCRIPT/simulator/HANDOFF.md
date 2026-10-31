# Area 06 of 10: Python simulators to TypeScript (Node)

## Verdict

**Convert.** All four Python pieces are now ported to strict TypeScript that runs on Node 24 with
`--experimental-strip-types`. The pieces are `tc_protocol`, `tc_map`, `launch_all` and the RTS intercom
estate. Parity is checked against fixtures produced by running the original Python:

- the codec bytes, the BER bytes, `--dump-oids`, `--check-mibs`, the generated keypanels (CPython's MT19937 is reproduced) and `world_config`/`spawn_config` are identical;
- the full 188-device world estate matches Python on totals, trunk count, OID-store size, map states and console text.

`tsc` is clean and 37 of 37 tests pass. Nothing outside `TYPESCRIPT/simulator/` was changed.

**`TRUNK-SIMULATOR/frame-sim` (Rust): keep it in Rust** (see the "frame-sim" section below).

## Scope (audited)

| file | lines | ported to |
|---|---|---|
| `TRUNK-SIMULATOR/tc_protocol.py` | 1-108 (all) | `src/tc-protocol.ts` |
| `TRUNK-SIMULATOR/tc_map.py` | 1-68 geojson; 70-447 HTML; 450-564 server, tz | `src/tc-map.ts` + `src/map-page.html` (verbatim copy) |
| `TRUNK-SIMULATOR/launch_all.py` | 1-255 (all) | `src/launch-all.ts` |
| `TRUNK-SIMULATOR/emulators.json` | 1-109 | read unchanged by `launch-all.ts` |
| `TRUNK-SIMULATOR/README.md` | 1-90 | docs only; drift noted below |
| `KNOWN PROTOCOLS/VENDOR/RTS/SIMULATOR/rts_intercom_sim.py` | 88-262 BER | `src/rts/ber.ts` |
| same | 265-453 MIB parser | `src/rts/mib.ts` |
| same | 456-695 plans, capitals, subsites, panels; 2199-2280 configs | `src/rts/world.ts` |
| same | 697-1985 Device, AudioEngine, Matrix, RVON, TM-2000 | `src/rts/devices.ts` |
| same | 1988-2197 Estate; 2283-2378 client, traps, reports | `src/rts/estate.ts` |
| same | 2380-2485 CLI | `src/rts/main.ts` |
| `TRUNK-SIMULATOR/frame-sim/src/main.rs` | 1-253 | audit only |

That is 3,864 source lines audited. I wrote 4,695 lines of TypeScript source and 592 lines of tests.

## Findings

1. **The Python simulators do not speak Ward-Beck and do not use TCP 7879.** The RTS estate speaks:
   - SNMP v1/v2c (16100+i);
   - a telnet console (17100+i);
   - the `tc_protocol` UDP audio series (20000+256i, plus 43000+16k for the 8x8 frames);
   - HTTP map and API (8180-8185).

   Only the Rust `frame-sim` speaks `SITE,FRAME,INPUT,...` lines to the caster on 7879, and it is the only thing `docker-compose.sims.yml` runs. The project brief ("each intercom simulator speaks Ward-Beck lines to 7879") does not describe the Python sims as they are today.
2. **The port plan matches the brief.** Tests check it:
   - capital i: SNMP 16100+i, console 17100+i, series 20000+256i;
   - 8x8 frame k: SNMP 36000+k, console 37000+k, series 43000+16k.

   `--base-port` only moves the Trunk Master; the world ports are fixed (`capital_ports`).
3. **Python bug: the console `walk` command always fails.** `fmt_value` is called on `str` store values (sysDescr etc.), raises `AttributeError: 'str' object has no attribute 'hex'`, and the console prints `error: ...`. Confirmed by running it. The TS port prints the value instead. The test in `estate.test.ts` covers this.
4. **MIB parser quirk.** The regex `^\s*([\w-]+)\s+MODULE-IDENTITY` matches the `IMPORTS ... MODULE-IDENTITY` list, so a bogus object named `IMPORTS` is registered (it appears in `--dump-oids` line 3). I kept it for byte parity.
5. **launch_all error forwarding loses the text.** When an emulator answers 400, `urllib` raises `HTTPError` before the body is read. The combined map then returns **500 "HTTP Error 400: Bad Request"**, and the `if not data.get("ok")` branch is dead code. I kept this faithfully; a test pins it. Recommended fix: read the body on 4xx and re-raise it as a 400.
6. **launch_all owner lookup by device name has no `break`,** so the last matching emulator wins. Kept.
7. **The README and docstrings disagree with the code about ports:**
   - the README says the per-vendor maps are on `:8081 .. :8085`, but the registry uses 8181-8185;
   - the `launch_all` docstring says the combined map is on `:8080`, but the registry uses 8180;
   - `rts_intercom_sim.py` still defaults `--map-port 8080`, which the Rust runtime owns.
8. **Python errors leak into the API.** `str(KeyError('port'))` is `'port'` with the quotes, so API 400 bodies read `{"error": "'port'"}`. The TS port reproduces this (`PyKeyError.pyStr`).
9. **numpy is optional in Python, so audio was optional.** TS needs no numpy, so the audio series is always on. A full 56-capital estate binds about 7,171 UDP sockets (56×107 + 131×9), plus 188 SNMP and 188 TCP. The RTS-only process (10 capitals + 97 frames) binds about 1,943. This was smoke-tested on small estates only.
10. **SO_REUSEADDR on Windows UDP.** Both Python and Node (`reuseAddr: true`) can bind a UDP port that another process already holds, silently sharing or stealing datagrams instead of logging "cannot bind". That is why the tests never bind world ports while the Python emulators are running.
11. **Python behaviours that do not map cleanly:**
    - **threads**: Python ran one thread per agent and console plus a mixer thread. TS uses the event loop, so no locks are needed.
    - **`threading.Timer` (non-daemon)**: in Python this delayed exit by up to 20 s. TS uses `setTimeout(...).unref()`.
    - **unbounded Python ints**: TS uses BigInt for BER (Counter64, negative INTEGER).
    - **tuple OIDs**: TS keys the store on dotted strings and sorts with `oidCmp`.
    - **`random.Random(1234)`**: reimplemented as `PyRandom` (MT19937, init_by_array, randbelow), so the panels are identical.
    - **`json.dumps`**: re-implemented as `pyJson` (ensure_ascii, `", "`/`": "` separators, `indent`). A float with an integral value prints `160`, not `160.0`.
    - **`%Z`**: Windows long names are mirrored via Intl.
    - **float32 tone**: numpy computed it in float32 and TS uses float64 with `Math.fround`, so samples may differ by 1 LSB.
    - **argparse prefix abbreviations**: not supported.
12. **Untyped hazards that TS now catches:**
    - `talks` keys mix `int` and `"ALPHA:port"` strings; TS types them as `TalkKey = number | string`.
    - Endpoint dicts double as UDP endpoints and button claims (`addr=None`); TS uses an explicit `Endpoint.addr: Addr | null`.
    - `cfg` is mutated in place before `super().__init__`.

## What was built (`TYPESCRIPT/simulator/`)

| file | what | status |
|---|---|---|
| `tsconfig.json` | extends `../tsconfig.base.json`, lib ES2022, types node+ws | ok |
| `src/py.ts` | Python shims: PyKeyError/PyValueError (400s), pyInt/pyFloat, pyJson, pyRepr, PyRandom (MT19937), isoNow, localTzLabel | ok, tested |
| `src/tc-protocol.ts` | codec (pack/unpack/HELLO/ACK/AUDIO/KEY/STATE/BYE), local wire types | byte-identical to Python |
| `src/tc-map.ts` + `src/map-page.html` | `toGeojson`, `MapServer` on node:http (GET/POST/OPTIONS, `/api` 400/500 mapping, CORS, no-store) | ok, tested on an ephemeral port |
| `src/launch-all.ts` | registry, Child (child_process spawn, line pump, filter, SIGTERM→5 s→SIGKILL), Launcher (merge `/state`, placeholders, `/api` routing and fan-out), CLI with `--runtime node\|python` | ok, tested incl. a real spawn |
| `src/rts/ber.ts` | BER/SNMP encode/decode, OID helpers, `fmtValue` | byte-identical |
| `src/rts/mib.ts` | Telex MIB parser (by module name), TCs, `tagFor`, `lookup` | dump identical |
| `src/rts/world.ts` | port types, 56 capitals, 131 state frames, port numbering, panels, `worldConfig`/`spawnConfig`, `hslHex` | identical |
| `src/rts/devices.ts` | Device (SNMP agent via dgram, TCP console via net), AudioEngine (256-socket series, 20 ms mixer), Matrix, RVON, TM-2000 | tested live on high ports |
| `src/rts/estate.ts` | Estate (scenarios, traffic weight, button API, state, run/stop), SNMP client, trap listener, reports | tested |
| `src/rts/main.ts` | same CLI flags as the Python script | smoke-tested on :18999 |
| `src/*.test.ts`, `src/rts/*.test.ts` | 37 tests | pass |
| `fixtures/python-parity.json`, `fixtures/python-world.json` | outputs from running the Python modules (generator scripts were run from the scratchpad with `python -B`) | data |
| `fixtures/fake_emulator.py` | test double for the launcher spawn test | test only |

### Typecheck and tests (run from `TYPESCRIPT/`)

```
$ node node_modules/typescript/bin/tsc -p simulator
exit 0

$ node --test --experimental-strip-types simulator/src/*.test.ts simulator/src/rts/*.test.ts
✔ plan from the real emulators.json: RTS runs itself, the other four vendors are stood in for by RTS
✔ --only filters, dead emulators show as offline placeholders
✔ merges a live emulator's /state and forwards /api calls to the owner
✔ spawns a child process, pumps its output, polls it, stops it
✔ argument parsing
✔ PyRandom(1234) reproduces CPython's stream
✔ KeyError / ValueError strings match str(exc)
✔ int() / float() conversions throw like Python
✔ json.dumps formatting
✔ BER encodings are byte-identical to Python
✔ build_message / parse_message round trip
✔ OID helpers
✔ world estate (56 capitals + 131 state frames + TM) matches Python, built without binding anything
✔ SNMP agent: GET, GETNEXT, GETBULK, SET, bad community
✔ console: talk, calls, walk (Python crashed on str values here), unknown, error text
✔ audio series: HELLO on +0 hands out a port, HELLO on the port socket gets the plan, KEY changes STATE, mixer sends AUDIO
✔ button API: claim, key, port, trunk call through the Trunk Master, hangup, release, scenario, errors
✔ --dump-oids output is identical to Python
✔ --check-mibs output is identical to Python (modules found by content, Telex-Icom-MIB missing)
✔ textual conventions and enums match
✔ tag_for / lookup
✔ strip_comments keeps -- inside strings
✔ generated keypanels are identical to Python's random.Random(1234)
✔ tables: 56 capitals, continents, flags, subsites
✔ port plan: capital i owns snmp 16100+i, console 17100+i, series 20000+256i; subsite k 36000+k / 37000+k / 43000+16k
✔ hsl_hex matches
✔ world_config and spawn_config are identical to Python
✔ parse_plan
✔ to_geojson: points for placed devices, lines only between placed devices
✔ map page is the verbatim tc_map.HTML
✔ GET / /geojson /state
✔ /api: help, ok, 400 for ValueError/KeyError, 500 otherwise, CORS preflight
✔ POST bodies: JSON values become str(), forms parse like parse_qs
✔ start() rejects when the port is taken
✔ constants match tc_protocol.py
✔ pack_* are byte-identical to Python
✔ unpack round-trips and rejects foreign datagrams
ℹ tests 37
ℹ pass 37
ℹ fail 0
```

The tests bind only:

- ephemeral ports;
- 47100-47103 (SNMP), 47200-47203 (console) and 47500-48011 (audio series);
- 18997 (the fake emulator).

None of these is 8080, 8081 or 8180-8185. A manual smoke test ran `rts/main.ts --spawn tm2000=1,cronus=1,rvon8=1 --base-port 46100 --map-port 18999`. `/api/matrices` and `/geojson` answered, and then I killed only that PID.

## How to wire it in (NOT applied)

1. **Local launcher, replacing `python TRUNK-SIMULATOR/launch_all.py`.** Stop the Python launcher first, because it holds 8180-8185 and every world port. Then:
   ```
   cd TYPESCRIPT
   node --experimental-strip-types simulator/src/launch-all.ts            # same registry, same ports
   node --experimental-strip-types simulator/src/launch-all.ts --list     # shows [node ...] per vendor
   node --experimental-strip-types simulator/src/launch-all.ts --runtime python   # old behaviour
   ```
2. **The RTS estate directly.** Replace `python "KNOWN PROTOCOLS/VENDOR/RTS/SIMULATOR/rts_intercom_sim.py" <flags>` with `node --experimental-strip-types TYPESCRIPT/simulator/src/rts/main.ts <flags>`. The flags are the same: `--world --capitals --vendor --map-port --chaos --spawn --config --walk --get --trap-listener --dump-oids --check-mibs --write-config --export-geojson --no-subsites --scenario --quiet`.
3. **Optional `package.json` scripts** (shared file, so this is for the owner to apply):
   ```json
   "sim:launch": "node --experimental-strip-types simulator/src/launch-all.ts",
   "sim:rts":    "node --experimental-strip-types simulator/src/rts/main.ts"
   ```
4. **`docker-compose.sims.yml` needs no change.** It runs only `trunk-caster-frame-sim` (Rust, Ward-Beck on 7879), never Python. If the RTS estate should run in Docker too, a service could look like this (sketch, not applied):
   ```yaml
   sim-rts-estate:
     image: node:24-alpine
     working_dir: /repo/TYPESCRIPT
     command: ["node","--experimental-strip-types","simulator/src/rts/main.ts","--world","--capitals","WASH,OTTA","--map-port","8181","--quiet"]
     volumes: [".:/repo:ro"]
     network_mode: host     # thousands of UDP ports: publishing them one by one is impractical
     profiles: ["sims"]
   ```
5. **Existing consumers keep working without change**, because the frames and HTTP shapes are identical:
   - `TRUNK-SIMULATOR/trunk_panel.py` speaks `tc_protocol` to the series ports;
   - `PANELS/` Stream Deck users call the `/api/*` endpoints.
6. **For an esbuild bundle**, `tc-map.ts` reads `map-page.html` via `import.meta.url`. Copy the HTML next to the bundle, or switch it to an esbuild `text` loader import.

## frame-sim (Rust): keep it in Rust

- It is 253 lines and already small and correct for its job: TCP client to 7879, CHECKIN wildcard, apply CLOSE/OPEN, echo, periodic check-in, and the `U<56`/`C<8` port check.
- It imports `trunk_caster_sdk::wardbeck::{Line, Switch}`, the same crate the caster uses. Parse and format stay single-sourced with the broker. A TS port would need agent 04's Ward-Beck codec and would then have two implementations to keep in lockstep.
- One image serves 27 compose services. The Rust static binary is small; `node:24` adds a runtime per container.
- Minor issues worth fixing in Rust:
  - `Sim::now()` returns epoch seconds, not the ISO time the comment implies;
  - check-ins only fire after a read returns or times out (fine at 500 ms);
  - no jitter on reconnect backoff across 27 containers.

## Risks and open questions

- **Socket scale under Node.** A full world estate in one process (~7.5k sockets) is untested. Per-vendor processes, as `launch-all` does, keep RTS at about 2k. Each live matrix mixer runs a 20 ms `setTimeout` chain, so Windows timer granularity may jitter frames. Idle matrices tick every 100 ms, as in Python.
- **Windows UDP `reuseAddr`** can silently double-bind next to a running Python emulator (finding 10). Do not run both stacks at once.
- **Dedup with agent 04 (sdk).** These types are defined locally:
  - `HelloAck`, `HelloAckPort`, `PortState`, `IncomingCall`, `Message` in `tc-protocol.ts`;
  - `EstateState`, `MapDevice`, `MapLink`, `GeoCollection` in `tc-map.ts`;
  - `Scenario` and `DeviceMapState` in `rts/devices.ts`.

  Move them to `TYPESCRIPT/sdk` if they are canonical there.
- **Open question:** should the vendor emulators also speak Ward-Beck to 7879, as the brief assumes, or does that stay `frame-sim`'s job only?
- **Open question:** should the Python bugs (the console `walk` crash and the launcher's 400→500) be fixed in Python too, or only here?
- **Open question:** retire the Python sims after a soak period, or keep `--runtime python` indefinitely?

## Next steps

1. Soak test: run `launch-all.ts` for real on a quiet machine (Python stack stopped) and compare `/state` totals and the map against the Python launcher.
2. Decide on the two Python bugs; if they are fixed here, drop the parity pin in `launch-all.test.ts`.
3. Dedup the wire types with `TYPESCRIPT/sdk` once agent 04 publishes them.
4. Optionally port `trunk_panel.py` (Tk plus sounddevice; out of scope here). The codec it needs is `tc-protocol.ts`.
5. Fix the README/docstring port drift (8081-8085 vs 8181-8185, 8080 vs 8180) in the Python sources.
