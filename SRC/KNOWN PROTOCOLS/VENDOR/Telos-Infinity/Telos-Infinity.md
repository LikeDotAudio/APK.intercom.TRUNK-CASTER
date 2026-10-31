# Telos-Infinity

Telos Alliance. Matrix-free IP intercom: every panel is an AES67 / Livewire+ endpoint; Infinity Link for SIP, 2-wire and 4-wire.

| vendor name | protocol family | vendor files |
|---|---|---|
| 2-wire party-line via converter | [2-Wire Party-Line](../../2-Wire-Party-Line/2-Wire-Party-Line.md) |  |
| 4-wire | [4-Wire](../../4-Wire/4-Wire.md) |  |
| AES67 | [AES67](../../AES67/AES67.md) |  |
| Dante | [Dante](../../Dante/Dante.md) |  |
| GPIO | [GPIO](../../GPIO/GPIO.md) |  |
| Livewire+ | [Vendor AoIP (standards-compatible)](../../Vendor-AoIP/Vendor-AoIP.md) |  |
| SIP | [SIP](../../SIP/SIP.md) |  |
| SMPTE ST 2110-30 | [SMPTE ST 2110](../../SMPTE-2110/SMPTE-2110.md) |  |
| SNMP | [SNMP](../../SNMP/SNMP.md) |  |

## Simulator

None yet. `TRUNK-SIMULATOR/launch_all.py` runs the RTS emulator under this vendor's name for its capitals. To build one, start from `VENDOR/RTS/SIMULATOR/rts_intercom_sim.py` (keep the SNMP agent, console, AudioEngine and map wiring; swap the MIBs and device types) and put this vendor's MIB files in a `SNMP/` folder here.
