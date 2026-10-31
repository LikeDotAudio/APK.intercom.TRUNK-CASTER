//! Capture and analysis. A capture records telemetry between START and
//! STOP into `TRUNK-SIMULATOR/captures/<id>.json`; the analyzer summarizes
//! any capture or recorded run into hourly, half-hour and quarter-hour
//! check-ins so a 24-hour collection reads at a glance, offline.

use crate::util;
use std::fs;
use std::path::{Path, PathBuf};
use trunk_caster_sdk::folders::Layout;
use trunk_caster_sdk::{Bucket, Capture, CaptureBuckets, Fader, RunSummary, Sample, SimRun, WIRE_VERSION};

const MAX_CAPTURE_SAMPLES: usize = 40_000; // 24 h at a sample every 2 s

pub fn start(fader: &Fader, sim_time: f64, clock: &str, frames: usize, sites: usize, note: &str) -> Capture {
    let now = util::now_unix();
    let slug: String = note.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect::<String>().to_ascii_lowercase();
    Capture {
        wire_version: WIRE_VERSION,
        id: if slug.is_empty() { format!("capture-{now}") } else { format!("capture-{now}-{slug}") },
        note: note.to_string(),
        started_at: util::iso(now),
        started_sim: sim_time,
        started_clock: clock.to_string(),
        ended_at: None,
        ended_sim: None,
        fader: fader.clone(),
        frames,
        sites,
        summary: RunSummary::default(),
        buckets: CaptureBuckets::default(),
        samples: Vec::new(),
    }
}

/// Add a sample to a running capture.
pub fn record(c: &mut Capture, s: &Sample) {
    c.samples.push(s.clone());
    if c.samples.len() > MAX_CAPTURE_SAMPLES {
        c.samples.remove(0);
    }
}

/// Close a capture: summary and the three bucketings.
pub fn finish(c: &mut Capture, sim_time: f64) {
    c.ended_at = Some(util::now_iso());
    c.ended_sim = Some(sim_time);
    c.summary = summarize(&c.samples);
    c.buckets = buckets(&c.samples);
}

pub fn summarize(s: &[Sample]) -> RunSummary {
    let n = s.len().max(1) as f64;
    let (first, last) = (s.first(), s.last());
    let d = |f: fn(&Sample) -> u64| last.map(f).unwrap_or(0).saturating_sub(first.map(f).unwrap_or(0));
    RunSummary {
        samples: s.len(),
        duration_sim_seconds: last.map(|x| x.sim_time).unwrap_or(0.0) - first.map(|x| x.sim_time).unwrap_or(0.0),
        granted: d(|x| x.granted_total),
        granted_via: d(|x| x.granted_via_total),
        denied: d(|x| x.denied_total),
        released: d(|x| x.released_total),
        peak_live: s.iter().map(|x| x.active).max().unwrap_or(0),
        avg_live: s.iter().map(|x| x.active as f64).sum::<f64>() / n,
        peak_muted: s.iter().map(|x| x.muted).max().unwrap_or(0),
        avg_channel_utilization: s.iter().map(|x| x.channel_utilization).sum::<f64>() / n,
        max_channel_utilization: s.iter().map(|x| x.channel_utilization).fold(0.0, f64::max),
        avg_caster_utilization: s.iter().map(|x| x.caster_utilization).sum::<f64>() / n,
        crosschecks_failed: d(|x| x.crosschecks_failed),
        blackout_samples: s.iter().filter(|x| x.blackout).count(),
        ..Default::default()
    }
}

/// Bucket samples by a window width in simulated seconds, aligned to the
/// simulated day so the hour buckets start on the hour.
pub fn bucketize(s: &[Sample], width: f64) -> Vec<Bucket> {
    if s.is_empty() {
        return Vec::new();
    }
    // Align to time of day: a sample's window index is floor(tod / width),
    // and consecutive days are told apart by sim_time.
    let mut out: Vec<Bucket> = Vec::new();
    let mut cur: Vec<&Sample> = Vec::new();
    let key = |x: &Sample| ((x.sim_time - x.time_of_day) / 86_400.0).round() as i64 * 1000 + (x.time_of_day / width).floor() as i64;
    let mut cur_key = key(&s[0]);
    let flush = |cur: &Vec<&Sample>, out: &mut Vec<Bucket>| {
        if cur.is_empty() {
            return;
        }
        let n = cur.len() as f64;
        let first = cur[0];
        let tod_start = (first.time_of_day / width).floor() * width;
        let t = tod_start as u64 % 86_400;
        let span = |f: fn(&Sample) -> u64| cur.iter().map(|x| f(x)).max().unwrap_or(0).saturating_sub(cur.iter().map(|x| f(x)).min().unwrap_or(0));
        out.push(Bucket {
            start_sim: first.sim_time - (first.time_of_day - tod_start),
            clock: format!("{:02}:{:02}", t / 3600, (t % 3600) / 60),
            samples: cur.len(),
            avg_live: cur.iter().map(|x| x.active as f64).sum::<f64>() / n,
            peak_live: cur.iter().map(|x| x.active).max().unwrap_or(0),
            avg_muted: cur.iter().map(|x| x.muted as f64).sum::<f64>() / n,
            granted: span(|x| x.granted_total),
            denied: span(|x| x.denied_total),
            released: span(|x| x.released_total),
            avg_channel_utilization: cur.iter().map(|x| x.channel_utilization).sum::<f64>() / n,
            max_channel_utilization: cur.iter().map(|x| x.channel_utilization).fold(0.0, f64::max),
            avg_load: cur.iter().map(|x| x.load_multiplier).sum::<f64>() / n,
            blackout: cur.iter().any(|x| x.blackout),
            crosschecks_failed: span(|x| x.crosschecks_failed),
        });
    };
    for x in s {
        let k = key(x);
        if k != cur_key {
            flush(&cur, &mut out);
            cur.clear();
            cur_key = k;
        }
        cur.push(x);
    }
    flush(&cur, &mut out);
    out
}

