# Plan: TRUNK-USAGE

**Purpose.** All the frames and all the trunks, and the place to bring any to any.

**Files.** `state.json` is the routing state (frames, trunks, connections, counters, port names,
last activity). `index.html` lists capacity, live connections (who, for what, how long), every frame
with its casters, trunks, busy panels, named ports and time since last connection, and every trunk.
`space.html` is the same fleet drawn as constellations: a protocol per constellation, a frame per
star, trunks as lines that thicken with channels.

**Controls (while serving).** Connect any frame to any frame, with an optional GPIO pin to close on
connect; release; send GPIO on a live connection.

**Next.** Drag-to-connect on the space view; a per-protocol capacity forecast from the timeline.
