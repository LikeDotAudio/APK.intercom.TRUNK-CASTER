//! Trunk state and any-to-any routing.
//!
//! A `Trunk` is a link between one caster on frame A and one caster on
//! frame B, carrying up to `capacity` channels. A `Connection` is one
//! conversation routed over one or more trunks (hops) between a user port
//! on A and a user port on B. The router prefers a direct trunk; when
//! direct capacity is exhausted it goes via one or two intermediate frames.

use crate::util;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use trunk_caster_sdk::{AllowedTrunk, CasterAd, Connection, Frame, Hop, Label, LastActivity, RouteKind, Shape, Trunk};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Counters {
    pub granted: u64,
    pub granted_via: u64,
    pub denied: u64,
    pub released: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub shape: Shape,
    pub frames: Vec<Frame>,
    pub trunks: Vec<Trunk>,
    pub connections: Vec<Connection>,
    pub counters: Counters,
    pub updated_at: String,
    /// User ports renamed after the people who called through them,
    /// keyed `"<frame>:U<nn>"`. Names persist until the next caller.
    #[serde(default)]
    pub port_names: BTreeMap<String, String>,
    /// The same names cut for 6-, 8- and 16-character panels.
    #[serde(default)]
    pub port_labels: BTreeMap<String, Label>,
    /// Last connection seen on each frame.
    #[serde(default)]
    pub last_activity: BTreeMap<String, LastActivity>,
    /// Gain on one crosspoint inside a frame, keyed
    /// `"<frame>|<input>|<output>"` (the TAPS and Mixes faders).
    #[serde(default)]
    pub xp_gains: BTreeMap<String, f64>,
    #[serde(default)]
    next_trunk: u64,
    /// See `ViaIndex`; `trunks_changed` marks its trunk part stale.
    #[serde(skip)]
    via_cache: std::cell::RefCell<Option<ViaIndex>>,
    #[serde(skip)]
    via_stale: std::cell::Cell<bool>,
}

/// A request to route, with everything the connection should remember.
#[derive(Debug, Clone, Default)]
pub struct RouteAsk<'a> {
    pub id: &'a str,
    pub who: &'a str,
    pub from: &'a str,
    pub to: &'a str,
    pub from_port: Option<usize>,
    pub to_port: Option<usize>,
    pub why: Option<&'a str>,
    pub where_: Option<&'a str>,
    pub origin: &'a str,
    pub sim_now: f64,
    pub expires_at_sim: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CrossCheck {
    pub checked: usize,
    pub ok: usize,
    pub failures: Vec<String>,
}

/// FNV-1a: the via index hashes frame ids and position pairs thousands
/// of times per search, where the default SipHash costs more than the search.
#[derive(Default, Clone, Copy)]
struct Fnv(u64);
impl std::hash::Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 { 0xcbf2_9ce4_8422_2325 } else { self.0 };
        for b in bytes {
            h = (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3);
        }
        self.0 = h;
    }
}
type FastHash = std::hash::BuildHasherDefault<Fnv>;

/// What the via search asks of the fleet, by frame position: free casters
/// per frame and which frame pairs have a trunk with a free channel, so
/// the n² candidate paths are checked without rescanning every frame and
/// trunk (that rescan made a two-hop search take seconds on a full fleet).
/// Kept on the `State`: the frame part is built once, the trunk part is
/// recomputed in place after the trunks change (`trunks_changed`).
#[derive(Debug, Clone, Default)]
struct ViaIndex {
    pos: HashMap<String, u32, FastHash>,
    /// Frame id and casters at each position.
    ids: Vec<String>,
    casters: Vec<usize>,
    free: Vec<usize>,
    room: HashSet<(u32, u32), FastHash>,
    /// Frames each frame reaches over a trunk with room.
    adj: Vec<Vec<u32>>,
}

impl ViaIndex {
    fn build(st: &State) -> ViaIndex {
        let mut ix = ViaIndex { pos: HashMap::with_capacity_and_hasher(st.frames.len(), FastHash::default()), ..ViaIndex::default() };
        for f in &st.frames {
            if !ix.pos.contains_key(&f.id) {
                ix.pos.insert(f.id.clone(), ix.ids.len() as u32);
                ix.ids.push(f.id.clone());
                ix.casters.push(f.casters);
            }
        }
        ix.refresh_trunks(st);
        ix
    }
    /// Still the same frames, in the same order?
    fn same_frames(&self, st: &State) -> bool {
        self.ids.len() == st.frames.len() && st.frames.iter().zip(&self.ids).zip(&self.casters).all(|((f, id), c)| f.id == *id && f.casters == *c)
    }
    fn refresh_trunks(&mut self, st: &State) {
        self.free.clone_from(&self.casters);
        self.room.clear();
        self.adj.resize_with(self.ids.len(), Vec::new);
        self.adj.iter_mut().for_each(Vec::clear);
        for t in &st.trunks {
            let (Some(&a), Some(&b)) = (self.pos.get(&t.a_frame), self.pos.get(&t.b_frame)) else { continue };
            self.free[a as usize] = self.free[a as usize].saturating_sub(1);
            if a != b {
                self.free[b as usize] = self.free[b as usize].saturating_sub(1);
            }
            if t.free() > 0 && self.room.insert((a.min(b), a.max(b))) {
                self.adj[a as usize].push(b);
                self.adj[b as usize].push(a);
            }
        }
    }
    fn at(&self, f: &str) -> Option<u32> {
        self.pos.get(f).copied()
    }
    fn id(&self, f: u32) -> &str {
        &self.ids[f as usize]
    }
    fn free(&self, f: u32) -> usize {
        self.free[f as usize]
    }
    fn has_room(&self, x: u32, y: u32) -> bool {
        self.room.contains(&(x.min(y), x.max(y)))
    }
    /// Could a single hop x-y be made, on its own?
    fn hop(&self, x: u32, y: u32) -> bool {
        self.has_room(x, y) || (self.free(x) > 0 && self.free(y) > 0)
    }
    /// `State::evaluate` without building the plan: the new trunks the
    /// path needs, or None when it is not feasible.
    fn cost(&self, path: &[u32]) -> Option<usize> {
        let mut taken: [(u32, usize); 8] = [(u32::MAX, 0); 8];
        let mut used = 0;
        let mut new = 0;
        let held = |f: u32, taken: &[(u32, usize)]| taken.iter().find(|t| t.0 == f).map_or(0, |t| t.1);
        for w in path.windows(2) {
            let (x, y) = (w[0], w[1]);
            if self.has_room(x, y) {
                continue;
            }
            if self.free(x).saturating_sub(held(x, &taken[..used])) == 0 || self.free(y).saturating_sub(held(y, &taken[..used])) == 0 {
                return None;
            }
            for f in [x, y] {
                match taken[..used].iter_mut().find(|t| t.0 == f) {
                    Some(t) => t.1 += 1,
                    None => {
                        taken[used] = (f, 1);
                        used += 1;
                    }
                }
            }
            new += 1;
        }
        Some(new)
    }
}

