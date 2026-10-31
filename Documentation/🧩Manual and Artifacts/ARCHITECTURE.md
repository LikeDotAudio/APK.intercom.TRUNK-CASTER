# Architecture of INTERCOM.Caster

← [Manual and Artifacts](INDEX.md) · [Repo README](../../README.md)

**What is in `SRC/` today: the reference source the rewrite reads.** Nothing here runs under
APK.audio yet. Line counts are as imported (2026-10-31).

## The four wires the reference uses

| Wire | Where | Who |
|---|---|---|
| **HTTP** `TRUNK_PORT` (8080 in its compose, 7878 by default) | 66 GET + 21 POST routes, plus the prefixes `/api/device/`, `/api/taps/`, `/api/voices/`, `/api/capture/`, `/api/analyze/`, `/voices/` | `http.rs` → `html.rs` pages, `runtime.rs` state |
| **WebSocket** `/ws` on the same port | server→browser telemetry stream | `ws.rs`, fed by `runtime.rs` |
| **Ward-Beck TCP** `TRUNK_WB_PORT` 7879 | newline lines: `CHECKIN` per hosted frame, then `CLOSE/OPEN` crosspoint lines both ways, each echoed back as the ack | `wb.rs` ↔ `frame-sim/main.rs` |
| **MQTT** `TRUNK_MQTT` (root `trunk-caster/`) | `trunk-caster/<protocol>/<frame>/line` (caster→sim, a twin of each TCP line), `…/ack`, `…/reject` (`<reason>\|<line>`), `…/voice1`, `…/voice5` (sim voice chunks) | SDK `mqtt.rs` (hand-rolled MQTT 3.1.1, QoS 0); `wb.rs`, `voices.rs`, frame-sim |

Also: SNMPv2c SET over UDP (`snmp.rs`, a port rename pushed to a vendor frame) and the frame-sim's
plain HTTP GET of `/api/sites` from the caster (`voice.rs`).

## `SRC/RUST-RUNTIME` — the caster (13,479 lines)

| Module | Lines | Owns | Talks to |
|---|---:|---|---|
| `main.rs` | 335 | CLI and env (`TRUNK_ROOT SITE BIND PORT WB_PORT MQTT PUBLIC_URL VOICES_DIR`); commands `discover`, `advertise`, `compose`, `serve`, `status`, `simulate` | starts http, wb, voices, the tick loop |
| `runtime.rs` | 2,833 | **the state**: the repertoire, the routing, the crosspoint log, the simulator clock, the folder contract; `tick()` is the heartbeat | every `TRUNK-*` folder under `/data`; broadcasts on `ws` |
| `routing.rs` | 1,286 | trunks (caster A ↔ caster B, `capacity` channels) and connections (one conversation over 1+ hops); any-to-any routing, direct first | in-memory, through `runtime` |
| `crosspoints.rs` | 400 | the closed crosspoints per frame, derived from live connections; the set/clear delta log; the Ward-Beck rendering | `TRUNK-CROSS POINTS/` (`crosspoints.json`, `deltas.jsonl`, `wardbeck.log`, `settings.json`, `seeks/`) |
| `wb.rs` | 286 | the Ward-Beck TCP hub: remotes, CHECKIN, the resend on persistent mismatch, ack/reject counts | TCP 7879 listen; MQTT publish `…/line`, subscribe `…/+/+/ack`, `…/+/+/reject` |
| `voices.rs` | 316 | reassembles the frames' voices from the two cuts and meters their bandwidth | MQTT subscribe `…/+/+/voice1`, `voice5`; `TRUNK_VOICES_DIR` (WAV per frame), `TRUNK-USAGE/voices.jsonl` |
| `discover.rs` | 231 | the protocol repertoire, read off the `KNOWN PROTOCOLS/` tree (vendor / protocol / manuals, mixed) | reads `KNOWN PROTOCOLS/` |
| `protocol.rs` | 182 | protocol identity: canonical names, families, manual reading ("by protocol, not by brand") | used by discover, frame |
| `frame.rs` | 101 | fleet construction: frames per site by tier, protocol rotation, frame ids | `TRUNK-GLOBAL/sites.json` via SDK `sites` |
| `interface.rs` | 56 | the file-drop API: `<id>.json` in, `<id>.reply.json` out; delete the request = release | `TRUNK-CASTER-INTERFACE/`, `TRUNK-CROSS POINTS/seeks` |
| `bookings.rs` | 200 | the booking timeline: a port held for a program, start→end on the sim clock, daily re-arm | `TRUNK-USAGE/bookings.json` |
| `relay.rs` | 112 | the relay hosted on this computer, as frames of protocol `relay` | `TRUNK-RELAY/relay.json`, `state.json` |
| `trends.rs` | 379 | per-trunk use by day and hour, and "locked" trunks (held 1 h+) for the globe | `TRUNK-GLOBAL/trends.json` |
| `recorder.rs` | 143 | runs: the span between two parameter changes, with their summaries | `TRUNK-SIMULATOR/runs/<id>.json`, `runs.json` |
| `report.rs` | 150 | the run report as Markdown | serves `/api/report`, `/report.md` |
| `analyzer.rs` | 232 | captures (START→STOP telemetry) and their hourly/30/15-min bucketing | `TRUNK-SIMULATOR/captures/<id>.json` |
| `simulate.rs` | 235 | headless run of days of sim time in a scratch root, for a static replay site | copies the manuals and config into a scratch root |
| `users.rs` | 123 | one JSON per request ever made, plus an HTML log | `TRUNK-USERS/` |
| `snmp.rs` | 105 | SNMPv2c SET encoder (BER), one OctetString per call | UDP to a vendor frame |
| `http.rs` | 702 | a tiny HTTP/1.1 server (std::net, one thread per connection), the route table | TCP `TRUNK_PORT`; `runtime`, `html` |
| `ws.rs` | 201 | an RFC 6455 server (std only) | `/ws` upgrade on the http port |
| `html.rs` | 4,702 | **every page**, written as static files into their folders and served live: `/` and `/globe`, `/home`, `/usage`, `/space`, `/racks`, `/relay`, `/users`, `/crosspoints`, `/simulator`, `/analyzer?id=`, `/overlord`, `/continents`, `/panels`, `/panels/editor`, `/editor`, `/lights`, `/discovery`, `/about` | `runtime` state; the in-page JS calls `api('/api/…')` and `/ws` with absolute paths |
| `util.rs` | 169 | wall clock, ISO time, a seedable xorshift RNG, atomic JSON writes | — |

