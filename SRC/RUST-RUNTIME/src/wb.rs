//! The Ward-Beck port: remote frames (the per-protocol simulator
//! containers, later real frames) connect over TCP and speak crosspoint
//! lines, newline terminated.
//!
//! * A remote announces the frames it hosts by sending a CHECKIN line per
//!   frame. From then on the caster sends it every CLOSE/OPEN line for
//!   those frames, starting with a full state.
//! * The remote echoes every line it applied: that is its acknowledgement.
//! * The remote checks in periodically (CHECKIN header then CLOSE lines);
//!   the caster records what it reports and compares.
//! * With a broker configured (`TRUNK_MQTT`), every line sent down the port
//!   is also published to MQTT. The remote applies a line only when both
//!   copies agree, then acks over MQTT too; lone copies come back as
//!   rejects. See `trunk_caster_sdk::mqtt`.

use crate::util;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use trunk_caster_sdk::mqtt;
use trunk_caster_sdk::wardbeck::Line;
use trunk_caster_sdk::RemoteFrame;

struct Client {
    id: u64,
    peer: String,
    stream: TcpStream,
    frames: HashSet<String>,
    alive: bool,
}

#[derive(Default)]
struct HubState {
    clients: Vec<Client>,
    /// (client id, line) received, drained by the runtime each tick.
    inbox: VecDeque<(u64, Line)>,
    bad_lines: u64,
    next_id: u64,
    /// The parallel transport, when a broker is configured.
    mqtt: Option<mqtt::Link>,
    /// Frame id → protocol, for MQTT topics.
    protocol_of: HashMap<String, String>,
}

/// Shared between the listener threads and the runtime.
#[derive(Clone, Default)]
pub struct Hub {
    state: Arc<Mutex<HubState>>,
}

/// What the runtime learned about remote frames.
#[derive(Default)]
pub struct Remotes {
    pub frames: HashMap<String, RemoteFrame>,
    pub lines_in: u64,
}

pub enum Event {
    /// A remote announced (or re-announced) that it hosts `frame`.
    Announce { client: u64, frame: String },
    /// A remote echoed a line we sent: an acknowledgement.
    Ack,
    /// A remote checked in with its full state; the lines follow as acks.
    Checkin { frame: String, reported_closed: usize },
}

impl Hub {
    /// Run MQTT in parallel with the Ward-Beck port: publish every line to
    /// `broker` and listen for the remotes' acks and rejects.
    pub fn attach_mqtt(&self, broker: &str, client_id: &str) {
        let filters = vec![format!("{}/+/+/ack", mqtt::ROOT), format!("{}/+/+/reject", mqtt::ROOT)];
        let link = mqtt::Link::start(broker, client_id, filters);
        self.state.lock().unwrap_or_else(|e| e.into_inner()).mqtt = Some(link);
    }

    pub fn mqtt_stats(&self) -> Option<mqtt::LinkStats> {
        self.state.lock().ok()?.mqtt.as_ref().map(|l| l.stats())
    }

    /// Publish a line's MQTT copy for `frame`.
    fn publish(st: &HubState, frame: &str, line: &Line) {
        let Some(link) = &st.mqtt else { return };
        let Some(proto) = st.protocol_of.get(frame) else { return };
        link.publish(&mqtt::line_topic(proto, frame), &line.to_string());
    }