/// A routing plan before it is committed: each step is
/// (from, to, existing trunk id or None for a new trunk).
#[derive(Debug, Clone)]
struct Plan {
    steps: Vec<(String, String, Option<String>)>,
}

impl Plan {
    fn new_trunks(&self) -> usize {
        self.steps.iter().filter(|s| s.2.is_none()).count()
    }
    fn path(&self) -> Vec<String> {
        let mut p: Vec<String> = self.steps.iter().map(|s| s.0.clone()).collect();
        if let Some(last) = self.steps.last() {
            p.push(last.1.clone());
        }
        p
    }
}

impl State {
    pub fn new(frames: Vec<Frame>, shape: Shape) -> Self {
        State {
            shape,
            frames,
            trunks: Vec::new(),
            connections: Vec::new(),
            counters: Counters::default(),
            updated_at: util::now_iso(),
            port_names: BTreeMap::new(),
            port_labels: BTreeMap::new(),
            last_activity: BTreeMap::new(),
            xp_gains: BTreeMap::new(),
            next_trunk: 1,
            via_cache: Default::default(),
            via_stale: Default::default(),
        }
    }

    pub fn port_key(frame: &str, port: usize) -> String {
        format!("{frame}:{}", crate::crosspoints::user_port(port))
    }

    /// Name of a user port, if anyone has called through it.
    pub fn port_name(&self, frame: &str, port: usize) -> Option<&str> {
        self.port_names.get(&Self::port_key(frame, port)).map(String::as_str)
    }

    /// Rename a user port. Returns the previous name. The 6/8/16 cuts are
    /// derived; use [`State::set_label`] for explicit ones.
    pub fn rename_port(&mut self, frame: &str, port: usize, name: &str) -> Option<String> {
        let key = Self::port_key(frame, port);
        self.port_labels.insert(key.clone(), Label::new(name));
        self.port_names.insert(key, name.to_string())
    }

    pub fn set_label(&mut self, frame: &str, port: usize, label: Label) -> Option<String> {
        let key = Self::port_key(frame, port);
        let old = self.port_names.insert(key.clone(), label.full.clone());
        self.port_labels.insert(key, label);
        old
    }

    pub fn label_of(&self, frame: &str, port: usize) -> Option<&Label> {
        self.port_labels.get(&Self::port_key(frame, port))
    }

    /// Labels on one frame, keyed `U<nn>`.
    pub fn labels_of(&self, frame: &str) -> BTreeMap<String, Label> {
        let prefix = format!("{frame}:");
        self.port_labels
            .iter()
            .filter_map(|(k, v)| k.strip_prefix(&prefix).map(|p| (p.to_string(), v.clone())))
            .collect()
    }

    /// The site a frame lives at, if known.
    pub fn site_of(&self, frame: &str) -> Option<&str> {
        self.frame(frame).map(|f| f.site.as_str()).filter(|s| !s.is_empty())
    }

    // ----------------------------------------------------------------------
    // Volume: trunks can be adjusted at multiple points
    // ----------------------------------------------------------------------

    /// Set the gain at one end ("a" or "b") of a trunk. Returns the old value.
    pub fn set_trunk_gain(&mut self, trunk: &str, end: &str, db: f64) -> Result<f64, String> {
        let t = self.trunks.iter_mut().find(|t| t.id == trunk).ok_or_else(|| format!("no trunk {trunk}"))?;
        let db = db.clamp(-60.0, 20.0);
        let slot = match end {
            "a" | "A" => &mut t.gain_a_db,
            "b" | "B" => &mut t.gain_b_db,
            other => return Err(format!("end must be a or b, got {other}")),
        };
        let was = *slot;
        *slot = db;
        Ok(was)
    }

    /// Set the gain on one hop of one call. Returns the old value.
    pub fn set_hop_gain(&mut self, conn: &str, hop: usize, db: f64) -> Result<f64, String> {
        let c = self.connections.iter_mut().find(|c| c.id == conn).ok_or_else(|| format!("no live connection {conn}"))?;
        if hop >= c.hops.len() {
            return Err(format!("{conn} has {} hop(s)", c.hops.len()));
        }
        if c.hop_gains_db.len() < c.hops.len() {
            c.hop_gains_db.resize(c.hops.len(), 0.0);
        }
        let was = c.hop_gains_db[hop];
        c.hop_gains_db[hop] = db.clamp(-60.0, 20.0);
        Ok(was)
    }

    /// Set the gain on one crosspoint inside a frame. Returns the old value.
    pub fn set_xp_gain(&mut self, frame: &str, input: &str, output: &str, db: f64) -> Result<f64, String> {
        if self.frame(frame).is_none() {
            return Err(format!("no frame {frame}"));
        }
        let key = format!("{frame}|{input}|{output}");
        let db = db.clamp(-60.0, 20.0);
        let was = if db == 0.0 { self.xp_gains.remove(&key) } else { self.xp_gains.insert(key, db) };
        Ok(was.unwrap_or(0.0))
    }

    pub fn xp_gain_db(&self, frame: &str, input: &str, output: &str) -> f64 {
        self.xp_gains.get(&format!("{frame}|{input}|{output}")).copied().unwrap_or(0.0)
    }

    /// Total gain along a call: every trunk end it passes, its hop gains
    /// and every crosspoint it closes in the caller-to-callee direction.
    pub fn path_gain_db(&self, c: &Connection) -> f64 {
        let mut g = 0.0;
        for (i, h) in c.hops.iter().enumerate() {
            if let Some(t) = self.trunk(&h.trunk) {
                g += t.gain_a_db + t.gain_b_db;
            }
            g += c.hop_gains_db.get(i).copied().unwrap_or(0.0);
        }
        if !self.xp_gains.is_empty() {
            for x in crate::crosspoints::crosspoints_of(self, c).iter().step_by(2) {
                g += self.xp_gain_db(&x.frame, &x.input, &x.output);
            }
        }
        g
    }

