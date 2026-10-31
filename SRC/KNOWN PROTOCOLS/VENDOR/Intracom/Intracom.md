# Intracom

VCOM software matrix. SIP first, Dante and AES67 via software or gateways, no native analog.

| vendor name | protocol family | vendor files |
|---|---|---|
| 2-wire party-line via converter | [2-Wire Party-Line](../../2-Wire-Party-Line/2-Wire-Party-Line.md) |  |
| 4-wire | [4-Wire](../../4-Wire/4-Wire.md) |  |
| AES67 | [AES67](../../AES67/AES67.md) |  |
| Dante | [Dante](../../Dante/Dante.md) |  |
| GPIO | [GPIO](../../GPIO/GPIO.md) |  |
| SIP | [SIP](../../SIP/SIP.md) |  |
| SNMP | [SNMP](../../SNMP/SNMP.md) |  |

## Simulator

None yet. `TRUNK-SIMULATOR/launch_all.py` runs the RTS emulator under this vendor's name for its capitals. To build one, start from `VENDOR/RTS/SIMULATOR/rts_intercom_sim.py` (keep the SNMP agent, console, AudioEngine and map wiring; swap the MIBs and device types) and put this vendor's MIB files in a `SNMP/` folder here.
