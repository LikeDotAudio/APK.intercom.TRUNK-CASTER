# SNMP

**Family:** SNMP
**Layer:** Monitoring and alarms only. No audio, no key control.

## What it is
Simple Network Management Protocol. A standard for monitoring device health and raising alarms to a network management system.

## How to connect to a device
- Device exposes a management agent on the network with a community string or secure credentials
- Management system polls values and receives traps
- Vendor MIB files describe which values are available

## How to talk to a panel
- Panel and port status can be read, such as link up, PSU state and temperature
- Cannot press keys or route audio
- Useful for dashboards that show whether a trunk or panel is alive

## What it carries
Status values and alarm traps.

## Trunking notes
Monitoring layer for the trunking system. Not a transport.

## Spoken by
- **RTS**: SNMP  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: SNMP  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: SNMP  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: SNMP  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: SNMP  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
