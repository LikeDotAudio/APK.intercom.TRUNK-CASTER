//! The runtime: owns the repertoire, the routing state, the crosspoint log,
//! the simulator clock and the folder contract. `tick()` is the heartbeat.

use crate::crosspoints::{user_port, CrosspointLog};
use crate::discover::{self, Repertoire};
use crate::frame;
use crate::interface::{self, OFFER_SUFFIX, REPLY_SUFFIX};
use crate::routing::{CrossCheck, RouteAsk, State};
use crate::snmp;
use crate::users;
use crate::util::{self, Rng};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use trunk_caster_sdk::folders::Layout;
use trunk_caster_sdk::*;

const RECENT_RECORDS: usize = 300;
const MAX_SAMPLES: usize = 3000;
const SIM_RECORDS_ON_DISK: usize = 300;
const PERSIST_EVERY: Duration = Duration::from_millis(1000);
/// The Olympics venue's name in the production counters.
const OLYMPICS: &str = "Olympics";

#[derive(Debug, Clone)]
struct Honored {
    granted: bool,
    last_attempt: Instant,
}

pub struct Runtime {
    pub layout: Layout,
    pub shape: Shape,
    pub site: String,
    pub endpoint: String,
    pub repertoire: Repertoire,
    pub relay: RelayConfig,
    pub sites: Sites,
    pub globe: GlobeConfig,
    pub recent_prefs: VecDeque<Preference>,
    pref_seq: u64,
    pub state: State,
    pub recent_labels: VecDeque<LabelEvent>,
    pub recent_relay_events: VecDeque<RelayEvent>,
    pub recent_gains: VecDeque<GainEvent>,
    /// The frames' voices, re-assembled from the wave sender's two cuts.
    pub voices: crate::voices::SharedVoices,
    label_seq: u64,
    relay_seq: u64,
    gain_seq: u64,
    pub crosspoints: CrosspointLog,
    pub policy: VendorPolicy,
    pub fader: Fader,
    pub sim_time: f64,
    pub timeline: Timeline,
    pub last_crosscheck: CrossCheck,
    pub crosschecks_ok: u64,
    pub crosschecks_failed: u64,
    pub started_at: String,
    pub bad_requests: Vec<(PathBuf, String)>,
    pub offers: Vec<PanelOffer>,
    pub recent_records: VecDeque<UserRecord>,
    pub recent_gpio: VecDeque<GpioEvent>,
    pub recent_renames: VecDeque<RenameDispatch>,
    pub log: VecDeque<String>,
    /// The Ward-Beck TCP port: remote frames (simulator containers, real
    /// frames) connect here and speak crosspoint lines.
    pub hub: crate::wb::Hub,
    pub remotes: crate::wb::Remotes,
    pub wb_endpoint: Option<String>,
    mismatch_streak: HashMap<String, u32>,
    /// Simulated time of day at sim_time 0, seconds since midnight.
    day_start_secs: f64,
    /// Files to write, flushed by the caller *after* the runtime lock is
    /// released so slow disks (Docker mounts, OneDrive) never starve the
    /// HTTP and Ward-Beck threads.
    pending_writes: Vec<(PathBuf, String)>,
    /// Files to delete, same treatment.
    pending_deletes: Vec<PathBuf>,
    /// Boot time, so simulator record ids are unique across runs.
    boot_unix: u64,
    /// The daily disconnect window is in force.
    pub blackout_active: bool,
    /// Next round-robin sweep of parked lines (simulated time).
    next_sweep: f64,
    last_sweep: f64,
    /// The simulation recorder: one run per set of parameters.
    pub recorder: crate::recorder::Recorder,
    /// Every trunk's use count by simulated day and hour, and the days it
    /// was locked for an hour or more: the globe's colours and trend view.
    pub trends: crate::trends::Trends,
    /// Lights asked to blink by a GPIO "blink panel", until when.
    pub blinks: HashMap<String, Instant>,
    /// A capture in progress (START pressed, STOP not yet).
    pub capture: Option<Capture>,
    /// Telemetry stream to the pages.
    pub ws: crate::ws::Broadcaster,
    /// `simulate`: no folders or pages are written while ticking.
    pub headless: bool,
    last_stream: Instant,
    last_globe_stream: Instant,
    last_pages: Instant,
    rng: Rng,
    next_arrival: f64,
    next_crosscheck: f64,
    next_sample: f64,
    honored: HashMap<String, Honored>,
    sim_counter: u64,
    req_counter: u64,
    gpio_seq: u64,
    rename_seq: u64,
    dirty: bool,
    last_persist: Instant,
    advertised: HashMap<String, String>,
    sim_on_disk: VecDeque<String>,
    /// Every production's running counters, by production name.
    pub production_stats: BTreeMap<String, ProductionSample>,
    /// Next caller for each production (simulated time), by index.
    next_production_arrival: Vec<f64>,
    /// Next call inside a building (simulated time).
    next_building_arrival: f64,
    /// Next caller into the Olympics venue (simulated time).
    next_olympics_arrival: f64,
    /// The booking timeline: ports held for programs.
    pub bookings: crate::bookings::Bookings,
    /// When the simulated traffic next places a booking (simulated time).
    next_sim_booking: f64,
}

