# Plan: TRUNK-CASTER-SDK

**Purpose.** All of these connect via an SDK we control. This crate is that SDK and the home of the
plans.

**Contents.** `src/types.rs` (every JSON shape), `src/folders.rs` (the folder contract),
`src/wardbeck.rs` (the unifying line), `src/client.rs` (`FileClient` over folders, `HttpClient` over
the runtime's port), `src/mqtt.rs` (the second transport and double validation), `src/voice.rs`
(WAV, CRC-32, the wave sender's 1 s and 5 s cuts, the re-assembler, accents), `src/sites.rs` (sites,
continents, oceans, airport codes), `vendor-policy.json` (how renames reach each vendor), `plans/`.

**HttpClient.** Everything the runtime serves has a method: status, advertisements, request,
release, fader, panel seek, crosspoint settings, GPIO, rename, and TAPS and Mixes (`taps`,
`tap_strip`, `set_crosspoint_gain`, `set_gain`, `taps_unity`), voices (`voices`, `voice`,
`voice_wav`), `bandwidth` and `airports`. The TypeScript mirror is `TYPESCRIPT/sdk` (types, voice)
and `TYPESCRIPT/api` (typed client, OpenAPI).

**Rules.** Nothing in the SDK knows a brand as an address. `wire_version` is bumped on incompatible
changes. New components depend on this crate rather than re-declaring shapes.

**Next.** Publish as a workspace member; a Python mirror of the types for tooling; JSON Schema export
from the Rust types.
