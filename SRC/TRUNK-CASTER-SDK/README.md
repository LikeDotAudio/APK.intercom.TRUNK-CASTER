# Trunk-Caster SDK — what's up

This folder is the home of the plan. It holds the one crate every Trunk-Caster component
speaks through, the folder contract, the vendor policy, and a plan for each part of the system
(`plans/`). If you want to know what Trunk-Caster is and how the pieces fit, start here.

## The idea in one paragraph

Trunk-Caster is a protocol-first intercom trunk broker. It reads the manuals and API notes in
`KNOWN PROTOCOLS` (and the vendor folders beside it), finds every protocol they describe, and
**advertises each protocol as a set of identical virtual intercom frames**. It speaks by protocol,
not by brand: a Dante trunk is a Dante trunk whether Riedel, Clear-Com, RTS, Telos or Intracom is
behind it. Anything can be connected to anything: directly when a trunk has room, or *via* another
frame when direct capacity is low. Every switch it makes is expressed in one unifying sentence, the
Ward-Beck line.

## The unifying words

```
SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
```

* Same frame on both sides: a crosspoint inside that frame.
* Different frames or sites: an end-to-end connection, anything to anything.
* `CLOSE` makes it. `OPEN` expresses that it is gone.
* `INPUT_NAME` / `OUTPUT_NAME` carry the people on the ports: a port is renamed after whoever called
  through it.
* `INPUT = CHECKIN`: a periodic check-in. Each frame restates how many crosspoints it has closed,
  followed by one `CLOSE` line per crosspoint, so a listener can rebuild state from the last check-in.

Implemented in `src/wardbeck.rs`. Written continuously to `TRUNK-CROSS POINTS/wardbeck.log` and
`TRUNK-CROSS POINTS/checkin.wb`.

## Vocabulary

| Word | Meaning |
|---|---|
| protocol | What is advertised and trunked (Dante, SIP, 4-Wire, …). Never a brand. |
| frame | A virtual intercom matrix advertised per protocol: 56 user ports + 8 casters (configurable). Id `dante-03`. |
| caster | A trunk port on a frame. 8 per frame. |
| trunk | A link between one caster on frame A and one on frame B. Carries up to 8 channels. |
| connection | One conversation, user port to user port, over one or more trunks (hops). |
| direct / via | One hop, or routed through one or two intermediate frames when direct capacity is low. |
| panel | A user port. Takes the caller's name. |
| crosspoint | A closed input→output switch inside one frame (`U03→C1`, `C1→U03`, `C0→C5` on a via frame). |
| tap / fader | The gain of one crosspoint: the thing coming in on its input, crossed to its output. The Overlord's TAPS and Mixes mixer has one per closed crosspoint. |
| voice | What a simulated frame says, in the accent of its country: its ident once, then its connections, from and to, the whole time it is connected. |
| wave sender / cut | Each saying is cut into 1-second and 5-second chunks and both cuts are sent at the same time; the caster re-assembles it and corrects a damaged second from the other cut. |
| check-in | A frame restating its state in Ward-Beck lines, periodically. |
| relay | The matrices hosted on this computer (two 8×8, one 2×2), real frames of protocol `relay`. |
| site | The name this runtime puts in the SITE fields (`--site`, default `trunk-caster`). |

## Folder contract

Everything lives under the project root, beside this folder. `src/folders.rs` is the typed version.

