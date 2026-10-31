# Plan: TAPS and Mixes, voices and the bandwidth simulation

**Purpose.** Hear the system. Every crosspoint gets a fader, every simulated frame gets a voice that
says what it is and what it is connected to, and the voice traffic is real bytes on a real broker, so
the load of the calls can be measured: the bandwidth simulation.

## TAPS and Mixes

A drop-down on the Overlord: a mixer of every connected frame. One strip per frame (in its vendor's
colour), one little fader per closed crosspoint. Each fader is the gain of **the thing coming in**
(the input, top label) crossed to the output (bottom label), -60 to +20 dB, double-click for unity.

* Stored in `state.json → xp_gains`, keyed `"<frame>|<input>|<output>"`; only gains off unity are kept.
* The crosspoints a call closes in its caller-to-callee direction add to the call's path gain
  (`State::path_gain_db`), beside the trunk-end and hop gains. The return-direction faders are kept
  and logged but not in that sum.
* Every change is a `GainEvent` in `TRUNK-USAGE/gains.jsonl`, like every other gain point.
* API: `GET /api/taps`, `GET /api/taps/<frame>`, `POST /api/gain {frame,input,output,db}`,
  `POST /api/taps/unity {frame?}`.

## Voices

Every frame in every simulator container (`frame-sim`) has its own speaker, and they all talk at
the same time.

* **Ident**, once per run, when the frame is first hosted: *"This is frame paris 01. Paris, France,
  Europe. Airport C D G. dante protocol, simulator sim dante."*
* **Call**, over and over **the whole time the frame is connected**, one connection after another:
  *"Connection from Andrey, on paris 01 user port 3, Paris, France, airport C D G. To Lena, on hanoi 05
  user port 0, Hanoi, Vietnam, airport H A N."* It is learned from the end-to-end Ward-Beck `CLOSE`
  line and stops at its `OPEN`. A frame with no connection is silent.
* **Accents.** Each frame speaks English in the accent of its country (`voice::accent_base`: French
  for France, Mandarin for China, Scottish for Glasgow, New York for New York …) plus a variant picked by
  the frame id (`+m1` … `+f5`), so frames on one site do not sound alike. Japanese and Hebrew voices
  spell English out letter by letter, so those countries speak plain English.
* **Airports.** `sites::airport_of(site)`: the IATA code of the site's main airport (the biggest one
  for a state or province), spelled out letter by letter.
* Speech is `espeak-ng` (installed in the frame-sim image) at 8 kHz, 16-bit mono. Without it the
  frame plays a tone sketch of the words. Each saying is synthesised once per accent and text, then
  replayed from memory.

## The wave sender

Each saying is cut twice: into **1-second** chunks and into **5-second** chunks. The two cuts are
sent **at the same time**, each chunk as its audio has played out, so the send takes about as long as
the audio (1.0×) and the redundancy costs twice the bytes.

```text
trunk-caster/<protocol>/<frame>/voice1   1-second chunks
trunk-caster/<protocol>/<frame>/voice5   5-second chunks
payload: V1|<id>|<cut>|<index>|<total samples>|<rate>|<crc32>|<kind>|<text b64>|<pcm b64>|<sent ms>
```

The voice has its own broker connection at both ends (`voice-<host>` in each simulator,
`caster-voice-<site>` in the caster), so it never queues behind the double-validated crosspoint
lines.

## Re-assembly and error correction

`voice::Reassembler` (caster side, in its own thread) puts each saying back together second by
second:

1. the second's 1-second chunk, when it arrived and its CRC-32 is good;
2. otherwise that second's slice of the 5-second chunk, when that is intact (**corrected**);
3. otherwise silence (**lost**: both copies were hit).

A saying is handed back as soon as every second is recoverable, or 4 s after its last chunk. Late
chunks of a saying already handed back are ignored. The CRC is checked once per chunk, on arrival.
`SIM_VOICE_FAULTS` (default 0.05) damages or drops that share of chunks in transit so the correction
has work to do. Measured with 707 frames talking: about 1 in 30 seconds is corrected from the
5-second cut, and about 1 in 1000 is lost on both.

The newest saying of each frame is kept as `<frame>-ident.wav` and `<frame>-call.wav` in the voices
folder: `TRUNK_VOICES_DIR`, else `TRUNK-USAGE/voices/`. In Docker it is the `voices` volume
(`/voices`), because the WAVs churn as calls change and the project folder may be synced (OneDrive)
and slow to write. `voices.jsonl` gets a line whenever what a frame says changes (not every repeat).
The caster reloads that index when it restarts, checking each recording's WAV once.

## The bandwidth simulation

Every chunk heard is metered (topic plus payload, as on the wire) per frame, per protocol and in
total, over a 10-second window. Each frame's rate is shared between its live calls and added to
every trunk those calls cross, so a trunk's load is the voice actually riding it.

* Overlord → **Bandwidth**: voice on the wire, frames talking, voice carried on trunks, trunks
  carrying voice, bytes heard; per protocol; the 25 busiest trunks (calls of capacity, kbit/s,
  kbit/s per channel).
* TAPS strips show 🔊 kbit/s for each frame talking.
* API: `GET /api/bandwidth`.

With every frame connected the system carries about 100–150 Mbit/s of voice (about 340 kbit/s per
talking frame over both cuts, base64 included).

## Knobs (frame-sim environment)

| Variable | Default | |
|---|---|---|
| `SIM_VOICE` | on | `off` silences the simulator |
| `SIM_VOICE_FAULTS` | 0.05 | share of chunks damaged or dropped in transit |
| `SIM_VOICE_PACE` | 1.0 | 1 = real time; 0 sends as fast as possible |
| `SIM_VOICE_GAP_MS` | 600 | the breath between two sayings |
| `SIM_VOICE_DIR` | `/home/sim/voices` | where the simulator keeps its own WAVs |
| `SIM_HTTP` | caster host:8080 | where `/api/sites` (countries) is read from |

## API

| Method | Path | Result |
|---|---|---|
| GET | `/api/taps` | `Taps`: strips, faders, gains, accents, live rate |
| GET | `/api/taps/<frame>` | `TapStrip` |
| POST | `/api/gain` | `GainSet {frame,input,output,db}` → `GainEvent` |
| POST | `/api/taps/unity` | `TapsUnity {frame?}` → `TapsUnityResult {reset}` |
| GET | `/api/voices` | `VoiceSummary`: counters, live rate, newest saying per frame |
| GET | `/api/voices/<frame>` | `FrameVoice`: site, country, airport, accent, rate, ident, call, WAV paths |
| GET | `/voices/<frame>-<kind>.wav` | the re-assembled WAV (`audio/wav`) |
| GET | `/api/bandwidth` | `Bandwidth`: totals, by protocol, by frame, by trunk |
| GET | `/api/airports` | `[Airport]`: every site's IATA code and accent |

Rust: `HttpClient::{taps, tap_strip, set_crosspoint_gain, set_gain, taps_unity, voices, voice,
voice_wav, bandwidth, airports}`. TypeScript: `TYPESCRIPT/api` (typed routes, client, OpenAPI) and
`TYPESCRIPT/sdk/voice.ts` (the wave sender and re-assembler).

## Next

* Mix for real: let a TAPS fader scale the PCM of the voice crossing it, and play a frame's
  mix-minus in the browser.
* Codecs: send G.711 or Opus instead of 16-bit PCM and compare the bandwidth.
* A capacity model: a trunk channel's budget in kbit/s, and red trunks when the voice exceeds it.
