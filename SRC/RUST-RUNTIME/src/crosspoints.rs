//! TRUNK-CROSS POINTS: the closed crosspoints inside every frame, derived
//! from the live connections, plus a delta log of every set/clear.
//!
//! Everything is also expressed in the unifying Ward-Beck line:
//!
//! ```text
//! SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
//! ```
//!
//! * every delta is appended to `wardbeck.log` as a CLOSE or OPEN line,
//! * every live connection is one end-to-end line (frame to frame),
//! * every frame checks in periodically: `checkin.wb` is rewritten with a
//!   CHECKIN line per frame followed by its CLOSE lines.
//!
//! The delta log ends after `settings.max_events` events (default 1000).
//! The limit is editable from the crosspoint display or `settings.json`;
//! `reset` starts a fresh log. Check-ins never stop.

use crate::routing::State;
use crate::util;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;
use trunk_caster_sdk::folders::Layout;
use trunk_caster_sdk::wardbeck::{Line, Switch};
use trunk_caster_sdk::{Connection, Crosspoint, CrosspointEvent, CrosspointSettings, CrosspointSnapshot, DeltaOp, WIRE_VERSION};

pub fn user_port(i: usize) -> String {
    format!("U{i:02}")
}
pub fn caster_port(i: usize) -> String {
    format!("C{i}")
}

#[derive(Debug)]
pub struct CrosspointLog {
    pub site: String,
    pub settings: CrosspointSettings,
    pub current: HashSet<Crosspoint>,
    /// End-to-end connection lines currently CLOSEd.
    pub current_e2e: HashSet<Line>,
    pub seq: u64,
    pub events_logged: u64,
    pub ended: bool,
    pub recent: Vec<CrosspointEvent>,
    /// Recent Ward-Beck lines (deltas, end-to-end, check-in headers).
    pub recent_wb: VecDeque<String>,
    pub last_checkin_at: Option<String>,
    pub checkins: u64,
    last_checkin: Instant,
    deltas: PathBuf,
    wb_log: PathBuf,
    checkin_file: PathBuf,
    snapshot: PathBuf,
    settings_path: PathBuf,
}

impl CrosspointLog {
    pub fn load(layout: &Layout, site: &str) -> Self {
        let settings_path = layout.crosspoint_settings();
        let settings: CrosspointSettings = util::read_json(&settings_path).unwrap_or_default();
        let deltas = layout.crosspoint_deltas();
        let snapshot = layout.crosspoints_json();

        let mut events_logged = 0u64;
        let mut seq = 0u64;
        let mut recent = Vec::new();
        if let Ok(f) = fs::File::open(&deltas) {
            for line in io::BufReader::new(f).lines().map_while(Result::ok) {
                if let Ok(ev) = serde_json::from_str::<CrosspointEvent>(&line) {
                    seq = seq.max(ev.seq);
                    events_logged += 1;
                    recent.push(ev);
                }
            }
        }
        if recent.len() > 200 {
            recent.drain(..recent.len() - 200);
        }
        let current: HashSet<Crosspoint> = util::read_json::<CrosspointSnapshot>(&snapshot)
            .map(|s| s.crosspoints.into_iter().collect())
            .unwrap_or_default();

        let ended = events_logged >= settings.max_events;
        CrosspointLog {
            site: site.to_string(),
            settings,
            current,
            current_e2e: HashSet::new(),
            seq,
            events_logged,
            ended,
            recent,
            recent_wb: VecDeque::new(),
            last_checkin_at: None,
            checkins: 0,
            last_checkin: Instant::now(),
            deltas,
            wb_log: layout.wardbeck_log(),
            checkin_file: layout.checkin_file(),
            snapshot,
            settings_path,
        }
    }

    /// Pick up edits made to `settings.json` by hand.
    pub fn reload_settings(&mut self) {
        if let Ok(s) = util::read_json::<CrosspointSettings>(&self.settings_path) {
            if s.max_events != self.settings.max_events || s.checkin_every_seconds != self.settings.checkin_every_seconds {
                self.settings = s;
                self.ended = self.events_logged >= self.settings.max_events;
            }
        }
    }

