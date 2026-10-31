# SMPTE ST 2110

**Family:** SMPTE ST 2110
**Layer:** Audio transport within a facility-wide media network. Discovery and connection management come from a separate control layer.

## What it is
Suite of standards for carrying video, audio and ancillary data as separate essences over IP in broadcast facilities. Intercom uses the audio essence part, with a registry-based discovery and connection layer.

## How to connect to a device
- Redundant red and blue network connections with seamless protection switching
- PTP grandmaster using the broadcast profile
- Device registers itself with a discovery registry
- A broadcast controller makes and breaks connections between senders and receivers

## How to talk to a panel
- A panel's audio appears as an essence the broadcast controller can route anywhere in the plant
- Key behaviour and routing logic stay in the intercom configuration tool
- Signalling needs a separate path

## What it carries
Uncompressed audio essence identical in nature to the open standard above.

## Trunking notes
Lets intercom sit on the same fabric as video. For intercom-to-intercom links it behaves like the open audio standard.

## Spoken by
- **Riedel**: SMPTE ST 2110-30  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Telos-Infinity**: SMPTE ST 2110-30  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