    /// Port names on one frame, keyed `U<nn>`.
    pub fn port_names_of(&self, frame: &str) -> BTreeMap<String, String> {
        let prefix = format!("{frame}:");
        self.port_names
            .iter()
            .filter_map(|(k, v)| k.strip_prefix(&prefix).map(|p| (p.to_string(), v.clone())))
            .collect()
    }

    /// Who is live on each user port of a frame, keyed `U<nn>`.
    pub fn live_ports_of(&self, frame: &str) -> BTreeMap<String, String> {
        let mut m = BTreeMap::new();
        for c in &self.connections {
            if c.from_frame == frame {
                m.insert(crate::crosspoints::user_port(c.from_port), c.who.clone());
            }
            if c.to_frame == frame {
                m.insert(crate::crosspoints::user_port(c.to_port), c.who.clone());
            }
        }
        m
    }

    /// Seconds since the frame last carried a connection (wall clock).
    pub fn seconds_since_last(&self, frame: &str, now_unix: u64) -> Option<u64> {
        if self.connections.iter().any(|c| c.from_frame == frame || c.to_frame == frame) {
            return Some(0);
        }
        self.last_activity.get(frame).map(|a| now_unix.saturating_sub(a.unix))
    }

    fn touch(&mut self, frame: &str, who: &str, conn: &str, sim_now: f64) {
        let now = util::now_unix();
        self.last_activity.insert(
            frame.to_string(),
            LastActivity { at: util::iso(now), unix: now, sim_time: sim_now, who: who.to_string(), connection: conn.to_string() },
        );
    }

    /// Load persisted state, then reconcile it with the freshly discovered
    /// fleet: frames are replaced, trunks and connections that reference a
    /// frame no longer advertised are dropped.
    pub fn load_or_new(path: &Path, frames: Vec<Frame>, shape: Shape) -> Self {
        let mut st: State = match util::read_json(path) {
            Ok(s) => s,
            Err(_) => return State::new(frames, shape),
        };
        let ids: HashSet<String> = frames.iter().map(|f| f.id.clone()).collect();
        st.frames = frames;
        st.shape = shape;
        st.connections
            .retain(|c| c.hops.iter().all(|h| ids.contains(&h.from) && ids.contains(&h.to)));
        let live: HashSet<String> = st.connections.iter().map(|c| c.id.clone()).collect();
        st.trunks.retain(|t| ids.contains(&t.a_frame) && ids.contains(&t.b_frame));
        for t in &mut st.trunks {
            t.connections.retain(|c| live.contains(c));
        }
        st.trunks.retain(|t| !t.connections.is_empty());
        let max_trunk = st
            .trunks
            .iter()
            .filter_map(|t| t.id.strip_prefix("trunk-").and_then(|n| n.parse::<u64>().ok()))
            .max()
            .unwrap_or(0);
        if st.next_trunk <= max_trunk {
            st.next_trunk = max_trunk + 1;
        }
        st
    }

    pub fn frame(&self, id: &str) -> Option<&Frame> {
        self.frames.iter().find(|f| f.id == id)
    }
    pub fn trunk(&self, id: &str) -> Option<&Trunk> {
        self.trunks.iter().find(|t| t.id == id)
    }
    pub fn connection(&self, id: &str) -> Option<&Connection> {
        self.connections.iter().find(|c| c.id == id)
    }

    /// Casters this frame has (frames may differ, e.g. the local relay).
    pub fn casters_of(&self, frame: &str) -> usize {
        self.frame(frame).map(|f| f.casters).unwrap_or(self.shape.casters_per_frame)
    }
    /// User ports this frame has.
    pub fn user_ports_of(&self, frame: &str) -> usize {
        self.frame(frame).map(|f| f.user_ports).unwrap_or(self.shape.user_ports)
    }

    /// Casters on `frame` already bound to a trunk.
    pub fn used_casters(&self, frame: &str) -> usize {
        self.trunks.iter().filter(|t| t.touches(frame)).count()
    }
    pub fn free_casters(&self, frame: &str) -> usize {
        self.casters_of(frame).saturating_sub(self.used_casters(frame))
    }

    fn free_caster_indices(&self, frame: &str) -> Vec<usize> {
        let used: HashSet<usize> = self.trunks.iter().filter_map(|t| t.caster_on(frame)).collect();
        (0..self.casters_of(frame)).filter(|i| !used.contains(i)).collect()
    }

    /// Caster status for an advertisement.
    pub fn caster_ads(&self, frame: &str) -> Vec<CasterAd> {
        (0..self.casters_of(frame))
            .map(|i| {
                let t = self.trunks.iter().find(|t| t.caster_on(frame) == Some(i));
                CasterAd {
                    index: i,
                    state: if t.is_some() { "trunked" } else { "free" }.to_string(),
                    trunk: t.map(|t| t.id.clone()),
                    peer_frame: t.and_then(|t| t.peer_of(frame)).map(String::from),
                }
            })
            .collect()
    }

    /// User ports on `frame` currently in a conversation.
    pub fn used_user_ports(&self, frame: &str) -> HashSet<usize> {
        let mut s = HashSet::new();
        for c in &self.connections {
            if c.from_frame == frame {
                s.insert(c.from_port);
            }
            if c.to_frame == frame {
                s.insert(c.to_port);
            }
        }
        s
    }

    fn alloc_user_port(&self, frame: &str, wanted: Option<usize>, taken: &HashSet<usize>) -> Result<usize, String> {
        let used = self.used_user_ports(frame);
        let n = self.user_ports_of(frame);
        match wanted {
            Some(p) if p >= n => Err(format!("{frame} has no user port {p}")),
            Some(p) if used.contains(&p) || taken.contains(&p) => Err(format!("{frame} user port {p} is busy")),
            Some(p) => Ok(p),
            None => (0..n)
                .find(|p| !used.contains(p) && !taken.contains(p))
                .ok_or_else(|| format!("{frame} has no free user port")),
        }
    }

    fn existing_with_room(&self, x: &str, y: &str) -> Option<&Trunk> {
        self.trunks.iter().find(|t| t.joins(x, y) && t.free() > 0)
    }

    /// Channel utilization over all existing trunks, 0..1.
    pub fn channel_utilization(&self) -> f64 {
        let cap: usize = self.trunks.iter().map(|t| t.capacity).sum();
        if cap == 0 {
            0.0
        } else {
            self.trunks.iter().map(Trunk::used).sum::<usize>() as f64 / cap as f64
        }
    }