    pub fn set_settings(&mut self, s: CrosspointSettings) -> io::Result<()> {
        self.settings = s;
        self.ended = self.events_logged >= self.settings.max_events;
        util::write_json(&self.settings_path, &self.settings)
    }

    /// Start a fresh log. Current crosspoints are kept; the counter resets.
    pub fn reset(&mut self) -> io::Result<()> {
        let _ = fs::remove_file(&self.deltas);
        let _ = fs::remove_file(&self.wb_log);
        self.seq = 0;
        self.events_logged = 0;
        self.ended = false;
        self.recent.clear();
        self.recent_wb.clear();
        self.write_snapshot()
    }

    pub fn checkin_due(&self) -> bool {
        self.last_checkin.elapsed().as_secs_f64() >= self.settings.checkin_every_seconds.max(1.0)
    }

    // ----------------------------------------------------------------------
    // Derivation
    // ----------------------------------------------------------------------

    /// Derive the crosspoints every connection closes.
    pub fn derive(state: &State) -> HashSet<Crosspoint> {
        let mut set = HashSet::new();
        for c in &state.connections {
            for cp in crosspoints_of(state, c) {
                set.insert(cp);
            }
        }
        set
    }

    /// One end-to-end CLOSE line per live connection.
    pub fn derive_e2e(&self, state: &State) -> HashSet<Line> {
        state.connections.iter().map(|c| self.e2e_line(state, c, Switch::Close)).collect()
    }

    /// The SITE field for a frame: where it lives, or the caster's site.
    fn site_for<'a>(&'a self, state: &'a State, frame: &str) -> &'a str {
        state.site_of(frame).unwrap_or(&self.site)
    }

    pub fn e2e_line(&self, state: &State, c: &Connection, switch: Switch) -> Line {
        Line::between(
            self.site_for(state, &c.from_frame),
            &c.from_frame,
            &user_port(c.from_port),
            state.port_name(&c.from_frame, c.from_port).unwrap_or(&c.who),
            switch,
            state.port_name(&c.to_frame, c.to_port).unwrap_or(&c.who),
            &user_port(c.to_port),
            &c.to_frame,
            self.site_for(state, &c.to_frame),
        )
    }

    /// Express one internal crosspoint as a Ward-Beck line.
    pub fn wb_line(&self, state: &State, cp: &Crosspoint, switch: Switch) -> Line {
        Line::local(
            self.site_for(state, &cp.frame),
            &cp.frame,
            &cp.input,
            &port_label(state, &cp.frame, &cp.input, &cp.connection),
            switch,
            &port_label(state, &cp.frame, &cp.output, &cp.connection),
            &cp.output,
        )
    }

    // ----------------------------------------------------------------------
    // Sync and check-in
    // ----------------------------------------------------------------------

    /// Bring the log in line with `state`. Returns every Ward-Beck line
    /// generated (crosspoint deltas first, then end-to-end lines), so the
    /// runtime can push them to remote frames.
    pub fn sync(&mut self, state: &State, sim_time: Option<f64>) -> io::Result<Vec<Line>> {
        let next = Self::derive(state);
        let next_e2e = self.derive_e2e(state);

        let mut cleared: Vec<Crosspoint> = self.current.difference(&next).cloned().collect();
        let mut set: Vec<Crosspoint> = next.difference(&self.current).cloned().collect();
        let opened: Vec<Line> = self.current_e2e.difference(&next_e2e).map(Line::flipped).collect();
        let closed: Vec<Line> = next_e2e.difference(&self.current_e2e).cloned().collect();

        if cleared.is_empty() && set.is_empty() && opened.is_empty() && closed.is_empty() {
            return Ok(Vec::new());
        }
        cleared.sort_by(|a, b| (&a.frame, &a.input, &a.output).cmp(&(&b.frame, &b.input, &b.output)));
        set.sort_by(|a, b| (&a.frame, &a.input, &a.output).cmp(&(&b.frame, &b.input, &b.output)));

        let now = util::now_iso();
        let mut events = Vec::with_capacity(cleared.len() + set.len());
        let mut lines: Vec<Line> = Vec::with_capacity(events.capacity() + opened.len() + closed.len());
        for (op, list) in [(DeltaOp::Clear, cleared), (DeltaOp::Set, set)] {
            let switch = if op == DeltaOp::Set { Switch::Close } else { Switch::Open };
            for cp in list {
                self.seq += 1;
                lines.push(self.wb_line(state, &cp, switch));
                events.push(CrosspointEvent { seq: self.seq, at: now.clone(), sim_time, op, crosspoint: cp });
            }
        }
        lines.extend(opened);
        lines.extend(closed);
        let wb: Vec<String> = lines.iter().map(ToString::to_string).collect();
        self.append(&events, &wb)?;
        self.current = next;
        self.current_e2e = next_e2e;
        self.write_snapshot()?;
        Ok(lines)
    }