impl Runtime {
    pub fn boot(layout: Layout, shape: Shape, endpoint: String, site: String) -> io::Result<Runtime> {
        let repertoire = discover::discover(&layout)?;
        let relay = crate::relay::load_config(&layout)?;
        let sites: Sites = match util::read_json(&layout.sites()) {
            Ok(s) => s,
            Err(_) => {
                let s = Sites::default();
                util::write_json(&layout.sites(), &s)?;
                s
            }
        };
        let globe: GlobeConfig = match util::read_json(&layout.globe_config()) {
            Ok(g) => g,
            Err(_) => {
                let g = GlobeConfig::default();
                util::write_json(&layout.globe_config(), &g)?;
                g
            }
        };
        let mut frames = frame::fleet(&repertoire, &shape, Some(&endpoint), &sites, &site);
        let mut relay_frames = crate::relay::frames(&relay, &shape, &endpoint);
        for f in &mut relay_frames {
            f.site = site.clone();
        }
        frames.extend(relay_frames);
        let mut state = State::load_or_new(&layout.usage_state(), frames, shape);
        for m in &relay.matrices {
            for (port, name) in &m.port_names {
                if let Some(idx) = port.strip_prefix('U').and_then(|n| n.parse::<usize>().ok()) {
                    if state.port_name(&m.id, idx).is_none() {
                        state.rename_port(&m.id, idx, name);
                    }
                }
            }
        }
        let crosspoints = CrosspointLog::load(&layout, &site);
        // TRUNK_VOICES_DIR: the voices churn (a WAV per frame, rewritten as
        // its calls change), so Docker keeps them on a volume of their own
        // rather than in a synced project folder.
        let voices_dir = std::env::var_os("TRUNK_VOICES_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| layout.usage().join("voices"));
        let fader: Fader = util::read_json(&layout.fader()).unwrap_or_default();
        let timeline: Timeline = util::read_json(&layout.timeline()).unwrap_or_default();
        let sim_time = timeline.samples.last().map(|s| s.sim_time).unwrap_or(0.0);
        let policy: VendorPolicy = util::read_json(&layout.vendor_policy()).unwrap_or_default();

        // Only the newest records are read; the rest stay on disk untouched.
        let recent_records: VecDeque<UserRecord> = users::recent(&layout.users(), RECENT_RECORDS).into_iter().collect();
        let sim_on_disk: VecDeque<String> = users::sim_ids_on_disk(&layout.users()).into_iter().collect();

        let mut honored = HashMap::new();
        for c in state.connections.iter().filter(|c| c.origin == "interface") {
            honored.insert(c.id.clone(), Honored { granted: true, last_attempt: Instant::now() });
        }

        let seed = fader.seed;
        let fader = Self::sane(fader);
        let recorder = crate::recorder::Recorder::start(&layout, &fader, &state.counters, sim_time, state.frames.len(), sites.sites.len(), "boot");
        // Anchor the simulated clock: a requested hour, or the wall clock's time of day.
        let day_start_secs = if fader.day.start_hour < 0.0 {
            (util::now_unix() % 86_400) as f64 - sim_time
        } else {
            fader.day.start_hour * 3600.0 - sim_time
        };
        let trends = crate::trends::Trends::load(&layout.trends_json());
        let bookings = crate::bookings::Bookings::load(&layout.bookings_json());
        let mut rt = Runtime {
            layout,
            shape,
            site,
            endpoint,
            repertoire,
            relay,
            sites,
            globe,
            recent_prefs: VecDeque::new(),
            pref_seq: 0,
            state,
            recent_labels: VecDeque::new(),
            recent_relay_events: VecDeque::new(),
            recent_gains: VecDeque::new(),
            voices: std::sync::Arc::new(std::sync::Mutex::new(crate::voices::Voices::new(voices_dir))),
            label_seq: 0,
            relay_seq: 0,
            gain_seq: 0,
            crosspoints,
            policy,
            fader,
            sim_time,
            timeline,
            last_crosscheck: CrossCheck::default(),
            crosschecks_ok: 0,
            crosschecks_failed: 0,
            started_at: util::now_iso(),
            bad_requests: Vec::new(),
            offers: Vec::new(),
            recent_records,
            recent_gpio: VecDeque::new(),
            recent_renames: VecDeque::new(),
            log: VecDeque::new(),
            hub: crate::wb::Hub::default(),
            remotes: crate::wb::Remotes::default(),
            wb_endpoint: None,
            mismatch_streak: HashMap::new(),
            day_start_secs,
            trends,
            pending_writes: Vec::new(),
            pending_deletes: Vec::new(),
            boot_unix: util::now_unix(),
            blackout_active: false,
            next_sweep: sim_time,
            last_sweep: sim_time,
            recorder,
            blinks: HashMap::new(),
            capture: None,
            ws: crate::ws::Broadcaster::default(),
            headless: false,
            last_stream: Instant::now(),
            last_globe_stream: Instant::now(),
            last_pages: Instant::now() - Duration::from_secs(60),
            rng: Rng::new(seed ^ util::now_unix()),
            next_arrival: sim_time,
            next_crosscheck: sim_time,
            next_sample: sim_time,
            honored,
            sim_counter: 0,
            req_counter: 0,
            gpio_seq: 0,
            rename_seq: 0,
            dirty: true,
            last_persist: Instant::now() - PERSIST_EVERY,
            advertised: HashMap::new(),
            sim_on_disk,
            production_stats: BTreeMap::new(),
            next_production_arrival: Vec::new(),
            next_building_arrival: sim_time,
            next_olympics_arrival: sim_time,
            bookings,
            next_sim_booking: sim_time,
        };
        let now = rt.clock_abs();
        rt.bookings.rebase(now);
        let mut f = rt.fader.clone();
        rt.resolve_productions(&mut f);
        rt.fader = f;
        rt.sync_productions();
        rt.ensure_folders()?;
        if !rt.layout.fader().is_file() {
            util::write_json(&rt.layout.fader(), &rt.fader)?;
        }
        if !rt.layout.crosspoint_settings().is_file() {
            util::write_json(&rt.layout.crosspoint_settings(), &rt.crosspoints.settings)?;
        }
        if !rt.layout.vendor_policy().is_file() {
            util::write_json(&rt.layout.vendor_policy(), &rt.policy)?;
        }
        let backlog = rt.sim_on_disk.len();
        rt.prune_simulated();
        if backlog > SIM_RECORDS_ON_DISK {
            rt.note(format!("{} old simulator records in TRUNK-USERS; removing {} in the background", backlog, backlog - SIM_RECORDS_ON_DISK));
        }
        rt.note(format!(
            "booted site {}: {} protocols, {} sites, {} frames, {} manuals read",
            rt.site,
            rt.repertoire.protocols.len(),
            rt.sites.sites.len(),
            rt.state.frames.len(),
            rt.repertoire.documents
        ));
        Ok(rt)
    }

    /// Frames by protocol, for wildcard announces from simulators.
    fn frames_by_protocol(&self) -> HashMap<String, Vec<String>> {
        let mut m: HashMap<String, Vec<String>> = HashMap::new();
        for f in &self.state.frames {
            m.entry(f.protocol.clone()).or_default().push(f.id.clone());
        }
        m
    }

    /// Record a user preference: anything a person set, in TRUNK-GLOBAL.
    pub fn pref(&mut self, kind: &str, who: Option<&str>, value: serde_json::Value) {
        self.pref_seq += 1;
        let p = Preference { seq: self.pref_seq, at: util::now_iso(), kind: kind.into(), who: who.map(String::from), value };
        if let Ok(j) = serde_json::to_string(&p) {
            let _ = util::append_line_capped(&self.layout.preferences(), &j, util::LOG_CAP);
        }
        self.recent_prefs.push_back(p);
        if self.recent_prefs.len() > 300 {
            self.recent_prefs.pop_front();
        }
    }

    pub fn set_globe(&mut self, g: GlobeConfig) -> io::Result<GlobeConfig> {
        self.globe = g;
        util::write_json(&self.layout.globe_config(), &self.globe)?;
        self.pref("globe", None, serde_json::to_value(&self.globe).unwrap_or_default());
        self.dirty = true;
        Ok(self.globe.clone())
    }

    /// Set the simulated clock to a UTC hour of day (scrubbing the timeline).
    pub fn set_clock_hour(&mut self, hour: f64) {
        let hour = hour.rem_euclid(24.0);
        self.day_start_secs = hour * 3600.0 - self.sim_time;
        self.note(format!("clock scrubbed to {}", self.clock()));
        self.pref("clock", None, serde_json::json!({ "hour": hour, "clock": self.clock() }));
        self.new_run("clock");
        self.dirty = true;
    }

    /// Usage per region: every site with its local time, load multiplier,
    /// live calls and trunks up.
    pub fn regions(&self) -> Vec<serde_json::Value> {
        let utc = self.time_of_day();
        let mut out = Vec::new();
        for s in &self.sites.sites {
            let frames: Vec<&Frame> = self.state.frames.iter().filter(|f| f.site == s.name).collect();
            if frames.is_empty() {
                continue;
            }
            let ids: std::collections::HashSet<&str> = frames.iter().map(|f| f.id.as_str()).collect();
            let calls = self.state.connections.iter().filter(|c| ids.contains(c.from_frame.as_str()) || ids.contains(c.to_frame.as_str())).count();
            let trunks = self.state.trunks.iter().filter(|t| ids.contains(t.a_frame.as_str()) || ids.contains(t.b_frame.as_str())).count();
            let local = DaySchedule::local_tod(utc, s.lon);
            let l = local as u64;
            out.push(serde_json::json!({
                "site": s.name, "slug": s.slug, "country": s.country, "tier": s.tier,
                "lat": s.lat, "lon": s.lon, "frames": frames.len(),
                "local_clock": format!("{:02}:{:02}", l / 3600, (l % 3600) / 60),
                "load": self.fader.day.multiplier(local),
                "calls": calls, "trunks": trunks,
                "panels_live": frames.iter().map(|f| self.state.live_ports_of(&f.id).len()).sum::<usize>(),
            }));
        }
        out
    }

    /// Load multiplier for a frame at its site's local time.
    fn frame_multiplier(&self, f: &Frame) -> f64 {
        match f.lon {
            Some(lon) => self.fader.day.multiplier_at(self.time_of_day(), lon),
            None => self.load_multiplier(),
        }
    }

    fn ensure_folders(&self) -> io::Result<()> {
        for d in [
            self.layout.advertisement(),
            self.layout.interface(),
            self.layout.usage(),
            self.layout.users(),
            self.layout.cross_points(),
            self.layout.seeks_dir(),
            self.layout.simulator(),
            self.layout.relay(),
            self.layout.global(),
            self.layout.sdk(),
        ] {
            fs::create_dir_all(d)?;
        }
        Ok(())
    }

    // ----------------------------------------------------------------------
    // Deferred file writes
    // ----------------------------------------------------------------------

    fn queue_text(&mut self, path: PathBuf, text: String) {
        // A later write to the same path replaces the earlier one.
        self.pending_writes.retain(|(p, _)| p != &path);
        self.pending_writes.push((path, text));
    }

    fn queue_json<T: serde::Serialize>(&mut self, path: PathBuf, value: &T) {
        match serde_json::to_string_pretty(value) {
            Ok(text) => self.queue_text(path, text),
            Err(e) => self.note(format!("could not serialize {}: {e}", path.display())),
        }
    }

    /// Take everything queued: writes, and every pending delete (the caller
    /// hands deletes to the janitor thread so a slow mount never holds up
    /// the tick). Call with the lock held, then release it and pass the
    /// result to [`Runtime::flush`].
    pub fn take_writes(&mut self) -> (Vec<(PathBuf, String)>, Vec<PathBuf>) {
        (std::mem::take(&mut self.pending_writes), std::mem::take(&mut self.pending_deletes))
    }

    /// Write queued files. Runs without the lock. Deletes are returned to
    /// the caller for the janitor.
    pub fn flush((writes, deletes): (Vec<(PathBuf, String)>, Vec<PathBuf>)) -> Vec<PathBuf> {
        for (path, text) in writes {
            if let Err(e) = util::write_text(&path, &text) {
                eprintln!("write {} failed: {e}", path.display());
            }
        }
        deletes
    }

    pub fn note(&mut self, msg: String) {
        let line = format!("{} {msg}", util::now_iso());
        // Headless (`simulate`) notes every call: kept for the pages, never printed.
        if !self.headless {
            eprintln!("{line}");
        }
        self.log.push_back(line);
        if self.log.len() > 200 {
            self.log.pop_front();
        }
    }

    // ----------------------------------------------------------------------
    // Heartbeat
    // ----------------------------------------------------------------------

    /// Start the Ward-Beck TCP port.
    pub fn listen_wb(&mut self, addr: &str) -> io::Result<()> {
        self.hub.listen(addr)?;
        self.wb_endpoint = Some(addr.to_string());
        Ok(())
    }

    /// Remote frames: announcements get the frame's full state, check-ins
    /// are compared with what we believe, acks are counted.
    fn process_remotes(&mut self) {
        let by_proto = self.frames_by_protocol();
        let events = self.hub.drain(&mut self.remotes, &by_proto);
        for ev in events {
            match ev {
                crate::wb::Event::Announce { client, frame } => {
                    if self.state.frame(&frame).is_none() {
                        self.note(format!("remote announced unknown frame {frame}; ignoring"));
                        continue;
                    }
                    let lines = self.crosspoints.frame_state(&self.state, &frame);
                    let n = self.hub.send_to(client, &lines, &mut self.remotes);
                    let peer = self.remotes.frames.get(&frame).map(|r| r.peer.clone()).unwrap_or_default();
                    self.note(format!("remote {peer} hosts {frame}: sent {n} line(s) of state"));
                    self.dirty = true;
                }
                crate::wb::Event::Checkin { frame, reported_closed } => {
                    let ours = self.crosspoints.current.iter().filter(|c| c.frame == frame).count();
                    let streak = self.mismatch_streak.entry(frame.clone()).or_default();
                    if reported_closed != ours {
                        *streak += 1;
                        if *streak == 2 {
                            self.note(format!("remote {frame} reports {reported_closed} crosspoints, we have {ours}: resending state"));
                            let lines = self.crosspoints.frame_state(&self.state, &frame);
                            for l in &lines {
                                self.hub.send(&frame, l, &mut self.remotes);
                            }
                        }
                    } else {
                        *streak = 0;
                    }
                }
                crate::wb::Event::Ack => {}
            }
        }
    }

    /// Push freshly generated lines to the remotes hosting their frames.
    fn push_lines(&mut self, lines: &[trunk_caster_sdk::wardbeck::Line]) {
        if self.remotes.frames.is_empty() {
            return;
        }
        for l in lines {
            self.hub.send(&l.frame, l, &mut self.remotes);
            if !l.is_local() {
                self.hub.send(&l.out_frame, l, &mut self.remotes);
            }
        }
    }

    /// One heartbeat. `wall_dt` is wall-clock seconds since the last tick.
    pub fn tick(&mut self, wall_dt: f64) -> io::Result<()> {
        self.reload_fader();
        self.crosspoints.reload_settings();
        if self.fader.speed > 0.0 {
            self.sim_time += wall_dt * self.fader.speed;
        }
        self.process_remotes();
        self.daily_reset()?;

        self.process_interface()?;
        self.process_seeks()?;
        self.expire_simulated()?;
        self.synthetic_load()?;
        self.run_bookings();

        if self.sim_time >= self.next_crosscheck {
            self.run_crosscheck();
            let every = self.fader.crosscheck_every_seconds.max(0.1);
            self.next_crosscheck = self.sim_time + every;
        }
        if self.sim_time >= self.next_sample {
            self.sample()?;
            let every = self.fader.sample_every_seconds.max(0.1);
            self.next_sample = self.sim_time + every;
        }
        if self.crosspoints.checkin_due() {
            // Make sure the crosspoint view is current before restating it.
            let lines = self.crosspoints.sync(&self.state, Some(self.sim_time))?;
            self.push_lines(&lines);
            let n = self.crosspoints.checkin(&self.state)?;
            self.note(format!("check-in: {n} frames restated, {} crosspoints closed", self.crosspoints.current.len()));
            self.dirty = true;
        }

        if self.dirty && !self.headless && self.last_persist.elapsed() >= PERSIST_EVERY {
            self.persist()?;
        }
        self.stream_telemetry();
        Ok(())
    }

    /// Push telemetry to every page over the WebSocket: a light status
    /// frame twice a second, the globe data every two seconds.
    fn stream_telemetry(&mut self) {
        if self.ws.count() == 0 {
            return;
        }
        if self.last_stream.elapsed() >= Duration::from_millis(500) {
            self.last_stream = Instant::now();
            let msg = self.status_message();
            self.ws.broadcast(&msg.to_string());
        }
        if self.last_globe_stream.elapsed() >= Duration::from_millis(2000) {
            self.last_globe_stream = Instant::now();
            let msg = self.globe_message();
            self.ws.broadcast(&msg.to_string());
        }
    }

    /// The `status` telemetry frame the pages apply (also what `simulate` records).
    pub fn status_message(&self) -> serde_json::Value {
        let st = self.status();
        let msg = serde_json::json!({
            "type": "status",
            "build": env!("TC_BUILD"),
            "status": st,
            "clock": self.clock(),
            "hour": self.time_of_day() / 3600.0,
            "load": self.load_multiplier(),
            "fader": { "speed": self.fader.speed, "running": self.fader.running, "preset": self.fader.preset },
            "productions": self.production_samples(),
            "blackout": self.blackout_active,
            "muted": self.state.connections.iter().filter(|c| c.muted).count(),
            "log": self.log.iter().rev().take(12).collect::<Vec<_>>(),
            "wardbeck": self.crosspoints.recent_wb.iter().rev().take(8).collect::<Vec<_>>(),
            "continents": self.continent_totals(),
            "lines": self.lines().into_iter().take(60).collect::<Vec<_>>(),
            "run": { "id": self.recorder.current.id, "summary": self.recorder.current.summary },
            "dirty": self.dirty,
        });
        msg
    }

    /// The `globe-delta` telemetry frame (also what `simulate` records).
    pub fn globe_message(&mut self) -> serde_json::Value {
        // Just the deltas: trunks, calls and each frame's live count. The
        // page keeps the nodes it loaded with the HTML (or fetched once)
        // and asks for a full frame only when the fleet changes.
        let st = &self.state;
        let live: serde_json::Map<String, serde_json::Value> = st
            .frames
            .iter()
            .filter_map(|f| {
                let n = st.live_ports_of(&f.id).len();
                if n > 0 { Some((f.id.clone(), serde_json::json!(n))) } else { None }
            })
            .collect();
        let lease = self.fader.lease_seconds;
        let mut red: Vec<&str> = Vec::new();
        let mut parked: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for c in &st.connections {
            for f in [&c.from_frame, &c.to_frame] {
                if c.lease_left(self.sim_time, lease) <= 0.0 && !red.contains(&f.as_str()) {
                    red.push(f.as_str());
                }
                if c.muted {
                    let e = parked.entry(f.clone()).or_insert(serde_json::json!(0));
                    *e = serde_json::json!(e.as_u64().unwrap_or(0) + 1);
                }
            }
        }
        let now_i = Instant::now();
        self.blinks.retain(|_, until| *until > now_i);
        let blink: Vec<String> = self.blinks.keys().cloned().collect();
        let last: serde_json::Map<String, serde_json::Value> = st.last_activity.iter().map(|(f, a)| (f.clone(), serde_json::Value::String(a.who.clone()))).collect();
        let g = crate::html::globe_data(self);
        let msg = serde_json::json!({
            "type": "globe-delta",
            "frames": st.frames.len(),
            "clock": self.clock(),
            "trunkList": g["trunkList"],
            "history": g["history"], "today": g["today"],
            "callList": g["callList"],
            "live": live,
            "red": red,
            "parked": parked,
            "blink": blink,
            "last": last,
            "lights": crate::html::lights_json(self),
            "clusters": g["clusters"],
            "sites": g["sites"], "trunks": g["trunks"], "calls": g["calls"], "sims": g["sims"],
        });
        msg
    }

    fn reload_fader(&mut self) {
        if let Ok(f) = util::read_json::<Fader>(&self.layout.fader()) {
            if f.day.start_hour >= 0.0 && f.day.start_hour != self.fader.day.start_hour {
                // Re-anchor the day so "now" is the requested hour.
                self.day_start_secs = f.day.start_hour * 3600.0 - self.sim_time;
            }
            let mut f = Self::sane(f);
            self.resolve_productions(&mut f);
            if crate::recorder::Recorder::parameters_changed(&self.fader, &f) {
                self.fader = f;
                self.sync_productions();
                self.new_run("fader-file");
            }
        }
    }

    /// A production with no studio named (or one that does not exist) gets
    /// a capital's first frame, striding through the capitals so several
    /// productions land on different continents. Deterministic, so the
    /// file and the memory agree.
    fn resolve_productions(&self, f: &mut Fader) {
        let capitals: Vec<&Site> = self.sites.sites.iter().filter(|s| s.tier == Tier::Capital).collect();
        let n = capitals.len();
        for (i, p) in f.productions.iter_mut().enumerate() {
            if p.studio.is_empty() || self.state.frame(&p.studio).is_none() {
                if n == 0 {
                    continue;
                }
                let site = capitals[(i * 7 + 3) % n];
                if let Some(fr) = self.state.frames.iter().find(|fr| fr.site == site.name) {
                    p.studio = fr.id.clone();
                }
            }
            if let Some(fr) = self.state.frame(&p.studio) {
                p.trunks = p.trunks.clamp(1, fr.casters.max(1));
            }
        }
        // The Olympics venue: a capital on the far side of the list from
        // the productions.
        let o = &mut f.day.olympics;
        if (o.venue.is_empty() || self.state.frame(&o.venue).is_none()) && n > 0 {
            let site = capitals[(n / 2 + 1) % n];
            if let Some(fr) = self.state.frames.iter().find(|fr| fr.site == site.name) {
                o.venue = fr.id.clone();
            }
        }
        if let Some(fr) = self.state.frame(&o.venue) {
            o.trunks = o.trunks.clamp(1, fr.casters.max(1));
        }
    }

    /// The Olympics venue as a production, for the caller counters.
    fn olympics_production(&self) -> Production {
        let o = &self.fader.day.olympics;
        Production {
            enabled: o.enabled && self.fader.day.enabled,
            name: OLYMPICS.into(),
            studio: o.venue.clone(),
            trunks: o.trunks,
            calls_per_minute: o.calls_per_minute,
            mean_hold_seconds: o.mean_hold_seconds,
            start_hour: -1.0,
            end_hour: -1.0,
            every_minutes: 0.0,
            at_minute: 0.0,
            for_minutes: 0.0,
        }
    }

    /// The productions changed: every one starts its arrivals now and has
    /// a counter row.
    fn sync_productions(&mut self) {
        self.next_production_arrival = vec![self.sim_time; self.fader.productions.len()];
        for p in &self.fader.productions {
            let e = self.production_stats.entry(p.name.clone()).or_default();
            e.studio = p.studio.clone();
            e.trunks = p.trunks;
        }
    }

    /// Every production's counters right now.
    pub fn production_samples(&self) -> BTreeMap<String, ProductionSample> {
        let utc = self.time_of_day();
        let mut out = BTreeMap::new();
        for p in &self.fader.productions {
            let mut s = self.production_stats.get(&p.name).cloned().unwrap_or_default();
            s.studio = p.studio.clone();
            s.trunks = p.trunks;
            s.live = self.state.connections.iter().filter(|c| c.to_frame == p.studio && c.why.as_deref() == Some(p.name.as_str()) && !c.muted).count();
            s.trunks_used = self.state.used_casters(&p.studio);
            let lon = self.state.frame(&p.studio).and_then(|f| f.lon).unwrap_or(0.0);
            s.on_air = !self.blackout_active && p.on_air_at(DaySchedule::local_tod(utc, lon));
            out.insert(p.name.clone(), s);
        }
        let o = self.olympics_production();
        if o.enabled && self.state.frame(&o.studio).is_some() {
            let mut s = self.production_stats.get(OLYMPICS).cloned().unwrap_or_default();
            s.studio = o.studio.clone();
            s.trunks = o.trunks;
            s.live = self.state.connections.iter().filter(|c| c.to_frame == o.studio && c.why.as_deref() == Some(OLYMPICS) && !c.muted).count();
            s.trunks_used = self.state.used_casters(&o.studio);
            s.on_air = !self.blackout_active && self.fader.day.olympics.on_air_at(utc);
            out.insert(OLYMPICS.into(), s);
        }
        out
    }

    /// Apply an event preset: a complete fader, and the clock set just before
    /// its one major event, in local time where the event happens (the first
    /// production's studio, else the anchor zone).
    pub fn apply_preset(&mut self, id: &str) -> Result<Fader, String> {
        let p = presets(&self.fader).into_iter().find(|p| p.id == id).ok_or_else(|| format!("no event preset {id}"))?;
        let mut f = p.fader.clone();
        self.resolve_productions(&mut f);
        let offset = f.productions.first().and_then(|x| self.state.frame(&x.studio)).and_then(|fr| fr.lon).map(|lon| lon / 15.0).unwrap_or_else(|| self.globe.anchor().offset_hours);
        f.day.start_hour = p.start_utc_hour(offset);
        self.day_start_secs = f.day.start_hour * 3600.0 - self.sim_time;
        // Pressing the same event again restarts it, so it needs its own run.
        let same = !crate::recorder::Recorder::parameters_changed(&self.fader, &f);
        self.set_fader(f).map_err(|e| e.to_string())?;
        if same {
            self.new_run("preset");
        }
        let studios: Vec<String> = self.fader.productions.iter().map(|x| format!("{} at {} ({} trunks, {} callers/min)", x.name, x.studio, x.trunks, x.calls_per_minute)).collect();
        self.note(format!("event: {} applied, clock {} UTC{}{}", p.name, self.clock(), if studios.is_empty() { "" } else { ": " }, studios.join("; ")));
        Ok(self.fader.clone())
    }

    /// The fader is always ready to go: never NaN, never negative, never a
    /// zero interval that would spin.
    fn sane(mut f: Fader) -> Fader {
        let fix = |v: &mut f64, lo: f64, hi: f64, dflt: f64| {
            if !v.is_finite() {
                *v = dflt;
            }
            *v = v.clamp(lo, hi);
        };
        fix(&mut f.speed, 0.0, 3600.0, 1.0);
        fix(&mut f.requests_per_minute, 0.0, 100_000.0, 30.0);
        fix(&mut f.mean_hold_seconds, 1.0, 86_400.0, 90.0);
        fix(&mut f.crosscheck_every_seconds, 0.1, 86_400.0, 5.0);
        fix(&mut f.sample_every_seconds, 0.1, 86_400.0, 5.0);
        fix(&mut f.bookings_per_hour, 0.0, 10_000.0, 12.0);
        fix(&mut f.in_building_calls_per_hour, 0.0, 100_000.0, 100.0);
        let o = &mut f.day.olympics;
        fix(&mut o.hour, 0.0, 23.99, 19.0);
        fix(&mut o.hours, 0.25, 12.0, 2.0);
        fix(&mut o.peak, 1.0, 100.0, 5.0);
        fix(&mut o.calls_per_minute, 0.0, 100_000.0, 3000.0);
        fix(&mut o.mean_hold_seconds, 1.0, 86_400.0, 120.0);
        if o.trunks == 0 {
            o.trunks = 8;
        }
        fix(&mut f.day.hourly_news, 1.0, 100.0, 3.0);
        fix(&mut f.day.radio_prep, 1.0, 100.0, 2.0);
        fix(&mut f.day.overnight, 0.0, 1.0, 0.3);
        f.day.newscasts.retain(|n| n.hour.is_finite() && n.peak.is_finite());
        for n in &mut f.day.newscasts {
            n.hour = n.hour.rem_euclid(24.0);
            n.peak = n.peak.clamp(1.0, 100.0);
        }
        let mut seen: Vec<String> = Vec::new();
        for p in &mut f.productions {
            fix(&mut p.calls_per_minute, 0.0, 100_000.0, 1000.0);
            fix(&mut p.mean_hold_seconds, 1.0, 86_400.0, 90.0);
            fix(&mut p.start_hour, -1.0, 24.0, -1.0);
            fix(&mut p.end_hour, -1.0, 24.0, -1.0);
            if p.trunks == 0 {
                p.trunks = 8;
            }
            p.name = p.name.trim().to_string();
            if p.name.is_empty() {
                p.name = "Production".into();
            }
            while seen.contains(&p.name) {
                p.name.push_str(" 2");
            }
            seen.push(p.name.clone());
        }
        f
    }

    /// Quick fader: speed and run/pause only, the rest untouched.
    pub fn quick_fader(&mut self, speed: Option<f64>, running: Option<bool>) -> io::Result<Fader> {
        let mut f = self.fader.clone();
        if let Some(s) = speed {
            f.speed = s;
        }
        if let Some(r) = running {
            f.running = r;
        }
        self.set_fader(f)?;
        Ok(self.fader.clone())
    }

    /// Simulated time of day, seconds since midnight.
    pub fn time_of_day(&self) -> f64 {
        (self.day_start_secs + self.sim_time).rem_euclid(86_400.0)
    }

    /// The simulated day number, for the day-by-day trunk trends.
    pub fn sim_day(&self) -> i64 {
        ((self.day_start_secs + self.sim_time) / 86_400.0).floor() as i64
    }

    /// The simulated hour of day, 0..24.
    pub fn sim_hour(&self) -> usize {
        ((self.time_of_day() / 3600.0) as usize).min(23)
    }

    /// Current load multiplier from the news-cycle schedule.
    pub fn load_multiplier(&self) -> f64 {
        self.fader.day.multiplier(self.time_of_day())
    }

    /// "17:58:03" for the simulated clock.
    pub fn clock(&self) -> String {
        let t = self.time_of_day() as u64;
        format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60)
    }

