# Plan: TRUNK-SIMULATOR

**Purpose.** A timing simulator that creates requests and syncs, cross-checks every connection at a
rate, and graphs usage. Also the physical manager (racks that fold out) and, in Docker, one little
intercom simulator container per protocol that speaks as a crosspoint.

**Fader.** `fader.json`: speed (simulated seconds per real second; 0 freezes), baseline requests per
simulated minute, mean hold, cross-check and sample intervals, running, seed, and `day`, the news
cycle. Re-read every tick, so editing the file or posting `/api/fader` both work.

**The broadcast day (`day`).** `enabled`, `start_hour` (clock at sim_time 0; -1 = wall clock),
`hourly_news` (×3, :55 to :10), `radio_prep` (×2, :25 to :35 and :55 to :05), `six_pm_news` (×6,
builds from one hour before `main_news_hour`, peaks the last quarter before and first half hour after),
`overnight` (×0.3 before 05:00). The multiplier shapes the arrival rate; every page header shows the
simulated clock and current multiplier; the strip on Space, Simulator and Overlord draws the day.

**Cross-check.** Every live connection verifies: hops chain from `from` to `to`, every trunk exists,
joins the right frames, lists the connection and is within capacity; no user port is shared; no
caster is bound twice; no trunk lists a dead connection. Totals and failures are graphed.

**Timeline.** `timeline.json` samples: live, via, trunks, grants, denials, releases, channel and
caster utilisation, cross-check totals, time of day, load multiplier.

**Racks.** `racks.html`: per protocol a rack; per frame a fold-out card with trunks in and out on its
casters, the panels connected (who, to where, for what, how long), every local input and output, and
a ● sim mark when a simulator container hosts the frame.

**frame-sim containers.** `frame-sim/` is a tiny binary: `SIM_PROTOCOL=dante` hosts `dante-01..10`.
It connects to the caster's Ward-Beck port, announces with CHECKIN lines, applies CLOSE/OPEN lines to
its 64×64 matrices, echoes each applied line (the ack), rejects lines naming ports it does not have,
and checks in every `SIM_CHECKIN_SECONDS`. `trunk-caster compose` writes one compose service per
protocol into `docker-compose.sims.yml` (profile `sims`).

**Voices.** Each hosted frame has a speaker; all of them talk at once, in the accent of the
frame's country. A frame says its ident once (frame, site, country, continent, airport, protocol,
simulator), then says each of its connections, from and to, the whole time it is connected (from the
end-to-end `CLOSE` until its `OPEN`). Speech is espeak-ng; the wave sender cuts every saying into
1-second and 5-second chunks and sends both cuts at the same time over its own MQTT connection
(`voice1` / `voice5` topics), damaging `SIM_VOICE_FAULTS` of them so the caster's correction is
exercised. See `11-taps-voices-bandwidth.md`.

**Park and sweep.** A call whose hold runs out is parked: connected but muted until the next
round-robin sweep (`round_robin_seconds`, 60). A request between the same two frames before the sweep
picks the parked line up again (`reconnects` counts it). An average call lasts ten minutes.

**The lease.** `lease_seconds` (900): green while it has time left, reset whenever the line is used
(granted, picked up, GPIO). At zero the line is red ("may be dead"), parked with its bandwidth on hold,
and `reclaim_for` releases it first when a new call between the same frames finds no capacity.

**Daily reset.** `day.blackout` (11:00 to 12:00 UTC on the simulated clock): everything is released,
every remote frame receives OPEN lines and an empty check-in, requests are denied with the reason,
synthetic load pauses; at the end a new run starts and traffic reconnects.

**Recorder.** `runs/<id>.json` per run (`reason`: boot, fader, fader-file, clock, blackout-end), the
fader it ran under and a `RunSummary` (grants, denials, peak/avg live, utilisation, cross-check
failures); `runs.json` indexes closed runs. Any parameter change closes the run.

**Next.** Scenario files (a show's call sheet replayed on the simulated clock); failure injection
(stop a simulator container, watch the frame go ○ and via routing take over); a simulator that also
answers SNMP so the RTS rename path can be exercised end to end; per-device samples so a device's
timeline is a chart rather than its records.
