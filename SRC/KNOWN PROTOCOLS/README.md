# KNOWN PROTOCOLS

Every protocol an intercom can speak, described once, generically. Vendors are implementations of these protocols and are indexed under `VENDOR/`.

## The common language

- [Ward-Beck Crosspoint Line](Ward-Beck%20Systems/Crosspoint-Line/Crosspoint-Line.md): one text line per crosspoint; the unifying words between all of the below.
- `TRUNK-SIMULATOR/tc_protocol.py`: the simulators' audio and key transport (series of sockets, one per port).

## Protocol families

| family | carries | spoken by |
|---|---|---|
| [AES67](AES67/AES67.md) | audio | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [Dante](Dante/Dante.md) | audio + discovery | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [SMPTE ST 2110](SMPTE-2110/SMPTE-2110.md) | audio essence in a media fabric | Riedel, Telos-Infinity |
| [SIP](SIP/SIP.md) | call control + audio | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [4-Wire](4-Wire/4-Wire.md) | analog audio | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [2-Wire Party-Line](2-Wire-Party-Line/2-Wire-Party-Line.md) | analog audio + power + call | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [GPIO](GPIO/GPIO.md) | on/off state | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [SNMP](SNMP/SNMP.md) | status + alarms | Clear-Com, Intracom, RTS, Riedel, Telos-Infinity |
| [Vendor IP Transport](Vendor-IP-Transport/Vendor-IP-Transport.md) | audio + full key control, same brand | Clear-Com, RTS |
| [Digital Networked Party-Line](Digital-Party-Line/Digital-Party-Line.md) | multi-channel party-line + control | Clear-Com |
| [Wireless Beltpack System](Wireless-Beltpack/Wireless-Beltpack.md) | audio + control over radio | Clear-Com, Riedel |
| [Vendor AoIP (standards-compatible)](Vendor-AoIP/Vendor-AoIP.md) | audio + logic | Telos-Infinity |

## Vendors

See [VENDOR/README.md](VENDOR/README.md). Vendor-specific files that are not documents (MIBs, simulators) stay in the vendor folder.

