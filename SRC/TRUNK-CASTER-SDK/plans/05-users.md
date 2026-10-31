# Plan: TRUNK-USERS

**Purpose.** The state of who requested whom, when, why, where and how.

**Files.** One `UserRecord` JSON per request ever made (interface, http or simulator): who, whom
(`frame:Unn`), from, when, why, where, how (direct or via which frames, trunks), status, how long it
lasted (wall and simulated seconds), GPIO sent. `index.html` shows people (requests, live now, total
connected time, last asked) and the request log.

**Housekeeping.** Simulator records are capped at 300 on disk (oldest removed); real records are
kept.

**Next.** Export to CSV; per-show grouping; authentication of `who`.
