# Dante

**Family:** Dante
**Layer:** Audio transport plus its own device discovery and routing layer. Control of keys is not part of it.

## What it is
Licensed audio-over-IP transport with built-in discovery, routing software and automatic clocking. Widely supported across consoles, DSPs and intercom.

## How to connect to a device
- Ethernet to a switch; devices auto-discover on the subnet
- Routing done by subscribing receiver channels to transmitter channels in the routing software
- Clock elected automatically between devices
- Multi-subnet or large systems need a domain management layer
- Most devices can switch into an interoperability mode that exposes streams to the open standard above

## How to talk to a panel
- Panel audio is routed in the routing software like any other channel
- Key assignment still happens in the intercom's own configuration tool
- Talk from the panel appears as a transmitter channel other devices can subscribe to
- Signalling needs GPIO or a control protocol

## What it carries
Uncompressed audio with automatic clocking and discovery.

## Trunking notes
Convenient when both ends already have it. For mixed-brand trunks switch to the open interoperability mode.

## Spoken by
- **RTS**: Dante  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: Dante  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: Dante  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: Dante  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: Dante  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
