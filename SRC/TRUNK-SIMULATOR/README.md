# TRUNK-SIMULATOR

Your computer as an intercom port, plus the common language every brand
simulator speaks.

| file              | what it is |
|-------------------|------------|
| `trunk_panel.py`  | the soft panel: microphone to matrix, matrix to speakers, 8 TX keys, 8 RX keys, break-away key windows, incoming-call display, users / users-calling counter |
| `tc_protocol.py`  | the Trunk-Caster audio and control protocol (UDP, one socket per port in a series of 256 per intercom, 20 ms frames of 8 kHz 16-bit PCM, HELLO / KEY / STATE messages) |
| `tc_map.py`       | the live GeoJSON map server any brand simulator can mount, plus the HTTP button API (`/api/...`) |
| `launch_all.py`   | starts every vendor emulator with its capitals and serves one combined map on :8180 |
| `emulators.json`  | the registry: which emulator covers which capitals, on which ports; vendors with no emulator yet are stood in for by RTS |

## Run the panel

Start a matrix simulator first, for example `KNOWN PROTOCOLS/VENDOR/RTS/SIMULATOR/rts_intercom_sim.py`.
Then:

```
python trunk_panel.py --matrix 127.0.0.1:22304                    London's series socket: get assigned a free panel
python trunk_panel.py --matrix 127.0.0.1:22304 --port 5          ask the series socket for port 5
python trunk_panel.py --matrix 127.0.0.1:22309 --name "Control room PC"   go straight to London port 5's own socket
python trunk_panel.py --list-devices
```

Each intercom owns a series of 256 UDP sockets (20000 + 256 × capital number).
Socket +0 is the intercom; socket +n is port n and talks only to the endpoint
that owns that port. The map popup shows every intercom's series.

Needs tkinter (ships with Python), numpy and sounddevice. Without sounddevice
the keys and status still work, with no audio.

What you get:

- **TX row**: 8 talk keys. Pick a port in the dropdown, press the key. While any
  TX key is latched your microphone is sent to the matrix and routed to that port.
- **RX row**: 8 listen keys. Latching one monitors that port: you hear the port
  itself and anyone talking to it, which is how you listen to an IFB or a party line.
- **Break away**: every key has a button that pops it into its own small
  always-on-top window. Close the window to dock it again.
- **Incoming**: when a port talks to you, the TX key assigned to it turns amber
  and shows CALLING, and the bottom bar lists who is calling and for how long.
- **Counter** (bottom right): users on the matrix and users currently making calls.
- Your computer appears on the matrix console (`endpoints`) and on the map
  under the port it claimed. With `--port 0` the matrix hands you the first free panel.

## The protocol

See the docstring in `tc_protocol.py`. In one line: an endpoint sends HELLO to
claim a port, sends AUDIO frames while a talk key is down, sends KEY messages
to press or release talk and listen keys, and receives AUDIO frames with its
mix and STATE messages describing who is calling it.

Other brand simulators (Riedel, Clear-Com, Intracom, Telos) should import this
module and serve the same audio port, so one soft panel works against all of them.

## Everything at once

```
python launch_all.py            every vendor, 56 capitals, combined map at http://127.0.0.1:8180/
python launch_all.py --list     what would start, on which ports
python launch_all.py --only RTS,Riedel
```

Each vendor runs as its own process with its own map (:8081 .. :8085). The
combined map merges them and forwards button presses (`/api/...`) to whichever
emulator owns the matrix, so one Stream Deck can reach any capital. Vendors
whose emulator does not exist yet are run by the RTS emulator under that
vendor's name; the map says "stand-in" on those.

Note: trunk calls only work between matrices inside the same emulator process
(London to Paris, yes; London to Washington, not yet). Cross-vendor trunking is
the job of the trunk broker, not the emulators.

## The map page

- **Flat or globe**: buttons top-left. The flat map never shows more than one and a half worlds across and wraps both ways; the globe spins (Spin toggles it) and is lit by the sun.
- **Sunlight**: the night half is shaded on both views from the real sun position; the footer shows where the sun is.
- **Continents**: the left list groups intercoms by continent, and every national capital folds out its state and provincial 8x8 frames.
- **Select several**: click rows or markers to select any number of intercoms. The view fits them, everything else dims, and the counter box lists each one's calls with direction, OUT → and IN ←.
- **Direction**: trunk calls are drawn caller to called with moving dashes and an arrowhead; popups list OUT and IN calls per intercom.
- **Flags** on every marker and row.
- **Call simulators** (footer): Quiet, Normal, Olympics (host = first selected capital, else random), Sporting events (three random venues), Evening events (cities where it is 18:00 to 23:00 local), Breaking news. The level slider sets how much traffic. State 8x8 frames spike at local noon, on the hour and at half past.

## State and provincial 8x8 frames

Every national capital with a state or province table (US, Canada, Australia, Germany, Brazil, India so far) gets a
small 8-port frame in each state or provincial capital, trunked only to its national capital. They live on
SNMP udp 36000+k, console tcp 37000+k and a 16-socket series at udp 43000+16k. Run the RTS emulator
with `--no-subsites` to leave them out.