    /// Full state of one frame as lines: CHECKIN header, its CLOSE lines,
    /// then the end-to-end CLOSE line of every connection it is an end of,
    /// so a remote that (re)announces learns the calls already up. Sent to
    /// a remote when it announces the frame.
    pub fn frame_state(&self, state: &State, frame: &str) -> Vec<Line> {
        let mut cps: Vec<&Crosspoint> = self.current.iter().filter(|c| c.frame == frame).collect();
        cps.sort_by(|a, b| (&a.input, &a.output).cmp(&(&b.input, &b.output)));
        let mut out = vec![Line::checkin(self.site_for(state, frame), frame, &util::now_iso(), cps.len())];
        out.extend(cps.into_iter().map(|cp| self.wb_line(state, cp, Switch::Close)));
        let mut e2e: Vec<&Line> = self.current_e2e.iter().filter(|l| l.frame == frame || l.out_frame == frame).collect();
        e2e.sort_by(|a, b| (&a.frame, &a.input).cmp(&(&b.frame, &b.input)));
        out.extend(e2e.into_iter().cloned());
        out
    }

    fn append(&mut self, events: &[CrosspointEvent], wb: &[String]) -> io::Result<()> {
        if let Some(parent) = self.deltas.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new().create(true).append(true).open(&self.deltas)?;
        let mut wb_iter = wb.iter();
        for ev in events {
            if self.ended {
                break;
            }
            writeln!(f, "{}", serde_json::to_string(ev).map_err(io::Error::other)?)?;
            if let Some(line) = wb_iter.next() {
                util::append_line_capped(&self.wb_log, line, util::LOG_CAP)?;
                self.remember_wb(line);
            }
            self.events_logged += 1;
            self.recent.push(ev.clone());
            if self.events_logged >= self.settings.max_events {
                self.ended = true;
            }
        }
        // End-to-end lines ride along while the log is open.
        if !self.ended {
            for line in wb_iter {
                util::append_line_capped(&self.wb_log, line, util::LOG_CAP)?;
                self.remember_wb(line);
            }
        }
        if self.recent.len() > 200 {
            let n = self.recent.len() - 200;
            self.recent.drain(..n);
        }
        Ok(())
    }

    fn remember_wb(&mut self, line: &str) {
        self.recent_wb.push_back(line.to_string());
        if self.recent_wb.len() > 200 {
            self.recent_wb.pop_front();
        }
    }

