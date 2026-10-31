//! Voice: every simulator says who it is and what it is connected to.
//!
//! A frame's announcement ("frame dante-01, Boston, United States, airport
//! B O S" or "connection from … to …") is spoken into a WAV and handed to
//! the wave sender. The sender cuts the same audio twice, into 1-second and
//! 5-second chunks, and sends both cuts at the same time:
//!
//! ```text
//! trunk-caster/<protocol>/<frame>/voice1   1-second chunks
//! trunk-caster/<protocol>/<frame>/voice5   5-second chunks
//! payload: V1|<id>|<cut>|<index>|<total samples>|<rate>|<crc32>|<kind>|<text b64>|<pcm b64>|<sent ms>
//! ```
//!
//! Each chunk carries a CRC-32 of its samples. The receiver re-assembles
//! second by second: from the 1-second chunk when it arrived intact, else
//! from that second's slice of the 5-second chunk. A second is lost only
//! when both copies are, so a damaged or dropped chunk on one cut is
//! corrected from the other. Every chunk also carries the announcement's
//! text, so any one chunk names what the recording says.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// The voice rate: telephone quality, as an intercom line carries it.
pub const RATE: u32 = 8000;
/// The two cuts, in seconds.
pub const CUTS: [usize; 2] = [1, 5];

pub fn topic(protocol: &str, frame: &str, cut: usize) -> String {
    format!("{}/{protocol}/{frame}/voice{cut}", crate::mqtt::ROOT)
}

// ---------------------------------------------------------------------------
// CRC-32, base64, WAV
// ---------------------------------------------------------------------------

const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            k += 1;
        }
        t[i] = c;
        i += 1;
    }
    t
};

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in bytes {
        c = CRC_TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    !c
}

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

/// The espeak-ng voice a frame speaks English in: the accent of its
/// country (its city, where a city has its own), plus a variant picked by
/// the frame id, so two frames on one site do not sound the same. Japanese
/// and Hebrew voices spell English out letter by letter, so those countries
/// speak plain English.
pub fn accent_of(country: &str, site: &str, frame: &str) -> String {
    const VARIANTS: [&str; 12] = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "f1", "f2", "f3", "f4", "f5"];
    let h = crc32(frame.as_bytes()) as usize;
    format!("{}+{}", accent_base(country, site), VARIANTS[h % VARIANTS.len()])
}

