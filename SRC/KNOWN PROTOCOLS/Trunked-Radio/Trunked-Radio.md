# Trunked Radio

**Family:** Trunked Radio
**Layer:** Audio plus PTT state. Half-duplex.

## What it is
Professional two-way digital radio network used by crews and security. Half-duplex, push-to-talk, organised in talkgroups.

## How to connect to a device
- Radio base station or gateway provides audio in and out plus a PTT input and busy output
- Connected to the intercom over 4-wire and GPIO, or through a SIP gateway

## How to talk to a panel
- A talkgroup appears as a port on the panel
- Pressing the key asserts PTT; releasing lets the radio side talk
- Logic in the intercom handles the half-duplex turn-taking

## What it carries
Compressed radio audio and PTT.

## Trunking notes
Radio-to-intercom trunking. Always one-way at a time.

## Spoken by
- **Riedel**: TETRA radio  (vendor index: `VENDOR/Riedel/Riedel.md`)
