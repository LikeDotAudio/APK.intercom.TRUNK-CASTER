# Plan: KNOWN PROTOCOLS

**Purpose.** The repertoire. One folder per vendor, one sub-folder per protocol, manuals inside.
Vendor folders may sit under `KNOWN PROTOCOLS/` or directly under the project root; both are scanned
and merged. Vendors are merged away: the result is one entry per protocol listing every vendor that
implements it.

**What the runtime reads.** Markdown with `**Type:**`, `## Talking to the panel`, `## Trunking notes`.
Those three land in the advertisement and the home page. Any other file counts as a document.

**Canonical names.** `RUST-RUNTIME/src/protocol.rs` (`canonicalize`) maps folder names to ids:
`2-Wire-Encore`, `2-Wire-TW`, `2-Wire-Performer` and `2-Wire` all become `2-wire` with a flavour.
Unknown folders are kept under a slug so nothing is dropped. `TRUNK-*` folders under a vendor are
that vendor's trunk-interface notes, not protocols.

**Ward-Beck Systems.** `Crosspoint-Line/` documents the unifying line. It is also a protocol
(`wardbeck-line`) and gets its frames like any other.

**Next.** Richer digests (ports, OIDs, API endpoints) pulled out of the manuals into the
`ManualDigest`; a per-vendor `device.json` describing a real frame's address so the runtime can bind
to it.