    pub fn set_fader(&mut self, f: Fader) -> io::Result<()> {
        if f.day.start_hour >= 0.0 && f.day.start_hour != self.fader.day.start_hour {
            self.day_start_secs = f.day.start_hour * 3600.0 - self.sim_time;
        }
        let mut f = Self::sane(f);
        self.resolve_productions(&mut f);
        let changed = crate::recorder::Recorder::parameters_changed(&self.fader, &f);
        self.fader = f;
        util::write_json(&self.layout.fader(), &self.fader)?;
        self.pref("fader", None, serde_json::to_value(&self.fader).unwrap_or_default());
        if changed {
            self.sync_productions();
            self.new_run("fader");
        }
        Ok(())
    }

    /// A simulation parameter changed: close the run, start a fresh one, so
    /// every metric belongs to the parameters that produced it.
    fn new_run(&mut self, reason: &str) {
        let (id, s) = self.recorder.restart(&self.fader, &self.state.counters, self.sim_time, self.state.frames.len(), self.sites.sites.len(), reason);
        self.note(format!(
            "run {id} closed ({}): {} samples, {} granted, {} denied, peak {} live, avg channel util {:.0}%; new run started",
            reason,
            s.samples,
            s.granted,
            s.denied,
            s.peak_live,
            s.avg_channel_utilization * 100.0
        ));
        self.dirty = true;
    }

    // ----------------------------------------------------------------------
    // TRUNK-CASTER-INTERFACE
    // ----------------------------------------------------------------------

    fn process_interface(&mut self) -> io::Result<()> {
        let dir = self.layout.interface();
        let (pending, bad) = interface::scan::<Request>(&dir, REPLY_SUFFIX)?;
        self.bad_requests = bad;

        let present: std::collections::HashSet<String> = pending.iter().map(|p| p.id.clone()).collect();

        // Requests whose file disappeared: release.
        let gone: Vec<String> = self.honored.keys().filter(|id| !present.contains(*id)).cloned().collect();
        for id in gone {
            self.honored.remove(&id);
            interface::remove_answer(&dir, &id, REPLY_SUFFIX);
            if let Some(c) = self.state.release(&id) {
                self.finish_release(&c)?;
                self.note(format!("released {id} (request file removed) after {}s", c.connected_for(util::now_unix())));
            }
        }

        for p in pending {
            let retry = match self.honored.get(&p.id) {
                Some(h) if h.granted => false,
                Some(h) => h.last_attempt.elapsed() > Duration::from_secs(10),
                None => true,
            };
            if !retry {
                continue;
            }
            let mut req = p.body;
            req.id = Some(p.id.clone());
            let reply = self.handle_request(req, "interface");
            util::write_json(&interface::answer_path(&dir, &p.id, REPLY_SUFFIX), &reply)?;
            self.honored.insert(
                p.id.clone(),
                Honored { granted: reply.status == ReplyStatus::Granted, last_attempt: Instant::now() },
            );
        }
        Ok(())
    }

    /// Route a request from any origin, rename the ports after the caller,
    /// send any GPIO that came with it, and record it in TRUNK-USERS.
    pub fn handle_request(&mut self, mut req: Request, origin: &str) -> Reply {
        let id = match req.id.clone() {
            Some(id) if !id.trim().is_empty() => id,
            _ => {
                self.req_counter += 1;
                format!("req-{}-{:04}", util::now_unix(), self.req_counter)
            }
        };
        req.id = Some(id.clone());
        let expires = req.hold_seconds.map(|h| self.sim_time + h.max(0.0));

        // The daily reset: nothing connects between 11:00 and 12:00.
        if self.blackout_active {
            let reason = format!(
                "daily reset: everything is disconnected until {:02}:00 UTC on the simulated clock",
                self.fader.day.blackout.end_hour as u32
            );
            self.state.counters.denied += 1;
            let rec = users::from_request(&id, &req, origin, &Err(reason.clone()));
            self.queue_json(users::record_path(&self.layout.users(), &id), &rec);
            self.push_record(rec);
            self.dirty = true;
            return trunk_caster_sdk::client::reply(&id, ReplyStatus::Denied, None, Some(reason), util::now_iso());
        }

        // Park and sweep: a parked line between these frames is picked up
        // again, unmuted, with no new trunking.
        if let Some(parked) = self.state.find_parked(&req.from, &req.to) {
            if let Some(c) = self.state.unmute(&parked, &req.who, self.sim_time, req.hold_seconds) {
                self.note(format!("picked up parked line {} for {} ({} -> {}), reconnect #{}", c.id, c.who, c.from_frame, c.to_frame, c.reconnects));
                for mut g in req.gpio.clone() {
                    g.connection = Some(c.id.clone());
                    let _ = self.gpio(g);
                }
                let rec = users::from_request(&id, &req, origin, &Ok(c.clone()));
                self.queue_json(users::record_path(&self.layout.users(), &id), &rec);
                self.push_record(rec);
                let (day, hour) = (self.sim_day(), self.sim_hour());
                self.trends.used(&c, day, hour, &util::now_iso(), self.sim_time);
                self.dirty = true;
                let c = self.state.connection(&parked).cloned().unwrap_or(c);
                return trunk_caster_sdk::client::reply(&id, ReplyStatus::Granted, Some(c), Some("picked up a parked line".into()), util::now_iso());
            }
        }

        let mut outcome = self.state.route(RouteAsk {
            id: &id,
            who: &req.who,
            from: &req.from,
            to: &req.to,
            from_port: req.from_port,
            to_port: req.to_port,
            why: req.why.as_deref(),
            where_: req.where_.as_deref(),
            origin,
            sim_now: self.sim_time,
            expires_at_sim: expires,
        });

        // No capacity: a red line (lease run out, bandwidth on hold) touching
        // either frame is first priority to be reclaimed. Then try once more.
        if matches!(&outcome, Err(e) if e.contains("no capacity")) {
            let lease = self.fader.lease_seconds;
            if let Some(dead) = self.state.reclaim_for(&req.from, &req.to, self.sim_time, lease) {
                self.note(format!("reclaimed red line {} ({}, unused {}s) for {}", dead.id, dead.who, (self.sim_time - dead.last_used_sim) as u64, req.who));
                let _ = self.finish_release(&dead);
                self.state.counters.denied = self.state.counters.denied.saturating_sub(1);
                outcome = self.state.route(RouteAsk {
                    id: &id,
                    who: &req.who,
                    from: &req.from,
                    to: &req.to,
                    from_port: req.from_port,
                    to_port: req.to_port,
                    why: req.why.as_deref(),
                    where_: req.where_.as_deref(),
                    origin,
                    sim_now: self.sim_time,
                    expires_at_sim: expires,
                });
            }
        }

        let outcome = match outcome {
            Ok(c) => {
                let (from, fp, to, tp, who) = (c.from_frame.clone(), c.from_port, c.to_frame.clone(), c.to_port, c.who.clone());
                let (day, hour) = (self.sim_day(), self.sim_hour());
                self.trends.used(&c, day, hour, &util::now_iso(), self.sim_time);
                self.set_port_label(&from, fp, Label::new(&who), Some(&id), origin);
                self.set_port_label(&to, tp, Label::new(&who), Some(&id), origin);
                for mut g in req.gpio.clone() {
                    g.connection = Some(id.clone());
                    if let Err(e) = self.gpio(g) {
                        self.note(format!("gpio on {id} failed: {e}"));
                    }
                }
                // Re-read so the reply carries the GPIO count.
                Ok(self.state.connection(&id).cloned().unwrap_or(c))
            }
            Err(e) => Err(e),
        };

        let rec = users::from_request(&id, &req, origin, &outcome);
        self.queue_json(users::record_path(&self.layout.users(), &id), &rec);
        if origin == "simulator" {
            self.sim_on_disk.push_back(id.clone());
            self.prune_simulated();
        }
        self.push_record(rec);
        match &outcome {
            Ok(c) => self.note(format!(
                "granted {id}: {} -> {} for {} ({:?}, {} hop(s))",
                c.from_frame,
                c.to_frame,
                c.who,
                c.kind,
                c.hops.len()
            )),
            Err(e) => self.note(format!("denied {id}: {e}")),
        }
        self.dirty = true;
        trunk_caster_sdk::client::reply(
            &id,
            if outcome.is_ok() { ReplyStatus::Granted } else { ReplyStatus::Denied },
            outcome.as_ref().ok().cloned(),
            outcome.err(),
            util::now_iso(),
        )
    }

    /// Release from the HTTP API or the pages.
    pub fn release(&mut self, id: &str) -> Reply {
        let dir = self.layout.interface();
        let released = self.state.release(id);
        if let Some(c) = &released {
            let _ = self.finish_release(c);
            self.honored.remove(id);
            let _ = fs::remove_file(dir.join(format!("{id}.json")));
            interface::remove_answer(&dir, id, REPLY_SUFFIX);
            self.note(format!("released {id} after {}s", c.connected_for(util::now_unix())));
        }
        trunk_caster_sdk::client::reply(
            id,
            if released.is_some() { ReplyStatus::Released } else { ReplyStatus::Denied },
            released,
            None,
            util::now_iso(),
        )
    }

