//! Small shared helpers: wall clock, ISO timestamps, a dependency-free RNG,
//! and atomic JSON file I/O.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// UTC ISO-8601 timestamp (seconds precision) for a unix time.
pub fn iso(unix: u64) -> String {
    let days = unix / 86_400;
    let secs = unix % 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

pub fn now_iso() -> String {
    iso(now_unix())
}

// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// xorshift64* — deterministic, seedable, good enough for load simulation.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in [0, 1).
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform integer in [0, n). `n` must be > 0.
    pub fn below(&mut self, n: usize) -> usize {
        (self.f64() * n as f64) as usize % n
    }

    /// Exponentially distributed sample with the given mean.
    pub fn exponential(&mut self, mean: f64) -> f64 {
        let u = 1.0 - self.f64();
        -mean * u.ln()
    }
}

/// Pretty-print JSON to `path`, writing a temp file first so readers never
/// see a half-written document.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path).or_else(|_| {
        // Windows refuses rename over an open target; fall back to copy.
        fs::copy(&tmp, path).map(|_| ()).and_then(|_| fs::remove_file(&tmp))
    })
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<T> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|e| {
        io::Error::new(io::ErrorKind::InvalidData, format!("{}: {e}", path.display()))
    })
}

pub fn write_text(path: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path).or_else(|_| {
        fs::copy(&tmp, path).map(|_| ()).and_then(|_| fs::remove_file(&tmp))
    })
}

/// Append one line to a log, keeping the file under `max_bytes`: when it
/// grows past that, the file is rotated to `<name>.1` (replacing the previous
/// rotation) and a fresh one starts. Logs can never fill the disk.
pub fn append_line_capped(path: &Path, line: &str, max_bytes: u64) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > max_bytes {
            let rotated = path.with_extension(format!("{}.1", path.extension().and_then(|e| e.to_str()).unwrap_or("log")));
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(path, &rotated);
        }
    }
    use std::io::Write;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{line}")
}

/// Default cap for the append-only logs: 100 MB each, then rotated once
/// to `.1`, so a log never holds more than 200 MB on disk.
pub const LOG_CAP: u64 = 100 * 1024 * 1024;

/// Minimal HTML escaping for text nodes and attribute values.
pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_epoch_and_known_date() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        // 2026-10-20T12:00:00Z
        assert_eq!(iso(1_792_497_600), "2026-10-20T12:00:00Z");
    }

    #[test]
    fn rng_is_deterministic_and_bounded() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        for _ in 0..100 {
            let x = a.below(10);
            assert_eq!(x, b.below(10));
            assert!(x < 10);
        }
    }
}