/// The espeak-ng voice of a country (or of a city that has its own accent),
/// without the per-frame variant.
pub fn accent_base(country: &str, site: &str) -> &'static str {
    let c = country.to_lowercase();
    let s = site.to_lowercase();
    let is = |names: &[&str]| names.iter().any(|n| c.contains(n));
    if s.starts_with("new york") {
        "en-us-nyc"
    } else if s.starts_with("glasgow") || s.starts_with("scotland") {
        "en-gb-scotland"
    } else if s.starts_with("manchester") {
        "en-gb-x-gbclan"
    } else if s.starts_with("wales") || s.starts_with("northern ireland") {
        "en-gb-x-gbcwmd"
    } else if s.starts_with("hawaii") {
        "haw"
    } else if is(&["united states", "canada", "philippines", "japan"]) {
        "en-us"
    } else if is(&["united kingdom", "ireland", "australia", "new zealand", "singapore", "nigeria", "ghana", "israel"]) {
        "en-gb-x-rp"
    } else if is(&["jamaica", "cuba", "caribbean"]) {
        "en-029"
    } else if is(&["france", "morocco", "tunisia", "algeria"]) {
        "fr-fr"
    } else if is(&["belgium"]) {
        "fr-be"
    } else if is(&["switzerland"]) {
        "fr-ch"
    } else if is(&["germany", "austria", "luxembourg"]) {
        "de"
    } else if is(&["spain"]) {
        "es"
    } else if is(&["mexico", "argentina", "chile", "colombia", "peru", "venezuela", "uruguay", "bolivia", "ecuador", "paraguay", "guatemala", "costa rica", "panama"]) {
        "es-419"
    } else if is(&["brazil"]) {
        "pt-br"
    } else if is(&["portugal"]) {
        "pt"
    } else if is(&["italy"]) {
        "it"
    } else if is(&["netherlands"]) {
        "nl"
    } else if is(&["sweden"]) {
        "sv"
    } else if is(&["norway"]) {
        "nb"
    } else if is(&["denmark"]) {
        "da"
    } else if is(&["finland"]) {
        "fi"
    } else if is(&["iceland"]) {
        "is"
    } else if is(&["poland"]) {
        "pl"
    } else if is(&["czech"]) {
        "cs"
    } else if is(&["hungary"]) {
        "hu"
    } else if is(&["greece"]) {
        "el"
    } else if is(&["romania"]) {
        "ro"
    } else if is(&["croatia", "serbia"]) {
        "hr"
    } else if is(&["ukraine"]) {
        "uk"
    } else if is(&["russia"]) {
        "ru"
    } else if is(&["türkiye", "turkey"]) {
        "tr"
    } else if is(&["iran"]) {
        "fa"
    } else if is(&["saudi", "emirates", "qatar", "iraq", "kuwait", "jordan", "lebanon", "oman", "bahrain", "syria", "yemen", "egypt"]) {
        "ar"
    } else if is(&["india"]) {
        "hi"
    } else if is(&["pakistan"]) {
        "ur"
    } else if is(&["bangladesh"]) {
        "bn"
    } else if s.starts_with("hong kong") {
        "yue"
    } else if is(&["china", "taiwan"]) {
        "cmn"
    } else if is(&["korea"]) {
        "ko"
    } else if is(&["vietnam"]) {
        "vi"
    } else if is(&["thailand"]) {
        "th"
    } else if is(&["indonesia"]) {
        "id"
    } else if is(&["malaysia"]) {
        "ms"
    } else if is(&["kenya", "tanzania"]) {
        "sw"
    } else if is(&["south africa"]) {
        "af"
    } else if is(&["ethiopia"]) {
        "am"
    } else {
        "en-gb"
    }
}

