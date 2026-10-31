//! The simulation report: what the current run (and the runs before it)
//! say, as Markdown. The simulator page renders it in its left column;
//! `/api/report` serves the text.

use crate::runtime::Runtime;
use std::fmt::Write;
use trunk_caster_sdk::*;

fn pct(part: u64, whole: u64) -> String {
    if whole == 0 {
        "–".into()
    } else {
        format!("{:.1}%", part as f64 / whole as f64 * 100.0)
    }
}

fn hms(secs: f64) -> String {
    let t = secs.rem_euclid(86_400.0) as u64;
    format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60)
}

fn dur(secs: f64) -> String {
    let s = secs.max(0.0) as u64;
    if s < 60 {
        format!("{s} s")
    } else if s < 3600 {
        format!("{} min {:02} s", s / 60, s % 60)
    } else {
        format!("{} h {:02} min", s / 3600, (s % 3600) / 60)
    }
}

/// The event a run was recorded under, from its fader.
pub fn event_name(f: &Fader) -> String {
    if f.preset.is_empty() {
        "hand-set fader".to_string()
    } else {
        presets(f).into_iter().find(|p| p.id == f.preset).map(|p| p.name).unwrap_or_else(|| f.preset.clone())
    }
}

pub fn markdown(rt: &Runtime) -> String {
    let run = &rt.recorder.current;
    let s = &run.summary;
    let f = &run.fader;
    let samples = &run.samples;
    let mut md = String::new();
    let _ = writeln!(md, "# Simulation report");
    let _ = writeln!(
        md,
        "Event: **{}** · run `{}` · started {} sim clock, {} wall · {} simulated so far · {} samples",
        event_name(f),
        run.id,
        samples.first().map(|x| hms(x.time_of_day)).unwrap_or_else(|| rt.clock()),
        run.started_at,
        dur(s.duration_sim_seconds),
        s.samples
    );
    let _ = writeln!(
        md,
        "Fader: speed {:.0}×, baseline {:.0} requests/min, mean hold {:.0} s, news cycle {}, {} frames at {} sites",
        f.speed,
        f.requests_per_minute,
        f.mean_hold_seconds,
        if f.day.enabled { "on" } else { "off" },
        run.frames,
        run.sites
    );
    md.push('\n');

    let offered = s.granted + s.denied;
    let _ = writeln!(md, "## Headline");
    let _ = writeln!(md, "- Offered **{offered}** calls: granted {} ({} via), denied {} → **{} denied**", s.granted, s.granted_via, s.denied, pct(s.denied, offered));
    if let Some(peak) = samples.iter().max_by_key(|x| x.active) {
        let _ = writeln!(md, "- Peak **{}** live at {} sim clock (load ×{:.1}); average {:.0} live, peak {} parked", s.peak_live, hms(peak.time_of_day), peak.load_multiplier, s.avg_live, s.peak_muted);
    }
    let _ = writeln!(md, "- Channel utilisation average {:.1}%, peak {:.1}%; caster utilisation average {:.1}%", s.avg_channel_utilization * 100.0, s.max_channel_utilization * 100.0, s.avg_caster_utilization * 100.0);
    let _ = writeln!(
        md,
        "- Cross-check failures {}{}",
        s.crosschecks_failed,
        if s.blackout_samples > 0 { format!(" · {} samples inside the daily reset", s.blackout_samples) } else { String::new() }
    );
    if let (Some(a), Some(b)) = (samples.first(), samples.last()) {
        let dt = (b.sim_time - a.sim_time).max(1.0) / 60.0;
        let _ = writeln!(md, "- Rates: {:.0} granted/min, {:.0} denied/min over the run", (b.granted_total.saturating_sub(a.granted_total)) as f64 / dt, (b.denied_total.saturating_sub(a.denied_total)) as f64 / dt);
    }
    md.push('\n');

    if !f.productions.is_empty() {
        let _ = writeln!(md, "## Productions");
        let now = rt.production_samples();
        for p in &f.productions {
            let ps = s.productions.get(&p.name).cloned().unwrap_or_default();
            let live = now.get(&p.name).cloned().unwrap_or_default();
            let window = if p.start_hour < 0.0 || p.end_hour < 0.0 { "all day".to_string() } else { format!("{:02}:00 to {:02}:00 studio time", p.start_hour as u32, p.end_hour as u32) };
            let _ = writeln!(md, "### {} · studio `{}` · {} trunks made available", p.name, p.studio, p.trunks);
            let _ = writeln!(md, "- {:.0} callers/min asked for, {:.0} s mean hold, on air {} · now {}", p.calls_per_minute, p.mean_hold_seconds, window, if live.on_air { "**on air**" } else { "off air" });
            let _ = writeln!(md, "- Offered **{}**: answered {} ({}), busy **{}** ({})", ps.offered, ps.answered, pct(ps.answered, ps.offered), ps.busy, pct(ps.busy, ps.offered));
            let _ = writeln!(md, "- Peak {} callers on the line · right now {} on the line, {} of {} trunks in use", ps.peak_live, live.live, live.trunks_used, p.trunks);
            if let Some(t) = ps.first_busy_sim {
                let _ = writeln!(md, "- First busy signal {} into the run", dur(t - run.started_sim));
            }
            // Erlang arithmetic: the offered load against what the studio has.
            let erlangs = p.calls_per_minute / 60.0 * p.mean_hold_seconds;
            let ports = rt.state.user_ports_of(&p.studio);
            let channels = p.trunks * rt.shape.channels_per_trunk;
            let capacity = ports.min(channels);
            let can_answer = capacity as f64 / p.mean_hold_seconds.max(1.0) * 60.0;
            let _ = writeln!(
                md,
                "- Arithmetic: {:.0} Erlangs offered against {} lines ({} user ports, {} trunks × {} channels): about {:.0} callers a minute can be answered of {:.0} asking, so roughly {} would need about {:.0} lines",
                erlangs,
                capacity,
                ports,
                p.trunks,
                rt.shape.channels_per_trunk,
                can_answer,
                p.calls_per_minute,
                if erlangs > capacity as f64 { "answering everyone" } else { "this load" },
                erlangs.max(1.0)
            );
        }
        md.push('\n');
    }

    let _ = writeln!(md, "## Earlier runs");
    let mut any = false;
    for r in rt.recorder.index.iter().take(6) {
        any = true;
        let rs = &r.summary;
        let off = rs.granted + rs.denied;
        let prods: Vec<String> = rs.productions.iter().map(|(n, p)| format!("{n}: {} answered, {} busy", p.answered, p.busy)).collect();
        let _ = writeln!(
            md,
            "- **{}** ({}) · {} · {} offered, {} denied, peak {} live{}",
            event_name(&r.fader),
            r.reason,
            dur(rs.duration_sim_seconds),
            off,
            pct(rs.denied, off),
            rs.peak_live,
            if prods.is_empty() { String::new() } else { format!(" · {}", prods.join("; ")) }
        );
    }
    if !any {
        let _ = writeln!(md, "- none yet");
    }
    md
}
