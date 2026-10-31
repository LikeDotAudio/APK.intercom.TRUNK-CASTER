# RTS

Bosch. ADAM and ODIN matrices, KP-Series keypanels, ROAMEO wireless, RVON legacy IP cards, TW and Audiocom party-line. The only vendor with a working simulator so far.

| vendor name | protocol family | vendor files |
|---|---|---|
| TW two-wire | [2-Wire Party-Line](../../2-Wire-Party-Line/2-Wire-Party-Line.md) |  |
| 4-wire | [4-Wire](../../4-Wire/4-Wire.md) |  |
| AES67 | [AES67](../../AES67/AES67.md) |  |
| Audiocom two-wire | [2-Wire Party-Line](../../2-Wire-Party-Line/2-Wire-Party-Line.md) |  |
| Dante | [Dante](../../Dante/Dante.md) |  |
| GPIO | [GPIO](../../GPIO/GPIO.md) |  |
| OMNEO | [Vendor IP Transport](../../Vendor-IP-Transport/Vendor-IP-Transport.md) |  |
| RVON | [Legacy Compressed VoIP](../../Legacy-Compressed-VoIP/Legacy-Compressed-VoIP.md) |  |
| SIP | [SIP](../../SIP/SIP.md) |  |
| SNMP | [SNMP](../../SNMP/SNMP.md) | `SNMP/` |

## Simulator

`SIMULATOR/rts_intercom_sim.py`: the working emulator. See `SIMULATOR/README.md`. It also stands in for the other vendors when `TRUNK-SIMULATOR/launch_all.py` runs the world.