fn pcm_bytes(pcm: &[i16]) -> Vec<u8> {
    pcm.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn pcm_of(bytes: &[u8]) -> Vec<i16> {
    bytes.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for ch in bytes.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// A 16-bit mono PCM WAV.
pub fn wav_encode(pcm: &[i16], rate: u32) -> Vec<u8> {
    let data = pcm_bytes(pcm);
    let mut w = Vec::with_capacity(44 + data.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(data.len() as u32).to_le_bytes());
    w.extend_from_slice(&data);
    w
}

/// Read a 16-bit PCM WAV (any rate, channels mixed down to mono). Tolerates
/// the 0xFFFFFFFF sizes a WAV streamed to stdout carries.
pub fn wav_decode(w: &[u8]) -> Option<(Vec<i16>, u32)> {
    if w.len() < 12 || &w[0..4] != b"RIFF" || &w[8..12] != b"WAVE" {
        return None;
    }
    let (mut i, mut rate, mut channels, mut bits) = (12usize, 0u32, 1usize, 16u16);
    while i + 8 <= w.len() {
        let id = &w[i..i + 4];
        let len = u32::from_le_bytes([w[i + 4], w[i + 5], w[i + 6], w[i + 7]]) as usize;
        let body = &w[i + 8..];
        if id == b"fmt " && body.len() >= 16 {
            channels = u16::from_le_bytes([body[2], body[3]]).max(1) as usize;
            rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            if bits != 16 || rate == 0 {
                return None;
            }
            let data = &body[..len.min(body.len()) & !1];
            let all = pcm_of(data);
            let mono = all.chunks(channels).map(|f| (f.iter().map(|&s| s as i32).sum::<i32>() / f.len() as i32) as i16).collect();
            return Some((mono, rate));
        }
        i += 8 + len + (len & 1);
    }
    None
}

/// Linear resampling to `to` Hz.
pub fn resample(pcm: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to || pcm.is_empty() {
        return pcm.to_vec();
    }
    let n = (pcm.len() as u64 * to as u64 / from as u64) as usize;
    (0..n)
        .map(|j| {
            let x = j as f64 * from as f64 / to as f64;
            let (k, f) = (x as usize, x.fract());
            let a = pcm[k.min(pcm.len() - 1)] as f64;
            let b = pcm[(k + 1).min(pcm.len() - 1)] as f64;
            (a + (b - a) * f) as i16
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Chunks: the wave sender's cuts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub id: String,
    /// 1 or 5: the cut's length in seconds.
    pub cut: usize,
    pub index: usize,
    pub total: usize,
    pub rate: u32,
    pub crc: u32,
    /// "ident" or "call".
    pub kind: String,
    pub text: String,
    pub pcm: Vec<i16>,
    /// When the sender sent it, in ms from the start of the recording's
    /// transmission.
    pub sent_ms: u64,
}

impl Chunk {
    pub fn intact(&self) -> bool {
        crc32(&pcm_bytes(&self.pcm)) == self.crc
    }

    pub fn encode(&self) -> String {
        format!(
            "V1|{}|{}|{}|{}|{}|{:08x}|{}|{}|{}|{}",
            self.id,
            self.cut,
            self.index,
            self.total,
            self.rate,
            self.crc,
            self.kind,
            b64_encode(self.text.as_bytes()),
            b64_encode(&pcm_bytes(&self.pcm)),
            self.sent_ms
        )
    }

    pub fn decode(s: &str) -> Option<Chunk> {
        let p: Vec<&str> = s.trim().split('|').collect();
        if !(10..=11).contains(&p.len()) || p[0] != "V1" {
            return None;
        }
        Some(Chunk {
            id: p[1].to_string(),
            cut: p[2].parse().ok()?,
            index: p[3].parse().ok()?,
            total: p[4].parse().ok()?,
            rate: p[5].parse().ok()?,
            crc: u32::from_str_radix(p[6], 16).ok()?,
            kind: p[7].to_string(),
            text: String::from_utf8(b64_decode(p[8])?).ok()?,
            pcm: pcm_of(&b64_decode(p[9])?),
            sent_ms: p.get(10).and_then(|v| v.parse().ok()).unwrap_or(0),
        })
    }
}

/// Cut one recording into `secs`-second chunks.
pub fn cut(id: &str, kind: &str, text: &str, pcm: &[i16], rate: u32, secs: usize) -> Vec<Chunk> {
    let step = rate as usize * secs;
    pcm.chunks(step.max(1))
        .enumerate()
        .map(|(index, s)| Chunk {
            id: id.into(),
            cut: secs,
            index,
            total: pcm.len(),
            rate,
            crc: crc32(&pcm_bytes(s)),
            kind: kind.into(),
            text: text.into(),
            pcm: s.to_vec(),
            sent_ms: 0,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Re-assembly with error correction
// ---------------------------------------------------------------------------

/// A recording put back together, with how each second was recovered.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Assembled {
    pub id: String,
    pub frame: String,
    pub kind: String,
    pub text: String,
    pub rate: u32,
    pub seconds: usize,
    /// Seconds taken from their 1-second chunk.
    pub from_1s: usize,
    /// Seconds corrected from the 5-second cut (their 1-second chunk was
    /// damaged or never came).
    pub corrected_from_5s: usize,
    /// Seconds lost on both cuts, filled with silence.
    pub lost: usize,
    /// Chunks that failed their CRC.
    pub damaged: usize,
    pub chunks: usize,
    /// How long the sender took over both cuts (the last chunk's send time).
    pub transmit_s: f64,
    pub at: String,
    #[serde(skip)]
    pub pcm: Vec<i16>,
}

struct Pending {
    frame: String,
    last: Instant,
    /// Each chunk with whether it passed its CRC (checked once, on arrival).
    chunks: BTreeMap<(usize, usize), (Chunk, bool)>,
    damaged: usize,
    meta: Chunk,
    /// A chunk arrived since `recoverable` was last asked.
    fresh: bool,
}

impl Pending {
    fn expected(&self, cut: usize) -> usize {
        self.meta.total.div_ceil(self.meta.rate as usize * cut)
    }

    /// Every second can be had from an intact copy on one cut or the other.
    fn recoverable(&self) -> bool {
        let rate = self.meta.rate as usize;
        let good = |cut: usize, i: usize| self.chunks.get(&(cut, i)).is_some_and(|c| c.1);
        CUTS.iter().all(|&c| self.expected(c) > 0) && (0..self.meta.total.div_ceil(rate)).all(|s| good(1, s) || good(5, s / 5))
    }

    fn assemble(self) -> Assembled {
        let rate = self.meta.rate as usize;
        let total = self.meta.total;
        let seconds = total.div_ceil(rate);
        let mut pcm = vec![0i16; total];
        let (mut from_1s, mut corrected, mut lost) = (0, 0, 0);
        for s in 0..seconds {
            let (a, b) = (s * rate, ((s + 1) * rate).min(total));
            if let Some((c, _)) = self.chunks.get(&(1, s)).filter(|(c, ok)| *ok && c.pcm.len() == b - a) {
                pcm[a..b].copy_from_slice(&c.pcm);
                from_1s += 1;
                continue;
            }
            let five = rate * 5;
            let off = a - (s / 5) * five;
            match self.chunks.get(&(5, s / 5)).filter(|(c, ok)| *ok && c.pcm.len() >= off + (b - a)) {
                Some((c, _)) => {
                    pcm[a..b].copy_from_slice(&c.pcm[off..off + (b - a)]);
                    corrected += 1;
                }
                None => lost += 1,
            }
        }
        Assembled {
            id: self.meta.id.clone(),
            frame: self.frame,
            kind: self.meta.kind.clone(),
            text: self.meta.text.clone(),
            rate: self.meta.rate,
            seconds,
            from_1s,
            corrected_from_5s: corrected,
            lost,
            damaged: self.damaged,
            chunks: self.chunks.len(),
            transmit_s: self.chunks.values().map(|(c, _)| c.sent_ms).max().unwrap_or(0) as f64 / 1000.0,
            at: String::new(),
            pcm,
        }
    }
}

/// Collects chunks from both cuts and hands back whole recordings: as soon
/// as every second can be recovered, or `idle` after the last chunk arrived
/// (the seconds still missing are then silence). Late chunks of a recording
/// already handed back are ignored.
pub struct Reassembler {
    idle: Duration,
    pending: BTreeMap<String, Pending>,
    done: std::collections::VecDeque<String>,
}

impl Reassembler {
    pub fn new(idle: Duration) -> Self {
        Reassembler { idle, pending: BTreeMap::new(), done: Default::default() }
    }

    /// Offer one chunk's payload, heard for `frame`. False when it does not parse.
    pub fn offer(&mut self, frame: &str, payload: &str) -> bool {
        let Some(c) = Chunk::decode(payload) else { return false };
        if c.rate == 0 || !CUTS.contains(&c.cut) {
            return false;
        }
        let now = Instant::now();
        let key = format!("{frame}|{}", c.id);
        if self.done.contains(&key) {
            return true;
        }
        let p = self.pending.entry(key).or_insert_with(|| Pending {
            frame: frame.to_string(),
            last: now,
            chunks: BTreeMap::new(),
            damaged: 0,
            meta: Chunk { pcm: Vec::new(), ..c.clone() },
            fresh: false,
        });
        p.last = now;
        p.fresh = true;
        let ok = c.intact();
        if !ok {
            p.damaged += 1;
        }
        p.chunks.insert((c.cut, c.index), (c, ok));
        true
    }

    /// Recordings that are whole, or have waited long enough.
    pub fn ready(&mut self) -> Vec<Assembled> {
        let now = Instant::now();
        let idle = self.idle;
        let done: Vec<String> = self
            .pending
            .iter_mut()
            .filter_map(|(k, p)| (std::mem::take(&mut p.fresh) && p.recoverable() || now.duration_since(p.last) > idle).then(|| k.clone()))
            .collect();
        for k in &done {
            self.done.push_back(k.clone());
            if self.done.len() > 512 {
                self.done.pop_front();
            }
        }
        done.into_iter().filter_map(|k| self.pending.remove(&k)).map(Pending::assemble).collect()
    }

    pub fn waiting(&self) -> usize {
        self.pending.len()
    }
}

/// Spell a code letter by letter so a speech engine says "B O S".
pub fn spell(code: &str) -> String {
    code.chars().map(|c| c.to_string()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(secs: f64) -> Vec<i16> {
        (0..(RATE as f64 * secs) as usize).map(|i| ((i as f64 * 0.07).sin() * 8000.0) as i16).collect()
    }

    #[test]
    fn base64_and_wav_round_trip() {
        for s in [&b""[..], b"a", b"ab", b"abc", b"hello world"] {
            assert_eq!(b64_decode(&b64_encode(s)).unwrap(), s);
        }
        let pcm = tone(0.3);
        assert_eq!(wav_decode(&wav_encode(&pcm, RATE)), Some((pcm, RATE)));
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn accents_follow_the_country() {
        assert!(accent_of("France", "Paris", "paris-01").starts_with("fr-fr+"));
        assert!(accent_of("United Kingdom", "Glasgow", "glasgow-02").starts_with("en-gb-scotland+"));
        assert!(accent_of("China", "Beijing", "beijing-01").starts_with("cmn+"));
        assert!(accent_of("Atlantis", "Nowhere", "x").starts_with("en-gb+"));
    }

    #[test]
    fn both_cuts_reassemble_and_correct() {
        let pcm = tone(7.4);
        let mut r = Reassembler::new(Duration::from_secs(60));
        let ones = cut("m1", "ident", "frame dante-01", &pcm, RATE, 1);
        let fives = cut("m1", "ident", "frame dante-01", &pcm, RATE, 5);
        assert_eq!((ones.len(), fives.len()), (8, 2));
        for (i, c) in ones.iter().enumerate() {
            let mut c = c.clone();
            if i == 2 {
                c.pcm[10] ^= 0x55; // damaged on the 1 s cut
            }
            if i != 6 {
                // second 6 never arrives on the 1 s cut
                assert!(r.offer("dante-01", &c.encode()));
            }
        }
        assert!(r.ready().is_empty());
        for c in &fives {
            r.offer("dante-01", &c.encode());
        }
        // A late copy of a recording already handed back starts nothing new.
        let a0 = r.ready();
        r.offer("dante-01", &ones[6].encode());
        assert!(r.ready().is_empty());
        let a = a0;
        assert_eq!(a.len(), 1);
        let a = &a[0];
        assert_eq!((a.seconds, a.from_1s, a.corrected_from_5s, a.lost, a.damaged), (8, 6, 2, 0, 1));
        assert_eq!(a.pcm, pcm);
        assert_eq!(a.text, "frame dante-01");
    }

    #[test]
    fn lost_on_both_cuts_is_silence() {
        let pcm = tone(2.0);
        let mut r = Reassembler::new(Duration::from_millis(0));
        r.offer("f", &cut("m2", "call", "x", &pcm, RATE, 1)[0].encode());
        std::thread::sleep(Duration::from_millis(2));
        let a = &r.ready()[0];
        assert_eq!((a.from_1s, a.corrected_from_5s, a.lost), (1, 0, 1));
    }
}
