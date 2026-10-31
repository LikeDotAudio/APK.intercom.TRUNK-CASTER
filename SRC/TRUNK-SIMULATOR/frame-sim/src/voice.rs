//! The simulator's voice: every frame has its own speaker, and they all
//! talk at the same time. A frame says what it is (country, site, frame,
//! airport, protocol) when it is first hosted, then, the whole time it is
//! connected, says its connections over and over, from and to, one after
//! another. A frame with no connection is silent, so the voice traffic is
//! the real load of the calls: the caster meters it as the bandwidth
//! simulation.
//!
//! Each frame speaks English in the accent of its country (`accent_of`),
//! with its own variant. Speech comes from `espeak-ng` (a tone sketch of
//! the words when it is missing), the newest of each kind is kept as a WAV
//! under `SIM_VOICE_DIR`, and everything goes out through the wave sender:
//! cut into 1-second and 5-second chunks sent at the same time on two
//! topics, over a broker connection of its own so the voice never queues
//! behind the crosspoint lines.
//!
//! `SIM_VOICE_FAULTS` (default 0.05) damages or drops that share of chunks
//! on the way out, so the caster's correction has something to do.
//! `SIM_VOICE_GAP_MS` (default 600) is the breath between two sayings.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use trunk_caster_sdk::mqtt::Link;
use trunk_caster_sdk::sites::{airport_of, continent_of};
use trunk_caster_sdk::voice::{self, RATE};

/// What a site is, for saying it.
#[derive(Clone, Default)]
struct Place {
    country: String,
    continent: String,
}

/// One frame's speaker: what it has left to say.
#[derive(Default)]
struct Speaker {
    site: String,
    ident: Option<String>,
    /// Live connections by the user port they came in on.
    calls: BTreeMap<String, String>,
    /// Round robin over `calls`.
    turn: usize,
}

struct Shared {
    speakers: Mutex<BTreeMap<String, Speaker>>,
    wake: Condvar,
    places: Mutex<BTreeMap<String, Place>>,
    /// Synthesised sayings, by voice and text.
    said: Mutex<HashMap<(String, String), Arc<Vec<i16>>>>,
    bytes_out: AtomicU64,
}

#[derive(Clone)]
pub struct Voice {
    protocol: String,
    host: String,
    http: String,
    dir: PathBuf,
    faults: f64,
    pace: f64,
    gap: Duration,
    link: Option<Link>,
    shared: Arc<Shared>,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

impl Voice {
    /// None when `SIM_VOICE=off`. The voice opens its own connection to
    /// `broker`.
    pub fn start(protocol: &str, host: &str, caster: &str, broker: Option<&str>) -> Option<Voice> {
        if env("SIM_VOICE").is_some_and(|v| v == "off") {
            return None;
        }
        let http = env("SIM_HTTP").unwrap_or_else(|| format!("{}:8080", caster.rsplit_once(':').map(|(h, _)| h).unwrap_or(caster)));
        let link = broker.map(|b| Link::start(b, &format!("voice-{host}"), Vec::new()));
        let v = Voice {
            protocol: protocol.into(),
            host: host.into(),
            http,
            dir: PathBuf::from(env("SIM_VOICE_DIR").unwrap_or_else(|| "/tmp/voices".into())),
            faults: env("SIM_VOICE_FAULTS").and_then(|v| v.parse().ok()).unwrap_or(0.05f64).clamp(0.0, 0.9),
            pace: env("SIM_VOICE_PACE").and_then(|v| v.parse().ok()).unwrap_or(1.0f64).clamp(0.0, 10.0),
            gap: Duration::from_millis(env("SIM_VOICE_GAP_MS").and_then(|v| v.parse().ok()).unwrap_or(600)),
            link,
            shared: Arc::new(Shared {
                speakers: Mutex::new(BTreeMap::new()),
                wake: Condvar::new(),
                places: Mutex::new(BTreeMap::new()),
                said: Mutex::new(HashMap::new()),
                bytes_out: AtomicU64::new(0),
            }),
        };
        let _ = std::fs::create_dir_all(&v.dir);
        eprintln!(
            "voice: a speaker per frame, all at once; espeak-ng {}; sites from http://{}/api/sites; {:.0}% of chunks damaged in transit",
            if espeak_ok() { "found" } else { "missing (tones)" },
            v.http,
            v.faults * 100.0
        );
        let me = v.clone();
        thread::spawn(move || me.report());
        Some(v)
    }