    fn finish_release(&mut self, c: &Connection) -> io::Result<()> {
        let sim_now = self.sim_time;
        let day = self.sim_day();
        self.trends.released(c, day, &util::now_iso(), sim_now);
        let path = users::record_path(&self.layout.users(), &c.id);
        let updated = match self.recent_records.iter_mut().find(|r| r.id == c.id) {
            Some(r) => {
                users::apply_release(r, c, sim_now);
                Some(r.clone())
            }
            None => None,
        };
        match updated {
            // The record is in memory: queue the rewrite, no disk read needed.
            Some(rec) => self.queue_json(path, &rec),
            // Older record: read and rewrite it inline.
            None => users::mark_released(&self.layout.users(), c, sim_now)?,
        }
        self.dirty = true;
        Ok(())
    }

    fn push_record(&mut self, rec: UserRecord) {
        self.recent_records.push_front(rec);
        self.recent_records.truncate(RECENT_RECORDS);
    }

    fn prune_simulated(&mut self) {
        let dir = self.layout.users();
        while self.sim_on_disk.len() > SIM_RECORDS_ON_DISK {
            if let Some(id) = self.sim_on_disk.pop_front() {
                let p = users::record_path(&dir, &id);
                // Never delete a record that is still queued to be written.
                self.pending_writes.retain(|(q, _)| q != &p);
                self.pending_deletes.push(p);
            }
        }
    }

    // ----------------------------------------------------------------------
    // Renames: the port takes the caller's name, and every vendor that
    // implements the frame's protocol is told in its own transport.
    // ----------------------------------------------------------------------

    /// Give a port a label (full name plus its 6/8/16 cuts). Logs an event
    /// when the name is longer than a 6- or 8-character panel shows, then
    /// tells every vendor in its own transport.
    pub fn set_port_label(&mut self, frame: &str, port: usize, label: Label, connection: Option<&str>, origin: &str) -> Vec<RenameDispatch> {
        let name = label.full.clone();
        let unchanged = self.state.label_of(frame, port) == Some(&label);
        let old = self.state.set_label(frame, port, label.clone());
        if unchanged {
            return Vec::new();
        }
        // Simulated callers all have long names; logging them would only
        // fill the disk. Real callers' long names are the point.
        if (label.over6 || label.over8) && origin != "simulator" {
            self.label_seq += 1;
            let ev = LabelEvent {
                seq: self.label_seq,
                at: util::now_iso(),
                frame: frame.into(),
                port: user_port(port),
                over: match (label.over6, label.over8) {
                    (true, true) => "over6,over8".into(),
                    (true, false) => "over6".into(),
                    _ => "over8".into(),
                },
                label: label.clone(),
                connection: connection.map(String::from),
                origin: origin.into(),
            };
            if let Ok(j) = serde_json::to_string(&ev) {
                let _ = util::append_line_capped(&self.layout.label_events(), &j, util::LOG_CAP);
            }
            if origin != "simulator" {
                self.note(format!(
                    "label \"{}\" is {} chars: shows as \"{}\" on 6, \"{}\" on 8, \"{}\" on 16",
                    label.full, label.chars, label.l6, label.l8, label.l16
                ));
            }
            self.recent_labels.push_back(ev);
            if self.recent_labels.len() > 200 {
                self.recent_labels.pop_front();
            }
        }
        let name = name.as_str();
        self.dispatch_rename(frame, port, name, old, connection, origin == "simulator")
    }

    fn dispatch_rename(&mut self, frame: &str, port: usize, name: &str, old: Option<String>, connection: Option<&str>, simulated: bool) -> Vec<RenameDispatch> {
        let vendors: Vec<String> = self.state.frame(frame).map(|f| f.implemented_by.clone()).unwrap_or_default();
        let now = util::now_iso();
        let port_label = user_port(port);
        let mut out = Vec::new();
        let mut sdk_vendors = Vec::new();

        for vendor in vendors {
            let Some(t) = self.policy.for_vendor(&vendor).cloned() else { continue };
            match t.transport.as_str() {
                "snmp" => {
                    self.rename_seq += 1;
                    let oid = format!("{}.{}", t.oid.clone().unwrap_or_else(|| "1.3.6.1.4.1.99999.1.2.1.3".into()), port + 1);
                    let community = t.community.clone().unwrap_or_else(|| "private".into());
                    let pdu = snmp::set_request(&community, &oid, name, (self.rename_seq % i32::MAX as u64) as i32);
                    let (payload_hex, mut detail) = match &pdu {
                        Some(p) => (
                            Some(snmp::hex(p)),
                            format!("SNMP v{} SET {oid} = \"{name}\" (community {community}, {} bytes)", t.version.clone().unwrap_or_else(|| "2c".into()), p.len()),
                        ),
                        None => (None, format!("SNMP SET not built: bad OID {oid}")),
                    };
                    let mut sent = false;
                    match (&t.target, &pdu) {
                        (Some(target), Some(p)) => match snmp::send(target, t.port.unwrap_or(161), p) {
                            Ok(n) => {
                                sent = true;
                                detail.push_str(&format!(" -> sent {n} bytes to {target}"));
                            }
                            Err(e) => detail.push_str(&format!(" -> send to {target} failed: {e}")),
                        },
                        (None, _) => detail.push_str(" -> not sent: no target in vendor-policy.json"),
                        _ => {}
                    }
                    if let Some(n) = &t.note {
                        detail.push_str(&format!(" [{n}]"));
                    }
                    out.push(RenameDispatch {
                        seq: self.rename_seq,
                        at: now.clone(),
                        frame: frame.into(),
                        port: port_label.clone(),
                        old_name: old.clone(),
                        new_name: name.into(),
                        vendor,
                        transport: "snmp".into(),
                        detail,
                        payload_hex,
                        target: t.target.clone(),
                        sent,
                        connection: connection.map(String::from),
                    });
                }
                "native" => {
                    self.rename_seq += 1;
                    out.push(RenameDispatch {
                        seq: self.rename_seq,
                        at: now.clone(),
                        frame: frame.into(),
                        port: port_label.clone(),
                        old_name: old.clone(),
                        new_name: name.into(),
                        vendor,
                        transport: "native".into(),
                        detail: format!("vendor API not wired yet{}", t.note.map(|n| format!(" [{n}]")).unwrap_or_default()),
                        payload_hex: None,
                        target: t.target.clone(),
                        sent: false,
                        connection: connection.map(String::from),
                    });
                }
                _ => sdk_vendors.push(vendor),
            }
        }
        if !sdk_vendors.is_empty() || out.is_empty() {
            self.rename_seq += 1;
            out.push(RenameDispatch {
                seq: self.rename_seq,
                at: now.clone(),
                frame: frame.into(),
                port: port_label.clone(),
                old_name: old.clone(),
                new_name: name.into(),
                vendor: sdk_vendors.join(", "),
                transport: "sdk".into(),
                detail: "kept in Trunk-Caster: shown in the frame's advertisement and Ward-Beck lines".into(),
                payload_hex: None,
                target: None,
                sent: true,
                connection: connection.map(String::from),
            });
        }

        // Simulated callers rename ports thousands of times an hour; only
        // real renames are worth a line on disk (all stay in memory).
        if !simulated {
            for d in &out {
                if let Ok(j) = serde_json::to_string(d) {
                    let _ = util::append_line_capped(&self.layout.renames_log(), &j, util::LOG_CAP);
                }
            }
        }
        for d in &out {
            self.recent_renames.push_back(d.clone());
        }
        while self.recent_renames.len() > 200 {
            self.recent_renames.pop_front();
        }
        self.dirty = true;
        out
    }

    /// Manual rename from the API, with optional explicit 6/8/16 cuts.
    pub fn rename(&mut self, r: Rename) -> Result<Vec<RenameDispatch>, String> {
        if self.state.frame(&r.frame).is_none() {
            return Err(format!("unknown frame {}", r.frame));
        }
        if r.port >= self.state.user_ports_of(&r.frame) {
            return Err(format!("{} has no user port {}", r.frame, r.port));
        }
        let label = Label::with_overrides(r.name.trim(), r.l6.as_deref(), r.l8.as_deref(), r.l16.as_deref());
        self.pref("rename", None, serde_json::to_value(&r).unwrap_or_default());
        let d = self.set_port_label(&r.frame, r.port, label.clone(), None, "http");
        self.note(format!("renamed {}:{} to \"{}\" [{} | {} | {}] ({} dispatch(es))", r.frame, user_port(r.port), label.full, label.l6, label.l8, label.l16, d.len()));
        // Relay ports keep their names in relay.json too.
        if let Some(m) = self.relay.matrices.iter_mut().find(|m| m.id == r.frame) {
            m.port_names.insert(user_port(r.port), label.full.clone());
            let _ = crate::relay::save_config(&self.layout, &self.relay);
        }
        Ok(d)
    }

    // ----------------------------------------------------------------------
    // Volume at multiple points
    // ----------------------------------------------------------------------

    /// `GET /api/taps`: the TAPS and Mixes mixer, a strip per connected frame
    /// and a fader per closed crosspoint.
    pub fn taps(&self) -> trunk_caster_sdk::Taps {
        let mut by_frame: BTreeMap<&str, Vec<&trunk_caster_sdk::Crosspoint>> = BTreeMap::new();
        for x in &self.crosspoints.current {
            by_frame.entry(x.frame.as_str()).or_default().push(x);
        }
        let voices = self.voices.lock().unwrap_or_else(|e| e.into_inner());
        let strips: Vec<trunk_caster_sdk::TapStrip> = by_frame.into_iter().map(|(frame, xs)| self.tap_strip_of(frame, xs, &voices)).collect();
        trunk_caster_sdk::Taps {
            frames: strips.len(),
            crosspoints: strips.iter().map(|s| s.faders.len()).sum(),
            trimmed: self.state.xp_gains.len(),
            strips,
        }
    }

    /// `GET /api/taps/<frame>`; None for an unknown frame.
    pub fn tap_strip(&self, frame: &str) -> Option<trunk_caster_sdk::TapStrip> {
        self.state.frame(frame)?;
        let xs: Vec<&trunk_caster_sdk::Crosspoint> = self.crosspoints.current.iter().filter(|x| x.frame == frame).collect();
        let voices = self.voices.lock().unwrap_or_else(|e| e.into_inner());
        Some(self.tap_strip_of(frame, xs, &voices))
    }

    fn tap_strip_of(&self, frame: &str, mut xs: Vec<&trunk_caster_sdk::Crosspoint>, voices: &crate::voices::Voices) -> trunk_caster_sdk::TapStrip {
        xs.sort_by(|a, b| (&a.input, &a.output).cmp(&(&b.input, &b.output)));
        let f = self.state.frame(frame);
        let site = f.map(|f| f.site.clone()).unwrap_or_default();
        trunk_caster_sdk::TapStrip {
            frame: frame.into(),
            protocol: f.map(|f| f.protocol.clone()).unwrap_or_default(),
            vendor: f.and_then(|f| f.badge.as_ref()).map(|b| b.vendor.clone()).unwrap_or_default(),
            accent: trunk_caster_sdk::voice::accent_of(f.and_then(|f| f.country.as_deref()).unwrap_or(""), &site, frame),
            site,
            kbps: voices.frame_kbps(frame),
            faders: xs
                .into_iter()
                .map(|x| trunk_caster_sdk::TapFader {
                    input: x.input.clone(),
                    output: x.output.clone(),
                    connection: x.connection.clone(),
                    who: self.state.connection(&x.connection).map(|c| c.who.clone()).unwrap_or_default(),
                    db: self.state.xp_gain_db(frame, &x.input, &x.output),
                })
                .collect(),
        }
    }

    /// `POST /api/taps/unity`: every crosspoint off unity (of one frame, or
    /// all) back to 0 dB, each change logged like any other gain.
    pub fn taps_unity(&mut self, u: trunk_caster_sdk::TapsUnity) -> Result<trunk_caster_sdk::TapsUnityResult, String> {
        if let Some(f) = &u.frame {
            if self.state.frame(f).is_none() {
                return Err(format!("no frame {f}"));
            }
        }
        let keys: Vec<(String, String, String)> = self
            .state
            .xp_gains
            .keys()
            .filter_map(|k| {
                let mut p = k.splitn(3, '|');
                Some((p.next()?.to_string(), p.next()?.to_string(), p.next()?.to_string()))
            })
            .filter(|(f, _, _)| u.frame.as_ref().is_none_or(|w| w == f))
            .collect();
        for (frame, input, output) in &keys {
            self.set_gain(GainSet {
                frame: Some(frame.clone()),
                input: Some(input.clone()),
                output: Some(output.clone()),
                trunk: None,
                end: None,
                connection: None,
                hop: None,
                db: 0.0,
                who: u.who.clone().or_else(|| Some("taps unity".into())),
            })?;
        }
        Ok(trunk_caster_sdk::TapsUnityResult { reset: keys.len() })
    }

    pub fn set_gain(&mut self, set: GainSet) -> Result<GainEvent, String> {
        let xp = match (&set.frame, &set.input, &set.output) {
            (Some(f), Some(i), Some(o)) => Some((f.clone(), i.clone(), o.clone())),
            _ => None,
        };
        let was = match (&set.trunk, &set.connection, &xp) {
            (Some(t), _, _) => self.state.set_trunk_gain(t, set.end.as_deref().unwrap_or("a"), set.db)?,
            (None, Some(c), _) => self.state.set_hop_gain(c, set.hop.unwrap_or(0), set.db)?,
            (None, None, Some((f, i, o))) => self.state.set_xp_gain(f, i, o, set.db)?,
            (None, None, None) => return Err("give trunk+end, connection+hop or frame+input+output".into()),
        };
        // Report the total along every call touched.
        let affected: Vec<Connection> = match (&set.trunk, &set.connection, &xp) {
            (Some(t), _, _) => self.state.connections.iter().filter(|c| c.hops.iter().any(|h| &h.trunk == t)).cloned().collect(),
            (None, Some(cid), _) => self.state.connection(cid).cloned().into_iter().collect(),
            (None, None, Some((f, i, o))) => self
                .crosspoints
                .current
                .iter()
                .filter(|x| &x.frame == f && &x.input == i && &x.output == o)
                .filter_map(|x| self.state.connection(&x.connection).cloned())
                .collect(),
            _ => Vec::new(),
        };
        let path_gain_db = affected.iter().map(|c| (c.id.clone(), self.state.path_gain_db(c))).collect();
        self.gain_seq += 1;
        self.pref("gain", set.who.as_deref(), serde_json::to_value(&set).unwrap_or_default());
        let ev = GainEvent { seq: self.gain_seq, at: util::now_iso(), set: set.clone(), was_db: was, path_gain_db };
        if let Ok(j) = serde_json::to_string(&ev) {
            let _ = util::append_line_capped(&self.layout.usage().join("gains.jsonl"), &j, util::LOG_CAP);
        }
        self.note(format!(
            "gain {} -> {:+.1} dB (was {:+.1}) on {}",
            set.who.as_deref().unwrap_or("operator"),
            set.db,
            was,
            set.trunk
                .as_ref()
                .map(|t| format!("{t} end {}", set.end.as_deref().unwrap_or("a")))
                .or_else(|| set.connection.as_ref().map(|c| format!("{c} hop {}", set.hop.unwrap_or(0))))
                .or_else(|| xp.as_ref().map(|(f, i, o)| format!("{f} crosspoint {i} -> {o}")))
                .unwrap_or_default()
        ));
        self.recent_gains.push_back(ev.clone());
        if self.recent_gains.len() > 200 {
            self.recent_gains.pop_front();
        }
        self.dirty = true;
        Ok(ev)
    }