## `SRC/TRUNK-SIMULATOR/frame-sim` — one protocol's frames (783 lines)

| Module | Lines | Owns | Talks to |
|---|---:|---|---|
| `main.rs` | 377 | hosts one protocol's frames (`dante-01…10`) as local matrices; CHECKIN every `SIM_CHECKIN_SECONDS`; **double validation**: it applies a CLOSE/OPEN only once the same line has arrived over both TCP and MQTT within `SIM_VALIDATE_MS` | TCP to `SIM_CASTER` (7879); MQTT subscribe `…/<proto>/+/line`, publish `…/ack`, `…/reject` |
| `voice.rs` | 406 | every frame speaks its identity, then its connections, through espeak-ng; the WAV is cut twice (1 s and 5 s) and both cuts are sent | MQTT publish `…/voice1`, `…/voice5`; HTTP GET `/api/sites` from the caster |

Run as 28 containers (`SRC/docker-compose.sims.yml`, one per protocol, generated by `trunk-caster compose`).

## `SRC/TRUNK-CASTER-SDK` — Trunk-Caster's own SDK crate (4,499 lines)

`types.rs` (2,066: every JSON shape, frame/caster/trunk/connection/panel/crosspoint), `voice.rs` (613),
`mqtt.rs` (438: the std-only MQTT 3.1.1 client and the topic builders), `sites.rs` (417),
`client.rs` (351: `FileClient` over the folder contract, `HttpClient` over the HTTP port),
`wardbeck.rs` (236: the line), `folders.rs` (209: the `TRUNK-*` names), `labels.rs` (149: 6/8/16-character panel labels).
Its `README.md` and `plans/` describe the vocabulary and the folder contract.

## Where the rewrite takes each wire

| Today | On APK.audio |
|---|---|
| own MQTT client, root `trunk-caster/` | the APK broker through `apk-plugin-runner`, topics under the contract's roots |
| HTTP + WebSocket server and `html.rs` pages | the OS shell: soft apps reading the bus |
| `TRUNK-*` folders under `/data` | state volume + retained topics |
| 28 frame-sim containers | plugin-shaped agents on the SDK |
| Ward-Beck TCP 7879 | kept as the wire real frames speak |
