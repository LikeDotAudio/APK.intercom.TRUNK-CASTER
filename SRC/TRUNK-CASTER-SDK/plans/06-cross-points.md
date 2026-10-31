# Plan: TRUNK-CROSS POINTS

**Purpose.** Where the JSON for the crosspoints is made and the deltas are logged, where someone
looking for a panel is advertised, and where all the allowed trunks for that seek are advertised.

**Files.**
* `crosspoints.json`: every closed crosspoint right now (`frame`, `input`, `output`, `connection`).
* `deltas.jsonl`: one event per set or clear. Ends after `max_events` (default 1000), settable from
  the display or `settings.json`; `reset` starts over.
* `wardbeck.log`: the same deltas, plus every end-to-end connection and every check-in header, as
  Ward-Beck lines.
* `checkin.wb`: the latest check-in: per frame a CHECKIN line then its CLOSE lines; then a site
  section (`FRAME = *`) with every end-to-end line. Rewritten every `checkin_every_seconds`.
* `gpio.jsonl`: every GPIO command and the trunks it rode.
* `renames.jsonl`: every port rename and how it was dispatched per vendor.
* `seeking.json`, `seeks/<id>.json`, `seeks/<id>.offer.json`: panel seeks and their allowed trunks.

**Crosspoint derivation.** A connection from `A:Up` to `B:Uq` over hops closes `Up-Cx` on A,
`Cin-Cout` on every via frame, `Cy-Uq` on B, both directions.

**Next.** Push Ward-Beck lines to a TCP or serial listener; accept Ward-Beck lines as commands.
