# AES67

**Family:** AES67
**Layer:** Audio transport only. No key, call or control signalling.

## What it is
Open interoperability standard for professional audio over IP. Defines how uncompressed audio streams, clocking and stream description work so that equipment from different manufacturers can exchange audio on the same network.

## How to connect to a device
- Ethernet connection to a managed switch with multicast (IGMP) and QoS enabled
- Device gets an IP address by DHCP or static assignment
- Device locks to a PTP grandmaster clock on the network
- Streams are announced by SDP descriptions, either via a discovery protocol or entered by hand
- Receiver subscribes to a sender's multicast address to take the stream

## How to talk to a panel
- Audio for a panel arrives as one or more subscribed streams
- Which stream maps to which key is decided in the system's configuration tool, not inside the protocol
- Talk from the panel is published as a stream the far end subscribes to
- Call lights, key presses and tallies need a separate path such as GPIO, SIP or a vendor control protocol

## What it carries
Uncompressed audio, 48 kHz typical, low fixed latency.

## Trunking notes
The standard way to pass audio between intercoms of different brands. Pair it with a signalling path if call state matters.

## Spoken by
- **RTS**: AES67  (vendor index: `VENDOR/RTS/RTS.md`)
- **Riedel**: AES67  (vendor index: `VENDOR/Riedel/Riedel.md`)
- **Clear-Com**: AES67  (vendor index: `VENDOR/Clear-Com/Clear-Com.md`)
- **Intracom**: AES67  (vendor index: `VENDOR/Intracom/Intracom.md`)
- **Telos-Infinity**: AES67  (vendor index: `VENDOR/Telos-Infinity/Telos-Infinity.md`)
