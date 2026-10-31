//! The simulation recorder. A run is the stretch between two parameter
//! changes: whenever the fader changes (or the clock is scrubbed, or the
//! daily reset ends) the current run is closed with its summary and a new
//! one begins, so every metric belongs to the parameters that produced it.
//! Runs live in `TRUNK-SIMULATOR/runs/<id>.json`; `runs.json` indexes them.

use crate::routing::Counters;
use crate::util;
use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use trunk_caster_sdk::folders::Layout;
use std::collections::BTreeMap;
use trunk_caster_sdk::{Fader, ProductionSummary, RunSummary, Sample, SimRun, WIRE_VERSION};

const MAX_SAMPLES_PER_RUN: usize = 5000;
const INDEX_KEEP: usize = 200;

pub struct Recorder {
    pub current: SimRun,
    counters_start: Counters,
    pub index: VecDeque<SimRun>,
    runs_dir: PathBuf,
    index_path: PathBuf,
}

impl Recorder {
    pub fn start(layout: &Layout, fader: &Fader, counters: &Counters, sim_time: f64, frames: usize, sites: usize, reason: &str) -> Recorder {
        let runs_dir = layout.runs_dir();
        let _ = fs::create_dir_all(&runs_dir);
        let mut index: VecDeque<SimRun> = util::read_json::<Vec<SimRun>>(&layout.runs_index()).unwrap_or_default().into_iter().collect();
        index.truncate(INDEX_KEEP);
        let r = Recorder { current: Self::new_run(fader, sim_time, frames, sites, reason), counters_start: counters.clone(), index, runs_dir, index_path: layout.runs_index() };
        r.save_current();
        r
    }

    fn new_run(fader: &Fader, sim_time: f64, frames: usize, sites: usize, reason: &str) -> SimRun {
        let now = util::now_unix();
        SimRun {
            wire_version: WIRE_VERSION,
            id: format!("run-{}-{}", now, reason),
            started_at: util::iso(now),
            started_sim: sim_time,
            ended_at: None,
            ended_sim: None,
            reason: reason.into(),
            fader: fader.clone(),
            frames,
            sites,
            summary: RunSummary::default(),
            samples: Vec::new(),
        }
    }

    /// Record a sample into the current run and refresh its summary.
    pub fn sample(&mut self, s: &Sample, counters: &Counters) {
        self.current.samples.push(s.clone());
        if self.current.samples.len() > MAX_SAMPLES_PER_RUN {
            self.current.samples.remove(0);
        }
        self.current.summary = self.summarize(counters, s.sim_time);
    }

    fn summarize(&self, counters: &Counters, sim_now: f64) -> RunSummary {
        let s = &self.current.samples;
        let n = s.len().max(1) as f64;
        RunSummary {
            samples: s.len(),
            duration_sim_seconds: (sim_now - self.current.started_sim).max(0.0),
            granted: counters.granted.saturating_sub(self.counters_start.granted),
            granted_via: counters.granted_via.saturating_sub(self.counters_start.granted_via),
            denied: counters.denied.saturating_sub(self.counters_start.denied),
            released: counters.released.saturating_sub(self.counters_start.released),
            peak_live: s.iter().map(|x| x.active).max().unwrap_or(0),
            avg_live: s.iter().map(|x| x.active as f64).sum::<f64>() / n,
            peak_muted: s.iter().map(|x| x.muted).max().unwrap_or(0),
            avg_channel_utilization: s.iter().map(|x| x.channel_utilization).sum::<f64>() / n,
            max_channel_utilization: s.iter().map(|x| x.channel_utilization).fold(0.0, f64::max),
            avg_caster_utilization: s.iter().map(|x| x.caster_utilization).sum::<f64>() / n,
            crosschecks_failed: s.last().map(|x| x.crosschecks_failed).unwrap_or(0).saturating_sub(s.first().map(|x| x.crosschecks_failed).unwrap_or(0)),
            blackout_samples: s.iter().filter(|x| x.blackout).count(),
            productions: Self::production_summaries(s),
        }
    }

    /// What each production did between the first and last sample of a run.
    fn production_summaries(s: &[Sample]) -> BTreeMap<String, ProductionSummary> {
        let mut out = BTreeMap::new();
        let (Some(first), Some(last)) = (s.first(), s.last()) else { return out };
        for (name, l) in &last.productions {
            let f = first.productions.get(name).cloned().unwrap_or_default();
            let first_busy_sim = s.iter().find(|x| x.productions.get(name).map(|p| p.busy > f.busy).unwrap_or(false)).map(|x| x.sim_time);
            out.insert(
                name.clone(),
                ProductionSummary {
                    studio: l.studio.clone(),
                    trunks: l.trunks,
                    offered: l.offered.saturating_sub(f.offered),
                    answered: l.answered.saturating_sub(f.answered),
                    busy: l.busy.saturating_sub(f.busy),
                    peak_live: s.iter().filter_map(|x| x.productions.get(name).map(|p| p.live)).max().unwrap_or(0),
                    first_busy_sim,
                },
            );
        }
        out
    }

    /// Close the current run and start a new one. Returns the closed run's
    /// id and summary.
    pub fn restart(&mut self, fader: &Fader, counters: &Counters, sim_time: f64, frames: usize, sites: usize, reason: &str) -> (String, RunSummary) {
        self.current.ended_at = Some(util::now_iso());
        self.current.ended_sim = Some(sim_time);
        self.current.summary = self.summarize(counters, sim_time);
        self.save_current();
        let closed = (self.current.id.clone(), self.current.summary.clone());
        let mut indexed = self.current.clone();
        indexed.samples.clear();
        self.index.push_front(indexed);
        self.index.truncate(INDEX_KEEP);
        let _ = util::write_json(&self.index_path, &self.index.iter().collect::<Vec<_>>());
        self.current = Self::new_run(fader, sim_time, frames, sites, reason);
        self.counters_start = counters.clone();
        self.save_current();
        closed
    }

    /// The current run's file, as text to queue for writing.
    pub fn current_file(&self) -> (PathBuf, String) {
        (self.runs_dir.join(format!("{}.json", self.current.id)), serde_json::to_string_pretty(&self.current).unwrap_or_default())
    }

    fn save_current(&self) {
        let (p, t) = self.current_file();
        let _ = util::write_text(&p, &t);
    }

    /// Does this fader differ in anything that shapes the simulation?
    pub fn parameters_changed(a: &Fader, b: &Fader) -> bool {
        serde_json::to_string(a).ok() != serde_json::to_string(b).ok()
    }
}