    fn speakers(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Speaker>> {
        self.shared.speakers.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A frame came up: give it a speaker, which first says what it is.
    pub fn ident(&self, frame: &str, site: &str) {
        if self.speakers().contains_key(frame) {
            return;
        }
        let p = self.place(site);
        let ident = format!(
            "This is frame {}. {}, {}, {}. Airport {}. {} protocol, simulator {}.",
            say_id(frame),
            site,
            p.country,
            p.continent,
            voice::spell(&airport_of(site)),
            say_id(&self.protocol),
            say_id(&self.host)
        );
        let mut sp = self.speakers();
        if sp.contains_key(frame) {
            return;
        }
        sp.insert(frame.into(), Speaker { site: site.into(), ident: Some(ident), ..Default::default() });
        drop(sp);
        let me = self.clone();
        let frame = frame.to_string();
        thread::spawn(move || me.speak_for(&frame));
    }

    /// A connection was made through this frame: it is said, from and to,
    /// for as long as it lasts.
    #[allow(clippy::too_many_arguments)]
    pub fn call(&self, frame: &str, site: &str, port: &str, name: &str, far_frame: &str, far_site: &str, far_port: &str, far_name: &str) {
        let (a, b) = (self.place(site), self.place(far_site));
        let text = format!(
            "Connection from {}, on {} {}, {}, {}, airport {}. To {}, on {} {}, {}, {}, airport {}.",
            name,
            say_id(frame),
            say_port(port),
            site,
            a.country,
            voice::spell(&airport_of(site)),
            far_name,
            say_id(far_frame),
            say_port(far_port),
            far_site,
            b.country,
            voice::spell(&airport_of(far_site)),
        );
        if let Some(s) = self.speakers().get_mut(frame) {
            s.calls.insert(port.into(), text);
        }
        self.shared.wake.notify_all();
    }

    /// The connection on `port` ended: stop saying it.
    pub fn hangup(&self, frame: &str, port: &str) {
        if let Some(s) = self.speakers().get_mut(frame) {
            s.calls.remove(port);
        }
    }

    /// The caster is about to resend the full state: forget the calls, the
    /// ones still live come back with it.
    pub fn reset_calls(&self) {
        for s in self.speakers().values_mut() {
            s.calls.clear();
        }
    }

    fn place(&self, site: &str) -> Place {
        let mut places = self.shared.places.lock().unwrap_or_else(|e| e.into_inner());
        if places.is_empty() {
            *places = fetch_places(&self.http).unwrap_or_else(|| {
                trunk_caster_sdk::sites::Sites::default()
                    .sites
                    .into_iter()
                    .map(|s| (s.name.clone(), Place { continent: continent_of(&s.country).into(), country: s.country }))
                    .collect()
            });
        }
        places.get(site).cloned().unwrap_or_else(|| Place { country: "unknown country".into(), continent: "unknown continent".into() })
    }

    /// One frame's speaker, forever: its ident, then its live connections
    /// round robin, silent while it has none.
    fn speak_for(self, frame: &str) {
        let mut rng = seed(frame);
        loop {
            let (kind, text, site) = {
                let mut sp = self.speakers();
                loop {
                    let Some(s) = sp.get_mut(frame) else { return };
                    if let Some(t) = s.ident.take() {
                        break ("ident", t, s.site.clone());
                    }
                    if !s.calls.is_empty() {
                        s.turn = (s.turn + 1) % s.calls.len();
                        let t = s.calls.values().nth(s.turn).cloned().unwrap_or_default();
                        break ("call", t, s.site.clone());
                    }
                    sp = self.shared.wake.wait_timeout(sp, Duration::from_secs(2)).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
                }
            };
            let accent = voice::accent_of(&self.place(&site).country, &site, frame);
            let pcm = self.synth(&accent, &text, frame, kind);
            self.send(frame, kind, &text, &pcm, &mut rng);
            thread::sleep(self.gap);
        }
    }

    /// Speech for `text` in `accent`, made once and kept.
    fn synth(&self, accent: &str, text: &str, frame: &str, kind: &str) -> Arc<Vec<i16>> {
        let key = (accent.to_string(), text.to_string());
        if let Some(p) = self.shared.said.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return p.clone();
        }
        let pcm = Arc::new(speak(accent, text));
        let _ = std::fs::write(self.dir.join(format!("{frame}-{kind}.wav")), voice::wav_encode(&pcm, RATE));
        let mut said = self.shared.said.lock().unwrap_or_else(|e| e.into_inner());
        if said.len() > 4000 {
            said.clear();
        }
        said.insert(key, pcm.clone());
        pcm
    }

    /// The wave sender: both cuts at the same time, each chunk sent as its
    /// audio has played out (scaled by SIM_VOICE_PACE).
    fn send(&self, frame: &str, kind: &str, text: &str, pcm: &[i16], rng: &mut u64) {
        let Some(link) = &self.link else {
            thread::sleep(Duration::from_secs_f64(pcm.len() as f64 / RATE as f64 * self.pace));
            return;
        };
        let id = format!("{kind}-{}", now_ms());
        let t = Instant::now();
        let senders: Vec<_> = voice::CUTS
            .iter()
            .map(|&cut| {
                let chunks = voice::cut(&id, kind, text, pcm, RATE, cut);
                let topic = voice::topic(&self.protocol, frame, cut);
                let (link, pace, faults, shared) = (link.clone(), self.pace, self.faults, self.shared.clone());
                let mut rng = next_u64(rng) ^ cut as u64;
                thread::spawn(move || {
                    for mut c in chunks {
                        let due = Duration::from_secs_f64((c.index * cut * RATE as usize + c.pcm.len()) as f64 / RATE as f64 * pace);
                        if let Some(w) = due.checked_sub(t.elapsed()) {
                            thread::sleep(w);
                        }
                        let roll = next(&mut rng);
                        if roll < faults / 2.0 {
                            continue; // dropped on the way
                        }
                        if roll < faults && !c.pcm.is_empty() {
                            let i = (next(&mut rng) * c.pcm.len() as f64) as usize % c.pcm.len();
                            c.pcm[i] ^= 0x2A5; // damaged on the way
                        }
                        c.sent_ms = t.elapsed().as_millis() as u64;
                        let payload = c.encode();
                        if link.publish(&topic, &payload) {
                            shared.bytes_out.fetch_add(payload.len() as u64, Ordering::Relaxed);
                        }
                    }
                })
            })
            .collect();
        for h in senders {
            let _ = h.join();
        }
    }

    /// Every 30 s: how many frames are talking and what they put on the wire.
    fn report(self) {
        let mut last = (Instant::now(), 0u64);
        loop {
            thread::sleep(Duration::from_secs(30));
            let bytes = self.shared.bytes_out.load(Ordering::Relaxed);
            let secs = last.0.elapsed().as_secs_f64().max(1.0);
            let (frames, talking) = {
                let sp = self.speakers();
                (sp.len(), sp.values().filter(|s| !s.calls.is_empty()).count())
            };
            eprintln!(
                "voice: {talking} of {frames} frames connected and talking, {:.0} kbit/s on the wire over both cuts",
                (bytes - last.1) as f64 * 8.0 / 1000.0 / secs
            );
            last = (Instant::now(), bytes);
        }
    }
}

/// "dante-01" → "dante 01": said as words and digits, not a minus sign.
fn say_id(id: &str) -> String {
    id.replace(['-', '_'], " ")
}

/// "U03" → "user port 3", "C2" → "caster 2".
fn say_port(p: &str) -> String {
    match (p.get(..1), p.get(1..).and_then(|n| n.parse::<usize>().ok())) {
        (Some("U"), Some(n)) => format!("user port {n}"),
        (Some("C"), Some(n)) => format!("caster {n}"),
        _ => p.to_string(),
    }
}

fn espeak_ok() -> bool {
    Command::new("espeak-ng").arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Speak `text` in `accent` at the voice rate; the plain voice when the
/// accent is not installed.
fn speak(accent: &str, text: &str) -> Vec<i16> {
    for v in [accent, "en-us"] {
        if let Ok(o) = Command::new("espeak-ng").args(["-v", v, "-s", "165", "--stdout", text]).output() {
            if let Some((pcm, rate)) = voice::wav_decode(&o.stdout).filter(|(p, _)| !p.is_empty()) {
                return voice::resample(&pcm, rate, RATE);
            }
        }
    }
    tones(text)
}

/// No speech engine: one short tone per character, pitched by the letter.
fn tones(text: &str) -> Vec<i16> {
    let step = RATE as usize / 12;
    let mut out = Vec::new();
    for ch in text.chars() {
        let f = if ch.is_alphanumeric() { 300.0 + (ch.to_ascii_lowercase() as u32 % 40) as f64 * 25.0 } else { 0.0 };
        for i in 0..step {
            let env = (i.min(step - i) as f64 / 80.0).min(1.0);
            out.push((f64::sin(std::f64::consts::TAU * f * i as f64 / RATE as f64) * 6000.0 * env) as i16);
        }
    }
    out
}

/// Site name → country and continent, from the caster's `/api/sites`.
fn fetch_places(http: &str) -> Option<BTreeMap<String, Place>> {
    let mut s = TcpStream::connect(http).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(s, "GET /api/sites HTTP/1.0\r\nHost: {http}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.split_once("\r\n\r\n")?.1;
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let out: BTreeMap<String, Place> = v["sites"]
        .as_array()?
        .iter()
        .filter_map(|s| {
            let country = s["country"].as_str()?.to_string();
            let continent = s["continent"].as_str().filter(|c| !c.is_empty()).map(str::to_string).unwrap_or_else(|| continent_of(&country).to_string());
            Some((s["name"].as_str()?.to_string(), Place { country, continent }))
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn seed(frame: &str) -> u64 {
    ((now_ms() as u64) ^ ((voice::crc32(frame.as_bytes()) as u64) << 32)) | 1
}

fn next_u64(x: &mut u64) -> u64 {
    *x ^= *x << 13;
    *x ^= *x >> 7;
    *x ^= *x << 17;
    *x
}

fn next(x: &mut u64) -> f64 {
    (next_u64(x) >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_for_ids_and_ports() {
        assert_eq!(say_id("dante-01"), "dante 01");
        assert_eq!(say_port("U03"), "user port 3");
        assert_eq!(say_port("C2"), "caster 2");
        assert!(!tones("ab").is_empty());
    }
}
