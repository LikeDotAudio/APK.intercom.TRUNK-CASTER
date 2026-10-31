# Legacy Compressed VoIP

**Family:** Legacy Compressed VoIP
**Layer:** Compressed audio and basic control to remote panels or frames.

## What it is
An earlier generation of manufacturer IP transport that compressed audio to fit narrow WAN links. Still found on installed systems.

## How to connect to a device
- Point-to-point IP links with static addressing
- Codec and jitter buffer chosen per channel to suit link quality
- Firewall rules for the vendor's port range

## How to talk to a panel
- Remote panel connects to the interface card and behaves as if local, with added latency
- Keys configured centrally as normal

## What it carries
Compressed audio.

## Trunking notes
Only for integration with existing installations. New links should use the current transport.

## Spoken by
- **RTS**: RVON  (vendor index: `VENDOR/RTS/RTS.md`)
