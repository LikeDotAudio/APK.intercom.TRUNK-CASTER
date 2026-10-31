# Area 08: the broker core (routing, runtime tick, ports)

**Verdict: keep the server core in Rust.** I built one part in TypeScript: the route finder, written as pure functions so the browser can preview a route ("what if") before asking for it.

Nothing in the core gets better by moving to Node. Rust gives one `Mutex<Runtime>`, OS threads for HTTP, WebSocket and Ward-Beck, a tick that does a lot of computing, a small Docker image and 25 tests. The real problems found here are in the algorithms. They can be fixed in Rust in about a day, and they would be just as bad in TypeScript. The route finder is worth having in TS. It now passes every assertion from the Rust routing tests, a 3,000-case fuzz test against a line-by-line copy of `routing.rs`, and a replay of the live 710-frame `state.json`.

---

## Scope (audited)

| File | Lines | What I read for |
|---|---|---|
| `RUST-RUNTIME/src/routing.rs` | 1-934 (all) | Ported in full except port names, labels and gains |
| `RUST-RUNTIME/src/runtime.rs` | 131-298 boot, 499-540 tick, 930-1100 `handle_request`/`release`, 1623-1690 seeks, 1696-1762 expire/daily reset, 1764-2020 synthetic load, 2295-2395 crosscheck/persist | Concurrency, decision order, load shape |
| `RUST-RUNTIME/src/main.rs` | 1-316 (all) | Threads, run loop, janitor, CLI |
| `RUST-RUNTIME/src/http.rs` | 1-40, 505-520, 637 | Thread per connection, one global lock |
| `RUST-RUNTIME/src/wb.rs` | 1-224 (skim) | TCP 7879, thread per remote, hub mutex |
| `RUST-RUNTIME/src/snmp.rs` | 70-105 | UDP SET, one socket per send |
| `RUST-RUNTIME/src/crosspoints.rs`, `frame.rs`, `relay.rs`, `users.rs`, `protocol.rs` | skim | Not on the routing path; no changes recommended |
| `TRUNK-CASTER-SDK/src/types.rs` | 120-135, 194-220, 584-768, 900-910, 1143-1208 | `Shape`, `Frame`, `Connection`, `Trunk`, `AllowedTrunk`, lease, blackout |
| `TRUNK-CASTER-SDK/plans/10-runtime.md`, `06-cross-points.md` | all | Intended design |
| `Dockerfile` | 1-40 | Image build, `cargo test` already runs during the build |

---

## Rust or Node? The trade-offs

| Concern | Rust today | Node/TS port | Weight |
|---|---|---|---|
| Concurrency | `Arc<Mutex<Runtime>>`. The tick holds the lock while it computes, and disk writes are flushed outside it (`main.rs:262-282`). HTTP and Ward-Beck threads can still accept connections and do I/O while the tick runs. | One event loop serialises the same way. While the tick computes (up to 200 spawns/tick (`runtime.rs:1783`), crosscheck, rendering 4,462 lines of `html.rs`), every socket is starved, not only the state. Avoiding that needs `worker_threads` plus a message-passing rewrite. | **Rust** |
| TCP 7879 (Ward-Beck lines), UDP SNMP SET, WS | Plain `std::net` | `net`, `dgram` and `ws` are all easy | neutral |
| Performance under simulated load | Native, but the via-2 search is O(F²·T) (finding 1) | The same algorithm would be roughly 3-10x slower. The fix is algorithmic. | **Rust**, after the fix |
| Memory and image | One static binary on `debian:bookworm-slim` | Adds about 150 MB of Node runtime, plus `ws` | Rust |
| Tests | 25 runtime tests (7 in routing) plus 8 in the SDK, run by `docker build` | Would have to be rewritten | Rust |
| Team stack | Pages, simulators and the SDK client are moving to TS (areas 01-07, 09-10) | Shared types and logic with the browser | **TS, for the pure logic only**, which is what I built |
| Dependencies | `serde`, `serde_json`, `walkdir`. Nothing to maintain. | — | Rust |

**Recommendation:** keep `RUST-RUNTIME` as the server. Use `TYPESCRIPT/routing` as the browser and simulator copy of the routing rules, and keep it honest with a golden file (below).

---

## Findings