pub fn buckets(s: &[Sample]) -> CaptureBuckets {
    CaptureBuckets { hour: bucketize(s, 3600.0), half_hour: bucketize(s, 1800.0), quarter_hour: bucketize(s, 900.0) }
}

pub fn path_for(layout: &Layout, id: &str) -> PathBuf {
    layout.captures_dir().join(format!("{}.json", id.replace(['/', '\\'], "_")))
}

/// Captures on disk, newest first, without their samples.
pub fn list(layout: &Layout) -> Vec<Capture> {
    let mut v: Vec<Capture> = match fs::read_dir(layout.captures_dir()) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |x| x == "json"))
            .filter_map(|p| util::read_json::<Capture>(&p).ok())
            .map(|mut c| {
                c.samples.clear();
                c
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    v
}

/// A capture or a recorded run, by id, with samples, as a Capture so the
/// analyzer treats them alike.
pub fn load(layout: &Layout, id: &str) -> Option<Capture> {
    let p = path_for(layout, id);
    if p.is_file() {
        return util::read_json::<Capture>(&p).ok().map(|mut c| {
            if c.buckets.hour.is_empty() {
                c.buckets = buckets(&c.samples);
            }
            if c.summary.samples == 0 {
                c.summary = summarize(&c.samples);
            }
            c
        });
    }
    let rp: &Path = &layout.runs_dir().join(format!("{}.json", id.replace(['/', '\\'], "_")));
    let run: SimRun = util::read_json(rp).ok()?;
    Some(Capture {
        wire_version: WIRE_VERSION,
        id: run.id.clone(),
        note: format!("run ({})", run.reason),
        started_at: run.started_at.clone(),
        started_sim: run.started_sim,
        started_clock: run.samples.first().map(|s| { let t = s.time_of_day as u64; format!("{:02}:{:02}", t / 3600, (t % 3600) / 60) }).unwrap_or_default(),
        ended_at: run.ended_at.clone(),
        ended_sim: run.ended_sim,
        fader: run.fader.clone(),
        frames: run.frames,
        sites: run.sites,
        summary: summarize(&run.samples),
        buckets: buckets(&run.samples),
        samples: run.samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(sim: f64, tod: f64, live: usize, granted: u64) -> Sample {
        Sample {
            sim_time: sim,
            wall_time: String::new(),
            active: live,
            active_via: 0,
            trunks: 0,
            granted_total: granted,
            granted_via_total: 0,
            denied_total: 0,
            released_total: 0,
            channel_utilization: 0.5,
            caster_utilization: 0.2,
            crosschecks_ok: 0,
            crosschecks_failed: 0,
            time_of_day: tod,
            load_multiplier: 1.0,
            muted: 0,
            blackout: false,
            continents: Default::default(),
            ..Default::default()
        }
    }

    #[test]
    fn hour_buckets_start_on_the_hour_and_count_grants() {
        // 06:50 to 08:10, one sample every ten simulated minutes.
        let mut s = Vec::new();
        for i in 0..9 {
            let tod = 6.0 * 3600.0 + 50.0 * 60.0 + i as f64 * 600.0;
            s.push(sample(1000.0 + i as f64 * 600.0, tod, 10 + i, 100 + i as u64 * 5));
        }
        let h = bucketize(&s, 3600.0);
        assert_eq!(h.iter().map(|b| b.clock.as_str()).collect::<Vec<_>>(), vec!["06:00", "07:00", "08:00"]);
        assert_eq!(h[1].samples, 6);
        assert_eq!(h[1].granted, 25);
        assert_eq!(h[1].peak_live, 16);
        let q = bucketize(&s, 900.0);
        assert_eq!(q[0].clock, "06:45");
        assert_eq!(bucketize(&s, 1800.0)[0].clock, "06:30");
    }
}
