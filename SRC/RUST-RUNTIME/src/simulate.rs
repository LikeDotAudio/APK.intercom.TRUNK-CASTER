//! `trunk-caster simulate`: run the caster headless and flat out for days of
//! simulated time, recording the telemetry the pages would have streamed, so
//! a static site can replay a whole year as if it were live.
//!
//! The run happens in a scratch root (the manuals and the configuration are
//! copied in), so the folders of a caster that is serving are never touched.
//! Each tick advances the clock exactly as the live loop does at the fader's
//! speed, so the recorded year behaves like the live caster would have.
//!
//! Output, in `--out`:
//!   index.json      { build, site, generated, days, every, frames }
//!   day-000.json    [ { "s": <status frame>, "g": <globe-delta frame> }, ... ]
//!   ...             one file per simulated day, `86400 / every` frames each
//!
//! The daily reset clears every line and trunk once a simulated day, so
//! days are independent: `--first-day` lets several processes each run a
//! slice of the year into the same folder. `index.json` counts the day
//! files present when a run finishes, so the last slice to finish writes
//! the whole year's index.

use crate::runtime::Runtime;
use crate::util;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;
use trunk_caster_sdk::folders::Layout;
use trunk_caster_sdk::*;

pub struct SimOpts {
    pub days: u32,
    /// Number of the first day this run writes (its weekday and season).
    pub first_day: u32,
    /// Simulated seconds between recorded frames.
    pub every: f64,
    /// Wall-clock milliseconds the live loop would spend per tick.
    pub tick_ms: u64,
    pub out: PathBuf,
    /// Demand profile for the run instead of the caster's own fader file.
    pub fader: Option<PathBuf>,
}

