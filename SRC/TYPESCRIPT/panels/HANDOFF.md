# Area 07 of 10: Panels (Stream Deck emulator, panel schema, soft panel)

## Verdict: CONVERT

Both Python programs port cleanly to Node TS. Everything except the Tk window and PortAudio maps 1:1 onto the Node standard library: `fetch`, `node:http`, `node:dgram`, `Buffer` and `parseArgs`. The windows are replaced by small local web pages that the process serves. The panel schema now has exact hand-written types, a validator with no dependencies, and a lint pass. All four decks and `connect.json` validate.

Node cannot open a microphone or speaker without native code. I built the audio path as a **browser bridge**: getUserMedia and an AudioWorklet connect over a WebSocket to Node, and Node runs the same DSP as the `.py`. There is also a tone device for headless tests. The Python originals should stay in place until the TS version has been run against the real `rts_intercom_sim.py`, which I did not start because it uses ports 8080/8180.

| | |
|---|---|
| Source lines audited | 1,226 (emulator 267, schema 77, connect 52, 4 decks 120, README 73, trunk_panel 529, tc_protocol 108) |
| TS lines written | 2,319 (1,863 source + 456 tests) in 15 files |
| `tsc -p panels` | **pass** (exit 0) |
| `node --test` | **23 / 23 pass** |

## Scope (audited)

| File | Lines | What |
|---|---|---|
| `PANELS/panel.schema.json` | 1-77 | JSON Schema 2020-12 for a button panel |
| `PANELS/connect.json` | 1-52 | Endpoint recipes for Companion / Stream Deck |
| `PANELS/streamdeck-{mini,mk2,plus,xl}.json` | 16/25/24/55 | Ready-made decks |
| `PANELS/README.md` | 1-73 | Model and usage docs |
| `PANELS/streamdeck_emulator.py` | 28-38 Api, 41-230 Emulator, 233-263 main | Tk deck that drives the HTTP button API |
| `TRUNK-SIMULATOR/trunk_panel.py` | 49-137 MatrixLink, 143-210 Audio, 216-302 Key/KeyView, 308-478 Panel, 481-525 main | Turns the PC into a matrix port over TC/UDP |
| `TRUNK-SIMULATOR/tc_protocol.py` | 1-108 | Wire format used by trunk_panel (read for fidelity; ported locally) |
| `KNOWN PROTOCOLS/VENDOR/RTS/SIMULATOR/rts_intercom_sim.py` | 1440-1466, 2108-2145 | Server side of `/api/*` and `port_state` (read only, to type the responses) |

## Findings

Bugs and hazards in the originals. "Fixed" means the TS port behaves differently and a test covers it. "Faithful" means the behaviour was kept and is flagged here.

- **F1 (bug, fixed).** `trunk_panel.py:236-243` `Key.set_target`: retargeting an *active* TALK key sends talk-off but never re-evaluates the mic gate, so `audio.mic_open` stays True. The mic keeps streaming frames with no talk key latched. Covered by the test in `trunk-panel.test.ts`.
- **F2 (bug, hardened).** `trunk_panel.py:117-118`: a HELLO_ACK without `port`/`alpha` raises KeyError inside the link thread. That kills the thread silently, and the panel shows "connecting" forever. The TS port ignores malformed acks.
- **F3 (bug, faithful).** `streamdeck_emulator.py:149`: `col.get("active", "#2e9e4f")` is dead code, because `colors()` (128-133) always fills `active` with red. A listen key without `colors.active` lights **red, not green**. All shipped decks set green explicitly, so this is latent. Test: `emulator.test.ts`. Fixing it is one line in `emulator-core.ts` `face()`.
- **F4 (fidelity).** `streamdeck_emulator.py:222-227` `close()` releases talks but not listens or a latched trunk call. Latch state (`self.latched`) is never reconciled with server state, so a listen the server drops comes back inverted on the next press. `latched` and `state` are also mutated from worker threads with no lock (175, 198).
- **F5 (stale).** `trunk_panel.py:17-18` docstring and `:314` fallback `int(port or 18100)` predate the `20000 + 256*n` series scheme (`--matrix` default 20256, London 22304). Separately, `--matrix myhost` with no port connects to 127.0.0.1:18100, because `rpartition` puts the bare host in the port slot. This is kept faithful in `splitMatrix` and tested.
- **F6 (doc drift).**
  - `PANELS/README.md:71` says "map and API on :8080", but the same line, `connect.json` and every deck use `:8180`.
  - README line 18 says `color`; the schema says `colors`.
  - `panel.schema.json:18` says key_px is "96 for XL/MK2", but MK2 keys are 72 px, which `streamdeck-mk2.json` uses.