    /// Every frame restates itself: `checkin.wb` is rewritten in full and
    /// one CHECKIN header per frame is appended to the log.
    pub fn checkin(&mut self, state: &State) -> io::Result<usize> {
        let now = util::now_iso();
        let mut by_frame: BTreeMap<&str, Vec<&Crosspoint>> = BTreeMap::new();
        for f in &state.frames {
            by_frame.entry(f.id.as_str()).or_default();
        }
        for cp in &self.current {
            by_frame.entry(cp.frame.as_str()).or_default().push(cp);
        }

        let mut out = String::new();
        let mut headers = Vec::new();
        for (frame, mut list) in by_frame {
            list.sort_by(|a, b| (&a.input, &a.output).cmp(&(&b.input, &b.output)));
            let head = Line::checkin(self.site_for(state, frame), frame, &now, list.len());
            headers.push(head.to_string());
            out.push_str(&head.to_string());
            out.push('\n');
            for cp in list {
                out.push_str(&self.wb_line(state, cp, Switch::Close).to_string());
                out.push('\n');
            }
        }
        // Site-level section: every end-to-end connection.
        let mut e2e: Vec<String> = self.current_e2e.iter().map(ToString::to_string).collect();
        e2e.sort();
        let site_head = Line::checkin(&self.site, "*", &now, e2e.len());
        out.push_str(&site_head.to_string());
        out.push('\n');
        for l in &e2e {
            out.push_str(l);
            out.push('\n');
        }

        util::write_text(&self.checkin_file, &out)?;
        if !self.ended {
            util::append_line_capped(&self.wb_log, &site_head.to_string(), util::LOG_CAP)?;
        }
        self.remember_wb(&site_head.to_string());
        self.last_checkin = Instant::now();
        self.last_checkin_at = Some(now);
        self.checkins += 1;
        Ok(headers.len())
    }

    pub fn write_snapshot(&self) -> io::Result<()> {
        let mut crosspoints: Vec<Crosspoint> = self.current.iter().cloned().collect();
        crosspoints.sort_by(|a, b| (&a.frame, &a.input, &a.output).cmp(&(&b.frame, &b.input, &b.output)));
        let snap = CrosspointSnapshot {
            wire_version: WIRE_VERSION,
            updated_at: util::now_iso(),
            settings: self.settings.clone(),
            events_logged: self.events_logged,
            log_ended: self.ended,
            crosspoints,
        };
        util::write_json(&self.snapshot, &snap)
    }
}

/// Name shown for a port in a Ward-Beck line: the renamed user port, or
/// the trunk a caster is bound to.
fn port_label(state: &State, frame: &str, port: &str, conn: &str) -> String {
    if let Some(idx) = port.strip_prefix('U').and_then(|n| n.parse::<usize>().ok()) {
        if let Some(name) = state.port_name(frame, idx) {
            return name.to_string();
        }
        if let Some(c) = state.connection(conn) {
            return c.who.clone();
        }
        return port.to_string();
    }
    if let Some(idx) = port.strip_prefix('C').and_then(|n| n.parse::<usize>().ok()) {
        if let Some(t) = state.trunks.iter().find(|t| t.caster_on(frame) == Some(idx)) {
            return t.id.clone();
        }
    }
    port.to_string()
}

/// The crosspoints one connection closes, in signal order.
pub fn crosspoints_of(state: &State, c: &Connection) -> Vec<Crosspoint> {
    let mut out = Vec::new();
    let n = c.hops.len();
    if n == 0 {
        return out;
    }
    let caster = |trunk: &str, frame: &str| state.trunk(trunk).and_then(|t| t.caster_on(frame));
    let mut both = |frame: &str, a: String, b: String| {
        out.push(Crosspoint { frame: frame.into(), input: a.clone(), output: b.clone(), connection: c.id.clone() });
        out.push(Crosspoint { frame: frame.into(), input: b, output: a, connection: c.id.clone() });
    };

    if let Some(ca) = caster(&c.hops[0].trunk, &c.from_frame) {
        both(&c.from_frame, user_port(c.from_port), caster_port(ca));
    }
    for i in 1..n {
        let x = &c.hops[i].from;
        if let (Some(cin), Some(cout)) = (caster(&c.hops[i - 1].trunk, x), caster(&c.hops[i].trunk, x)) {
            both(x, caster_port(cin), caster_port(cout));
        }
    }
    if let Some(cb) = caster(&c.hops[n - 1].trunk, &c.to_frame) {
        both(&c.to_frame, caster_port(cb), user_port(c.to_port));
    }
    out
}
