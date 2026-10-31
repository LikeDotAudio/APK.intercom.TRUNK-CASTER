# Architecture of INTERCOM.Caster

← [Manual and Artifacts](INDEX.md) · [Repo README](../../README.md)

**The imported Trunk-Caster source, and where each piece went (ROAD-3440, ROAD-3453).** The
runtime is retired: nothing here runs under APK.audio. The caster is `PLUGIN.TRUNK_CASTER`, the
frame simulators are `PLUGIN.TRUNK_SIM`, the pages are the Intercom soft apps, and the wires they
speak are the `trunk` contract (`contracts/TRUNK.md`).

## The wires: then and now

| Then (the imported runtime) | Now |
|---|---|
| **HTTP** `TRUNK_PORT`: 64 GET + 21 POST routes, pages from `html.rs` | the 21 POSTs are the contract's verbs on `trunk/outgoing/command` → `trunk/incoming/result`; the state is retained documents (`trunk/Device/Frame/…`, `Trunk/…`, `Connection/…`, `Crosspoint/…`, `Booking/…`, `Site/…`, `Relay/…`); the GET-only views are retained `trunk/View/…` documents (`PLUGIN.TRUNK_CASTER` `src/views.rs`); the pages are the Intercom soft apps |
| **WebSocket** `/ws` telemetry | the same retained documents and `trunk/Event/…`, read by the OS shell (`OS/Network/trunk-bus`) |
| **Ward-Beck TCP** 7879 | kept: `PLUGIN.TRUNK_CASTER` `src/wb.rs` listens, `PLUGIN.TRUNK_SIM` and real frames connect |
| **MQTT** `trunk-caster/<protocol>/<frame>/line\|ack\|reject\|voice1\|voice5` on its own broker | the APK broker, `trunk_sim/<protocol>/Frame/<frame>/…` (contract) |
| `TRUNK-*` folders under `/data` | the caster's state volume `apk-audio-trunk-state` (`/var/lib/apkaudio/trunk`), laid from `PLUGIN.TRUNK_CASTER/SRC/data/seed/` at boot |

## Where each module went

| Imported (SRC/…) | Lines | Went to |
|---|---:|---|
| `RUST-RUNTIME/src/runtime.rs`, `routing.rs`, `crosspoints.rs`, `discover.rs`, `protocol.rs`, `frame.rs`, `bookings.rs`, `relay.rs`, `trends.rs`, `recorder.rs`, `analyzer.rs`, `users.rs`, `snmp.rs`, `voices.rs`, `wb.rs`, `util.rs` | 7,9xx | `PLUGIN.TRUNK_CASTER/SRC/src/` — the same modules, nearly verbatim |
| `RUST-RUNTIME/src/report.rs`, `simulate.rs` | 385 | `PLUGIN.TRUNK_CASTER` `src/report.rs` (published as `trunk/View/Report`) and `src/simulate.rs` + the binary `apk-trunk_caster-simulate` |
| `RUST-RUNTIME/src/main.rs` | 335 | the runner's `main!` (`src/bin/apk-trunk_caster.rs`), `config.ini`, `src/bus.rs`; `discover`/`advertise`/`status` are the retained documents; `compose` is gone (one `PLUGIN.TRUNK_SIM` container hosts every protocol) |
| `RUST-RUNTIME/src/http.rs` | 702 | `src/command.rs` (the verbs) and `src/views.rs` (the GET views) |
| `RUST-RUNTIME/src/ws.rs` | 201 | gone — the bus is the stream |
| `RUST-RUNTIME/src/html.rs` | 4,702 | the Intercom soft apps' views (`INTERCOM.TRUNK-CASTER/js/trunk/views/`); `globe_data`'s trunk/call/trend part and `lights_json` are `src/views.rs` (`globe_message`, `lights`, `View/Globe`); the globe's layout is the Globe window's own |
| `RUST-RUNTIME/src/interface.rs` | 56 | gone — the file-drop interface is the command envelope |
| `RUST-RUNTIME/src/land.json` | — | the soft app's `data/land.json` |
| `TRUNK-SIMULATOR/frame-sim/` | 783 | `PLUGIN.TRUNK_SIM` — one container, a simulator per protocol read off the caster's frames |
| `TRUNK-CASTER-SDK/src/` | 4,499 | `PLUGIN.TRUNK_CASTER/SRC/src/sdk/` (the caster's model); the wire shapes the plugins share (Ward-Beck line, labels, command envelope, topics) are `contracts/` `trunk` |
| `TRUNK-CASTER-SDK/vendor-policy.json`, `TRUNK-GLOBAL/`, `TRUNK-RELAY/`, `TRUNK-CROSS POINTS/settings.json` | — | `PLUGIN.TRUNK_CASTER/SRC/data/seed/` (identical copies) |
| `PANELS/streamdeck-*.json`, `panel.schema.json` | — | the soft app's `data/decks/` (its Stream Deck windows) |
| `TYPESCRIPT/` | — | gone — its pages, panels, routing and charts are the soft app's views |
| `Dockerfile`, `docker-compose*.yml`, `rebuild.py`, `TRUNK-CASTER-INTERFACE/` | — | gone — the plugins are built by the Discovery Engine image; the public-snapshot publisher went with `trunk-caster-site` (ROAD-3440) |

## What stays here

| Kept | Why |
|---|---|
| `SRC/KNOWN PROTOCOLS/` | the manuals as imported; `TRUNK-SIMULATOR/launch_all.py` loads the vendor simulators some of them carry. The caster reads its own copy (`PLUGIN.TRUNK_CASTER/SRC/data/seed/KNOWN PROTOCOLS`) |
| `SRC/TRUNK-CASTER-SDK/README.md`, `plans/` | Trunk-Caster's vocabulary, folder contract and plans — cited by the SDK wiki page and the plugins' wikis |
| `SRC/TRUNK-SIMULATOR/*.py`, `README.md`, `emulators.json`, `fader.json`, `preview-fader.json`, `mqtt/`, `captures/` | the Python matrix simulator (typed ports `PNL01`, `IFB01` …, its own HTTP API on 8180) — a separate tool from the caster |
| `SRC/PANELS/README.md`, `connect.json`, `streamdeck_emulator.py` | the panel model and the emulator that presses that simulator's keys |