    /// Fraction of all casters in the fleet bound to a trunk, 0..1.
    pub fn caster_utilization(&self) -> f64 {
        let total: usize = self.frames.iter().map(|f| f.casters).sum();
        if total == 0 {
            0.0
        } else {
            (self.trunks.len() * 2) as f64 / total as f64
        }
    }

    // ----------------------------------------------------------------------
    // Routing
    // ----------------------------------------------------------------------

    pub fn route(&mut self, ask: RouteAsk<'_>) -> Result<Connection, String> {
        let RouteAsk { id, who, from, to, from_port, to_port, why, where_, origin, sim_now, expires_at_sim } = ask;
        let check = || -> Result<(), String> {
            if from == to {
                return Err("from and to are the same frame".into());
            }
            if self.frame(from).is_none() {
                return Err(format!("unknown frame {from}"));
            }
            if self.frame(to).is_none() {
                return Err(format!("unknown frame {to}"));
            }
            if self.connection(id).is_some() {
                return Err(format!("connection {id} already exists"));
            }
            Ok(())
        };
        if let Err(e) = check() {
            self.counters.denied += 1;
            return Err(e);
        }

        let fp = match self.alloc_user_port(from, from_port, &HashSet::new()) {
            Ok(p) => p,
            Err(e) => {
                self.counters.denied += 1;
                return Err(e);
            }
        };
        let tp = match self.alloc_user_port(to, to_port, &HashSet::new()) {
            Ok(p) => p,
            Err(e) => {
                self.counters.denied += 1;
                return Err(e);
            }
        };

        let plan = self
            .plan_direct(from, to)
            .or_else(|| self.plan_via(from, to, 1))
            .or_else(|| self.plan_via(from, to, 2));

        let Some(plan) = plan else {
            self.counters.denied += 1;
            return Err("no capacity: no direct trunk, no free casters, no via path".into());
        };

        let hops = self.commit(&plan, id);
        let hops_len = hops.len();
        let kind = if hops.len() == 1 { RouteKind::Direct } else { RouteKind::Via };
        let now = util::now_unix();
        let conn = Connection {
            id: id.to_string(),
            who: who.to_string(),
            from_frame: from.to_string(),
            from_port: fp,
            to_frame: to.to_string(),
            to_port: tp,
            kind,
            hops,
            granted_at: util::iso(now),
            granted_unix: now,
            granted_sim: sim_now,
            why: why.map(String::from),
            where_: where_.map(String::from),
            origin: origin.to_string(),
            expires_at_sim,
            gpio_sent: 0,
            hop_gains_db: vec![0.0; hops_len],
            muted: false,
            muted_at_sim: None,
            reconnects: 0,
            last_used_sim: sim_now,
            latched: false,
            listen: false,
        };
        self.counters.granted += 1;
        if kind == RouteKind::Via {
            self.counters.granted_via += 1;
        }
        self.touch(from, who, id, sim_now);
        self.touch(to, who, id, sim_now);
        self.connections.push(conn.clone());
        Ok(conn)
    }

    fn plan_direct(&self, from: &str, to: &str) -> Option<Plan> {
        if let Some(t) = self.existing_with_room(from, to) {
            return Some(Plan { steps: vec![(from.into(), to.into(), Some(t.id.clone()))] });
        }
        if self.free_casters(from) > 0 && self.free_casters(to) > 0 {
            return Some(Plan { steps: vec![(from.into(), to.into(), None)] });
        }
        None
    }

    /// Evaluate one candidate path. Existing trunks with room are preferred
    /// over binding new casters; caster consumption along the path is
    /// tracked so a frame is never over-committed within one plan.
    fn evaluate(&self, path: &[&str]) -> Option<Plan> {
        let mut tentative: HashMap<&str, usize> = HashMap::new();
        let mut steps = Vec::with_capacity(path.len().saturating_sub(1));
        for w in path.windows(2) {
            let (x, y) = (w[0], w[1]);
            if let Some(t) = self.existing_with_room(x, y) {
                steps.push((x.to_string(), y.to_string(), Some(t.id.clone())));
                continue;
            }
            let fx = self.free_casters(x).saturating_sub(*tentative.get(x).unwrap_or(&0));
            let fy = self.free_casters(y).saturating_sub(*tentative.get(y).unwrap_or(&0));
            if fx == 0 || fy == 0 {
                return None;
            }
            *tentative.entry(x).or_default() += 1;
            *tentative.entry(y).or_default() += 1;
            steps.push((x.to_string(), y.to_string(), None));
        }
        Some(Plan { steps })
    }