- **F7 (contract gap).** `connect.json` `feedback.fields` omits `remote` (the `"ICOM:port"` list) and `port`/`alpha`/`matrix`/`time`. The emulator relies on `remote` to light call keys (`streamdeck_emulator.py:150`).
- **F8 (schema promises not kept).** The emulator ignores `hold_to_latch_ms`, `icon`, `device.serial` and encoder actions. Encoders are drawn only as labels. Lint warns if a deck uses `hold_to_latch_ms`.
- **F9 (data).** In `streamdeck-xl.json:17` the "ALL\nCAMS" key targets `CAM07` only, the same as the CAM 7 key on page `cams2`. Either the label is wrong or the target needs a group.
- **F10 (audio quality).**
  - `trunk_panel.py:193` decimates by boxcar averaging, which aliases above 4 kHz.
  - `:203` upsamples by sample-repeat, which causes zero-order-hold imaging.
  - The jitter buffer is `deque(maxlen=12)` (240 ms) with drop-oldest, no prefill and no drift correction.
  - `:440` subtracts the matrix's `since` epoch from the *local* clock.
  - **numpy is not installed on this machine**, so `trunk_panel.py` currently runs with no audio here at all.
- **F11 (security, by design).** The button API is unauthenticated GET-with-side-effects (`/api/key`, `/api/claim`). That is fine for a lab network. Both TS UIs bind to 127.0.0.1 only.

What TS buys here: `PortState`/`HelloAck`/`Panel` become checked contracts (the `.py` indexes untyped dicts everywhere), the validator rejects bad decks at load time with JSON paths, and the soft panel no longer needs Python + numpy + PortAudio installed on the operator PC.

## Audio assessment (trunk_panel.py:143-210)

| Need | Node natively? | Path taken |
|---|---|---|
| UDP TC frames, seq, keepalive | yes (`node:dgram`) | `matrix-link.ts` |
| Decimate / upsample / int16 LE | yes (typed arrays; 48k samples/s is trivial) | `audio.ts`, numpy maths reproduced and tested |
| Capture mic / play speaker | **no** (no PortAudio in the stdlib) | Browser bridge: `getUserMedia` + AudioWorklet, Float32 blocks over WS (`ws` already in the workspace). Node answers each mic block with one speaker block, so both run on one clock, like sounddevice's duplex callbacks. |
| Device list / choice | no | Browser device picker; `--list-devices` explains this |
| Headless test audio | yes | `ToneAudioDevice` (1 kHz, -12 dBFS) |

The recommended path is to keep the browser bridge as the default. It needs no native build, and `http://127.0.0.1` is a secure context, so getUserMedia works. It also gets echo cancellation and the OS device picker for free.

For a headless operator PC, add an **ffmpeg/sox child-process device** that pipes raw f32le PCM on stdin and stdout (dshow on Windows). It slots into the `AudioDevice` interface and needs no npm package. A native addon such as `naudiodon` (PortAudio) is the last resort, because it needs node-gyp and MSVC and has an uncertain maintenance status.

Separately, replace the boxcar and sample-repeat filters with a short polyphase FIR. Alternatively, let the browser resample with `new AudioContext({sampleRate: 8000})` where supported.

