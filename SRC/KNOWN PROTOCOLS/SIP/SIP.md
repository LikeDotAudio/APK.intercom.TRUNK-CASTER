# SIP

**Family:** SIP
**Layer:** Call signalling and audio. Carries dial, ring, answer and hang-up, so it includes a form of call state.

## What it is
Session Initiation Protocol, the signalling standard for telephony over IP. Sets up, modifies and ends calls; audio travels alongside as RTP.

## How to connect to a device
- Endpoint registers with a PBX or SIP server using an extension and credentials, or two endpoints are pointed at each other directly
- Signalling on a well-known port, audio on a negotiated RTP port range
- Codec agreed at call setup; narrow-band telephone quality is common, wideband is possible
- Firewall and NAT rules needed when crossing network boundaries

## How to talk to a panel
- A SIP endpoint is assigned to a key or channel on the panel
- Pressing the key dials or answers; a keypad or soft panel provides DTMF
- Far-end caller hears the panel talk and speaks back on the same key
- Ring and hang-up translate naturally to call light and key release

## What it carries
Compressed or uncompressed audio plus call control.

## Trunking notes
The one protocol every intercom supports. Low channel count and higher latency, but it brings its own signalling.

## Spoken by
- **RTS**: SIP  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: SIP  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: SIP  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: SIP  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: SIP  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
