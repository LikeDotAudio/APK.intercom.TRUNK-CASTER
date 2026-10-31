# Plan: TRUNK-RELAY

**Purpose.** A relay hosted on this computer: two 8x8 matrices and one 2x2, where my audio can be
routed to and from everything else.

**Model.** `relay.json` lists the matrices (id, label, io, casters, port names). Each is a frame of
protocol `relay` with its own port counts, so any frame can be routed to a relay port and a relay
port to any frame. `state.json` is the live patch: per port its name, who is live, far end,
connection, how long; the caster status; the closed crosspoints. `index.html` shows each matrix as
a grid (local ports by casters) plus a port list with route, release and rename.

**Next.** Bind the local ports to real audio devices on this computer (WASAPI or ASIO endpoints) so a
closed crosspoint moves audio; expose the relay's own Ward-Beck lines on a local TCP port.
