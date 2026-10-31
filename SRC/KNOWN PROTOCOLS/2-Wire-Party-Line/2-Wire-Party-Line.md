# 2-Wire Party-Line

**Family:** 2-Wire Party-Line
**Layer:** Shared audio channel plus simple call signalling (a DC shift or tone) and power.

## What it is
Analog party-line where all users on a channel share one pair that carries audio and DC power. Several incompatible standards exist with different power voltages and pin assignments.

## How to connect to a device
- Daisy-chain or star wiring from a power supply or main station on XLR cable
- One termination per channel so sidetone and level stay stable
- Confirm which party-line standard is in use before connecting anything; mixing standards needs a converter
- A 2-wire to 4-wire interface bridges the line into a matrix or IP system, with a nulling adjustment to cancel echo

## How to talk to a panel
- After bridging, the whole party-line channel appears as a single port
- A matrix panel key talks to everyone on the line at once
- Call light on the line can be mapped to a call indication on the panel through the interface

## What it carries
Analog audio, DC power and basic call signalling on one pair.

## Trunking notes
Bridge into the trunking system through a 2-wire to 4-wire interface. Treat each channel as one port.

## Spoken by
- **RTS**: TW two-wire  (vendor index: `VENDOR/RTS/RTS.md`)
- **RTS**: Audiocom two-wire  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: Performer party-line  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: Encore two-wire  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: 2-wire party-line via converter  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: 2-wire party-line via converter  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