## What was built (`TYPESCRIPT/panels/`)

| File | Lines | Ports | Status |
|---|---|---|---|
| `tsconfig.json` | 8 | - | extends `../tsconfig.base.json` |
| `src/panel-schema.ts` | 271 | panel.schema.json | Exact types, default constants, `validatePanel()` with no dependencies, `lintPanel()` (grid bounds, duplicates, missing targets, `ICOM:port`, dangling pages, encoder count) |
| `src/connect.ts` | 88 | connect.json | `ConnectConfig` type, `validateConnect()`, `expandEndpoint()` |
| `src/matrix-api.ts` | 105 | emulator.py:28-38 | Typed `/api/*` client (fetch with a 3 s timeout); `ApiPort`, `PortState`, `ClaimResult`, `IncomingCall` |
| `src/emulator-core.ts` | 248 | emulator.py:41-230 | Headless deck: run/poll, `faces()`, press/latch/page/reply/call, close |
| `src/streamdeck-emulator.ts` | 179 | emulator.py:233-263 | CLI with the same flags, plus `--ui-port`/`--no-ui`; serves the deck page with SSE feedback |
| `src/tc-protocol.ts` | 109 | tc_protocol.py | Byte-identical pack/unpack (verified against Python vectors) |
| `src/audio.ts` | 164 | trunk_panel.py:143-210 | `AudioEngine` DSP plus `AudioDevice` interface; Null and Tone devices |
| `src/matrix-link.ts` | 166 | trunk_panel.py:49-137 | dgram link: HELLO keepalive, socket move, join, STATE, AUDIO queue (12), KEY, BYE (awaits the send) |
| `src/trunk-panel-core.ts` | 234 | trunk_panel.py:216-478 | Key, `keyFace()`, `PanelModel` (default assignments, incoming, counter, mic gate) |
| `src/trunk-panel.ts` | 299 | trunk_panel.py:481-525 + GUI | CLI with the same flags plus `--audio browser\|tone\|none`; web panel (16 keys, selects, break-away windows, meters, mute); WS audio bridge |
| `src/*.test.ts` (5) | 456 | - | 23 tests |

## Typecheck and tests (pasted)

```
$ node node_modules/typescript/bin/tsc -p panels ; echo TSC_EXIT $?
TSC_EXIT 0

$ node --test --experimental-strip-types "panels/src/*.test.ts"
✔ int16 conversion clips to +-32767 and truncates toward zero like numpy astype
✔ decimate averages blocks and drops the remainder
✔ upsample repeats samples and zero-pads
✔ engine: 48 kHz blocks become 160-sample frames only while the mic is open and unmuted
✔ emulator: claim, talk momentary, listen latch, call latch, reply, page, close
✔ emulator: listen key with no colors.active lights RED, not green (faithful py bug F3)
✔ emulator: page switching on the XL
✔ emulator CLI: --test-seconds --auto-press prints the .py test lines
  streamdeck-mini.json: 6 buttons, lint: []
  streamdeck-mk2.json: 15 buttons, lint: []
  streamdeck-plus.json: 8 buttons, lint: []
  streamdeck-xl.json: 32 buttons, lint: []
✔ streamdeck-mini.json validates against panel.schema.json
✔ streamdeck-mk2.json validates against panel.schema.json
✔ streamdeck-plus.json validates against panel.schema.json
✔ streamdeck-xl.json validates against panel.schema.json
✔ the four decks are lint-clean (grid, targets, pages, encoders)
✔ connect.json validates and every endpoint expands
✔ validator rejects what the schema rejects
✔ lint catches the hazards the schema cannot
✔ pack_* is byte-identical to tc_protocol.py
✔ unpack round-trips and rejects foreign datagrams
✔ frame constants
✔ link: HELLO on series, move to own socket, join, defaults, STATE, keys, mic gate, BYE
✔ tone device streams 20 ms frames only while a talk key is latched
✔ splitMatrix keeps the .py defaults
✔ trunk-panel CLI: --test-seconds --auto-talk --audio tone
ℹ tests 23  ℹ pass 23  ℹ fail 0
```

