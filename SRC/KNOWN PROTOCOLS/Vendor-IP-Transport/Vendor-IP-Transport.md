# Vendor IP Transport

**Family:** Vendor IP Transport
**Layer:** Audio plus full control: keys, labels, call lights, tallies and configuration in one connection.

## What it is
A manufacturer's own network protocol for carrying audio and control between its matrix, panels and interfaces. Usually built on top of a standard audio transport and adds the control layer the standard lacks.

## How to connect to a device
- Ethernet to the control and audio network; panel is given the matrix address or discovers it
- Panel authenticates or registers to a port on the matrix
- Configuration tool pushes the key layout and names to the panel
- WAN use needs fixed addressing, VPN or QoS

## How to talk to a panel
- Full-featured: keys, listen assignments, call lights and audio all over the one link
- This is the richest way to talk to a panel, but only to the same brand
- Third-party control is usually through the vendor's API or scripting rather than the transport itself

## What it carries
Audio and control.

## Trunking notes
Best choice for same-brand trunking between frames. For cross-brand trunking fall back to a standard transport plus signalling.

## Spoken by
- **RTS**: OMNEO  (vendor index: `VENDOR/RTS/RTS.md`)
- **Clear-Com**: IVC-32 / E-IPA IP panels  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
