//! TRUNK-USAGE/voices: the frames' voices, re-assembled, and the bandwidth
//! they take.
//!
//! Every simulator frame talks at once: it says what it is, then says its
//! connections for as long as it is connected, through the wave sender's two
//! cuts (1-second and 5-second chunks sent at the same time, see
//! `trunk_caster_sdk::voice`). The caster listens on a broker connection of
//! its own, in its own thread, so the voice load never slows the crosspoint
//! lines or the runtime. Chunks of both cuts are put back together second by
//! second, damaged or missing seconds corrected from the other cut, and the
//! newest recording of each frame is kept as `<frame>-ident.wav` and
//! `<frame>-call.wav`, with a line in `voices.jsonl` whenever what a frame
//! says changes.
//!
//! Every byte heard is metered per frame and per protocol: the bandwidth
//! simulation. The Overlord spreads each frame's rate over the trunks its
//! calls cross.

use crate::routing::State;
use crate::util;
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use trunk_caster_sdk::mqtt;
use trunk_caster_sdk::voice::{self, Assembled, Reassembler};
use trunk_caster_sdk::{Bandwidth, FrameLoad, FrameVoice, ProtocolLoad, TrunkLoad, VoiceSummary};

/// Seconds of history a meter averages over.
pub const WINDOW_S: u64 = 10;

/// Bytes per second over the last `WINDOW_S` seconds.
#[derive(Default, Clone)]
pub struct Meter {
    buckets: VecDeque<(u64, u64)>,
    pub total: u64,
}

impl Meter {
    fn add(&mut self, sec: u64, bytes: u64) {
        self.total += bytes;
        match self.buckets.back_mut() {
            Some((s, b)) if *s == sec => *b += bytes,
            _ => self.buckets.push_back((sec, bytes)),
        }
        while self.buckets.front().is_some_and(|(s, _)| *s + WINDOW_S < sec) {
            self.buckets.pop_front();
        }
    }

    /// kbit/s on the wire, over the whole seconds of the window.
    pub fn kbps(&self, now: u64) -> f64 {
        let b: u64 = self.buckets.iter().filter(|(s, _)| *s < now && *s + WINDOW_S >= now).map(|(_, b)| b).sum();
        b as f64 * 8.0 / 1000.0 / WINDOW_S as f64
    }
}

pub struct Voices {
    dir: PathBuf,
    started: Instant,
    reassembler: Reassembler,
    /// Newest recording per `frame|kind`.
    pub latest: BTreeMap<String, Assembled>,
    pub recent: VecDeque<Assembled>,
    pub chunks_in: u64,
    pub bad_chunks: u64,
    pub recordings: u64,
    pub corrected_s: u64,
    pub lost_s: u64,
    pub link: Option<mqtt::LinkStats>,
    pub by_frame: BTreeMap<String, Meter>,
    pub by_protocol: BTreeMap<String, Meter>,
    pub all: Meter,
}

/// The caster's voice: shared between its listener thread and the pages.
pub type SharedVoices = Arc<Mutex<Voices>>;

impl Voices {
    /// Picks up where the last run left off: the newest recording of each
    /// frame from `voices.jsonl`, where its WAV is still on disk.
    pub fn new(dir: PathBuf) -> Self {
        let mut latest = BTreeMap::new();
        if let Ok(text) = std::fs::read_to_string(dir.join("voices.jsonl")) {
            for a in text.lines().filter_map(|l| serde_json::from_str::<Assembled>(l).ok()) {
                latest.insert(format!("{}|{}", a.frame, a.kind), a);
            }
        }
        // One look at the disk per recording, not per line of the log.
        latest.retain(|_, a: &mut Assembled| dir.join(file_name(&a.frame, &a.kind)).exists());
        Voices {
            dir,
            started: Instant::now(),
            reassembler: Reassembler::new(Duration::from_secs(4)),
            latest,
            recent: VecDeque::new(),
            chunks_in: 0,
            bad_chunks: 0,
            recordings: 0,
            corrected_s: 0,
            lost_s: 0,
            link: None,
            by_frame: BTreeMap::new(),
            by_protocol: BTreeMap::new(),
            all: Meter::default(),
        }
    }

