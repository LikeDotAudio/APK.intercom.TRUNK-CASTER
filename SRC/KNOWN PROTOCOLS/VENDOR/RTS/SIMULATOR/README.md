# RTS simulator

A stand-alone pretend RTS / Telex intercom estate. One Python file, standard
library only (numpy is optional and only needed for the audio port).

It reads the MIB files in `../SNMP` and pretends to be the devices those MIBs
describe, plus a matrix frame with a full port plan, generated keypanels, tone
generators, a live GeoJSON map and an audio port your computer can join.

## Run it

```
python rts_intercom_sim.py                               one intercom in each of 56 country capitals (the default)
python rts_intercom_sim.py --capitals LOND,PARI,BERL     just those
python rts_intercom_sim.py --plan PANEL=24,CAM=8,LIGHT=8,AUDIO=8,FIELD=8   a different port plan
python rts_intercom_sim.py --spawn tm2000=1,adam=2,rvon16=4 --chaos 0.3    the small lab estate instead
python rts_intercom_sim.py --config sim_config.json
python rts_intercom_sim.py --check-mibs                  which modules are really in ../SNMP
python rts_intercom_sim.py --dump-oids                   the resolved Telex OID tree
```

Default (world) estate: one Trunk Master plus one ADAM frame per capital,
56 frames, each with the port plan below and a coloured coverage circle on the
map. Every capital has one fixed, unique set of ports no matter which emulator
process runs it. Capital number i (table order, Washington = 1, London = 9):

| what | where |
|------|-------|
| SNMP | udp 16100 + i |
| console | tcp 17100 + i |
| series | udp 20000 + 256·i, through + 255 |

The series is the intercom's block of 256 sockets. Socket +0 is the intercom
itself: send HELLO there and it assigns you a port and tells you which socket
is yours. Socket +n is matrix port n: one generator, one socket, and only the
endpoint that owns port n is spoken to on it. London's series starts at 22304,
so London port 1 is udp/22305. The map popup and list show all of this.

The small `--spawn` lab estate allocates like this from `--base-port` (16100):

| device   | SNMP udp | console tcp | audio udp |
|----------|----------|-------------|-----------|
| TM1      | 16100    | 17100       |           |
| ADM1     | 16101    | 17101       | 18100     |
| CRO1     | 16102    | 17102       | 18101     |
| RVON16-1 | 16103    | 17103       |           |
| RVON16-2 | 16104    | 17104       |           |

Map: `http://127.0.0.1:8180/` (change with `--map-port`). Bottom right shows
users and users making calls. Markers pulse when a device has calls; trunk
calls between intercoms are drawn as lines. `/geojson` and `/state` are the raw feeds.

## Talk to it

SNMP (any manager, or the built-in client):

```
python rts_intercom_sim.py --walk 127.0.0.1:16100
python rts_intercom_sim.py --get 127.0.0.1:16103 --oid csIsUp.1 --oid deviceDescription
python rts_intercom_sim.py --trap-listener 16200          then start the estate with --trap-target 127.0.0.1:16200
```

Console (telnet or `nc` to the console port, then `help`):

```
plan                 the port plan and user count
ports [TYPE]         ports, who is live, who is talking
panel 1              the generated keypanel for port 1
talk PNL01 CAM03     press a talk key           untalk PNL01 CAM03
listen WLS01 IFB03   monitor a feed
calls                who is calling whom, users calling
call 3 CRO1 5        trunk call via the Trunk Master (noTrunksTrap when none left)
offline / online     frame drops off: Trunk Master marks its trunks outOfService
```

Your computer as a port: `python ../../../../TRUNK-SIMULATOR/trunk_panel.py --matrix 127.0.0.1:22304` (London's series socket; add +n to take port n directly)

## State and provincial 8x8 frames

Each capital with a state table also spawns a small 8-port frame (4 panels, 2 cameras, 1 field, 1 IFB) in every
state or provincial capital, trunked only to its national capital. Sub-site k: SNMP udp 36000+k, console tcp
37000+k, series udp 43000+16k (+0 intercom, +1..+8 ports). `--no-subsites` turns them off. They run hotter at
local noon, on the hour and at half past.

## Traffic scenarios

`--scenario quiet|normal|olympics|sports|evening|breaking` at start, or `GET /api/scenario?name=...&level=0.4&host=LOND`
while running (the map footer does this). The weight each matrix gets is in `Estate.traffic_weight`.

## Button API

Next to the map the simulator answers an HTTP API that Stream Decks (through
Companion), the PANELS emulator or anything else can use:

```
GET /api/help
GET /api/claim?matrix=LOND&port=0&name=Deck
GET /api/key?matrix=LOND&port=1&kind=talk&target=CAM03&state=1
GET /api/port?matrix=LOND&port=1
```

See `../../../../PANELS/` for panel definitions and the Stream Deck emulator.

## The port plan

Every matrix gets this plan unless its config says otherwise:

| type  | count | alphas        | user? | talks | listens |
|-------|-------|---------------|-------|-------|---------|
| PANEL | 24    | PNL01..PNL24  | yes   | yes   | yes     |
| CAM   | 10    | CAM01..CAM10  | no    | yes   | yes     |
| LIGHT | 8     | LGT01..LGT08  | no    | yes   | yes     |
| AUDIO | 8     | AUD01..AUD08  | no    | yes   | yes     |
| FIELD | 8     | FLD01..FLD08  | yes   | yes   | yes     |
| IFB   | 24    | IFB01..IFB24  | no    | no    | no      |
| WLESS | 24    | WLS01..WLS24  | yes   | no    | yes     |

106 ports. 56 are counted as users (panels, field, wireless). Camera, lighting
and audio positions are counted as positions, not users. Change that by editing
`PORT_TYPES` in the script or the `plan` list in the config.

Every talk-capable port gets a generated 8-key panel (`panel <port>` shows it)
and an identifying tone, so when a pretend port calls your computer you hear it.

## About the MIB files

The filenames in `../SNMP` do not match the module inside each file (the set
is rotated). The simulator parses by module name so it does not care, but a
MIB browser will. `--check-mibs` prints the real mapping.

`Telex-Icom-MIB` (the module that describes an ADAM / Cronus frame's own cards,
ports and status) is not in the folder. Matrix devices therefore answer the
standard system group with the right Telex `sysObjectID`, and everything else
about them is reachable through the Trunk Master tables, the console, the map
and the audio port. Drop the missing file into `../SNMP` and the parser will
pick it up; the matrix tables would still need populating in `MatrixDevice`.