    #[cfg(test)]
    fn candidates<'a>(&'a self, from: &str, to: &str) -> Vec<&'a str> {
        self.frames
            .iter()
            .map(|f| f.id.as_str())
            .filter(|f| *f != from && *f != to)
            .collect()
    }

    /// The via index, brought up to date with the trunks.
    fn via_index(&self) -> std::cell::Ref<'_, ViaIndex> {
        {
            let mut c = self.via_cache.borrow_mut();
            match c.as_mut() {
                Some(ix) if ix.same_frames(self) => {
                    if self.via_stale.get() {
                        ix.refresh_trunks(self);
                    }
                }
                _ => *c = Some(ViaIndex::build(self)),
            }
            self.via_stale.set(false);
        }
        std::cell::Ref::map(self.via_cache.borrow(), |c| c.as_ref().expect("built above"))
    }

    /// Every change to the trunks or their channels goes through here, so
    /// the via index is never stale.
    fn trunks_changed(&mut self) {
        self.via_stale.set(true);
    }

    /// All feasible plans with exactly `intermediates` frames between
    /// `from` and `to`, best first (fewest new trunks). Same answer as
    /// running `evaluate` on every path in order, found from the index.
    fn via_plans(&self, from: &str, to: &str, intermediates: usize, limit: usize) -> Vec<Plan> {
        if limit == 0 {
            return Vec::new();
        }
        let ix = self.via_index();
        let (Some(f), Some(t)) = (ix.at(from), ix.at(to)) else { return Vec::new() };
        // Candidates in frame order, as positions.
        let cands: Vec<u32> = (0..ix.free.len() as u32).filter(|&m| m != f && m != t).collect();
        if intermediates == 2 && limit == 1 {
            return Self::best_two_hop(&ix, &cands, f, t)
                .and_then(|(m1, m2)| self.evaluate(&[from, ix.id(m1), ix.id(m2), to]))
                .into_iter()
                .collect();
        }
        // (new trunks, first intermediate, second intermediate) in search order.
        let mut found: Vec<(usize, u32, Option<u32>)> = Vec::new();
        let mut zeros = 0;
        let mut keep = |cost: usize, m1, m2| {
            found.push((cost, m1, m2));
            zeros += (cost == 0) as usize;
            // Nothing later can beat `limit` plans that need no new trunk.
            zeros >= limit
        };
        match intermediates {
            1 => {
                for &m in &cands {
                    if let Some(c) = ix.cost(&[f, m, t]) {
                        if keep(c, m, None) {
                            break;
                        }
                    }
                }
            }
            2 => {
                // A path is only feasible if its first and last hops are.
                let firsts: Vec<u32> = cands.iter().copied().filter(|&m| ix.hop(f, m)).collect();
                let lasts: Vec<u32> = cands.iter().copied().filter(|&m| ix.hop(m, t)).collect();
                'outer: for &m1 in &firsts {
                    for &m2 in &lasts {
                        if m1 != m2 {
                            if let Some(c) = ix.cost(&[f, m1, m2, t]) {
                                if keep(c, m1, Some(m2)) {
                                    break 'outer;
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        found.sort_by_key(|x| x.0);
        found.truncate(limit);
        found
            .into_iter()
            .filter_map(|(_, m1, m2)| match m2 {
                Some(m2) => self.evaluate(&[from, ix.id(m1), ix.id(m2), to]),
                None => self.evaluate(&[from, ix.id(m1), to]),
            })
            .collect()
    }

    /// The first of the cheapest paths f-m1-m2-t, in search order, without
    /// trying every pair. A hop rides an existing trunk with room when there
    /// is one (cost 0), else needs a free caster at both ends (cost 1, and
    /// m1 or m2 then needs two when both its hops are new). So for each m1
    /// the best m2 is among m1's trunk neighbours, or the first frame (in
    /// order) that reaches `t` cheaply and is not one.
    fn best_two_hop(ix: &ViaIndex, cands: &[u32], f: u32, t: u32) -> Option<(u32, u32)> {
        let h1 = |m: u32| if ix.has_room(f, m) { Some(0) } else if ix.free(f) >= 1 && ix.free(m) >= 1 { Some(1) } else { None };
        // m2 candidates for a new middle hop, by what their last hop costs.
        let last0: Vec<u32> = cands.iter().copied().filter(|&m| ix.has_room(m, t) && ix.free(m) >= 1).collect();
        let last1: Vec<u32> = cands.iter().copied().filter(|&m| !ix.has_room(m, t) && ix.free(m) >= 2 && ix.free(t) >= 1).collect();
        // Positions follow frame order, so they compare as search order.
        let mut best: Option<(usize, u32, u32)> = None;
        for &m1 in cands {
            let Some(c1) = h1(m1) else { continue };
            if best.map_or(false, |b| b.0 <= c1) {
                continue;
            }
            let mut inner: Option<(usize, u32)> = None; // (cost of hops 2+3, m2)
            let offer = |c: usize, m2: u32, inner: &mut Option<(usize, u32)>| {
                if inner.map_or(true, |b| (c, m2) < b) {
                    *inner = Some((c, m2));
                }
            };
            // Middle hop over an existing trunk.
            for &m2 in &ix.adj[m1 as usize] {
                if m2 == f || m2 == t || m2 == m1 {
                    continue;
                }
                if ix.has_room(m2, t) {
                    offer(0, m2, &mut inner);
                } else if ix.free(m2) >= 1 && ix.free(t) >= 1 {
                    offer(1, m2, &mut inner);
                }
            }
            // Middle hop on a new trunk: m1 needs a caster beyond hop one's.
            if ix.free(m1) >= c1 + 1 {
                for (list, c) in [(&last0, 1), (&last1, 2)] {
                    if let Some(&m2) = list.iter().find(|&&m2| m2 != m1 && !ix.has_room(m1, m2)) {
                        offer(c, m2, &mut inner);
                    }
                }
            }
            if let Some((c, m2)) = inner {
                let cand = (c1 + c, m1, m2);
                if best.map_or(true, |b| cand < b) {
                    best = Some(cand);
                }
            }
            if best.map_or(false, |b| b.0 == 0) {
                break;
            }
        }
        best.map(|(_, m1, m2)| (m1, m2))
    }

    /// The original exhaustive search, kept to check `via_plans` against.
    #[cfg(test)]
    fn via_plans_naive(&self, from: &str, to: &str, intermediates: usize, limit: usize) -> Vec<Plan> {
        let cands = self.candidates(from, to);
        let mut plans: Vec<Plan> = Vec::new();
        match intermediates {
            1 => {
                for &m in &cands {
                    if let Some(p) = self.evaluate(&[from, m, to]) {
                        plans.push(p);
                    }
                }
            }
            2 => {
                for &m1 in &cands {
                    for &m2 in &cands {
                        if m1 != m2 {
                            if let Some(p) = self.evaluate(&[from, m1, m2, to]) {
                                plans.push(p);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        plans.sort_by_key(Plan::new_trunks);
        plans.truncate(limit);
        plans
    }

    fn plan_via(&self, from: &str, to: &str, intermediates: usize) -> Option<Plan> {
        self.via_plans(from, to, intermediates, 1).into_iter().next()
    }

    /// Advertise what a seeker on `from` is allowed to use to reach `to`:
    /// direct options first, then via one frame, then via two.
    pub fn allowed_trunks(&self, from: &str, to: &str, limit: usize) -> Vec<AllowedTrunk> {
        let mut out = Vec::new();
        if from == to || self.frame(from).is_none() || self.frame(to).is_none() {
            return out;
        }
        for t in self.trunks.iter().filter(|t| t.joins(from, to) && t.free() > 0) {
            out.push(AllowedTrunk {
                kind: RouteKind::Direct,
                path: vec![from.into(), to.into()],
                trunks: vec![Some(t.id.clone())],
                new_trunks_needed: 0,
                free_channels: t.free(),
            });
        }
        if self.free_casters(from) > 0 && self.free_casters(to) > 0 {
            out.push(AllowedTrunk {
                kind: RouteKind::Direct,
                path: vec![from.into(), to.into()],
                trunks: vec![None],
                new_trunks_needed: 1,
                free_channels: self.shape.channels_per_trunk,
            });
        }
        let mut via: Vec<Plan> = self.via_plans(from, to, 1, limit);
        if via.len() < limit {
            via.extend(self.via_plans(from, to, 2, limit - via.len()));
        }
        for p in via {
            let free = p
                .steps
                .iter()
                .map(|s| match &s.2 {
                    Some(id) => self.trunk(id).map(Trunk::free).unwrap_or(0),
                    None => self.shape.channels_per_trunk,
                })
                .min()
                .unwrap_or(0);
            out.push(AllowedTrunk {
                kind: RouteKind::Via,
                path: p.path(),
                trunks: p.steps.iter().map(|s| s.2.clone()).collect(),
                new_trunks_needed: p.new_trunks(),
                free_channels: free,
            });
        }
        out.truncate(limit);
        out
    }

    fn commit(&mut self, plan: &Plan, conn_id: &str) -> Vec<Hop> {
        let mut hops = Vec::with_capacity(plan.steps.len());
        for (x, y, existing) in &plan.steps {
            let trunk_id = match existing {
                Some(id) => id.clone(),
                None => self.create_trunk(x, y),
            };
            if let Some(t) = self.trunks.iter_mut().find(|t| t.id == trunk_id) {
                t.connections.push(conn_id.to_string());
            }
            self.trunks_changed();
            hops.push(Hop { trunk: trunk_id, from: x.clone(), to: y.clone() });
        }
        hops
    }

    fn create_trunk(&mut self, x: &str, y: &str) -> String {
        let a_caster = self.free_caster_indices(x)[0];
        let b_caster = self.free_caster_indices(y)[0];
        let id = format!("trunk-{:05}", self.next_trunk);
        self.next_trunk += 1;
        self.trunks_changed();
        self.trunks.push(Trunk {
            id: id.clone(),
            a_frame: x.to_string(),
            a_caster,
            b_frame: y.to_string(),
            b_caster,
            capacity: self.shape.channels_per_trunk,
            connections: Vec::new(),
            created_at: util::now_iso(),
            gain_a_db: 0.0,
            gain_b_db: 0.0,
        });
        id
    }

    /// Release a connection. Trunks left with no channels in use are torn
    /// down so their casters become free again.
    pub fn release(&mut self, conn_id: &str) -> Option<Connection> {
        let pos = self.connections.iter().position(|c| c.id == conn_id)?;
        let conn = self.connections.remove(pos);
        for t in &mut self.trunks {
            t.connections.retain(|c| c != conn_id);
        }
        self.trunks.retain(|t| !t.connections.is_empty());
        self.trunks_changed();
        self.counters.released += 1;
        Some(conn)
    }

    /// Simulated-clock expiries: a call whose hold ran out is *parked*,
    /// connected but muted, until the next round-robin sweep. Returns the
    /// ids just parked.
    pub fn expire(&mut self, now: f64) -> Vec<String> {
        let mut parked = Vec::new();
        for c in &mut self.connections {
            if !c.muted && !c.latched && c.expires_at_sim.map_or(false, |t| t <= now) {
                c.muted = true;
                c.muted_at_sim = Some(now);
                parked.push(c.id.clone());
            }
        }
        parked
    }

    /// A parked line between the same two frames, if there is one.
    pub fn find_parked(&self, from: &str, to: &str) -> Option<String> {
        self.connections
            .iter()
            .find(|c| c.muted && ((c.from_frame == from && c.to_frame == to) || (c.from_frame == to && c.to_frame == from)))
            .map(|c| c.id.clone())
    }

    /// Pick a parked line up again: unmuted, lease reset, hold extended.
    pub fn unmute(&mut self, id: &str, who: &str, now: f64, hold: Option<f64>) -> Option<Connection> {
        let c = self.connections.iter_mut().find(|c| c.id == id)?;
        c.muted = false;
        c.muted_at_sim = None;
        c.reconnects += 1;
        c.last_used_sim = now;
        c.who = who.to_string();
        c.expires_at_sim = hold.map(|h| now + h);
        Some(c.clone())
    }

    /// Lines whose lease ran out: red, "may be dead". Their bandwidth is on
    /// hold: they are parked if not already, and first to be reclaimed.
    #[cfg(test)]
    pub fn red_lines(&self, now: f64, lease: f64) -> Vec<String> {
        self.connections.iter().filter(|c| c.lease_left(now, lease) <= 0.0).map(|c| c.id.clone()).collect()
    }

    /// Park every red line (bandwidth on hold). Returns ids newly parked.
    pub fn hold_red(&mut self, now: f64, lease: f64) -> Vec<String> {
        let mut out = Vec::new();
        for c in &mut self.connections {
            if !c.muted && !c.latched && c.lease_left(now, lease) <= 0.0 {
                c.muted = true;
                c.muted_at_sim = Some(now);
                out.push(c.id.clone());
            }
        }
        out
    }

    /// The round-robin sweep: release lines parked since before `since`.
    pub fn sweep(&mut self, since: f64) -> Vec<Connection> {
        let due: Vec<String> = self
            .connections
            .iter()
            .filter(|c| c.muted && !c.latched && c.muted_at_sim.map_or(false, |t| t <= since))
            .map(|c| c.id.clone())
            .collect();
        due.iter().filter_map(|id| self.release(id)).collect()
    }

    /// First priority to be reclaimed: release the longest-dead red line
    /// touching either frame so a new call can have its bandwidth.
    pub fn reclaim_for(&mut self, from: &str, to: &str, now: f64, lease: f64) -> Option<Connection> {
        let mut red: Vec<&Connection> = self
            .connections
            .iter()
            .filter(|c| !c.latched && c.lease_left(now, lease) <= 0.0)
            .filter(|c| [&c.from_frame, &c.to_frame].iter().any(|f| *f == from || *f == to) || c.hops.iter().any(|h| h.from == from || h.to == to))
            .collect();
        red.sort_by(|a, b| a.last_used_sim.partial_cmp(&b.last_used_sim).unwrap_or(std::cmp::Ordering::Equal));
        let id = red.first().map(|c| c.id.clone())?;
        self.release(&id)
    }

    /// Release everything (the daily reset). Returns what was released.
    pub fn release_all(&mut self) -> Vec<Connection> {
        let ids: Vec<String> = self.connections.iter().map(|c| c.id.clone()).collect();
        ids.iter().filter_map(|id| self.release(id)).collect()
    }

    // ----------------------------------------------------------------------
    // Cross-check: every connection verifies itself against the trunks.
    // ----------------------------------------------------------------------

    pub fn crosscheck(&self) -> CrossCheck {
        let mut cc = CrossCheck::default();
        let by_id: BTreeMap<&str, &Trunk> = self.trunks.iter().map(|t| (t.id.as_str(), t)).collect();
        // Every user port in a conversation, counted once per end.
        let mut ports: HashMap<(&str, usize), usize> = HashMap::new();
        for c in &self.connections {
            *ports.entry((c.from_frame.as_str(), c.from_port)).or_default() += 1;
            *ports.entry((c.to_frame.as_str(), c.to_port)).or_default() += 1;
        }

        for c in &self.connections {
            cc.checked += 1;
            let mut problems = Vec::new();

            if c.hops.is_empty() {
                problems.push("no hops".to_string());
            }
            if c.hops.first().map(|h| h.from.as_str()) != Some(c.from_frame.as_str()) {
                problems.push("first hop does not start at from_frame".into());
            }
            if c.hops.last().map(|h| h.to.as_str()) != Some(c.to_frame.as_str()) {
                problems.push("last hop does not end at to_frame".into());
            }
            for w in c.hops.windows(2) {
                if w[0].to != w[1].from {
                    problems.push(format!("hop chain broken at {}", w[0].to));
                }
            }
            for h in &c.hops {
                match by_id.get(h.trunk.as_str()) {
                    None => problems.push(format!("trunk {} missing", h.trunk)),
                    Some(t) => {
                        if !t.joins(&h.from, &h.to) {
                            problems.push(format!("trunk {} does not join {}-{}", t.id, h.from, h.to));
                        }
                        if !t.connections.iter().any(|x| x == &c.id) {
                            problems.push(format!("trunk {} does not list this connection", t.id));
                        }
                        if t.used() > t.capacity {
                            problems.push(format!("trunk {} over capacity", t.id));
                        }
                    }
                }
            }
            // The same user port must not be in two conversations.
            let clash = ports[&(c.from_frame.as_str(), c.from_port)] > 1 || ports[&(c.to_frame.as_str(), c.to_port)] > 1;
            if clash {
                problems.push("user port shared with another connection".into());
            }
            if problems.is_empty() {
                cc.ok += 1;
            } else {
                cc.failures.push(format!("{}: {}", c.id, problems.join("; ")));
            }
        }

        let live: HashSet<&str> = self.connections.iter().map(|c| c.id.as_str()).collect();
        let mut bound: HashMap<(String, usize), &str> = HashMap::new();
        for t in &self.trunks {
            for cid in &t.connections {
                if !live.contains(cid.as_str()) {
                    cc.failures.push(format!("{}: trunk lists dead connection {cid}", t.id));
                }
            }
            for (f, cidx) in [(&t.a_frame, t.a_caster), (&t.b_frame, t.b_caster)] {
                if let Some(other) = bound.insert((f.clone(), cidx), &t.id) {
                    cc.failures.push(format!("{}: caster {f}#{cidx} also bound by {other}", t.id));
                }
            }
        }
        cc
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trunk_caster_sdk::{Family, Protocol};

    fn fleet(per: usize, casters: usize, channels: usize) -> (Vec<Frame>, Shape) {
        let shape = Shape { frames_per_protocol: per, user_ports: 56, casters_per_frame: casters, channels_per_trunk: channels };
        let proto = Protocol {
            id: "p0".into(),
            name: "P0".into(),
            family: Family::Other,
            implementations: vec![],
            documents: vec![],
            digest: Default::default(),
        };
        let frames = (1..=per)
            .map(|i| crate::frame::new_frame(&proto, crate::frame::frame_id(&proto.id, i), shape.user_ports, shape.casters_per_frame, &shape, None))
            .collect();
        (frames, shape)
    }

    fn ask<'a>(id: &'a str, from: &'a str, to: &'a str) -> RouteAsk<'a> {
        RouteAsk { id, who: "t", from, to, origin: "test", ..RouteAsk::default() }
    }

    fn go(st: &mut State, id: &str, from: &str, to: &str) -> Result<Connection, String> {
        st.route(ask(id, from, to))
    }

    #[test]
    fn direct_then_deny_when_casters_exhausted() {
        let (frames, shape) = fleet(3, 1, 1);
        let mut st = State::new(frames, shape);
        let c1 = go(&mut st, "c1", "p0-01", "p0-02").unwrap();
        assert_eq!(c1.kind, RouteKind::Direct);
        assert_eq!((c1.from_port, c1.to_port), (0, 0));
        assert!(go(&mut st, "c2", "p0-01", "p0-02").unwrap_err().contains("no capacity"));
        assert!(go(&mut st, "c3", "p0-03", "p0-01").is_err());
        assert!(st.crosscheck().failures.is_empty());
        assert_eq!(st.counters.denied, 2);
    }

    #[test]
    fn via_when_direct_saturated() {
        let (frames, shape) = fleet(3, 2, 2);
        let mut st = State::new(frames, shape);
        go(&mut st, "x1", "p0-01", "p0-03").unwrap();
        go(&mut st, "x2", "p0-03", "p0-02").unwrap();
        assert_eq!(go(&mut st, "x3", "p0-01", "p0-02").unwrap().kind, RouteKind::Direct);
        assert_eq!(go(&mut st, "x4", "p0-01", "p0-02").unwrap().kind, RouteKind::Direct);
        // Direct trunk full, no casters left on 01 -> via 03 over existing trunks.
        let v = go(&mut st, "x5", "p0-01", "p0-02").unwrap();
        assert_eq!(v.kind, RouteKind::Via);
        assert_eq!(v.via_frames(), vec!["p0-03"]);
        let cc = st.crosscheck();
        assert!(cc.failures.is_empty(), "{:?}", cc.failures);
        assert_eq!(cc.ok, 5);
        // User ports were handed out sequentially on p0-01: x1, x3, x4, x5.
        assert_eq!(v.from_port, 3);
    }

    #[test]
    #[ignore]
    fn bench_via_index() {
        let (frames, shape) = fleet(710, 8, 8);
        let ids: Vec<String> = frames.iter().map(|f| f.id.clone()).collect();
        let mut st = State::new(frames, shape);
        for i in 0..3000 {
            let _ = go(&mut st, &format!("b{i}"), &ids[(i * 7919) % 710], &ids[(i * 104729 + 3) % 710]);
        }
        eprintln!("{} trunks {} conns", st.trunks.len(), st.connections.len());
        let t = std::time::Instant::now();
        for _ in 0..200 {
            std::hint::black_box(st.via_index());
        }
        eprintln!("via_index {:?} each", t.elapsed() / 200);
        let t = std::time::Instant::now();
        for _ in 0..200 {
            std::hint::black_box(st.free_casters(&ids[5]));
        }
        eprintln!("free_casters {:?} each", t.elapsed() / 200);
    }

    #[test]
    fn indexed_via_search_matches_exhaustive() {
        // Fill a small fleet with random calls so trunks, full trunks and
        // spent casters are all mixed, checking the search at every step.
        for (per, casters, channels) in [(9, 3, 2), (10, 2, 1), (8, 4, 3), (12, 1, 2)] {
        let (frames, shape) = fleet(per, casters, channels);
        let ids: Vec<String> = frames.iter().map(|f| f.id.clone()).collect();
        let mut st = State::new(frames, shape);
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut next = |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        let key = |ps: Vec<Plan>| ps.into_iter().map(|p| p.steps).collect::<Vec<_>>();
        for i in 0..400 {
            let (a, b) = (next(ids.len()), next(ids.len()));
            if a == b {
                continue;
            }
            let (from, to) = (ids[a].as_str(), ids[b].as_str());
            for hops in [1, 2] {
                for limit in [1, 4] {
                    assert_eq!(key(st.via_plans(from, to, hops, limit)), key(st.via_plans_naive(from, to, hops, limit)), "fleet {per}x{casters}x{channels} call {i} {from}->{to} via {hops} limit {limit}");
                }
            }
            let _ = go(&mut st, &format!("r{i}"), from, to);
        }
        assert!(st.counters.denied > 0, "{:?}", st.counters);
        }
    }

    #[test]
    fn allowed_trunks_lists_direct_then_via() {
        let (frames, shape) = fleet(3, 2, 2);
        let mut st = State::new(frames, shape);
        go(&mut st, "x1", "p0-01", "p0-03").unwrap();
        let a = st.allowed_trunks("p0-01", "p0-02", 5);
        assert_eq!(a[0].kind, RouteKind::Direct);
        assert_eq!(a[0].new_trunks_needed, 1);
        assert!(a.iter().any(|t| t.kind == RouteKind::Via && t.path == vec!["p0-01", "p0-03", "p0-02"]));
    }

    #[test]
    fn expiry_parks_then_sweep_releases() {
        let (frames, shape) = fleet(2, 8, 8);
        let mut st = State::new(frames, shape);
        st.route(RouteAsk { expires_at_sim: Some(10.0), ..ask("s1", "p0-01", "p0-02") }).unwrap();
        st.route(RouteAsk { expires_at_sim: Some(20.0), ..ask("s2", "p0-01", "p0-02") }).unwrap();
        assert_eq!(st.trunks.len(), 1);
        // Hold ran out: parked (muted), still connected.
        assert_eq!(st.expire(10.0), vec!["s1".to_string()]);
        assert!(st.connection("s1").unwrap().muted);
        assert_eq!(st.connections.len(), 2);
        // Same frames call again before the sweep: picked up, not re-trunked.
        assert_eq!(st.find_parked("p0-02", "p0-01").as_deref(), Some("s1"));
        let c = st.unmute("s1", "Sam", 12.0, Some(100.0)).unwrap();
        assert!(!c.muted && c.reconnects == 1 && c.who == "Sam");
        // Park s2, sweep what was parked before t=30: s2 goes, s1 stays.
        st.expire(25.0);
        let gone = st.sweep(30.0);
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].id, "s2");
        assert_eq!(st.connections.len(), 1);
        // Lease: green at 12+100, red after 900s without use; red is held then reclaimed.
        assert!(st.connection("s1").unwrap().lease_left(100.0, 900.0) > 0.0);
        assert_eq!(st.red_lines(1000.0, 900.0), vec!["s1".to_string()]);
        assert_eq!(st.hold_red(1000.0, 900.0), vec!["s1".to_string()]);
        assert!(st.reclaim_for("p0-01", "p0-02", 1000.0, 900.0).is_some());
        assert!(st.trunks.is_empty());
        assert_eq!(st.free_casters("p0-01"), 8);
    }

    #[test]
    fn explicit_busy_port_is_denied() {
        let (frames, shape) = fleet(2, 8, 8);
        let mut st = State::new(frames, shape);
        st.route(RouteAsk { from_port: Some(5), ..ask("a", "p0-01", "p0-02") }).unwrap();
        let e = st.route(RouteAsk { from_port: Some(5), ..ask("b", "p0-01", "p0-02") }).unwrap_err();
        assert!(e.contains("busy"));
    }

    #[test]
    fn renames_and_last_activity() {
        let (frames, shape) = fleet(2, 8, 8);
        let mut st = State::new(frames, shape);
        assert!(st.rename_port("p0-01", 0, "Andrey").is_none());
        assert_eq!(st.rename_port("p0-01", 0, "Sam").as_deref(), Some("Andrey"));
        assert_eq!(st.port_name("p0-01", 0), Some("Sam"));
        assert_eq!(st.port_names_of("p0-01").get("U00").map(String::as_str), Some("Sam"));
        assert!(st.seconds_since_last("p0-02", 100).is_none());
        st.route(RouteAsk { who: "Andrey", sim_now: 5.0, ..ask("c", "p0-01", "p0-02") }).unwrap();
        assert_eq!(st.seconds_since_last("p0-02", util::now_unix() + 50), Some(0));
        st.release("c");
        assert!(st.seconds_since_last("p0-02", util::now_unix() + 50).unwrap() >= 50);
        assert_eq!(st.last_activity["p0-02"].who, "Andrey");
    }

    #[test]
    fn labels_and_gains() {
        let (frames, shape) = fleet(3, 2, 2);
        let mut st = State::new(frames, shape);
        st.rename_port("p0-01", 0, "🎙️ Andrey Kuzub");
        let l = st.label_of("p0-01", 0).unwrap();
        assert_eq!(l.l6, "🎙️ Andr");
        assert!(l.over8);
        let c = go(&mut st, "c1", "p0-01", "p0-02").unwrap();
        assert_eq!(st.path_gain_db(&c), 0.0);
        let trunk = c.hops[0].trunk.clone();
        assert_eq!(st.set_trunk_gain(&trunk, "a", -3.0).unwrap(), 0.0);
        st.set_trunk_gain(&trunk, "b", 1.5).unwrap();
        st.set_hop_gain("c1", 0, 2.0).unwrap();
        let c = st.connection("c1").unwrap().clone();
        assert!((st.path_gain_db(&c) - 0.5).abs() < 1e-9);
        assert!(st.set_hop_gain("c1", 3, 0.0).is_err());
        assert!(st.set_trunk_gain(&trunk, "x", 0.0).is_err());
    }
}
