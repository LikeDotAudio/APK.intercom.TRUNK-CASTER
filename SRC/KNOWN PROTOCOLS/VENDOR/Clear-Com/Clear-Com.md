# Clear-Com

HME. Eclipse HX matrices with E-IPA, V-Series panels, FreeSpeak wireless, HelixNet digital party-line, Encore analog party-line, LQ interfaces.

| vendor name | protocol family | vendor files |
|---|---|---|
| Encore two-wire | [2-Wire Party-Line](../../2-Wire-Party-Line/2-Wire-Party-Line.md) |  |
| 4-wire | [4-Wire](../../4-Wire/4-Wire.md) |  |
| AES67 | [AES67](../../AES67/AES67.md) |  |
| Dante | [Dante](../../Dante/Dante.md) |  |
| FreeSpeak II / FreeSpeak Edge | [Wireless Beltpack System](../../Wireless-Beltpack/Wireless-Beltpack.md) |  |
| GPIO | [GPIO](../../GPIO/GPIO.md) |  |
| HelixNet | [Digital Networked Party-Line](../../Digital-Party-Line/Digital-Party-Line.md) |  |
| IVC-32 / E-IPA IP panels | [Vendor IP Transport](../../Vendor-IP-Transport/Vendor-IP-Transport.md) |  |
| SIP | [SIP](../../SIP/SIP.md) |  |
| SNMP | [SNMP](../../SNMP/SNMP.md) |  |

## Simulator

None yet. `TRUNK-SIMULATOR/launch_all.py` runs the RTS emulator under this vendor's name for its capitals. To build one, start from `VENDOR/RTS/SIMULATOR/rts_intercom_sim.py` (keep the SNMP agent, console, AudioEngine and map wiring; swap the MIBs and device types) and put this vendor's MIB files in a `SNMP/` folder here.