    /// Start listening. Each connection gets a reader thread that parses
    /// lines into the inbox.
    pub fn listen(&self, addr: &str) -> io::Result<()> {
        let listener = TcpListener::bind(addr)?;
        let hub = self.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_else(|_| "?".into());
                let id = {
                    let mut st = hub.state.lock().unwrap_or_else(|e| e.into_inner());
                    st.next_id += 1;
                    let id = st.next_id;
                    if let Ok(w) = stream.try_clone() {
                        st.clients.push(Client { id, peer: peer.clone(), stream: w, frames: HashSet::new(), alive: true });
                    }
                    id
                };
                let hub = hub.clone();
                thread::spawn(move || hub.read_loop(id, stream));
            }
        });
        Ok(())
    }

    fn read_loop(&self, id: u64, stream: TcpStream) {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(text) = line else { break };
            if text.trim().is_empty() {
                continue;
            }
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match Line::parse(&text) {
                Ok(l) => st.inbox.push_back((id, l)),
                Err(_) => st.bad_lines += 1,
            }
            if st.inbox.len() > 50_000 {
                st.inbox.pop_front();
            }
        }
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = st.clients.iter_mut().find(|c| c.id == id) {
            c.alive = false;
        }
    }

    /// Drain received lines into events, updating client→frame ownership.
    /// `by_protocol` resolves wildcard announces (`FRAME = dante-*`: "I host
    /// every dante frame") to the actual frame ids.
    pub fn drain(&self, remotes: &mut Remotes, by_protocol: &HashMap<String, Vec<String>>) -> Vec<Event> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if st.mqtt.is_some() && st.protocol_of.len() != by_protocol.values().map(Vec::len).sum::<usize>() {
            st.protocol_of = by_protocol.iter().flat_map(|(p, fs)| fs.iter().map(move |f| (f.clone(), p.clone()))).collect();
        }
        // The parallel transport: acks and rejects from the remotes.
        let msgs = st.mqtt.as_ref().map(|l| l.drain()).unwrap_or_default();
        for (topic, payload) in msgs {
            let Some((_, frame, kind)) = mqtt::parse_topic(&topic) else { continue };
            let Some(r) = remotes.frames.get_mut(frame) else { continue };
            match kind {
                "ack" => r.mqtt_acks += 1,
                "reject" => {
                    r.rejects += 1;
                    if r.rejects <= 20 || r.rejects % 100 == 0 {
                        eprintln!("remote {frame} rejected (#{}) {payload}", r.rejects);
                    }
                }
                _ => {}
            }
        }
        let mut events = Vec::new();
        while let Some((cid, line)) = st.inbox.pop_front() {
            remotes.lines_in += 1;
            let now = util::now_iso();
            let Some(client) = st.clients.iter_mut().find(|c| c.id == cid) else { continue };
            if line.is_checkin() {
                if line.frame == "*" {
                    continue;
                }
                let frames: Vec<String> = match line.frame.strip_suffix("-*") {
                    Some(proto) => by_protocol.get(proto).cloned().unwrap_or_default(),
                    None => vec![line.frame.clone()],
                };
                let reported: usize = line.output.parse().unwrap_or(0);
                // "<when> @<host>": the host (container name) the simulator
                // announced itself from.
                let host: Option<String> = line.input_name.rsplit_once('@').map(|(_, h)| h.trim().to_string()).filter(|h| !h.is_empty());
                for frame in frames {
                    let first = !client.frames.contains(&frame);
                    client.frames.insert(frame.clone());
                    let peer = client.peer.clone();
                    let r = remotes.frames.entry(frame.clone()).or_insert_with(|| RemoteFrame {
                        frame: frame.clone(),
                        peer: peer.clone(),
                        connected_at: now.clone(),
                        last_seen: now.clone(),
                        last_checkin: None,
                        reported_closed: 0,
                        lines_sent: 0,
                        acks: 0,
                        checkins: 0,
                        mqtt_acks: 0,
                        rejects: 0,
                        connected: true,
                        host: host.clone(),
                    });
                    if !r.connected || r.peer != peer {
                        r.connected_at = now.clone();
                        r.peer = peer;
                        r.connected = true;
                    }
                    if host.is_some() {
                        r.host = host.clone();
                    }
                    r.last_seen = now.clone();
                    if first {
                        events.push(Event::Announce { client: cid, frame });
                    } else {
                        r.last_checkin = Some(now.clone());
                        r.reported_closed = reported;
                        r.checkins += 1;
                        events.push(Event::Checkin { frame, reported_closed: reported });
                    }
                }
            } else if client.frames.contains(&line.frame) {
                if let Some(r) = remotes.frames.get_mut(&line.frame) {
                    r.acks += 1;
                    r.last_seen = now;
                }
                events.push(Event::Ack);
            }
        }
        // Mark remotes whose client went away.
        let dead: Vec<String> = st
            .clients
            .iter()
            .filter(|c| !c.alive)
            .flat_map(|c| c.frames.iter().cloned())
            .collect();
        for f in dead {
            if let Some(r) = remotes.frames.get_mut(&f) {
                r.connected = false;
            }
        }
        st.clients.retain(|c| c.alive);
        events
    }

    /// Send a line to whichever remote hosts `frame`. Returns true if sent.
    pub fn send(&self, frame: &str, line: &Line, remotes: &mut Remotes) -> bool {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // Both copies go only to a frame a remote hosts, so a twin is never
        // published to a frame whose Ward-Beck copy has nowhere to go.
        if !st.clients.iter().any(|c| c.alive && c.frames.contains(frame)) {
            return false;
        }
        Self::publish(&st, frame, line);
        let Some(client) = st.clients.iter_mut().find(|c| c.alive && c.frames.contains(frame)) else { return false };
        let ok = writeln!(client.stream, "{line}").and_then(|_| client.stream.flush()).is_ok();
        if !ok {
            client.alive = false;
        } else if let Some(r) = remotes.frames.get_mut(frame) {
            r.lines_sent += 1;
        }
        ok
    }

    /// Send a batch to one client by id (used for the full state after an
    /// announce).
    pub fn send_to(&self, client: u64, lines: &[Line], remotes: &mut Remotes) -> usize {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(hosted) = st.clients.iter().find(|c| c.id == client && c.alive).map(|c| c.frames.clone()) else { return 0 };
        for l in lines {
            // An end-to-end line may be in the state for its far end: its
            // twin goes on the topic of the end this client hosts.
            let frame = if hosted.contains(&l.frame) || l.is_local() { &l.frame } else { &l.out_frame };
            Self::publish(&st, frame, l);
        }
        let Some(c) = st.clients.iter_mut().find(|c| c.id == client && c.alive) else { return 0 };
        let mut n = 0;
        for l in lines {
            if writeln!(c.stream, "{l}").is_err() {
                c.alive = false;
                break;
            }
            n += 1;
            if let Some(r) = remotes.frames.get_mut(&l.frame) {
                r.lines_sent += 1;
            }
        }
        let _ = c.stream.flush();
        n
    }

    pub fn bad_lines(&self) -> u64 {
        self.state.lock().map(|s| s.bad_lines).unwrap_or(0)
    }
}