1. **Severe: the two-frame "via" search is O(F²·T) and runs while holding the global lock.** The code is `routing.rs:492-519`, `461-480`, and the trunk scans at `334` and `280-284`. When a request fails both direct and one-frame-via, `via_plans(…, 2, …)` evaluates every ordered pair of candidates: 708·707 ≈ **500k paths** for the live 710-frame fleet. Each path scans every trunk at least once. It also collects every feasible plan before sorting, only to keep one. `allowed_trunks` (seeks, `runtime.rs:1667`, limit 12) does the same whenever one-frame-via finds fewer than 12 plans. I measured a line-by-line JS copy on a saturated fleet: **127 ms at 100 frames, 1.0 s at 200, 8.6 s at 400**. Extrapolated to 700 frames that is about 45 s in JS. Rust's constant factor is better, but this is still seconds per denied request with `Runtime` locked. That stalls HTTP, WS and Ward-Beck. The TS port answers the same question in **1.9 ms at 700 frames**, with identical results (fuzz-checked). It does three things the Rust code can copy:
   - a per-pass index from frame pair to the first trunk with room, plus casters in use per frame;
   - skip every `m2` when `from→m1` is already infeasible;
   - bucket plans by how many new trunks they need, stopping once bucket 0 is full.

   This is a **Rust fix**, not a reason to change language.
2. **Reclaim releases only ONE red line** (`runtime.rs:983-1003`, `routing.rs:692-702`). If the oldest red line shares its trunk with other calls, releasing it frees no caster. The retry is then denied, even though other red lines still hold the bandwidth. `request.test.ts` "reclaim releases ONE red line…" reproduces this: A's only caster is held by two red lines, the request is denied, and r2 stays red. Fix: keep reclaiming, oldest first, until the plan succeeds or no red line is left. Alternatively, reclaim by trunk.
3. **Picking up a parked line skips the caller rules** (`runtime.rs:957-975`):
   - the requested `from_port`/`to_port` are ignored;
   - the line keeps its original direction and connection id, so the new request id goes only to the user record;
   - **the ports are not renamed after the new caller**, because `set_port_label` only runs on the route path (`runtime.rs:1010-1011`);
   - the pick-up does not increment `counters.granted`;
   - `hold_seconds` is passed raw. The route path clamps it with `max(0.0)` at `runtime.rs:940`, but `unmute` at `routing.rs:655` does not, so a negative hold re-parks the line on the next tick.
4. **A parked line lives one to two sweep periods, not "until the next sweep".** `expire_simulated` calls `sweep(last_sweep)` (`runtime.rs:1712-1714`), so it releases lines parked before the *previous* sweep. A line parked at t=10 survives the sweep at 60 and goes at 120. This could be intentional (a grace period). It is encoded in `expireTick` and its test. Open question 1.
5. **Crosscheck is O(C²)** (`routing.rs:753-759`, the user-port clash check). It runs every 5 sim-seconds by default (`types.rs:1166`), which is several times per wall-second at faster fader speeds. On the live snapshot (1,029 connections) the TS copy takes 54 ms. At the 20k connections of the stress preset it would be about 400M comparisons. Fix: one `HashMap<(frame,port), id>` pass.
6. **Errors are classified by string matching** (`runtime.rs:983`, `e.contains("no capacity")`). Reword the message in `routing.rs:406` and reclaim silently stops working. Suggest a `RouteError` enum. The TS port keeps the strings for parity. Also, in the live `state.json`, `denied` is 24,054,545 against 2,292,785 granted (91%), and nothing records *why*. A per-reason counter is worth adding.
7. **`create_trunk` can panic** (`routing.rs:592-593`, `free_caster_indices(x)[0]`). It is safe only because the plan checked caster counts first. The TS version throws an `Error` with the frame name instead.
8. **Not a bug:** `reclaim_for` filters hops with `h.from == from || h.to == to` (`routing.rs:697`). This looks asymmetric, but since every intermediate frame appears as both a `to` and a `from`, it is the same as "the path touches `from` or `to`". It is documented in the code.
9. **Parity confirmed on live data.** The TS router loaded the real `TRUNK-USAGE/state.json` (710 frames, 1,005 trunks, 1,022 connections) and crosscheck returned **1,029/1,029 ok, 0 failures**. It then planned 2,000 random pairs (197 via, 0 none) and `allowed_trunks(…, 12)` in 3.5 ms. The live file read gave 1,022 connections; crosscheck counted 1,029 because the runtime appended to the file between the two reads.

---

## Files built (`TYPESCRIPT/routing/`)