    // ----------------------------------------------------------------------
    // Local sound card relay: bindings and events from the VU meters
    // ----------------------------------------------------------------------

    pub fn relay_bind(&mut self, b: RelayBinding) -> Result<RelayBinding, String> {
        let m = self.relay.matrices.iter_mut().find(|m| m.id == b.matrix).ok_or_else(|| format!("no relay matrix {}", b.matrix))?;
        if b.port >= m.io {
            return Err(format!("{} has {} ports", m.id, m.io));
        }
        let port = user_port(b.port);
        m.bindings.insert(port.clone(), b.clone());
        let pref_value = serde_json::to_value(&b).unwrap_or_default();
        if !m.port_names.contains_key(&port) {
            m.port_names.insert(port.clone(), b.device_label.clone());
        }
        let _ = crate::relay::save_config(&self.layout, &self.relay);
        self.pref("relay-bind", None, pref_value);
        let (matrix, label) = (b.matrix.clone(), b.device_label.clone());
        if self.state.port_name(&matrix, b.port).is_none() {
            self.set_port_label(&matrix, b.port, Label::new(&label), None, "relay");
        }
        self.relay_event(RelayEvent { seq: 0, at: String::new(), kind: "bind".into(), device_label: label, matrix: Some(matrix), port: Some(b.port), peak_dbfs: None, threshold_dbfs: None, note: Some(b.kind.clone()) });
        Ok(b)
    }

    pub fn relay_unbind(&mut self, matrix: &str, port: usize) -> Result<(), String> {
        let m = self.relay.matrices.iter_mut().find(|m| m.id == matrix).ok_or_else(|| format!("no relay matrix {matrix}"))?;
        let removed = m.bindings.remove(&user_port(port));
        let _ = crate::relay::save_config(&self.layout, &self.relay);
        self.pref("relay-unbind", None, serde_json::json!({ "matrix": matrix, "port": port }));
        if let Some(b) = removed {
            self.relay_event(RelayEvent { seq: 0, at: String::new(), kind: "unbind".into(), device_label: b.device_label, matrix: Some(matrix.into()), port: Some(port), peak_dbfs: None, threshold_dbfs: None, note: None });
        }
        Ok(())
    }

    /// Something the VU meters or device list noticed (browser side).
    pub fn relay_event(&mut self, mut ev: RelayEvent) -> RelayEvent {
        self.relay_seq += 1;
        ev.seq = self.relay_seq;
        ev.at = util::now_iso();
        if let Ok(j) = serde_json::to_string(&ev) {
            let _ = util::append_line_capped(&self.layout.relay_events(), &j, util::LOG_CAP);
        }
        if ev.kind == "over" {
            self.note(format!(
                "relay: {} peaked {:+.1} dBFS over {:+.1}{}",
                ev.device_label,
                ev.peak_dbfs.unwrap_or(0.0),
                ev.threshold_dbfs.unwrap_or(self.relay.over_threshold_dbfs),
                ev.matrix.as_ref().map(|m| format!(" on {m}:{}", user_port(ev.port.unwrap_or(0)))).unwrap_or_default()
            ));
        } else {
            self.note(format!("relay: {} {}", ev.kind, ev.device_label));
        }
        self.recent_relay_events.push_back(ev.clone());
        if self.recent_relay_events.len() > 300 {
            self.recent_relay_events.pop_front();
        }
        self.dirty = true;
        ev
    }

    // ----------------------------------------------------------------------
    // GPIO through the trunk caster
    // ----------------------------------------------------------------------

    /// A GPIO command rides the call's trunks and does what its pin means:
    /// 1 blink panel, 2 check lights, 3 set latch, 4 set listen, 5 unset
    /// latch, 6 clear, 7 last caller, 8 ping.
    pub fn gpio(&mut self, cmd: GpioCommand) -> Result<GpioEvent, String> {
        let cid = cmd.connection.clone().ok_or("gpio needs a connection id")?;
        let sim_now = self.sim_time;
        let lease = self.fader.lease_seconds;
        let function = cmd.function.unwrap_or_else(|| GpioFunction::from_pin(cmd.pin));
        let conn = self.state.connections.iter_mut().find(|c| c.id == cid).ok_or_else(|| format!("no live connection {cid}"))?;
        let simulated = conn.origin == "simulator";
        conn.gpio_sent += 1;
        // Using the line resets its green lease.
        conn.last_used_sim = sim_now;
        let (from, to) = (conn.from_frame.clone(), conn.to_frame.clone());
        let path: Vec<String> = std::iter::once(conn.from_frame.clone()).chain(conn.hops.iter().map(|h| h.to.clone())).collect();
        let trunks: Vec<String> = conn.hops.iter().map(|h| h.trunk.clone()).collect();
        let who = conn.who.clone();

        // Do what the key does.
        let result = match function {
            GpioFunction::SetLatch => {
                conn.latched = cmd.state;
                if cmd.state {
                    conn.muted = false;
                    conn.muted_at_sim = None;
                }
                serde_json::json!({ "latched": conn.latched, "listen": conn.listen })
            }
            GpioFunction::UnsetLatch => {
                conn.latched = false;
                serde_json::json!({ "latched": false, "listen": conn.listen })
            }
            GpioFunction::SetListen => {
                conn.listen = cmd.state;
                serde_json::json!({ "latched": conn.latched, "listen": conn.listen })
            }
            GpioFunction::Clear => {
                conn.latched = false;
                conn.listen = false;
                conn.muted = false;
                conn.muted_at_sim = None;
                serde_json::json!({ "latched": false, "listen": false, "cleared": true })
            }
            _ => serde_json::Value::Null,
        };
        let result = match function {
            GpioFunction::BlinkPanel => {
                let until = Instant::now() + Duration::from_secs(4);
                self.blinks.insert(from.clone(), until);
                self.blinks.insert(to.clone(), until);
                serde_json::json!({ "blinking": [from, to] })
            }
            GpioFunction::CheckLights => {
                let st = &self.state;
                let light = |f: &str| {
                    let live = st.connections.iter().filter(|c| c.from_frame == f || c.to_frame == f).count();
                    let parked = st.connections.iter().filter(|c| (c.from_frame == f || c.to_frame == f) && c.muted).count();
                    let red = st.connections.iter().any(|c| (c.from_frame == f || c.to_frame == f) && c.lease_left(sim_now, lease) <= 0.0);
                    serde_json::json!({ "frame": f, "live": live, "parked": parked, "red": red, "state": if red { "red" } else if live > 0 && parked == live { "parked" } else if live > 0 { "on" } else { "off" },
                        "last_caller": st.last_activity.get(f).map(|a| a.who.clone()), "simulator": self.remotes.frames.get(f).map(|r| r.connected) })
                };
                serde_json::json!({ "lights": path.iter().map(|f| light(f)).collect::<Vec<_>>() })
            }
            GpioFunction::LastCaller => {
                let st = &self.state;
                serde_json::json!({
                    "last_caller": path.iter().map(|f| serde_json::json!({ "frame": f, "who": st.last_activity.get(f).map(|a| a.who.clone()), "at": st.last_activity.get(f).map(|a| a.at.clone()) })).collect::<Vec<_>>()
                })
            }
            _ => result,
        };

        self.gpio_seq += 1;
        let ev = GpioEvent {
            seq: self.gpio_seq,
            at: util::now_iso(),
            sim_time: Some(self.sim_time),
            connection: cid,
            who,
            pin: cmd.pin,
            state: cmd.state,
            from_frame: from,
            to_frame: to,
            path,
            trunks,
            note: cmd.note,
            function: Some(function),
            result: if result.is_null() { None } else { Some(result) },
        };
        if !simulated {
            if let Ok(j) = serde_json::to_string(&ev) {
                let _ = util::append_line_capped(&self.layout.gpio_log(), &j, util::LOG_CAP);
            }
        }
        self.recent_gpio.push_back(ev.clone());
        if self.recent_gpio.len() > 200 {
            self.recent_gpio.pop_front();
        }
        if !simulated {
            self.note(format!(
                "gpio pin {} {} ({}) on {} rode {} -> {} via {}",
                ev.pin,
                if ev.state { "CLOSE" } else { "OPEN" },
                function.label(),
                ev.connection,
                ev.from_frame,
                ev.to_frame,
                ev.trunks.join(",")
            ));
        }
        self.dirty = true;
        Ok(ev)
    }

    // ----------------------------------------------------------------------
    // Capture START / STOP
    // ----------------------------------------------------------------------

    pub fn start_capture(&mut self, note: &str) -> Capture {
        if let Some(c) = self.capture.take() {
            let _ = self.finish_capture(c);
        }
        let c = crate::analyzer::start(&self.fader, self.sim_time, &self.clock(), self.state.frames.len(), self.sites.sites.len(), note);
        let _ = fs::create_dir_all(self.layout.captures_dir());
        self.note(format!("capture START {} at {} UTC{}", c.id, self.clock(), if note.is_empty() { String::new() } else { format!(": {note}") }));
        self.pref("capture-start", None, serde_json::json!({ "id": c.id, "note": note, "clock": self.clock() }));
        self.capture = Some(c.clone());
        self.dirty = true;
        c
    }

    pub fn stop_capture(&mut self) -> Option<Capture> {
        let c = self.capture.take()?;
        self.finish_capture(c)
    }

    fn finish_capture(&mut self, mut c: Capture) -> Option<Capture> {
        crate::analyzer::finish(&mut c, self.sim_time);
        let path = crate::analyzer::path_for(&self.layout, &c.id);
        if let Err(e) = util::write_json(&path, &c) {
            self.note(format!("capture {} could not be written: {e}", c.id));
        }
        self.note(format!(
            "capture STOP {}: {} samples over {} of simulated time, {} granted, {} denied, peak {} live; {} hourly, {} half-hour, {} quarter-hour check-ins",
            c.id,
            c.summary.samples,
            crate::html::dur(c.summary.duration_sim_seconds as u64),
            c.summary.granted,
            c.summary.denied,
            c.summary.peak_live,
            c.buckets.hour.len(),
            c.buckets.half_hour.len(),
            c.buckets.quarter_hour.len()
        ));
        self.pref("capture-stop", None, serde_json::json!({ "id": c.id, "samples": c.summary.samples }));
        self.dirty = true;
        Some(c)
    }