pub fn run(src: &Layout, shape: Shape, endpoint: String, site: String, o: &SimOpts) -> io::Result<()> {
    let scratch = std::env::temp_dir().join(format!("trunk-caster-sim-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    let dst = Layout::new(&scratch);
    copy_dir(&src.known_protocols(), &dst.known_protocols())?;
    for (from, to) in [
        (src.sites(), dst.sites()),
        (src.globe_config(), dst.globe_config()),
        (src.regions_json(), dst.regions_json()),
        (src.fader(), dst.fader()),
        (src.vendor_policy(), dst.vendor_policy()),
        (src.relay_config(), dst.relay_config()),
        (src.crosspoint_settings(), dst.crosspoint_settings()),
    ] {
        if from.is_file() {
            if let Some(p) = to.parent() {
                fs::create_dir_all(p)?;
            }
            fs::copy(&from, &to)?;
        }
    }
    let base: Fader = util::read_json(o.fader.as_deref().unwrap_or(&src.fader()))?;
    fs::create_dir_all(&o.out)?;

    let mut rt = Runtime::boot(dst.clone(), shape, endpoint, site.clone())?;
    rt.headless = true;
    // Frames are written as positions in this list (index.json "fleet").
    let fleet: Vec<String> = rt.state.frames.iter().map(|f| f.id.clone()).collect();
    let at: HashMap<&str, usize> = fleet.iter().enumerate().map(|(i, f)| (f.as_str(), i)).collect();
    let speed = if base.speed > 0.0 { base.speed } else { 60.0 };
    let wall_dt = o.tick_ms.max(20) as f64 / 1000.0;
    let t0 = rt.sim_time;
    let end = t0 + o.days as f64 * 86400.0;
    let per_day = (86400.0 / o.every).round() as usize;
    let mut next_frame = t0;
    let mut day: Vec<serde_json::Value> = Vec::with_capacity(per_day);
    let mut day_no = 0u32;
    let started = Instant::now();
    eprintln!(
        "simulating {} day(s) at {speed}x, {:.0} sim s per tick, a frame every {:.0} sim s, into {}",
        o.days,
        wall_dt * speed,
        o.every,
        o.out.display()
    );
    set_day(&dst, &base, o.first_day)?;
    while rt.sim_time < end {
        rt.tick(wall_dt)?;
        // Headless: the per-call records and folder files a tick queues are
        // not needed for the replay; dropping them keeps a year to minutes.
        let _ = rt.take_writes();
        if rt.sim_time >= next_frame {
            day.push(frame(&mut rt, &at, day.len(), o.every));
            next_frame += o.every;
        }
        let d = ((rt.sim_time - t0) / 86400.0).floor() as u32;
        if d > day_no || rt.sim_time >= end {
            // Compact: a year of frames has to fit on a static site.
            fs::write(o.out.join(format!("day-{:03}.json", o.first_day + day_no)), serde_json::to_string(&day)?)?;
            eprintln!("day {:>3}/{}: {} frames, {:.0}s so far", day_no + 1, o.days, day.len(), started.elapsed().as_secs_f64());
            day.clear();
            day_no = d;
            if day_no < o.days {
                set_day(&dst, &base, o.first_day + day_no)?;
            }
        }
    }
    // Days 0..n with no gaps, whichever runs wrote them.
    let mut days = 0u32;
    while o.out.join(format!("day-{days:03}.json")).is_file() {
        days += 1;
    }
    util::write_json(
        &o.out.join("index.json"),
        &serde_json::json!({
            "build": env!("TC_BUILD"),
            "site": site,
            "generated": util::now_iso(),
            "days": days,
            "fleet": fleet,
            "cap": shape.channels_per_trunk,
            "every": o.every,
            "frames": per_day,
        }),
    )?;
    let _ = fs::remove_dir_all(&scratch);
    eprintln!("done: {} day(s) in {:.0}s", o.days, started.elapsed().as_secs_f64());
    Ok(())
}

/// Calls kept per recorded frame (the live stream sends up to 1000).
const CALLS: usize = 300;

/// One recorded frame: the status and globe messages, slimmed to what the
/// pages draw. The globe's slow parts (trend history, clusters) ride only
/// on a day's first frame; the player applies that frame first on a new day.
fn frame(rt: &mut Runtime, at: &HashMap<&str, usize>, n: usize, every: f64) -> serde_json::Value {
    let first_of_day = n == 0;
    let cap = rt.state.shape.channels_per_trunk;
    let pos = |v: &serde_json::Value| v.as_str().and_then(|f| at.get(f)).map_or(serde_json::Value::Null, |i| serde_json::json!(i));
    let mut s = rt.status_message();
    if let Some(m) = s.as_object_mut() {
        for k in ["build", "dirty"] {
            m.remove(k);
        }
        for (k, keep) in [("lines", 12), ("log", 6), ("wardbeck", 4)] {
            if let Some(serde_json::Value::Array(a)) = m.get_mut(k) {
                a.truncate(keep);
            }
        }
    }
    let mut g = rt.globe_message();
    if let Some(m) = g.as_object_mut() {
        m.remove("last");
        // Calls: the dots on the globe and their tooltips, at most CALLS.
        if let Some(serde_json::Value::Array(calls)) = m.get_mut("callList") {
            calls.truncate(CALLS);
            for c in calls.iter_mut() {
                let pick = |k: &str| c.get(k).cloned().unwrap_or(serde_json::Value::Null);
                // Hops as frame positions, flat: [from, to, from, to, ...].
                let hops: Vec<serde_json::Value> = c.get("hops").and_then(|h| h.as_array()).into_iter().flatten().flat_map(|h| h.as_array().into_iter().flatten().map(&pos)).collect();
                *c = serde_json::json!({
                    "id": pick("id"), "hops": hops, "kind": pick("kind"), "muted": pick("muted"),
                    "who": pick("who"), "why": pick("why"), "bc": c.pointer("/badge/color").cloned().unwrap_or_default(),
                });
            }
        }
        // Trunks as [a, b, used, uses, streak] with frames as positions, plus
        // the capacity when it is not the fleet's (index.json "cap"). Trunk
        // ids are left out: they are unique numbers that gzip cannot shrink,
        // and the player names a trunk by its two frames instead.
        if let Some(serde_json::Value::Array(trunks)) = m.get_mut("trunkList") {
            for t in trunks.iter_mut() {
                let pick = |k: &str| t.get(k).cloned().unwrap_or(serde_json::Value::Null);
                let mut a = vec![pos(&pick("a")), pos(&pick("b")), pick("used"), pick("uses"), pick("streak")];
                if pick("cap").as_u64() != Some(cap as u64) {
                    a.push(pick("cap"));
                }
                *t = serde_json::Value::Array(a);
            }
        }
        // The panels' lights change slowly next to the globe: every three hours.
        if n % (3.0 * 3600.0 / every).max(1.0) as usize != 0 {
            m.remove("lights");
        }
        if !first_of_day {
            for k in ["history", "today", "clusters"] {
                m.remove(k);
            }
        }
    }
    serde_json::json!({ "s": s, "g": g })
}

/// A year is not 365 copies of one day: weekends are quieter, winter a little
/// busier than summer, and no two days are quite alike. The runtime reloads
/// the fader file every tick, so each day's demand is written there.
fn set_day(dst: &Layout, base: &Fader, day: u32) -> io::Result<()> {
    let mut f = base.clone();
    let weekday = match day % 7 {
        5 => 0.6,
        6 => 0.5,
        _ => 1.0,
    };
    let season = 1.0 + 0.12 * (2.0 * std::f64::consts::PI * day as f64 / 365.0).cos();
    // Cheap deterministic jitter, +-10%, from the day number and the seed.
    let h = (day as u64 ^ f.seed).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 40;
    let jitter = 0.9 + 0.2 * (h as f64 / (1u64 << 24) as f64);
    f.requests_per_minute = base.requests_per_minute * weekday * season * jitter;
    // The Olympics: one day in the middle of every month.
    f.day.olympics.enabled = (0..12).any(|m| day == ((m as f64 + 0.5) * 365.0 / 12.0) as u32);
    f.running = true;
    if f.speed <= 0.0 {
        f.speed = 60.0;
    }
    util::write_json(&dst.fader(), &f)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let p = e.path();
        let q = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&p, &q)?;
        } else {
            fs::copy(&p, &q)?;
        }
    }
    Ok(())
}