| Folder | What is in it |
|---|---|
| `KNOWN PROTOCOLS/<Vendor>/<Protocol>/` and `<Vendor>/<Protocol>/` | Manuals (Markdown). The runtime reads `**Type:**`, *Trunking notes* and *Talking to the panel*. |
| `TRUNK-ADVERTISEMENT/` | One JSON per frame, posted by the runtime about itself: casters, port names, who is live, last connection. |
| `TRUNK-CASTER-INTERFACE/` | Seekers drop `<id>.json`; the runtime answers `<id>.reply.json`. Deleting the request releases the connection. |
| `TRUNK-USAGE/` | `state.json` (frames, trunks, connections, port names, last activity, crosspoint gains), `gains.jsonl` (every gain change), `voices/` (each frame's newest re-assembled `<frame>-ident.wav` and `<frame>-call.wav`, `voices.jsonl`; in Docker these live on the `voices` volume, `TRUNK_VOICES_DIR=/voices`), `index.html` (any-to-any, all frames and trunks), `space.html` (frames in space). |
| `TRUNK-USERS/` | One JSON per request: who, whom, when, why, where, how, how long. `index.html` with people and requests. |
| `TRUNK-CROSS POINTS/` | `crosspoints.json`, `deltas.jsonl` (ends after N events, settable), `wardbeck.log`, `checkin.wb`, `gpio.jsonl`, `renames.jsonl`, `seeking.json`, `seeks/`, `settings.json`, `index.html`. |
| `TRUNK-SIMULATOR/` | `fader.json` (speed and load, re-read every tick), `timeline.json`, `index.html` (graphs), `racks.html` (physical manager). |
| `TRUNK-RELAY/` | `relay.json` (what this computer offers), `state.json` (how it is patched), `index.html`. |
| `TRUNK-CASTER-SDK/` | This crate, `vendor-policy.json`, `plans/`. |
| `RUST-RUNTIME/` | The runtime binary (`trunk-caster`). |

## Running it

```
cd RUST-RUNTIME
cargo run -- discover            # read the manuals, print the repertoire
cargo run -- advertise           # write one advertisement per frame, render pages, exit
cargo run -- serve --site HQ     # run: folders + http://127.0.0.1:7878
cargo run -- status
```

Options: `--root <dir>`, `--site <name>`, `--port <n>`, `--no-http`, `--frames <n>` (per protocol,
default 10), `--user-ports <n>` (56), `--casters <n>` (8), `--channels <n>` (8), `--tick-ms <n>`,
`--ticks <n>` / `--once` for bounded runs.

Pages while serving: `/` home, `/usage`, `/space`, `/racks`, `/relay`, `/users`, `/crosspoints`,
`/simulator`. The same pages are written as static HTML into their folders on every change.

### In Docker: one interface at http://127.0.0.1:8080/

The back end runs as containers. `Dockerfile`, `.dockerignore`, `docker-compose.yml` and the generated
`docker-compose.sims.yml` sit at the project root because the image builds all the crates. The project
folder is mounted at `/data`, so the caster reads the same manuals and writes into the same `TRUNK-*`
folders.

```
docker compose up --build -d                    # the caster: pages + API on 8080, Ward-Beck port 7879
docker compose --profile sims up --build -d     # plus one intercom simulator container per protocol
docker compose logs -f trunk-caster             # grants, renames, check-ins, remotes
docker compose --profile sims down
```

**Each intercom simulator is its own little container** (`TRUNK-SIMULATOR/frame-sim`). It hosts one
protocol's ten frames and speaks as a crosspoint: it connects to the caster's Ward-Beck TCP port,
announces its frames with CHECKIN lines, applies every CLOSE/OPEN line it is sent, echoes each one back
as its acknowledgement, and checks in with its full state every 20 s. The caster compares what each
simulator reports with what it believes and resends state on a persistent mismatch. `trunk-caster
compose` regenerates `docker-compose.sims.yml` from the discovered protocols. Real frames can use the
same port and the same lines.

**MQTT runs in parallel with the Ward-Beck port** (the `mqtt` service, Mosquitto on 1883). Every line
the caster sends down the high-speed TCP port is also published to
`trunk-caster/<protocol>/<frame>/line`. A simulator double validates each request: it applies a
CLOSE/OPEN line only once the same line has arrived over *both* transports, then echoes it on TCP and
acks it on `…/ack`. A copy whose twin does not arrive within `SIM_VALIDATE_MS` (3000) is dropped and
reported on `…/reject` as `<reason>|<line>`. The caster counts both per frame (`mqtt_acks`, `rejects`
in `/api/remotes`, broker state under `mqtt` in `/api/status`) and the persistent-mismatch resend
recovers anything rejected. Watch it with
`docker exec trunk-mqtt mosquitto_sub -v -t 'trunk-caster/#'`. The client is std-only
(`trunk_caster_sdk::mqtt`, MQTT 3.1.1, QoS 0).

Configuration is by environment variable (flags still work): `TRUNK_ROOT` (`/data`), `TRUNK_SITE`,
`TRUNK_BIND` (`0.0.0.0` in the container), `TRUNK_PORT` (`8080`), `TRUNK_WB_PORT` (`7879`),
`TRUNK_MQTT` (`mqtt:1883`; unset = Ward-Beck only), `TRUNK_PUBLIC_URL`. Simulators take
`SIM_PROTOCOL`, `SIM_FRAMES`, `SIM_SITE`, `SIM_CASTER`, `SIM_CHECKIN_SECONDS`, `SIM_MQTT`,
`SIM_VALIDATE_MS`. The caster image has a health check on `/api/status`; both run unprivileged.

### Publishing a public snapshot

`rebuild.py --publish --pages-repo <repo>` copies the static pages the runtime writes into the
`TRUNK-*` folders, rewrites their links to point at each other, and pushes them to that public
repository. There is no default target any more: the old snapshot site was retired when APK.audio
moved Trunk-Caster onto its plugin SDK (ROAD-3440), where every page became a window on the bus.

```
python rebuild.py --publish --pages-repo <repo>                 # rebuild, wait for the caster, then publish
python rebuild.py --publish-only --pages-repo <repo> --dry-run  # list what would go
```

### The globe (page one) and TRUNK-GLOBAL

The globe is managed from `TRUNK-GLOBAL`: `sites.json` lists where frames live (country capitals host
10 frames, states and provinces 1, smaller cities an 8×8 plus a 2×2), `globe.json` says how it is
drawn, `regions.json` is usage per region, `preferences.jsonl` logs every user preference ever set
(fader, clock scrubs, gains, renames, bindings, settings), and `index.html` is the globe itself.
Frames carry their site, country and coordinates; the SITE field of every Ward-Beck line is the
frame's site. Flows carry the vendor's badge: 🔵 Clear-Com, 🔴 Riedel, 🟣 RTS, 🟡 Telos, 🟢 Intracom,
🟠 Ward-Beck, ⚪ relay.

**Usage per region.** The simulated clock is UTC; every site follows its own local solar time from
its longitude. The news cycle (quiet overnight, hourly rushes, radio prep on the hours and halves,
newscasts at 06:00, 12:00 and 18:00) therefore sweeps around the globe, and callers are drawn from
wherever is busy. The broadcast day is a permanent footer on every page: drag it to scrub the clock,
and the fader beside it is always ready to go (speed, run/pause).

**Panel labels.** Every caller gets 6-, 8- and 16-character cuts of their name with full emoji
support (an emoji, flag or ZWJ sequence counts as one character). Names longer than a 6- or 8-character
panel are logged to `TRUNK-USERS/labels.jsonl`. `POST /api/rename` accepts explicit `l6`, `l8`, `l16`.

**Volume at multiple points.** Each trunk has a gain at its A and B casters; each call has a gain per
hop; each closed crosspoint has a gain (the TAPS and Mixes faders). `POST /api/gain` sets one; the
total along a call is shown on Overlord and logged to `TRUNK-USAGE/gains.jsonl`.

**Local sound card relay.** The Relay page enumerates this computer's audio devices in the browser,
meters every input live (peak, RMS, peak hold in dBFS), binds devices to relay ports and logs peaks
over the threshold (`relay.json → over_threshold_dbfs`, default −6) to `TRUNK-RELAY/events.jsonl`.

### Streaming, parking, the daily reset and the recorder

* **Telemetry streams** over a WebSocket at `/ws` (status twice a second, globe deltas every two
  seconds). Pages update in place, cache the last telemetry locally for an instant first paint, and
  never reload the whole screen. The footer's broadcast day is driven by the stream, separately from
  the charts.
* **Park and sweep.** A finished call stays connected but muted until the next round-robin sweep
  (`round_robin_seconds`, 60 s). Calling the same place again before the sweep picks the parked line up
  with no new trunking. An average call lasts ten minutes (`mean_hold_seconds`, 600).
* **The lease.** Every line has a green 15-minute lease (`lease_seconds`) that resets whenever the line
  is used. When it runs out the line shows red ("may be dead"): its bandwidth goes on hold (parked) and
  it is the first to be reclaimed when a new call needs capacity.
* **Daily reset.** At 11:00 UTC on the simulated clock everything disconnects and every sender is
  reset (OPEN for all crosspoints, empty check-ins); at 12:00 traffic reconnects
  (`fader.day.blackout`).
* **Simulation recorder.** A run is the stretch between parameter changes. Change the fader, scrub
  the clock or end a reset and the run closes with its summary (grants, denials, peak and average live,
  utilisation) in `TRUNK-SIMULATOR/runs/`, indexed by `runs.json`; a new run starts.
* **Discovery.** `/api/tree` is Global → continent → country → site → device with stats at every
  level; `/api/device/<frame>` is one device's own lines, trunks, labels and timeline. The Globe and
  Continents pages carry it as a fold-out. `/continents` is the overview by continent with the
  continent-to-continent cable totals; the Overlord draws only calls that leave their continent.

### Panels, lights, keys and the phone book

* `/panels` lists every panel (a user port with a name or a call) with the trunk-caster keys on it:
  the casters its call rides are lit; names as 6-, 8- and 16-character panels show them; lease state
  and GPIO count per line.
* The **light board** at the top of that page is one named light per intercom frame: lit when the
  frame carries a call, blinking when a call just came or went or a GPIO asked it to, red when a line
  may be dead, grey when every line is parked, hollow when its simulator is away. Each light carries
  the frame's **last caller**. It is driven by the telemetry stream.
* **GPIO keys.** Every GPIO pin is a key function that rides the call's trunks: 1 blink panel,
  2 check lights (returns the light state of every frame on the path), 3 set latch (the line stays up,
  never parked, swept or reclaimed), 4 set listen, 5 unset latch, 6 clear (latch and listen off,
  lease reset), 7 last caller (returns who last called each frame on the path), 8 ping.
  `GET /api/gpio/functions` lists them; `POST /api/gpio` takes `pin` or `function`.
* **Phone book.** `GET /api/phonebook` and the section on the Panels page: everyone who has called,
  the panels carrying their name right now and where, how often they call, when last seen and whom
  they last called.
* **Racks** is half list, half map: the frames of a rack light up on the flat map when the rack is
  folded open or hovered. Every page carries graphs of its own data.

### TAPS and Mixes, voices and the bandwidth simulation

Full plan: `plans/11-taps-voices-bandwidth.md`.

* **TAPS and Mixes** (a drop-down on `/overlord`): a mixer of every connected frame, one little
  fader per closed crosspoint, -60 to +20 dB, double-click for unity. A fader is the gain of the
  thing coming in, crossed to its output; forward crosspoints add to the call's path gain. Each strip
  shows the frame's accent, what its voice is putting on the wire, and ▶id / ▶call to hear it.
* **Voices.** Every simulated frame talks, all at once, in the accent of its country (espeak-ng in
  the frame-sim image): its ident once (frame, site, country, continent, airport code, protocol,
  simulator), then each of its connections, from and to, over and over while connected.
* **The wave sender.** Each saying goes out cut into 1-second and 5-second chunks with CRC-32, both
  cuts at the same time, on `trunk-caster/<protocol>/<frame>/voice1` and `voice5` (their own broker
  connection). The caster re-assembles second by second and corrects damaged or missing seconds from
  the other cut (`SIM_VOICE_FAULTS`, default 5%, damages chunks so there is something to correct).
* **Bandwidth** (a section on `/overlord`): the voice actually heard, per frame, per protocol, and
  spread over every trunk each call crosses: about 100–150 Mbit/s with every frame connected.
* API: `GET /api/taps`, `/api/taps/<frame>`, `/api/voices`, `/api/voices/<frame>`, `/voices/<file>.wav`,
  `/api/bandwidth`, `/api/airports`; `POST /api/gain`, `/api/taps/unity`.

### Capture and the analyzer

`/analyzer` has capture **START** and **STOP**. A capture records every telemetry sample into
`TRUNK-SIMULATOR/captures/<id>.json` (refreshed on disk as it runs); STOP closes it with a summary
and check-ins at **one hour, half an hour and a quarter hour** of the simulated day, so a 24-hour
collection reads at a glance. The analyzer opens any capture or any recorded run offline: tiles,
lines over the capture, bars and tables per check-in. API: `POST /api/capture/start {note}`,
`POST /api/capture/stop`, `GET /api/captures`, `GET /api/analyze/<id>` (summary and check-ins),
`GET /api/capture/<id>` (everything). Every append-only log is capped at 100 MB and rotated once.

### The control room

* `/overlord` is the global view: every panel live, every call drawn as a chord from caller to called
  (direct or via, thicker as GPIO rides it), connect / release / GPIO controls, and the log in the
  right-hand task bar with the latest Ward-Beck lines beneath it.
* `/space` is the globe: frames as constellations with the **broadcast day** strip above them.
* The simulator follows the news cycle: a quiet baseline, a rush at the top of every hour (:55 to :10),
  radio prep on the hours and halves, and the main 18:00 news building from 17:00 and peaking 17:45 to
  18:30, quiet overnight. `fader.json → day` holds the multipliers and the clock anchor; the header of
  every page shows the simulated clock and the current load multiplier.

## HTTP API (all JSON)

| Method | Path | Body → Result |
|---|---|---|
| GET | `/api/status` | `Status` |
| GET | `/api/advertisements` | `[Frame]` |
| GET | `/api/protocols` | `[Protocol]` |
| GET | `/api/state` | routing state |
| GET | `/api/users` | recent `[UserRecord]` |
| GET | `/api/crosspoints` | settings, counters, crosspoints, recent events |
| GET | `/api/wardbeck` | recent Ward-Beck lines (text) |
| GET | `/api/checkin` | latest check-in (text) |
| GET | `/api/gpio`, `/api/renames`, `/api/seeks`, `/api/relay`, `/api/policy`, `/api/fader`, `/api/timeline`, `/api/crosscheck`, `/api/log` | as named |
| POST | `/api/request` | `Request` → `Reply` |
| POST | `/api/release` | `{id}` → `Reply` |
| POST | `/api/gpio` | `GpioCommand` → `GpioEvent` |
| POST | `/api/rename` | `Rename` → `[RenameDispatch]` |
| POST | `/api/panel-seek` | `PanelSeek` → `PanelOffer` |
| POST | `/api/fader` | `Fader` → `Fader` |
| POST | `/api/crosspoints/settings` | `CrosspointSettings` |
| POST | `/api/crosspoints/reset` | `{reset:true}` |
| GET | `/api/taps` | `Taps`: a strip per connected frame, a fader per closed crosspoint |
| GET | `/api/taps/<frame>` | `TapStrip` |
| POST | `/api/gain` | `GainSet` (trunk+end, connection+hop, or frame+input+output) → `GainEvent` |
| POST | `/api/taps/unity` | `TapsUnity {frame?}` → `TapsUnityResult` |
| GET | `/api/gains` | recent `[GainEvent]` |
| GET | `/api/voices` | `VoiceSummary` |
| GET | `/api/voices/<frame>` | `FrameVoice` |
| GET | `/voices/<frame>-<ident\|call>.wav` | the re-assembled recording (`audio/wav`) |
| GET | `/api/bandwidth` | `Bandwidth` |
| GET | `/api/airports` | `[Airport]` |

The full machine-readable catalogue (every route, with types, errors and `http.rs` lines) is
`TYPESCRIPT/api/openapi.json`, generated from `TYPESCRIPT/api/routes.ts`.

## Using the crate

```toml
[dependencies]
trunk-caster-sdk = { path = "../TRUNK-CASTER-SDK" }
```

```rust
use trunk_caster_sdk::client::{FileClient, HttpClient, request};
use std::time::Duration;

// Folder-based: works anywhere that can see the project root.
let fc = FileClient::new(r"C:\...\Trunk-Caster");
let reply = fc.request(request("Andrey", "relay-a", "sip-03"), Duration::from_secs(5))?;

// HTTP: talks to a serving runtime.
let hc = HttpClient::new("127.0.0.1:7878");
let frames = hc.advertisements()?;

// TAPS and Mixes, voices, bandwidth.
let taps = hc.taps()?;
hc.set_crosspoint_gain("paris-01", "C0", "U03", -6.0)?;
let paris = hc.voice("paris-01")?;          // accent, airport, live kbit/s, newest ident and call
let wav: Vec<u8> = hc.voice_wav("paris-01", "call")?;
let bw = hc.bandwidth()?;                   // totals, by protocol, by frame, by trunk
```

Every JSON shape is in `src/types.rs`; `wire_version` is bumped on incompatible changes.

## Vendor policy

`vendor-policy.json` says how a rename reaches each vendor's equipment. `default` keeps the name
inside Trunk-Caster. `RTS` is set to `snmp`: the runtime builds a real SNMPv2c SET PDU
(`RUST-RUNTIME/src/snmp.rs`) for `<oid>.<port+1>` and sends it when `target` is set. The OID shipped
is a placeholder and is flagged in every dispatch: the RTS SNMP manual describes monitoring only, so
the writable port-label object must be confirmed against the RTS MIB before a target is configured.

## What is real and what is simulated

* Real: discovery, routing, capacity, crosspoints, the Ward-Beck lines, the folder and HTTP
  contracts, the SNMP PDU, the relay's frames and port names.
* Real: the voice traffic. Every saying is real 8 kHz audio in real chunks over a real MQTT
  broker, so the bandwidth figures are measured, not estimated. The speech itself is synthetic.
* Simulated: the frames themselves. Nothing yet speaks Dante, SIP or 4-Wire on a wire. The
  simulator generates load so the routing, the cross-checks and the graphs can be watched working.

## Next

See `plans/`. The big ones: bind a frame to a real device (vendor + address) so renames, GPIO and
crosspoints go out on a real transport; agree the RTS OID; let the relay drive actual audio devices
on this computer; multi-site (two runtimes exchanging Ward-Beck lines).
