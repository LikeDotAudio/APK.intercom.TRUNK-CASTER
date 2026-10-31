# Plan: TRUNK-CASTER-INTERFACE

**Purpose.** Where the ones looking for a trunk on a frame out there make themselves known.

**Protocol.** Drop `<id>.json` (a `Request`: who, from, to, optional ports, why, where, hold_seconds,
gpio). The runtime answers `<id>.reply.json` (a `Reply`: granted or denied, the `Connection`, reason).
Delete the request to release. Denied requests are retried every 10 s while the file is present.
The same request shape is accepted at `POST /api/request`.

**Routing.** Direct if an existing trunk between the two frames has a free channel, or both frames
have a free caster (a new trunk is created). Otherwise via one intermediate frame, then via two,
preferring paths that need the fewest new trunks. A frame is never over-committed within one plan.
Trunks with no channels left in use are torn down so casters free up.

**Next.** Priorities and pre-emption; reservations (hold a trunk for a show); requests that name a
protocol rather than a frame ("any free Dante frame").
