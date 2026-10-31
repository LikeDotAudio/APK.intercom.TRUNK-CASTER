# Vendor AoIP (standards-compatible)

**Family:** Vendor AoIP (Standards-Compatible)
**Layer:** Audio plus its own advertising, routing and logic.

## What it is
A manufacturer's audio-over-IP system that predates the open standard and remains compatible with it. Adds its own discovery, channel numbering and logic layer.

## How to connect to a device
- Ethernet to a multicast-enabled switch
- Sources are advertised by channel number; destinations pick a channel
- Logic and GPIO states also travel over the network as virtual signals

## How to talk to a panel
- Any advertised source can be placed on a panel key by channel number
- A routing control system can change key state and routes through its API
- Non-native devices see the same streams as the open standard

## What it carries
Uncompressed audio plus logic.

## Trunking notes
Native inside its own ecosystem; interoperable with the open standard for everything else.

## Spoken by
- **Telos-Infinity**: Livewire+  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
