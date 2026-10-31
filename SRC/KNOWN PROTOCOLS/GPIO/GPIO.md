# GPIO

**Family:** GPIO
**Layer:** Control only. No audio.

## What it is
General-purpose contact closures and logic inputs. The simplest way to pass on/off state between pieces of equipment.

## How to connect to a device
- Relay or open-collector outputs and opto-isolated inputs on a multi-pin connector or terminal block
- Networked GPIO boxes extend contacts over IP
- Logic mapping is done in the intercom configuration tool

## How to talk to a panel
- An incoming closure can activate a key, light a call indicator or force a route on a panel
- A key press on the panel can close a contact for tally, PTT or external triggering
- Combine with an audio path to recreate full talk/listen plus signalling

## What it carries
On/off state.

## Trunking notes
The usual companion to an audio-only trunk. Carries call and PTT state across brands.

## Spoken by
- **RTS**: GPIO  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: GPIO  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: GPIO  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: GPIO  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: GPIO  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