    /// The phone book: everyone who has called, where their name is on a
    /// panel right now, how often they call and when they were last seen.
    pub fn phone_book(&self) -> Vec<PhoneBookEntry> {
        let st = &self.state;
        let mut book: BTreeMap<String, PhoneBookEntry> = BTreeMap::new();
        fn entry<'a>(book: &'a mut BTreeMap<String, PhoneBookEntry>, who: &str) -> &'a mut PhoneBookEntry {
            book.entry(who.to_string()).or_insert_with(|| PhoneBookEntry {
                who: who.to_string(),
                label: Label::new(who),
                panels: Vec::new(),
                sites: Vec::new(),
                calls: 0,
                live_now: 0,
                last_seen: None,
                last_called: None,
                badge: None,
            })
        }
        for (key, name) in &st.port_names {
            let e = entry(&mut book, name);
            e.panels.push(key.clone());
            if let Some(frame) = key.split(':').next() {
                if let Some(f) = st.frame(frame) {
                    if !f.site.is_empty() && !e.sites.contains(&f.site) {
                        e.sites.push(f.site.clone());
                    }
                    if e.badge.is_none() {
                        e.badge = f.badge.clone();
                    }
                }
            }
            if let Some(l) = st.port_labels.get(key) {
                e.label = l.clone();
            }
        }
        for c in &st.connections {
            let e = entry(&mut book, &c.who);
            e.live_now += 1;
            e.last_called = Some(format!("{}:{}", c.to_frame, user_port(c.to_port)));
        }
        for r in &self.recent_records {
            let e = entry(&mut book, &r.who);
            e.calls += 1;
            if e.last_seen.as_deref().map_or(true, |s| s < r.when.as_str()) {
                e.last_seen = Some(r.when.clone());
                e.last_called = Some(r.whom.clone());
            }
        }
        let mut v: Vec<PhoneBookEntry> = book.into_values().collect();
        v.sort_by(|a, b| b.live_now.cmp(&a.live_now).then(b.last_seen.cmp(&a.last_seen)).then(a.who.cmp(&b.who)));
        v
    }

    // ----------------------------------------------------------------------
    // TRUNK-CROSS POINTS: panel seeks
    // ----------------------------------------------------------------------

    fn process_seeks(&mut self) -> io::Result<()> {
        let dir = self.layout.seeks_dir();
        let (pending, _bad) = interface::scan::<PanelSeek>(&dir, OFFER_SUFFIX)?;
        let present: std::collections::HashSet<String> = pending.iter().map(|p| p.id.clone()).collect();

        let before = self.offers.len();
        self.offers.retain(|o| present.contains(&o.seek_id) || o.seek_id.starts_with("http-"));
        let mut changed = self.offers.len() != before;

        for p in pending {
            if self.offers.iter().any(|o| o.seek_id == p.id) {
                continue;
            }
            let mut seek = p.body;
            seek.id = Some(p.id.clone());
            let offer = self.make_offer(seek);
            util::write_json(&interface::answer_path(&dir, &p.id, OFFER_SUFFIX), &offer)?;
            self.note(format!(
                "seek {}: {} on {} wants panel on {} -> {} allowed trunk(s)",
                offer.seek_id,
                offer.seek.who,
                offer.seek.from,
                offer.seek.panel_frame,
                offer.allowed_trunks.len()
            ));
            self.offers.push(offer);
            changed = true;
        }
        if changed {
            self.write_seeking()?;
            self.dirty = true;
        }
        Ok(())
    }

    pub fn make_offer(&mut self, mut seek: PanelSeek) -> PanelOffer {
        let id = match seek.id.clone() {
            Some(id) if !id.trim().is_empty() => id,
            _ => {
                self.req_counter += 1;
                format!("http-seek-{}-{:04}", util::now_unix(), self.req_counter)
            }
        };
        seek.id = Some(id.clone());
        let allowed = self.state.allowed_trunks(&seek.from, &seek.panel_frame, 12);
        PanelOffer { wire_version: WIRE_VERSION, seek, seek_id: id, offered_at: util::now_iso(), allowed_trunks: allowed }
    }

    /// Seek arriving over HTTP: advertised alongside the file-based ones.
    pub fn seek_http(&mut self, seek: PanelSeek) -> PanelOffer {
        let offer = self.make_offer(seek);
        self.offers.retain(|o| o.seek_id != offer.seek_id);
        self.offers.push(offer.clone());
        if self.offers.len() > 50 {
            let n = self.offers.len() - 50;
            self.offers.drain(..n);
        }
        let _ = self.write_seeking();
        self.dirty = true;
        offer
    }

    fn write_seeking(&self) -> io::Result<()> {
        util::write_json(&self.layout.seeking_json(), &self.offers)
    }

    // ----------------------------------------------------------------------
    // Simulator
    // ----------------------------------------------------------------------

    /// Calls whose hold ran out are parked (connected, muted); lines whose
    /// green lease ran out go red and are parked too (bandwidth on hold).
    /// The round-robin sweep releases what was parked before the last sweep.
    fn expire_simulated(&mut self) -> io::Result<()> {
        let parked = self.state.expire(self.sim_time);
        let red = self.state.hold_red(self.sim_time, self.fader.lease_seconds);
        if !parked.is_empty() || !red.is_empty() {
            self.dirty = true;
        }
        for id in &red {
            if let Some(c) = self.state.connection(id) {
                if c.origin != "simulator" {
                    self.note(format!("line {id} ({}) went red: lease of {}s ran out, bandwidth on hold", c.who, self.fader.lease_seconds as u64));
                }
            }
        }
        if self.sim_time >= self.next_sweep {
            let since = self.last_sweep;
            let released = self.state.sweep(since);
            for c in &released {
                self.finish_release(c)?;
            }
            if !released.is_empty() {
                self.note(format!("round-robin sweep: released {} parked line(s)", released.len()));
            }
            self.last_sweep = self.sim_time;
            self.next_sweep = self.sim_time + self.fader.round_robin_seconds.max(1.0);
        }
        Ok(())
    }

    /// The daily reset: at the blackout's start everything disconnects and
    /// every sender is reset (remotes get OPEN for everything, then an
    /// empty check-in); at its end traffic reconnects and a new run starts.
    fn daily_reset(&mut self) -> io::Result<()> {
        let now_in = self.fader.day.blackout.active_at(self.time_of_day());
        if now_in && !self.blackout_active {
            self.blackout_active = true;
            let released = self.state.release_all();
            for c in &released {
                self.finish_release(c)?;
            }
            // Push the OPEN lines now, then restate every remote frame as empty.
            let lines = self.crosspoints.sync(&self.state, Some(self.sim_time))?;
            self.push_lines(&lines);
            let frames: Vec<String> = self.remotes.frames.keys().cloned().collect();
            for f in frames {
                let state_lines = self.crosspoints.frame_state(&self.state, &f);
                for l in &state_lines {
                    self.hub.send(&f, l, &mut self.remotes);
                }
            }
            self.note(format!(
                "{} UTC daily reset: disconnected {} line(s), reset {} sender(s); reconnecting at {:02}:00",
                self.clock(),
                released.len(),
                self.remotes.frames.len(),
                self.fader.day.blackout.end_hour as u32
            ));
            self.pref("daily-reset", None, serde_json::json!({ "released": released.len(), "clock": self.clock() }));
            self.dirty = true;
        } else if !now_in && self.blackout_active {
            self.blackout_active = false;
            self.next_arrival = self.sim_time;
            let (id, s) = self.recorder.restart(&self.fader, &self.state.counters, self.sim_time, self.state.frames.len(), self.sites.sites.len(), "blackout-end");
            self.note(format!("{} UTC reconnect: traffic resumes; run {id} closed ({} granted, {} denied)", self.clock(), s.granted, s.denied));
            self.dirty = true;
        }
        Ok(())
    }

    fn synthetic_load(&mut self) -> io::Result<()> {
        if self.blackout_active || !self.fader.running || self.fader.speed <= 0.0 {
            self.next_arrival = self.sim_time;
            for t in &mut self.next_production_arrival {
                *t = self.sim_time;
            }
            self.next_building_arrival = self.sim_time;
            self.next_olympics_arrival = self.sim_time;
            return Ok(());
        }
        if self.state.frames.len() < 2 {
            return Ok(());
        }
        // Usage per region: every frame's own local time sets its weight, and
        // the fleet-wide rate is the baseline times the mean weight.
        let weights: Vec<f64> = self.state.frames.iter().map(|f| self.frame_multiplier(f)).collect();
        let mean_mult = weights.iter().sum::<f64>() / weights.len().max(1) as f64;
        let mut spawned = 0;
        if self.fader.requests_per_minute > 0.0 {
            while self.next_arrival <= self.sim_time && spawned < 200 {
                self.spawn_synthetic(&weights);
                spawned += 1;
                let rpm = self.fader.requests_per_minute * mean_mult;
                let mean_gap = 60.0 / rpm.max(0.01);
                self.next_arrival += self.rng.exponential(mean_gap);
            }
        } else {
            self.next_arrival = self.sim_time;
        }
        // Productions: callers from everywhere into one studio while it is
        // on air (studio local time). Busy signals are cheap: they never
        // reach the router.
        if self.next_production_arrival.len() != self.fader.productions.len() {
            self.next_production_arrival = vec![self.sim_time; self.fader.productions.len()];
        }
        let utc = self.time_of_day();
        for i in 0..self.fader.productions.len() {
            let p = self.fader.productions[i].clone();
            let Some(lon) = self.state.frame(&p.studio).map(|f| f.lon.unwrap_or(0.0)) else { continue };
            if !p.on_air_at(DaySchedule::local_tod(utc, lon)) || p.calls_per_minute <= 0.0 {
                self.next_production_arrival[i] = self.sim_time;
                continue;
            }
            let mean_gap = 60.0 / p.calls_per_minute;
            let mut n = 0;
            while self.next_production_arrival[i] <= self.sim_time && n < 2000 {
                self.spawn_production(&p, &weights);
                n += 1;
                let gap = self.rng.exponential(mean_gap);
                self.next_production_arrival[i] += gap;
            }
            // Fell more than a minute behind (the machine cannot keep up):
            // the callers who could not even get a dial tone count as busy.
            let behind = self.sim_time - self.next_production_arrival[i];
            if behind > 60.0 {
                let missed = (behind / mean_gap) as u64;
                let e = self.production_stats.entry(p.name.clone()).or_default();
                e.offered += missed;
                e.busy += missed;
                self.state.counters.denied += missed;
                self.next_production_arrival[i] = self.sim_time;
            }
            spawned += n;
        }
        // The Olympics: one moment for the whole globe, callers from
        // everywhere into the venue while it is on air.
        let o = self.olympics_production();
        if o.enabled && o.calls_per_minute > 0.0 && self.fader.day.olympics.on_air_at(utc) && self.state.frame(&o.studio).is_some() {
            let mean_gap = 60.0 / o.calls_per_minute;
            let mut n = 0;
            while self.next_olympics_arrival <= self.sim_time && n < 2000 {
                self.spawn_production(&o, &weights);
                n += 1;
                self.next_olympics_arrival += self.rng.exponential(mean_gap);
            }
            let behind = self.sim_time - self.next_olympics_arrival;
            if behind > 60.0 {
                let missed = (behind / mean_gap) as u64;
                let e = self.production_stats.entry(OLYMPICS.into()).or_default();
                e.offered += missed;
                e.busy += missed;
                self.state.counters.denied += missed;
                self.next_olympics_arrival = self.sim_time;
            }
            spawned += n;
        } else {
            self.next_olympics_arrival = self.sim_time;
        }
        // Calls inside the building: every site with two or more frames
        // calls between its own frames, a flat rate per site.
        if self.fader.in_building_calls_per_hour > 0.0 && self.next_building_arrival <= self.sim_time {
            let mut by_site: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
            for (i, f) in self.state.frames.iter().enumerate() {
                by_site.entry(f.site.as_str()).or_default().push(i);
            }
            let buildings: Vec<Vec<usize>> = by_site.into_values().filter(|v| v.len() >= 2).collect();
            if buildings.is_empty() {
                self.next_building_arrival = self.sim_time;
            } else {
                let mean_gap = 3600.0 / (self.fader.in_building_calls_per_hour * buildings.len() as f64);
                let mut n = 0;
                while self.next_building_arrival <= self.sim_time && n < 200 {
                    let b = &buildings[self.rng.below(buildings.len())];
                    let a = self.rng.below(b.len());
                    let mut c = self.rng.below(b.len() - 1);
                    if c >= a {
                        c += 1;
                    }
                    let (a, c) = (b[a], b[c]);
                    self.spawn_in_building(a, c);
                    n += 1;
                    self.next_building_arrival += self.rng.exponential(mean_gap);
                }
                if self.sim_time - self.next_building_arrival > 60.0 {
                    self.next_building_arrival = self.sim_time;
                }
                spawned += n;
            }
        }
        if spawned > 0 {
            self.dirty = true;
        }
        Ok(())
    }

    /// One intercom call inside a building: frame to frame at one site.
    fn spawn_in_building(&mut self, a: usize, b: usize) {
        self.sim_counter += 1;
        let from = self.state.frames[a].id.clone();
        let to = self.state.frames[b].id.clone();
        let hold = self.rng.exponential(self.fader.mean_hold_seconds.max(1.0));
        let who = SIM_NAMES[self.rng.below(SIM_NAMES.len())];
        let req = Request {
            id: Some(format!("bldg-{}-{:06}", self.boot_unix, self.sim_counter)),
            who: format!("{who} (in building)"),
            from,
            to,
            from_port: None,
            to_port: None,
            why: Some("in building".into()),
            where_: Some(format!("{} sim clock · {}", self.clock(), self.state.frames[a].site)),
            hold_seconds: Some(hold),
            gpio: Vec::new(),
        };
        let _ = self.handle_request(req, "simulator");
    }

    /// One caller into a production's studio. Busy when every trunk made
    /// available (or every user port) at the studio is taken.
    fn spawn_production(&mut self, p: &Production, weights: &[f64]) {
        let n = self.state.frames.len();
        let Some(si) = self.state.frames.iter().position(|f| f.id == p.studio) else { return };
        // The caller comes from wherever it is busy right now.
        let total: f64 = weights.iter().sum();
        let mut pick = self.rng.f64() * total;
        let mut a = 0;
        for (i, w) in weights.iter().enumerate() {
            if pick < *w {
                a = i;
                break;
            }
            pick -= w;
            a = i;
        }
        if a == si {
            a = (a + 1) % n;
        }
        let busy = self.state.used_casters(&p.studio) >= p.trunks || self.state.used_user_ports(&p.studio).len() >= self.state.user_ports_of(&p.studio);
        {
            let e = self.production_stats.entry(p.name.clone()).or_default();
            e.offered += 1;
            e.studio = p.studio.clone();
            e.trunks = p.trunks;
            e.on_air = true;
            if busy {
                e.busy += 1;
            }
        }
        if busy {
            self.state.counters.denied += 1;
            return;
        }
        self.sim_counter += 1;
        let from = self.state.frames[a].id.clone();
        let hold = self.rng.exponential(p.mean_hold_seconds.max(1.0));
        let who = SIM_NAMES[self.rng.below(SIM_NAMES.len())];
        let req = Request {
            id: Some(format!("prod-{}-{:06}", self.boot_unix, self.sim_counter)),
            who: format!("{who} (caller)"),
            from,
            to: p.studio.clone(),
            from_port: None,
            to_port: None,
            why: Some(p.name.clone()),
            where_: Some(format!("{} sim clock · {}", self.clock(), p.name)),
            hold_seconds: Some(hold),
            gpio: Vec::new(),
        };
        let reply = self.handle_request(req, "simulator");
        let e = self.production_stats.entry(p.name.clone()).or_default();
        if matches!(reply.status, ReplyStatus::Granted) {
            e.answered += 1;
        } else {
            e.busy += 1;
        }
    }

    fn spawn_synthetic(&mut self, weights: &[f64]) {
        self.sim_counter += 1;
        let n = self.state.frames.len();
        // The caller comes from wherever it is busy right now.
        let total: f64 = weights.iter().sum();
        let mut pick = self.rng.f64() * total;
        let mut a = 0;
        for (i, w) in weights.iter().enumerate() {
            if pick < *w {
                a = i;
                break;
            }
            pick -= w;
            a = i;
        }
        let mut b = self.rng.below(n - 1);
        if b >= a {
            b += 1;
        }
        let from = self.state.frames[a].id.clone();
        let to = self.state.frames[b].id.clone();
        let hold = self.rng.exponential(self.fader.mean_hold_seconds.max(1.0));
        let who = SIM_NAMES[self.rng.below(SIM_NAMES.len())];
        let why = SIM_REASONS[self.rng.below(SIM_REASONS.len())];
        let gpio = if self.rng.below(4) == 0 {
            vec![GpioCommand { connection: None, pin: 1 + self.rng.below(8) as u32, state: true, function: None, note: Some("call light".into()) }]
        } else {
            Vec::new()
        };
        let req = Request {
            id: Some(format!("sim-{}-{:06}", self.boot_unix, self.sim_counter)),
            who: format!("{who} (sim)"),
            from,
            to,
            from_port: None,
            to_port: None,
            why: Some(why.into()),
            where_: Some(format!("{} sim clock", self.clock())),
            hold_seconds: Some(hold),
            gpio,
        };
        let _ = self.handle_request(req, "simulator");
    }

    // ----------------------------------------------------------------------
    // Bookings: ports held for programs on the simulated clock
    // ----------------------------------------------------------------------

    /// The simulated clock as one number: seconds since midnight UTC of
    /// simulated day 0. Bookings are kept on this clock so a 09:30 booking
    /// stays at 09:30 across restarts and clock moves.
    pub fn clock_abs(&self) -> f64 {
        self.day_start_secs + self.sim_time
    }

    /// UTC time of day (seconds) at absolute clock `t`.
    pub fn tod_at(&self, t: f64) -> f64 {
        t.rem_euclid(86_400.0)
    }

    /// A frame's offset from UTC, seconds (by its longitude, as the day
    /// schedule reckons it).
    pub fn frame_offset_secs(&self, frame: &str) -> f64 {
        self.state.frame(frame).and_then(|f| f.lon).map(|lon| lon / 15.0 * 3600.0).unwrap_or(0.0)
    }

    /// The next simulated time a frame's local clock reads `hour`.
    fn next_local(&self, frame: &str, hour: f64) -> f64 {
        let utc = hour * 3600.0 - self.frame_offset_secs(frame);
        self.clock_abs() + (utc - self.time_of_day()).rem_euclid(86_400.0)
    }

    /// Book a port from the editor or the API.
    pub fn book(&mut self, ask: crate::bookings::BookingAsk) -> Result<crate::bookings::Booking, String> {
        use crate::bookings::*;
        let f = self.state.frame(&ask.frame).ok_or_else(|| format!("no frame {}", ask.frame))?;
        if ask.port >= f.user_ports {
            return Err(format!("{} has ports U00..U{:02}", f.id, f.user_ports.saturating_sub(1)));
        }
        if let Some(to) = ask.to.as_deref().filter(|t| !t.is_empty()) {
            if to == ask.frame || self.state.frame(to).is_none() {
                return Err(format!("cannot book a call to {to}"));
            }
        }
        if !ask.start_hour.is_finite() || !(0.0..24.0).contains(&ask.start_hour) {
            return Err("start must be 00:00 to 23:59".into());
        }
        let minutes = if ask.minutes.is_finite() { ask.minutes.clamp(1.0, 24.0 * 60.0) } else { 60.0 };
        let program = ask.program.trim();
        if program.is_empty() {
            return Err("name the program".into());
        }
        let start = self.next_local(&ask.frame, ask.start_hour);
        let end = start + minutes * 60.0;
        if let Some(b) = self.bookings.clash(&ask.frame, ask.port, start, end) {
            return Err(format!("{}:{} is already booked for {} ({})", ask.frame, user_port(ask.port), b.program, b.id));
        }
        let b = Booking {
            id: self.bookings.new_id("editor"),
            frame: ask.frame.clone(),
            port: ask.port,
            kind: ask.kind,
            program: program.to_string(),
            who: ask.who.clone().filter(|w| !w.trim().is_empty()).unwrap_or_else(|| "operator".into()),
            to: ask.to.clone().filter(|t| !t.is_empty()),
            start,
            end,
            daily: ask.daily,
            source: "editor".into(),
            status: BookingStatus::Booked,
            connection: None,
            reason: None,
            created_at: util::now_iso(),
        };
        self.note(format!("booked {} {}:{} for {} ({} min{})", b.id, b.frame, user_port(b.port), b.program, minutes as u64, if b.daily { ", daily" } else { "" }));
        self.pref("booking", Some(&b.who.clone()), serde_json::json!({ "id": b.id, "frame": b.frame, "port": b.port, "program": b.program, "to": b.to, "minutes": minutes, "daily": b.daily }));
        self.bookings.add(b.clone());
        self.dirty = true;
        Ok(b)
    }

    /// Cancel a booking; one on air is released.
    pub fn cancel_booking(&mut self, id: &str) -> Result<(), String> {
        let b = self.bookings.list.iter().find(|b| b.id == id).cloned().ok_or_else(|| format!("no booking {id}"))?;
        if let Some(c) = &b.connection {
            if b.status == crate::bookings::BookingStatus::OnAir {
                self.release(c);
            }
        }
        self.bookings.list.retain(|x| x.id != id);
        self.bookings.dirty = true;
        self.dirty = true;
        self.note(format!("booking {id} cancelled ({})", b.program));
        Ok(())
    }

    /// Start what is due, finish what has ended, re-arm daily bookings, and
    /// let the simulated traffic book ahead.
    fn run_bookings(&mut self) {
        use crate::bookings::BookingStatus as S;
        let now = self.clock_abs();
        for i in 0..self.bookings.list.len() {
            let (status, start, end, conn) = {
                let b = &self.bookings.list[i];
                (b.status, b.start, b.end, b.connection.clone())
            };
            match status {
                S::Booked if now >= end => self.finish_booking(i, S::Missed, Some("the window passed before it could start".into())),
                S::Booked if now >= start && !self.blackout_active => self.start_booking(i),
                S::OnAir if now >= end => {
                    if let Some(c) = &conn {
                        if self.state.connection(c).is_some() {
                            self.release(c);
                        }
                    }
                    self.finish_booking(i, S::Done, None);
                }
                // The call went away early (daily reset, released by hand).
                S::OnAir if conn.as_deref().is_some_and(|c| self.state.connection(c).is_none()) => {
                    self.finish_booking(i, S::Done, Some("the call ended before the booking did".into()))
                }
                _ => {}
            }
        }
        let sim_now = self.sim_time;
        if self.fader.running && !self.blackout_active && self.fader.speed > 0.0 && self.fader.bookings_per_hour > 0.0 {
            let mut n = 0;
            while self.next_sim_booking <= sim_now && n < 50 {
                self.sim_booking();
                n += 1;
                self.next_sim_booking += self.rng.exponential(3600.0 / self.fader.bookings_per_hour);
            }
            if n == 50 {
                self.next_sim_booking = sim_now;
            }
        } else {
            self.next_sim_booking = sim_now;
        }
        self.bookings.prune(now);
        if self.bookings.dirty {
            self.dirty = true;
        }
    }

    fn start_booking(&mut self, i: usize) {
        use crate::bookings::BookingStatus as S;
        let b = self.bookings.list[i].clone();
        let busy = self.state.used_user_ports(&b.frame).contains(&b.port);
        let Some(to) = b.to.clone() else {
            if busy {
                self.finish_booking(i, S::Failed, Some(format!("{} was in use", user_port(b.port))));
            } else {
                self.bookings.list[i].status = S::OnAir;
                self.bookings.dirty = true;
            }
            return;
        };
        let req = Request {
            id: Some(format!("book-{}-{}", self.boot_unix, b.id)),
            who: b.who.clone(),
            from: b.frame.clone(),
            to,
            from_port: Some(b.port),
            to_port: None,
            why: Some(b.program.clone()),
            where_: Some(format!("booking {} · {}", b.id, b.program)),
            hold_seconds: Some((b.end - self.clock_abs()).max(1.0)),
            gpio: Vec::new(),
        };
        let origin = if b.source == "simulator" { "simulator" } else { "booking" };
        let reply = self.handle_request(req, origin);
        match (reply.status, reply.connection) {
            (ReplyStatus::Granted, Some(c)) => {
                // Latched for the window: never parked, never red, never
                // swept; the booking releases it at its end.
                if let Some(line) = self.state.connections.iter_mut().find(|x| x.id == c.id) {
                    line.latched = true;
                }
                let bk = &mut self.bookings.list[i];
                bk.status = S::OnAir;
                bk.connection = Some(c.id);
                self.bookings.dirty = true;
                if b.source != "simulator" {
                    self.note(format!("booking {} on air: {} on {}:{}", b.id, b.program, b.frame, user_port(b.port)));
                }
            }
            _ => self.finish_booking(i, S::Failed, Some(reply.reason.unwrap_or_else(|| "refused".into()))),
        }
    }

    /// Close a booking; a daily one goes back on the timeline for tomorrow.
    fn finish_booking(&mut self, i: usize, status: crate::bookings::BookingStatus, reason: Option<String>) {
        let now = self.clock_abs();
        let b = &mut self.bookings.list[i];
        if b.daily {
            let day = 86_400.0;
            let ahead = ((now - b.start) / day).floor().max(0.0) + 1.0;
            b.start += ahead * day;
            b.end += ahead * day;
            b.status = crate::bookings::BookingStatus::Booked;
            b.connection = None;
            b.reason = reason.map(|r| format!("last time: {r}"));
        } else {
            b.status = status;
            b.reason = reason;
        }
        self.bookings.dirty = true;
    }

    /// The booking desk of the simulated traffic: a port somewhere busy,
    /// held for a production or a routine program a little ahead of time.
    fn sim_booking(&mut self) {
        use crate::bookings::*;
        if self.bookings.sim_upcoming() >= SIM_UPCOMING_CAP || self.state.frames.len() < 2 {
            return;
        }
        let weights: Vec<f64> = self.state.frames.iter().map(|f| self.frame_multiplier(f)).collect();
        let total: f64 = weights.iter().sum();
        let mut pick = self.rng.f64() * total;
        let mut a = 0;
        for (i, w) in weights.iter().enumerate() {
            a = i;
            if pick < *w {
                break;
            }
            pick -= w;
        }
        let frame = self.state.frames[a].id.clone();
        let ports = self.state.frames[a].user_ports;
        if ports == 0 {
            return;
        }
        let lead = 10.0 * 60.0 + self.rng.f64() * 4.0 * 3600.0;
        let minutes = self.rng.exponential(40.0).clamp(15.0, 180.0).round();
        let start = self.clock_abs() + lead;
        let end = start + minutes * 60.0;
        let mut port = self.rng.below(ports);
        let mut tries = 0;
        while self.bookings.clash(&frame, port, start, end).is_some() && tries < 8 {
            port = self.rng.below(ports);
            tries += 1;
        }
        if self.bookings.clash(&frame, port, start, end).is_some() {
            return;
        }
        // A production's studio, or a routine program to another frame.
        let prods: Vec<(String, String)> = self
            .fader
            .productions
            .iter()
            .filter(|p| p.enabled && p.studio != frame && self.state.frame(&p.studio).is_some())
            .map(|p| (p.name.clone(), p.studio.clone()))
            .collect();
        let (program, to) = if !prods.is_empty() && self.rng.below(2) == 0 {
            prods[self.rng.below(prods.len())].clone()
        } else {
            let mut b = self.rng.below(self.state.frames.len() - 1);
            if b >= a {
                b += 1;
            }
            (SIM_REASONS[self.rng.below(SIM_REASONS.len())].to_string(), self.state.frames[b].id.clone())
        };
        let kind = if self.rng.below(4) == 0 { PortKind::Input } else { PortKind::Panel };
        let who = SIM_NAMES[self.rng.below(SIM_NAMES.len())];
        let b = Booking {
            id: self.bookings.new_id("simulator"),
            frame,
            port,
            kind,
            program,
            who: format!("{who} (booking desk)"),
            to: Some(to),
            start,
            end,
            daily: false,
            source: "simulator".into(),
            status: BookingStatus::Booked,
            connection: None,
            reason: None,
            created_at: util::now_iso(),
        };
        self.bookings.add(b);
    }

    fn run_crosscheck(&mut self) {
        let cc = self.state.crosscheck();
        self.crosschecks_ok += cc.ok as u64;
        self.crosschecks_failed += cc.failures.len() as u64;
        if !cc.failures.is_empty() {
            let shown: Vec<&String> = cc.failures.iter().take(3).collect();
            self.note(format!("CROSS-CHECK FAILED ({}): {:?}", cc.failures.len(), shown));
        }
        self.last_crosscheck = cc;
    }

    fn sample(&mut self) -> io::Result<()> {
        // Calls held an hour or more lock their trunks for today, this hour.
        let (day, hour) = (self.sim_day(), self.sim_hour());
        self.trends.observe(&self.state.connections, self.sim_time, day, hour, &util::now_iso());
        let s = Sample {
            sim_time: self.sim_time,
            wall_time: util::now_iso(),
            active: self.state.connections.len(),
            active_via: self.state.connections.iter().filter(|c| c.kind == RouteKind::Via).count(),
            trunks: self.state.trunks.len(),
            granted_total: self.state.counters.granted,
            granted_via_total: self.state.counters.granted_via,
            denied_total: self.state.counters.denied,
            released_total: self.state.counters.released,
            channel_utilization: self.state.channel_utilization(),
            caster_utilization: self.state.caster_utilization(),
            crosschecks_ok: self.crosschecks_ok,
            crosschecks_failed: self.crosschecks_failed,
            time_of_day: self.time_of_day(),
            load_multiplier: self.load_multiplier(),
            muted: self.state.connections.iter().filter(|c| c.muted).count(),
            blackout: self.blackout_active,
            continents: self.calls_per_continent(),
            productions: self.production_samples(),
        };
        self.recorder.sample(&s, &self.state.counters);
        if let Some(c) = &mut self.capture {
            crate::analyzer::record(c, &s);
            // Keep the file on disk fresh every fifteen samples, so a crash
            // never loses more than a minute or so of a long capture.
            if c.samples.len() % 15 == 0 {
                let (p, t) = (crate::analyzer::path_for(&self.layout, &c.id), serde_json::to_string(&c).unwrap_or_default());
                self.queue_text(p, t);
            }
        }
        let (rp, rt) = self.recorder.current_file();
        self.queue_text(rp, rt);
        self.timeline.wire_version = WIRE_VERSION;
        self.timeline.samples.push(s);
        if self.timeline.samples.len() > MAX_SAMPLES {
            let n = self.timeline.samples.len() - MAX_SAMPLES;
            self.timeline.samples.drain(..n);
        }
        let path = self.layout.timeline();
        let text = serde_json::to_string_pretty(&self.timeline).map_err(io::Error::other)?;
        self.queue_text(path, text);
        self.dirty = true;
        Ok(())
    }

    // ----------------------------------------------------------------------
    // Persistence and pages
    // ----------------------------------------------------------------------

    /// Write everything that changed: state, advertisements, crosspoints,
    /// and (at most every ten seconds; the live pages refresh themselves
    /// from the server) the static HTML pages in every folder.
    pub fn persist(&mut self) -> io::Result<()> {
        self.state.updated_at = util::now_iso();
        let state_path = self.layout.usage_state();
        let state_text = serde_json::to_string_pretty(&self.state).map_err(io::Error::other)?;
        self.queue_text(state_path, state_text);
        let lines = self.crosspoints.sync(&self.state, Some(self.sim_time))?;
        self.push_lines(&lines);
        self.write_advertisements()?;
        if self.last_pages.elapsed() >= Duration::from_secs(10) {
            self.render_pages();
            self.last_pages = Instant::now();
            if self.trends.dirty {
                let text = serde_json::to_string(&self.trends).unwrap_or_default();
                self.queue_text(self.layout.trends_json(), text);
                self.trends.dirty = false;
            }
        }
        if self.bookings.dirty {
            self.bookings.clock_at_save = Some(self.clock_abs());
            let text = serde_json::to_string_pretty(&self.bookings).unwrap_or_default();
            self.queue_text(self.layout.bookings_json(), text);
            self.bookings.dirty = false;
        }
        self.dirty = false;
        self.last_persist = Instant::now();
        Ok(())
    }

    /// Final flush on shutdown or a bounded run: pages too.
    pub fn persist_all(&mut self) -> io::Result<()> {
        self.last_pages = Instant::now() - Duration::from_secs(60);
        self.persist()
    }

    fn advertisement_of(&self, f: &Frame, now_unix: u64, now_iso: &str) -> Frame {
        let mut f = f.clone();
        f.caster_status = self.state.caster_ads(&f.id);
        f.free_casters = self.state.free_casters(&f.id);
        f.port_names = self.state.port_names_of(&f.id);
        f.port_labels = self.state.labels_of(&f.id);
        f.live_ports = self.state.live_ports_of(&f.id);
        f.last_connection = self.state.last_activity.get(&f.id).cloned();
        f.seconds_since_last_connection = self.state.seconds_since_last(&f.id, now_unix);
        f.endpoint = Some(self.endpoint.clone());
        f.advertised_at = now_iso.to_string();
        f
    }

    /// One JSON per frame in TRUNK-ADVERTISEMENT; only rewritten when
    /// something about the frame changed.
    pub fn write_advertisements(&mut self) -> io::Result<()> {
        let dir = self.layout.advertisement();
        let now = util::now_unix();
        let now_iso = util::iso(now);
        let frames: Vec<Frame> = self.state.frames.clone();
        let mut written = 0;
        for f in &frames {
            let ad = self.advertisement_of(f, now, &now_iso);
            let key = serde_json::to_string(&(&ad.caster_status, &ad.port_names, &ad.live_ports, &ad.last_connection)).unwrap_or_default();
            if self.advertised.get(&f.id) == Some(&key) {
                continue;
            }
            self.queue_json(dir.join(format!("{}.json", f.id)), &ad);
            self.advertised.insert(f.id.clone(), key);
            written += 1;
        }
        if written > 0 {
            if let Ok(rd) = fs::read_dir(&dir) {
                for e in rd.filter_map(Result::ok) {
                    let p = e.path();
                    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                    if p.extension().map_or(false, |x| x == "json") && self.state.frame(&stem).is_none() {
                        let _ = fs::remove_file(&p);
                    }
                }
            }
        }
        Ok(())
    }

    /// Render every static page and queue it for writing.
    pub fn render_pages(&mut self) {
        let pages: Vec<(PathBuf, String)> = vec![
            (self.layout.usage().join("index.html"), crate::html::usage_page(self, false)),
            (self.layout.space_html(), crate::html::space_page(self, false)),
            (self.layout.usage().join("overlord.html"), crate::html::overlord_page(self, false)),
            (self.layout.users().join("index.html"), crate::html::users_page(self, false)),
            (self.layout.cross_points().join("index.html"), crate::html::crosspoints_page(self, false)),
            (self.layout.simulator().join("index.html"), crate::html::simulator_page(self, false)),
            (self.layout.simulator().join("racks.html"), crate::html::racks_page(self, false)),
            (self.layout.relay().join("index.html"), crate::html::relay_page(self, false)),
        ];
        for (p, t) in pages {
            self.queue_text(p, t);
        }
        let relay = crate::relay::snapshot(self);
        self.queue_json(self.layout.relay_state(), &relay);
        // The globe is managed from TRUNK-GLOBAL; the continents overview
        // and the about page live beside it.
        let globe = crate::html::globe_page(self, false);
        self.queue_text(self.layout.global().join("index.html"), globe);
        let continents = crate::html::continents_page(self, false);
        self.queue_text(self.layout.global().join("continents.html"), continents);
        let about = crate::html::index_page(self);
        self.queue_text(self.layout.global().join("about.html"), about);
        let panels = crate::html::panels_page(self, false);
        self.queue_text(self.layout.global().join("panels.html"), panels);
        let editor = crate::html::panel_editor_page(self, None, None, false);
        self.queue_text(self.layout.global().join("panel-editor.html"), editor);
        let regions = self.regions();
        self.queue_json(self.layout.regions_json(), &regions);
    }

    pub fn status(&self) -> Status {
        Status {
            wire_version: WIRE_VERSION,
            root: self.layout.root.clone(),
            endpoint: self.endpoint.clone(),
            shape: self.shape,
            protocols: self.repertoire.protocols.len(),
            frames: self.state.frames.len(),
            trunks: self.state.trunks.len(),
            connections: self.state.connections.len(),
            sim_time: self.sim_time,
            fader: self.fader.clone(),
            updated_at: util::now_iso(),
            remote_frames: self.remotes.frames.len(),
            remotes_connected: self.remotes.frames.values().filter(|r| r.connected).count(),
            wb_endpoint: self.wb_endpoint.clone(),
            sites: self.sites.sites.len(),
            clock: self.clock(),
            blackout: self.blackout_active,
            muted: self.state.connections.iter().filter(|c| c.muted).count(),
            capturing: self.capture.as_ref().map(|c| c.id.clone()),
            mqtt: self.hub.mqtt_stats(),
        }
    }

    /// Live calls touching each continent (a call counts for both ends).
    pub fn calls_per_continent(&self) -> BTreeMap<String, usize> {
        let mut m: BTreeMap<String, usize> = BTreeMap::new();
        for c in &self.state.connections {
            let a = self.state.frame(&c.from_frame).and_then(|f| f.continent.clone()).unwrap_or_else(|| "Other".into());
            let b = self.state.frame(&c.to_frame).and_then(|f| f.continent.clone()).unwrap_or_else(|| "Other".into());
            *m.entry(a.clone()).or_default() += 1;
            if b != a {
                *m.entry(b).or_default() += 1;
            }
        }
        m
    }

    /// Calls between continents, for the totals beside the globe and the
    /// Overlord's submarine-cable view: (from, to, ocean) -> count. Calls
    /// that do not leave their continent are counted under their own name.
    pub fn continent_totals(&self) -> Vec<serde_json::Value> {
        let mut m: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
        for c in &self.state.connections {
            let a = self.state.frame(&c.from_frame).and_then(|f| f.continent.clone()).unwrap_or_else(|| "Other".into());
            let b = self.state.frame(&c.to_frame).and_then(|f| f.continent.clone()).unwrap_or_else(|| "Other".into());
            let key = if a <= b { (a, b) } else { (b, a) };
            let e = m.entry(key).or_default();
            e.0 += 1;
            if c.muted {
                e.1 += 1;
            }
        }
        m.into_iter()
            .map(|((a, b), (calls, muted))| {
                serde_json::json!({
                    "from": a, "to": b, "ocean": ocean_between(&a, &b), "calls": calls, "muted": muted,
                    "crossing": a != b,
                })
            })
            .collect()
    }

    /// The discovery tree: Global → continent → country → site (province,
    /// state, city, capital) → device, with stats at every level.
    pub fn tree(&self) -> serde_json::Value {
        use std::collections::BTreeMap as M;
        let st = &self.state;
        let utc = self.time_of_day();
        let now = util::now_unix();
        // frame -> (live calls, parked)
        let mut per_frame: M<&str, (usize, usize)> = M::new();
        for c in &st.connections {
            for f in [&c.from_frame, &c.to_frame] {
                let e = per_frame.entry(f.as_str()).or_default();
                e.0 += 1;
                if c.muted {
                    e.1 += 1;
                }
            }
        }
        let site_meta: M<&str, &Site> = self.sites.sites.iter().map(|s| (s.name.as_str(), s)).collect();
        // continent -> country -> site -> frames
        let mut tree: M<String, M<String, M<String, Vec<&Frame>>>> = M::new();
        for f in &st.frames {
            let cont = f.continent.clone().unwrap_or_else(|| if f.protocol == crate::relay::PROTOCOL { "This computer".into() } else { "Other".into() });
            let country = f.country.clone().unwrap_or_else(|| self.site.clone());
            let site = if f.site.is_empty() { self.site.clone() } else { f.site.clone() };
            tree.entry(cont).or_default().entry(country).or_default().entry(site).or_default().push(f);
        }
        let dev = |f: &Frame| {
            let (calls, parked) = per_frame.get(f.id.as_str()).copied().unwrap_or((0, 0));
            serde_json::json!({
                "id": f.id, "protocol": f.protocol_name, "badge": f.badge, "ports": f.user_ports, "casters": f.casters,
                "free_casters": st.free_casters(&f.id), "calls": calls, "parked": parked,
                "panels_live": st.live_ports_of(&f.id).len(), "since": st.seconds_since_last(&f.id, now),
                "sim": self.remotes.frames.get(&f.id).map(|r| r.connected),
            })
        };
        let sum = |devs: &[serde_json::Value], key: &str| -> u64 { devs.iter().map(|d| d[key].as_u64().unwrap_or(0)).sum() };
        let mut continents = Vec::new();
        for (cont, countries) in tree {
            let mut cvec = Vec::new();
            let mut c_devs: Vec<serde_json::Value> = Vec::new();
            for (country, sites) in countries {
                let mut svec = Vec::new();
                let mut k_devs: Vec<serde_json::Value> = Vec::new();
                for (site, frames) in sites {
                    let devs: Vec<serde_json::Value> = frames.iter().map(|f| dev(f)).collect();
                    let meta = site_meta.get(site.as_str());
                    let local = meta.map(|s| DaySchedule::local_tod(utc, s.lon));
                    svec.push(serde_json::json!({
                        "site": site, "tier": meta.map(|s| serde_json::to_value(s.tier).unwrap_or_default()),
                        "lat": meta.map(|s| s.lat), "lon": meta.map(|s| s.lon),
                        "local_clock": local.map(|l| { let l = l as u64; format!("{:02}:{:02}", l / 3600, (l % 3600) / 60) }),
                        "load": local.map(|l| self.fader.day.multiplier(l)),
                        "frames": devs.len(), "calls": sum(&devs, "calls"), "parked": sum(&devs, "parked"), "panels_live": sum(&devs, "panels_live"),
                        "devices": devs,
                    }));
                    k_devs.extend(frames.iter().map(|f| dev(f)));
                }
                cvec.push(serde_json::json!({
                    "country": country, "sites": svec.len(), "frames": k_devs.len(), "calls": sum(&k_devs, "calls"), "parked": sum(&k_devs, "parked"), "panels_live": sum(&k_devs, "panels_live"),
                    "children": svec,
                }));
                c_devs.extend(k_devs);
            }
            continents.push(serde_json::json!({
                "continent": cont, "countries": cvec.len(), "frames": c_devs.len(), "calls": sum(&c_devs, "calls"), "parked": sum(&c_devs, "parked"), "panels_live": sum(&c_devs, "panels_live"),
                "children": cvec,
            }));
        }
        serde_json::json!({
            "global": { "sites": self.sites.sites.len(), "frames": st.frames.len(), "calls": st.connections.len(), "parked": st.connections.iter().filter(|c| c.muted).count(), "trunks": st.trunks.len(), "clock": self.clock() },
            "continents": continents,
        })
    }

    /// One device, centred: its own lines, trunks, labels, lease and the
    /// timeline of what happened to it (from the records we keep).
    pub fn device(&self, id: &str) -> Option<serde_json::Value> {
        let st = &self.state;
        let f = st.frame(id)?;
        let now = util::now_unix();
        let lease = self.fader.lease_seconds;
        let lines: Vec<serde_json::Value> = st
            .connections
            .iter()
            .filter(|c| c.from_frame == id || c.to_frame == id || c.hops.iter().any(|h| h.from == id || h.to == id))
            .map(|c| {
                let role = if c.from_frame == id { "from" } else if c.to_frame == id { "to" } else { "via" };
                let left = c.lease_left(self.sim_time, lease);
                serde_json::json!({
                    "id": c.id, "who": c.who, "role": role, "from": c.from_frame, "to": c.to_frame, "why": c.why,
                    "kind": kind_str_pub(c.kind), "muted": c.muted, "left": left, "state": if c.muted { "parked" } else if left <= 0.0 { "red" } else { "green" },
                    "connected_for": c.connected_for(now), "gpio": c.gpio_sent, "gain": st.path_gain_db(c), "reconnects": c.reconnects,
                })
            })
            .collect();
        let trunks: Vec<serde_json::Value> = st
            .trunks
            .iter()
            .filter(|t| t.touches(id))
            .map(|t| serde_json::json!({ "id": t.id, "caster": t.caster_on(id), "peer": t.peer_of(id), "used": t.used(), "capacity": t.capacity, "gain": if t.a_frame == id { t.gain_a_db } else { t.gain_b_db }, "since": t.created_at }))
            .collect();
        // The device's own timeline: every record that touched it, newest first.
        let events: Vec<serde_json::Value> = self
            .recent_records
            .iter()
            .filter(|r| r.from.starts_with(&format!("{id}:")) || r.whom.starts_with(&format!("{id}:")) || r.from == id || r.whom == id || r.how.as_ref().map_or(false, |h| h.via.iter().any(|v| v == id)))
            .take(60)
            .map(|r| serde_json::json!({ "when": r.when, "who": r.who, "from": r.from, "whom": r.whom, "why": r.why, "status": r.status, "lasted": r.connected_seconds, "via": r.how.as_ref().map(|h| h.via.clone()) }))
            .collect();
        let site = self.sites.sites.iter().find(|s| s.name == f.site);
        let local = site.map(|s| DaySchedule::local_tod(self.time_of_day(), s.lon));
        Some(serde_json::json!({
            "frame": self.advertisement_of(f, now, &util::iso(now)),
            "site": site, "local_clock": local.map(|l| { let l = l as u64; format!("{:02}:{:02}:{:02}", l / 3600, (l % 3600) / 60, l % 60) }),
            "load": local.map(|l| self.fader.day.multiplier(l)),
            "lines": lines, "trunks": trunks, "events": events,
            "labels": st.labels_of(id), "last": st.last_activity.get(id),
            "remote": self.remotes.frames.get(id),
        }))
    }

    /// Every line with its lease: green time left, red when it may be dead.
    pub fn lines(&self) -> Vec<serde_json::Value> {
        let lease = self.fader.lease_seconds;
        let mut v: Vec<serde_json::Value> = self
            .state
            .connections
            .iter()
            .map(|c| {
                let left = c.lease_left(self.sim_time, lease);
                let fa = self.state.frame(&c.from_frame);
                let fb = self.state.frame(&c.to_frame);
                serde_json::json!({
                    "id": c.id, "who": c.who, "from": c.from_frame, "to": c.to_frame,
                    "from_site": fa.map(|f| f.site.clone()), "to_site": fb.map(|f| f.site.clone()),
                    "from_continent": fa.and_then(|f| f.continent.clone()), "to_continent": fb.and_then(|f| f.continent.clone()),
                    "badge": fa.and_then(|f| f.badge.clone()),
                    "left": left, "lease": lease, "state": if c.muted { "parked" } else if left <= 0.0 { "red" } else { "green" },
                    "muted": c.muted, "reconnects": c.reconnects, "kind": kind_str_pub(c.kind),
                })
            })
            .collect();
        v.sort_by(|a, b| a["left"].as_f64().partial_cmp(&b["left"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        v
    }

    /// Remote frames, sorted by frame id.
    pub fn remote_list(&self) -> Vec<RemoteFrame> {
        let mut v: Vec<RemoteFrame> = self.remotes.frames.values().cloned().collect();
        v.sort_by(|a, b| a.frame.cmp(&b.frame));
        v
    }

    /// Current advertisements as the SDK sees them.
    pub fn advertisements(&self) -> Vec<Frame> {
        let now = util::now_unix();
        let now_iso = util::iso(now);
        self.state.frames.iter().map(|f| self.advertisement_of(f, now, &now_iso)).collect()
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }
}

fn kind_str_pub(k: RouteKind) -> &'static str {
    match k {
        RouteKind::Direct => "direct",
        RouteKind::Via => "via",
    }
}

const SIM_NAMES: &[&str] = &[
    "Andrey", "Sam", "Priya", "Jonas", "Mei", "Tariq", "Lena", "Diego", "Ama", "Noor", "Kofi", "Yuki", "Ivan", "Zoe", "Omar", "Hana",
];

const SIM_REASONS: &[&str] = &[
    "director to floor", "camera check", "truck to control room", "comms test", "stage manager call", "IFB to talent",
    "engineering tie-line", "producer to graphics", "replay cue", "audio to video",
];