Every test uses ephemeral ports (`listen(0)`/`bind(0)`): a fake HTTP button API and a fake two-socket UDP matrix.

I also ran an extra smoke test, not saved to the repo. Both pages were served on ephemeral ports, and their inline scripts and the AudioWorklet source parse. A WS client sent `audio` and a 960-sample mic block and got one speaker block back. A deck `POST /press` switched the page.

## How to wire it in (NOT applied)

1. Add `{ "path": "panels" }` to the root `TYPESCRIPT/tsconfig.json` references when one exists, so `tsc -b` covers it.
2. Run the TS against a real simulator (operator to run; ports are reserved for the other session):
   ```
   python "KNOWN PROTOCOLS\VENDOR\RTS\SIMULATOR\rts_intercom_sim.py"
   node --experimental-strip-types TYPESCRIPT/panels/src/streamdeck-emulator.ts PANELS/streamdeck-xl.json --api http://127.0.0.1:8180 --matrix LOND
   node --experimental-strip-types TYPESCRIPT/panels/src/trunk-panel.ts --matrix 127.0.0.1:22304
   ```
   Then run the scripted variants (`--test-seconds 4 --auto-press 0,0` and `--test-seconds 4 --auto-talk 3 --audio tone`) and compare the `test:` lines with the `.py` output.
3. Update `PANELS/README.md` "Try it" and the `connect.json` `audio_for_the_operator.command` to the `node ...` commands, and fix F6/F7 in the same edit.
4. Swap `tc-protocol.ts` and the `PortState`/`ApiPort`/`HelloAck` types for imports from `TYPESCRIPT/sdk` (agent 04) once it lands. Keep the byte-vector test.
5. Retire `streamdeck_emulator.py` / `trunk_panel.py` only after step 2 passes on the target PC with real audio.

## Risks

- Not exercised against the real `rts_intercom_sim.py`. Response shapes were read from its source (1452-1466, 2108-2145), not observed live.
- With the browser bridge, the operator must keep a tab open and grant mic permission, **even for listen-only**, because speaker blocks are clocked by mic blocks. The AudioContext must also run at `--rate`; Chrome honours `sampleRate:48000`, and a mismatch is reported in the panel.
- The DSP uses float64 means where numpy used float32 pairwise sums, so outputs can differ by about 1 LSB. This is inaudible, but it means the output is not bit-identical.
- `trunk-panel.ts` depends on `ws` (already in the workspace). Everything else uses only the stdlib.

## Open questions

1. Should `panel.schema.json` `action` grow the eight GPIO key functions? These are 1 blink panel, 2 check lights, 3 set latch, 4 set listen, 5 unset latch, 6 clear, 7 last caller and 8 ping. They do not map onto talk/listen/call/hangup/reply/page today.
2. Should the schema or lint enforce the house label widths (6 / 8 / 16 chars, emoji allowed)? The decks currently use at most 7 chars per line with `\n`.
3. F3: fix listen-green now (one line) or keep it faithful until the Python is retired?
4. Is the ffmpeg/sox pipe device wanted for a headless TRUNK-RELAY PC, or is the browser tab acceptable?

## Next steps

- Run step 2 above, then decide on F3 and F5 (drop the 18100 fallback; default to the series socket).
- Add `FfmpegAudioDevice` (spawn ffmpeg with `-f dshow` / `-f f32le` pipes) behind the existing `AudioDevice` interface.
- Replace the boxcar/sample-repeat filters with a polyphase FIR, and add a jitter-buffer prefill of 2 frames.
- Optional packages, not installed: `@elgato-stream-deck/node` (drive real hardware from `EmulatorCore.faces()` and `pressAt`) and `naudiodon` (native PortAudio).
