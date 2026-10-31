# Riedel

Artist matrices (Artist-1024 native AES67 / 2110), SmartPanels, Bolero wireless, MediorNet fiber, Performer party-line, TETRA radio integration.

| vendor name | protocol family | vendor files |
|---|---|---|
| Performer party-line | [2-Wire Party-Line](../../2-Wire-Party-Line/2-Wire-Party-Line.md) |  |
| 4-wire | [4-Wire](../../4-Wire/4-Wire.md) |  |
| AES67 | [AES67](../../AES67/AES67.md) |  |
| Bolero (DECT) | [Wireless Beltpack System](../../Wireless-Beltpack/Wireless-Beltpack.md) |  |
| Dante | [Dante](../../Dante/Dante.md) |  |
| GPIO | [GPIO](../../GPIO/GPIO.md) |  |
| MediorNet | [Fiber Media Network](../../Fiber-Media-Network/Fiber-Media-Network.md) |  |
| SIP | [SIP](../../SIP/SIP.md) |  |
| SMPTE ST 2110-30 | [SMPTE ST 2110](../../SMPTE-2110/SMPTE-2110.md) |  |
| SNMP | [SNMP](../../SNMP/SNMP.md) |  |
| TETRA radio | [Trunked Radio](../../Trunked-Radio/Trunked-Radio.md) |  |

## Simulator

None yet. `TRUNK-SIMULATOR/launch_all.py` runs the RTS emulator under this vendor's name for its capitals. To build one, start from `VENDOR/RTS/SIMULATOR/rts_intercom_sim.py` (keep the SNMP agent, console, AudioEngine and map wiring; swap the MIBs and device types) and put this vendor's MIB files in a `SNMP/` folder here.