    /// Listen for both cuts of every frame on a broker connection of its own.
    pub fn listen(me: &SharedVoices, broker: &str, client_id: &str) {
        let filters = voice::CUTS.iter().map(|c| format!("{}/+/+/voice{c}", mqtt::ROOT)).collect();
        let link = mqtt::Link::start(broker, client_id, filters);
        let me = me.clone();
        thread::spawn(move || loop {
            let msgs = link.drain();
            if msgs.is_empty() {
                thread::sleep(Duration::from_millis(40));
            }
            let mut v = me.lock().unwrap_or_else(|e| e.into_inner());
            v.link = Some(link.stats());
            v.take(msgs);
        });
    }

    /// Seconds since the caster started, the meters' clock.
    pub fn now_s(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    /// Take the chunks heard (topic, payload) and keep every recording they
    /// complete.
    pub fn take(&mut self, msgs: Vec<(String, String)>) {
        let sec = self.now_s();
        for (topic, payload) in msgs {
            let Some((proto, frame, _)) = mqtt::parse_topic(&topic) else { continue };
            self.chunks_in += 1;
            let n = (topic.len() + payload.len()) as u64;
            self.all.add(sec, n);
            self.by_protocol.entry(proto.to_string()).or_default().add(sec, n);
            self.by_frame.entry(frame.to_string()).or_default().add(sec, n);
            if !self.reassembler.offer(frame, &payload) {
                self.bad_chunks += 1;
            }
        }
        for mut a in self.reassembler.ready() {
            a.at = util::now_iso();
            self.recordings += 1;
            self.corrected_s += a.corrected_from_5s as u64;
            self.lost_s += a.lost as u64;
            let key = format!("{}|{}", a.frame, a.kind);
            // A frame repeats itself the whole time it is connected: the
            // file and the log change only when what it says changes (or a
            // clean take replaces one that lost seconds).
            let changed = self.latest.get(&key).is_none_or(|l| l.text != a.text || (l.lost > 0 && a.lost == 0));
            if changed {
                let _ = std::fs::create_dir_all(&self.dir);
                let _ = std::fs::write(self.dir.join(file_name(&a.frame, &a.kind)), voice::wav_encode(&a.pcm, a.rate));
            }
            a.pcm = Vec::new();
            if changed {
                if let Ok(j) = serde_json::to_string(&a) {
                    let _ = util::append_line_capped(&self.dir.join("voices.jsonl"), &j, util::LOG_CAP);
                }
            }
            self.recent.push_back(a.clone());
            if self.recent.len() > 200 {
                self.recent.pop_front();
            }
            self.latest.insert(key, a);
        }
    }

    pub fn of(&self, frame: &str, kind: &str) -> Option<&Assembled> {
        self.latest.get(&format!("{frame}|{kind}"))
    }

    /// kbit/s a frame is talking at right now.
    pub fn frame_kbps(&self, frame: &str) -> f64 {
        self.by_frame.get(frame).map(|m| m.kbps(self.now_s())).unwrap_or(0.0)
    }

    /// The WAV for `<frame>-<kind>.wav`, when one was heard.
    pub fn wav(&self, name: &str) -> Option<Vec<u8>> {
        let ok = name.ends_with(".wav") && !name.contains(['/', '\\']) && !name.contains("..");
        ok.then(|| std::fs::read(self.dir.join(name)).ok()).flatten()
    }

    pub fn waiting(&self) -> usize {
        self.reassembler.waiting()
    }

    pub fn talking(&self) -> usize {
        let now = self.now_s();
        self.by_frame.values().filter(|m| m.kbps(now) > 0.0).count()
    }

    /// `GET /api/voices`.
    pub fn summary(&self) -> VoiceSummary {
        let now = self.now_s();
        VoiceSummary {
            chunks_in: self.chunks_in,
            bad_chunks: self.bad_chunks,
            recordings: self.recordings,
            corrected_seconds: self.corrected_s,
            lost_seconds: self.lost_s,
            waiting: self.waiting(),
            kbps: self.all.kbps(now),
            talking: self.talking(),
            by_protocol_kbps: self.by_protocol.iter().map(|(p, m)| (p.clone(), m.kbps(now))).collect(),
            link: self.link.clone(),
            latest: self.latest.values().cloned().collect(),
        }
    }

    /// `GET /api/voices/<frame>`; None for a frame the caster does not know.
    pub fn frame_voice(&self, st: &State, frame: &str) -> Option<FrameVoice> {
        let f = st.frame(frame)?;
        let country = f.country.clone().unwrap_or_default();
        let wav = |k: &str| self.of(frame, k).map(|_| format!("/voices/{}", file_name(frame, k)));
        Some(FrameVoice {
            frame: frame.into(),
            site: f.site.clone(),
            airport: trunk_caster_sdk::sites::airport_of(&f.site),
            accent: voice::accent_of(&country, &f.site, frame),
            country,
            kbps: self.frame_kbps(frame),
            bytes: self.by_frame.get(frame).map(|m| m.total).unwrap_or(0),
            ident: self.of(frame, "ident").cloned(),
            call: self.of(frame, "call").cloned(),
            ident_wav: wav("ident"),
            call_wav: wav("call"),
        })
    }

    /// The bandwidth simulation: the voice heard, by protocol and frame, and
    /// spread over the trunks its calls cross (a frame on several calls
    /// shares its one voice between them).
    pub fn bandwidth(&self, st: &State) -> Bandwidth {
        let now = self.now_s();
        let mut calls_of: BTreeMap<&str, usize> = BTreeMap::new();
        for c in &st.connections {
            *calls_of.entry(c.from_frame.as_str()).or_default() += 1;
            *calls_of.entry(c.to_frame.as_str()).or_default() += 1;
        }
        let share = |f: &str| self.frame_kbps(f) / calls_of.get(f).copied().unwrap_or(1).max(1) as f64;
        let mut trunks: BTreeMap<&str, (f64, usize)> = BTreeMap::new();
        for c in &st.connections {
            let k = share(&c.from_frame) + share(&c.to_frame);
            for h in &c.hops {
                let e = trunks.entry(h.trunk.as_str()).or_default();
                e.0 += k;
                e.1 += 1;
            }
        }
        let mut trunks: Vec<TrunkLoad> = trunks
            .into_iter()
            .map(|(id, (kbps, calls))| {
                let t = st.trunk(id);
                let capacity = t.map(|t| t.capacity).unwrap_or(0);
                TrunkLoad {
                    trunk: id.into(),
                    a_frame: t.map(|t| t.a_frame.clone()).unwrap_or_default(),
                    b_frame: t.map(|t| t.b_frame.clone()).unwrap_or_default(),
                    calls,
                    capacity,
                    kbps,
                    kbps_per_channel: kbps / capacity.max(1) as f64,
                }
            })
            .collect();
        trunks.sort_by(|a, b| b.kbps.total_cmp(&a.kbps));
        let protocol_of = |f: &str| st.frame(f).map(|f| f.protocol.clone()).unwrap_or_default();
        let mut frames: Vec<FrameLoad> = self
            .by_frame
            .iter()
            .map(|(f, m)| FrameLoad { frame: f.clone(), protocol: protocol_of(f), calls: calls_of.get(f.as_str()).copied().unwrap_or(0), kbps: m.kbps(now), bytes: m.total })
            .collect();
        frames.sort_by(|a, b| b.kbps.total_cmp(&a.kbps));
        let by_protocol = self
            .by_protocol
            .iter()
            .map(|(p, m)| ProtocolLoad { protocol: p.clone(), talking: frames.iter().filter(|f| &f.protocol == p && f.kbps > 0.0).count(), kbps: m.kbps(now), bytes: m.total })
            .collect();
        Bandwidth {
            window_s: WINDOW_S,
            kbps: self.all.kbps(now),
            carried_kbps: trunks.iter().map(|t| t.kbps).sum(),
            talking: self.talking(),
            bytes: self.all.total,
            by_protocol,
            frames,
            trunks,
        }
    }
}

pub fn file_name(frame: &str, kind: &str) -> String {
    format!("{frame}-{kind}.wav")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meter_averages_whole_seconds() {
        let mut m = Meter::default();
        for s in 0..20 {
            m.add(s, 1000);
        }
        assert_eq!(m.kbps(20), 8.0);
        assert_eq!(m.total, 20_000);
        assert_eq!(m.kbps(40), 0.0);
    }
}
