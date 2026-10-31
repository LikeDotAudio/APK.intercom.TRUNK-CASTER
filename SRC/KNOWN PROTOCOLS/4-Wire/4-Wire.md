# 4-Wire

**Family:** 4-Wire
**Layer:** Audio only. Completely vendor-neutral at the electrical level.

## What it is
Analog balanced audio with one pair for send and one pair for receive. The oldest and most universal intercom interface.

## How to connect to a device
- Two balanced line-level pairs on a connector, typically a modular jack or XLR pair
- Match nominal levels and impedance between the two systems
- Check pinout; each manufacturer has its own convention for which pins are send and receive
- Shielded cable; distance limited by analog line practice

## How to talk to a panel
- The 4-wire port appears as a source and destination inside the intercom
- A key on the panel is assigned to that port; talk goes out the send pair, listen comes in on the receive pair
- No signalling in the audio path; use GPIO contacts alongside, or in-band tones

## What it carries
Line-level analog audio.

## Trunking notes
Works between any two intercoms with no configuration beyond levels and pinout. Needs GPIO for call state.

## Spoken by
- **RTS**: 4-wire  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: 4-wire  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: 4-wire  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: 4-wire  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: 4-wire  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
