# Plan: RUST-RUNTIME

**Purpose.** The program. Reads the manuals, advertises the frames, serves the interface, routes,
renames, sends GPIO, logs crosspoints, checks in, talks to remote frames, simulates, graphs, and hosts
the one interface (pages and API).

**Modules.** `discover` (repertoire), `protocol` (canonical names, manual digest), `frame` (fleet),
`routing` (state, any-to-any, via, cross-check, port names, last activity), `crosspoints` (deltas,
Ward-Beck lines, check-in, per-frame state), `wb` (the Ward-Beck TCP port: remote frames announce,
receive lines, ack, check in), `interface` (file requests), `users` (records), `relay`, `snmp` (SET
PDU), `runtime` (the tick), `http` (server), `html` (pages), `util`.

**Tick.** Every 250 ms (500 ms in Docker): re-read fader and settings, advance the simulated clock,
drain the Ward-Beck inbox (announce → send frame state; check-in → compare, resend on a persistent
mismatch), serve interface files, answer seeks, expire simulated connections, generate load shaped by
the news cycle, cross-check when due, sample when due, check in when due, persist when dirty (at most
once a second: state, advertisements, crosspoints and their lines pushed to remotes, pages).

**Ports.** `TRUNK_PORT` 8080 pages and API; `TRUNK_WB_PORT` 7879 Ward-Beck lines. `--bind 0.0.0.0`
in containers, `TRUNK_PUBLIC_URL` for what pages print.

**Renames.** The port takes the caller's name. For every vendor implementing the frame's protocol
the policy picks a transport: RTS → SNMP SET (built; sent when a target is configured), others kept
in the SDK.

**Pages.** `/` the globe (canvas; sites, flows with vendor badges, discovery tree and totals beside
it), `/continents` (overview by continent, cables), `/overlord` (messages flying into the protocol
bucket, calls between continents as cables, every panel with its 6/8/16 labels, log task bar),
`/usage` (any to any, usage per region, trunks with gains), `/racks`, `/relay` (local sound card relay
with VU meters), `/users`, `/crosspoints`, `/simulator`, `/home` (about). Static copies are written
every ten seconds; live pages refresh in place from the stream and cache telemetry locally.

**Streaming.** `/ws` (`ws.rs`, plain std): a status frame twice a second (clock, load, fader, log,
Ward-Beck tail, continent totals, lines with leases, current run) and a globe delta every two seconds
(trunks, calls, live counts). The first full globe comes with the page; a changed fleet triggers one
fetch of `/api/globe`.

**Disk.** Writes are queued under the lock and flushed after it; deletes go to a janitor thread.
Boot lists `TRUNK-USERS` by name only and reads just the newest records, so tens of thousands of
stale files on a Docker or OneDrive mount cost seconds, not minutes.

**Next.** Bind frames to real devices over the same Ward-Beck port; accept Ward-Beck lines as
commands (a remote closing a crosspoint asks for a connection); service install on Windows; move the
relay's audio from the browser into the runtime (WASAPI) so crosspoints move sound.