| File | Lines | What it is | Mirrors |
|---|---|---|---|
| `tsconfig.json` | 10 | Extends `../tsconfig.base.json`, `lib: ES2022`, `types: node` | — |
| `src/types.ts` | 169 | Local wire types: `Shape`, `RouteFrame`, `Connection`, `Trunk`, `Hop`, `AllowedTrunk`, `Counters`, `Blackout`, `RouteState`, `RouteAsk`, `Clock`. **Dedup with agent 04's `sdk/`.** | `types.rs:123,194,584-700,900,1184`; `routing.rs:15,23,46,61` |
| `src/router.ts` | 630 | `Router` class plus the trunk and connection helpers, `PlanIndex`, `cloneState`, `reconcile`. Pure, no I/O, browser-safe. | see table below |
| `src/request.ts` | 161 | `decide` (request decision order), `preview` (what-if on a deep copy), `expireTick`, `resetTick`, `blackoutActiveAt`, defaults (lease 900 s, round-robin 60 s, blackout 11-12 UTC) | `runtime.rs:930-1059, 1696-1762`; `types.rs:1143-1208` |
| `src/golden.ts` | 166 | Golden-file format and replayer (subset deep-equal; wall-clock fields ignored) | — |
| `golden/rust-tests.json` | 79 | The 5 Rust routing tests' assertions as golden cases | `routing.rs:817-897` |
| `src/router.test.ts` | 233 | 10 tests: error strings, trunk ids and caster order, via-2, tie-breaks, allowed trunks, release, latched, crosscheck, reconcile, **fuzz: indexed planner vs literal transliteration** | — |
| `src/request.test.ts` | 127 | 9 tests: golden replay, blackout, pick-up, reclaim (success and the finding 2 failure), preview immutability, sweep schedule, daily reset | — |

### Function map (for checking parity)

| TS | Rust |
|---|---|
| `trunkUsed/Free/Joins/Touches/CasterOn/PeerOf` | `types.rs:739-768` `Trunk::*` |
| `leaseLeft`, `viaFrames` | `types.rs:651`, `663` |
| `planNewTrunks`, `planPath` | `routing.rs:76`, `79` |
| `newState` | `routing.rs:89` `State::new` |
| `reconcile` | `routing.rs:232` `load_or_new` (reconcile half) |
| `Router.castersOf/userPortsOf/usedCasters/freeCasters/freeCasterIndices` | `routing.rs:271-290` |
| `Router.usedUserPorts/allocUserPort/existingWithRoom` | `routing.rs:308-336` |
| `Router.channelUtilization/casterUtilization` | `routing.rs:339-356` |
| `Router.route` | `routing.rs:362` |
| `Router.planDirect/evaluate/candidates/viaPlans/planVia` | `routing.rs:448-523` |
| `Router.plan` | `routing.rs:399-402` |
| `Router.allowedTrunks` | `routing.rs:527` |
| `Router.commit` / `createTrunk` | `routing.rs:576` / `591` |
| `Router.release/expire/findParked/unmute/redLines/holdRed/sweep/reclaimFor/releaseAll` | `routing.rs:613-708` |
| `Router.crosscheck` | `routing.rs:714-785` |
| `decide` | `runtime.rs:930-1059` (decision order only) |
| `expireTick` / `resetTick` | `runtime.rs:1696` / `1727` |
| `blackoutActiveAt` | `types.rs:1197` |

**Not ported, on purpose:** port names and labels (`routing.rs:104-139`), gains (`151-188`), `live_ports_of`/`seconds_since_last` (display only), and everything with side effects in `handle_request` (records, GPIO, renames, trends, notes).

---

## Typecheck and test output

```
$ node node_modules/typescript/bin/tsc -p routing; echo "tsc exit $?"
tsc exit 0

$ node --test --experimental-strip-types routing/src/*.test.ts
✔ golden: every assertion of routing.rs tests replays with zero mismatches
✔ blackout window: 11:00 inclusive to 12:00 exclusive, wraps midnight
✔ decide: blackout denies and counts
✔ decide: a parked line is picked up in either direction, ports and kind kept
✔ decide: no capacity -> reclaim the oldest red line -> retry succeeds
✔ decide: reclaim releases ONE red line, which may not free a caster (finding)
✔ preview never mutates the live state
✔ expireTick parks, holds red, sweeps on the round-robin schedule
✔ resetTick releases everything on entering the window only
✔ error strings match routing.rs:364-406
✔ trunk ids are trunk-NNNNN and casters are lowest-free first
✔ via two frames when direct and via-one are both blocked
✔ via prefers fewer new trunks, then fleet order (stable sort)
✔ allowed_trunks: every direct trunk with room, then a new direct, then vias
✔ release tears down empty trunks and frees casters
✔ latched lines are never parked, held red, swept or reclaimed
✔ crosscheck catches over-capacity, missing trunks and double-bound casters
✔ reconcile drops vanished frames and bumps next_trunk
✔ indexed planner == literal routing.rs planner over 3000 random states
ℹ tests 19  ℹ pass 19  ℹ fail 0  ℹ duration_ms ~790
```

The benchmark script and live-state replay were scratch files and were not committed. The saturated fleet had f0 fully blocked, so the full via-2 scan ran:

```
frames=100 trunks=348  indexed=1.5ms  literal=127ms
frames=200 trunks=700  indexed=1.0ms  literal=1003ms   (8.6 s at 400 in an earlier run)
frames=700 trunks=2448 indexed=1.9ms  literal=skipped (est. ~45 s)
live state.json: crosscheck 1029/1029 ok in 54ms; 2000 plans 1.66s; allowed_trunks(12) 3.5ms
```

---

## Golden parity (Rust dumps, TS replays)

The format is `GoldenFile` in `src/golden.ts`: `{version:1, source, cases:[{name, shape, frames, ops:[{op, …, expect}]}]}`. The supported ops are:

- `route`, `decide`
- `release`, `expire`, `find_parked`, `unmute`, `sweep`
- `red_lines`, `hold_red`, `reclaim_for`
- `expire_tick`, `allowed_trunks`, `state`

`expect` is a subset match. Fields that depend on the wall clock (`granted_at`, `granted_unix`, `created_at`, `at`, `unix`) are never compared.

Suggested Rust side (**not applied**, another session owns `RUST-RUNTIME`): add `#[test] #[ignore] fn dump_golden()` to `routing.rs` tests.
1. For seeds 1..=50, build `fleet(n, casters, channels)` with small random sizes (4-10 frames, 1-3 casters, 1-3 channels) from a fixed LCG.
2. Run 200 random ops: route 70%, release 20%, `expire` and `sweep` 10%.
3. After each op, record `{op, args, expect}`. For `route`, `expect` is `{ok, kind, from_port, to_port, hops, via}` or `{ok:false, error}`. Every 20 ops, record `state` with `trunks`, `connections`, `counters`, `free_casters` and `trunk_free`.
4. Write the result with `serde_json::to_writer_pretty` to `TYPESCRIPT/routing/golden/rust-dump.json`. Run it with `cargo test dump_golden -- --ignored`.

Then add one TS test that calls `replayFile("golden/rust-dump.json")` when the file exists. Any drift in Rust (a tie-break, an error string, caster order) becomes a red test in TS.

---

## Wiring steps (NOT applied)

1. **Dedup types.** Once agent 04's `sdk/` exports `Connection`, `Trunk`, `Shape`, `AllowedTrunk` and `RouteKind`, replace `routing/src/types.ts` with re-exports and keep `RouteFrame`/`RouteState`/`RouteAsk`/`Clock` local, or move them into the SDK.
2. **Browser bundle.**

   ```
   node node_modules/esbuild/bin/esbuild routing/src/request.ts --bundle --format=esm --platform=browser --outfile=<pages>/js/routing.js
   ```

   `golden.ts` imports `node:fs`, so leave it out. `router.ts` and `request.ts` are browser-safe.
3. **Page use.** Fetch `GET /api/state` (`http.rs:510`). It serialises `routing::State`, a superset of `RouteState`, including `next_trunk`. Then:

   ```
   preview(new Router(state), {id, who, from, to}, {sim_time, blackout_active, blackout_end_hour, lease_seconds, origin:"preview"})
   ```

   This shows direct, via or denied, with hops, before the user presses Request. `allowedTrunks(from, to, 12)` gives the same list as `/api/panel-seek` without a round trip.
4. **Simulators** (area 06/07) can import `Router` to predict grants offline.
5. **Rust fixes** (separate PRs to `RUST-RUNTIME`, after the concurrent session lands):
   - findings 1 and 5 (performance);
   - finding 2 (reclaim loop);
   - finding 3 (rename on pick-up, clamp the hold);
   - finding 6 (`RouteError` enum and per-reason counters).

   Change the TS mirror in the same PR and regenerate the golden file.

## Risks

- **Drift.** Two implementations of the routing rules. This is fixed only once the Rust dumper exists. Until then, parity rests on the hand-encoded Rust assertions, the fuzz test against a literal transliteration, and the live-state crosscheck.
- **The `/api/state` payload** is the whole state: about 1,000 connections now, and up to about 20k under the stress preset. If the page previews against it, cache it or use a slimmer endpoint.
- **The live snapshot is not atomic.** `state.json` was being rewritten while I read it, so I used a scratch copy.
- **`preview` uses the snapshot's `sim_time`,** which the caller supplies. If the page's clock lags, lease and red decisions can differ from the server's.

## Open questions

1. Is the "parked survives one extra sweep" behaviour (finding 4) intended as a grace period?
2. Should a picked-up parked line rename the ports after the new caller, and count as a grant?
3. Should reclaim keep releasing red lines until the request fits (finding 2)?
4. Where should the browser bundle live, the pages area (agent 0x) or `TRUNK-GLOBAL/js`?

## Next steps

1. Land the Rust golden dumper and the replay test.
2. Port the PlanIndex, hoisting and bucket optimisation into `routing.rs`. It changes no behaviour, and the golden file proves that.
3. Wire `preview()` into the panel and request page.
4. Dedup types with `sdk/`.
