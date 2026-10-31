# Plan: TRUNK-ADVERTISEMENT

**Purpose.** Where one device posts one JSON file about itself. The runtime posts one per frame.

**Shape.** `Frame` in `src/types.rs`: id, protocol, family, implemented_by (informational: never used
to address a trunk), user_ports, casters, channels_per_trunk, `caster_status` (free or trunked, which
trunk, which peer), `port_names` (renamed after callers), `live_ports` (who is on now),
`last_connection`, `seconds_since_last_connection`, `endpoint`.

**Behaviour.** Ten frames per discovered protocol (`--frames`), 56+8 ports (`--user-ports`,
`--casters`). Files are rewritten only when the frame changed. Stale files for frames that no longer
exist are removed.

**Next.** Other devices (real frames, other runtimes) post their own files here; the runtime reads
them back and treats them as remote frames it can trunk to (multi-site).
