//! frame-sim: one intercom simulator in its own little container.
//!
//! It hosts the frames of one protocol (`dante-01` … `dante-10`) and speaks
//! as a crosspoint: it connects to the caster's Ward-Beck port, announces
//! its frames with CHECKIN lines, applies every CLOSE/OPEN line it is sent
//! to its local matrices, echoes each applied line back as the
//! acknowledgement, and checks in periodically with its full state.
//!
//! With a broker (`SIM_MQTT`) it also subscribes to its protocol's lines on
//! MQTT and double validates: a CLOSE/OPEN line is applied only once the
//! same line has arrived over the Ward-Beck port *and* over MQTT. It is then
//! acked on both; a copy whose twin does not arrive within the window
//! (`SIM_VALIDATE_MS`) is dropped and reported on the reject topic.
//!
//! ```text
//! frame-sim --protocol dante --frames 10 --caster trunk-caster:7879 --site HQ --mqtt mqtt:1883
//! env: SIM_PROTOCOL SIM_FRAMES SIM_CASTER SIM_SITE SIM_CHECKIN_SECONDS SIM_USER_PORTS SIM_CASTERS SIM_NAME SIM_MQTT SIM_VALIDATE_MS
//!      SIM_VOICE SIM_HTTP SIM_VOICE_DIR SIM_VOICE_FAULTS SIM_VOICE_PACE SIM_VOICE_GAP_MS
//! ```
//!
//! Each frame also has a voice (see `voice`), all of them talking at once
//! in the accents of their countries: it says what it is when first hosted
//! and, the whole time it is connected, says its connections, from and to,
//! through the wave sender's 1-second and 5-second cuts.

mod voice;

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use trunk_caster_sdk::mqtt::{self, Path, Validator};
use trunk_caster_sdk::wardbeck::{Line, Switch};

struct Opts {
    protocol: String,
    frames: usize,
    caster: String,
    site: String,
    checkin: Duration,
    user_ports: usize,
    casters: usize,
    /// How this simulator names itself: its container name (SIM_NAME), else
    /// the host name. Announced after an `@` in every check-in.
    host: String,
    /// MQTT broker for the second copy of every line; None = Ward-Beck only.
    mqtt: Option<String>,
    /// How long a copy waits for its twin on the other transport.
    validate: Duration,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.trim().is_empty())
}

fn parse() -> Opts {
    let mut o = Opts {
        protocol: env("SIM_PROTOCOL").unwrap_or_else(|| "dante".into()),
        frames: env("SIM_FRAMES").and_then(|v| v.parse().ok()).unwrap_or(10),
        caster: env("SIM_CASTER").unwrap_or_else(|| "127.0.0.1:7879".into()),
        site: env("SIM_SITE").unwrap_or_else(|| "trunk-caster".into()),
        checkin: Duration::from_secs(env("SIM_CHECKIN_SECONDS").and_then(|v| v.parse().ok()).unwrap_or(20)),
        user_ports: env("SIM_USER_PORTS").and_then(|v| v.parse().ok()).unwrap_or(56),
        casters: env("SIM_CASTERS").and_then(|v| v.parse().ok()).unwrap_or(8),
        host: env("SIM_NAME").or_else(|| env("HOSTNAME")).or_else(|| env("COMPUTERNAME")).unwrap_or_else(|| "frame-sim".into()),
        mqtt: env("SIM_MQTT").filter(|v| v != "off"),
        validate: Duration::from_millis(env("SIM_VALIDATE_MS").and_then(|v| v.parse().ok()).unwrap_or(3000)),
    };
    let mut a = std::env::args().skip(1);
    while let Some(k) = a.next() {
        let mut v = || a.next().unwrap_or_default();
        match k.as_str() {
            "--protocol" => o.protocol = v(),
            "--frames" => o.frames = v().parse().unwrap_or(10),
            "--caster" => o.caster = v(),
            "--site" => o.site = v(),
            "--checkin" => o.checkin = Duration::from_secs(v().parse().unwrap_or(20)),
            "--user-ports" => o.user_ports = v().parse().unwrap_or(56),
            "--casters" => o.casters = v().parse().unwrap_or(8),
            "--name" => o.host = v(),
            "--mqtt" => o.mqtt = Some(v()).filter(|v| !v.is_empty() && v != "off"),
            "--validate-ms" => o.validate = Duration::from_millis(v().parse().unwrap_or(3000)),
            "-h" | "--help" => {
                eprintln!("frame-sim --protocol <id> --frames <n> --caster <host:port> --site <name> --checkin <s> --mqtt <host:port> --validate-ms <ms>");
                std::process::exit(0);
            }
            _ => {}
        }
    }
    o
}

/// A simulated frame: its closed crosspoints and the names on its ports.
#[derive(Default)]
struct Frame {
    closed: BTreeSet<(String, String)>,
    names: BTreeMap<String, String>,
    applied: u64,
}

struct Sim {
    opts: Opts,
    frames: BTreeMap<String, Frame>,
    /// Site of each hosted frame, learned from the caster's check-in lines.
    sites: BTreeMap<String, String>,
    /// The parallel transport and the pairing of copies across the two.
    link: Option<mqtt::Link>,
    validator: Validator,
    voice: Option<voice::Voice>,
}

impl Sim {
    fn new(opts: Opts, link: Option<mqtt::Link>) -> Self {
        let validator = Validator::new(opts.validate);
        let voice = voice::Voice::start(&opts.protocol, &opts.host, &opts.caster, opts.mqtt.as_deref());
        Sim { opts, frames: BTreeMap::new(), sites: BTreeMap::new(), link, validator, voice }
    }

    /// One copy of a CLOSE/OPEN line arrived over `path`. With MQTT on, it
    /// waits for its twin; when the pair is complete (or MQTT is off) the
    /// line is applied, echoed on the Ward-Beck port and acked over MQTT.
    fn receive(&mut self, l: &Line, path: Path, writer: &mut impl Write) -> std::io::Result<()> {
        if self.link.is_some() && !self.validator.offer(&l.to_string(), path) {
            return Ok(());
        }
        if !self.apply(l) {
            return Ok(());
        }
        // Speak as a crosspoint: echo what we did.
        writeln!(writer, "{l}")?;
        if let Some(link) = &self.link {
            link.publish(&mqtt::ack_topic(&self.opts.protocol, &l.frame), &l.to_string());
        }
        if l.is_local() {
            eprintln!("[{}] {} {}→{}{}", l.frame, l.switch.as_str(), l.input, l.output, if self.link.is_some() { " ✓✓" } else { "" });
        }
        Ok(())
    }

    /// Drop copies whose twin never came and report them.
    fn expire(&mut self) {
        let Some(link) = self.link.clone() else { return };
        for (text, path) in self.validator.expire() {
            let Ok(l) = Line::parse(&text) else { continue };
            if !self.frames.contains_key(&l.frame) {
                continue;
            }
            let why = match path {
                Path::Tcp => "only via ward-beck",
                Path::Mqtt => "only via mqtt",
            };
            eprintln!("[{}] rejected {text}: {why}", l.frame);
            link.publish(&mqtt::reject_topic(&self.opts.protocol, &l.frame), &format!("{why}|{text}"));
        }
    }

    /// Take the MQTT copies that arrived since the last call.
    fn take_mqtt(&mut self) -> Vec<Line> {
        let Some(link) = &self.link else { return Vec::new() };
        link.drain()
            .into_iter()
            .filter_map(|(topic, payload)| {
                let (_, _, kind) = mqtt::parse_topic(&topic)?;
                if kind != "line" {
                    return None;
                }
                Line::parse(payload.trim()).ok().filter(|l| !l.is_checkin())
            })
            .collect()
    }

    fn site_of(&self, frame: &str) -> &str {
        self.sites.get(frame).map(String::as_str).unwrap_or(&self.opts.site)
    }

    fn now() -> String {
        let s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        // Good enough for a log line: seconds since epoch as ISO-ish.
        format!("{}", s)
    }

    /// Apply a line to the frame it names. Returns true if it was ours.
    fn apply(&mut self, l: &Line) -> bool {
        if l.is_checkin() {
            return false;
        }
        if !l.is_local() {
            // End-to-end line: informational for us. Either end may be ours
            // (the caster sends it to both): remember the names there and say
            // the connection from that end, to the other.
            let ends = [
                (&l.frame, &l.site, &l.input, &l.input_name, &l.out_frame, &l.out_site, &l.output, &l.output_name),
                (&l.out_frame, &l.out_site, &l.output, &l.output_name, &l.frame, &l.site, &l.input, &l.input_name),
            ];
            let mut ours = false;
            for (frame, site, port, name, far, far_site, far_port, far_name) in ends {
                let Some(f) = self.frames.get_mut(frame) else { continue };
                ours = true;
                f.names.insert(port.clone(), name.clone());
                if let Some(v) = &self.voice {
                    match l.switch {
                        Switch::Close => v.call(frame, site, port, name, far, far_site, far_port, far_name),
                        Switch::Open => v.hangup(frame, port),
                    }
                }
            }
            return ours;
        }
        let Some(f) = self.frames.get_mut(&l.frame) else { return false };
        if !valid_port(&l.input, self.opts.user_ports, self.opts.casters) || !valid_port(&l.output, self.opts.user_ports, self.opts.casters) {
            eprintln!("[{}] rejected {l}: no such port", l.frame);
            return false;
        }
        let key = (l.input.clone(), l.output.clone());
        match l.switch {
            Switch::Close => {
                f.closed.insert(key);
                f.names.insert(l.input.clone(), l.input_name.clone());
                f.names.insert(l.output.clone(), l.output_name.clone());
            }
            Switch::Open => {
                f.closed.remove(&key);
            }
        }
        f.applied += 1;
        true
    }

    /// CHECKIN header plus CLOSE lines for one frame.
    fn checkin_lines(&self, frame: &str) -> Vec<Line> {
        let f = &self.frames[frame];
        let site = self.site_of(frame);
        let mut out = vec![Line::checkin(site, frame, &format!("{} @{}", Self::now(), self.opts.host), f.closed.len())];
        for (i, o) in &f.closed {
            let name = |p: &str| f.names.get(p).cloned().unwrap_or_else(|| p.to_string());
            out.push(Line::local(site, frame, i, &name(i), Switch::Close, &name(o), o));
        }
        out
    }
}

fn valid_port(p: &str, user_ports: usize, casters: usize) -> bool {
    if let Some(n) = p.strip_prefix('U').and_then(|n| n.parse::<usize>().ok()) {
        return n < user_ports;
    }
    if let Some(n) = p.strip_prefix('C').and_then(|n| n.parse::<usize>().ok()) {
        return n < casters;
    }
    false
}

fn main() {
    let opts = parse();
    eprintln!(
        "frame-sim: every {} frame the caster has (up to {}+{} ports each), default site {}, caster {}",
        opts.protocol, opts.user_ports, opts.casters, opts.site, opts.caster
    );
    let checkin_every = opts.checkin;
    let caster = opts.caster.clone();
    // The parallel transport comes up first, so the full state the caster
    // sends right after our announce arrives over both paths.
    let link = opts.mqtt.as_ref().map(|broker| {
        let link = mqtt::Link::start(broker, &format!("sim-{}", opts.host), vec![format!("{}/{}/+/line", mqtt::ROOT, opts.protocol)]);
        if link.wait_connected(Duration::from_secs(15)) {
            eprintln!("MQTT via {broker}: every line is double validated (window {:?})", opts.validate);
        } else {
            eprintln!("MQTT broker {broker} not reachable yet; lines are rejected until it is");
        }
        link
    });
    let sim = Arc::new(Mutex::new(Sim::new(opts, link)));
    let mut backoff = 1u64;

    loop {
        match TcpStream::connect(&caster) {
            Ok(stream) => {
                backoff = 1;
                eprintln!("connected to caster at {caster}");
                if let Err(e) = session(stream, sim.clone(), checkin_every) {
                    eprintln!("session ended: {e}");
                }
            }
            Err(e) => eprintln!("cannot reach caster at {caster}: {e}; retrying in {backoff}s"),
        }
        thread::sleep(Duration::from_secs(backoff));
        backoff = (backoff * 2).min(30);
    }
}

fn session(stream: TcpStream, sim: Arc<Mutex<Sim>>, checkin_every: Duration) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    // With MQTT on, wake often to pair copies from the broker.
    let mqtt_on = sim.lock().unwrap_or_else(|e| e.into_inner()).link.is_some();
    stream.set_read_timeout(Some(Duration::from_millis(if mqtt_on { 20 } else { 500 })))?;
    let mut reader = BufReader::new(stream);

    // Announce: "I host every frame of this protocol" (FRAME = <protocol>-*).
    // The caster answers with a CHECKIN per frame followed by its CLOSE
    // lines, and we learn our frame ids from those.
    {
        let mut s = sim.lock().unwrap_or_else(|e| e.into_inner());
        s.frames.clear();
        if let Some(v) = &s.voice {
            v.reset_calls();
        }
        let wildcard = format!("{}-*", s.opts.protocol);
        writeln!(writer, "{}", Line::checkin(&s.opts.site, &wildcard, &format!("{} @{}", Sim::now(), s.opts.host), 0))?;
        writer.flush()?;
        eprintln!("announced {wildcard}");
    }

    let mut last_checkin = Instant::now();
    let mut line = String::new();
    loop {
        // A read timeout can land mid-line: the bytes read so far stay in
        // `line` and the next read completes it, so only a whole line is
        // taken out.
        match reader.read_line(&mut line) {
            Ok(0) => return Err(std::io::Error::other("caster closed the connection")),
            Ok(_) => {
                let whole = std::mem::take(&mut line);
                let text = whole.trim();
                if text.is_empty() {
                    continue;
                }
                match Line::parse(text) {
                    Ok(l) => {
                        let mut s = sim.lock().unwrap_or_else(|e| e.into_inner());
                        if l.is_checkin() {
                            // The caster's view of one of our frames: adopt the frame
                            // (its site too); the CLOSE lines that follow are applied.
                            if l.frame != "*" && !s.frames.contains_key(&l.frame) {
                                s.frames.insert(l.frame.clone(), Frame::default());
                                s.sites.insert(l.frame.clone(), l.site.clone());
                                eprintln!("hosting {} at {}", l.frame, l.site);
                                if let Some(v) = &s.voice {
                                    v.ident(&l.frame, &l.site);
                                }
                            }
                            continue;
                        }
                        s.receive(&l, Path::Tcp, &mut writer)?;
                    }
                    Err(e) => eprintln!("bad line ignored ({e}): {text}"),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(e),
        }

        if mqtt_on {
            let mut s = sim.lock().unwrap_or_else(|e| e.into_inner());
            for l in s.take_mqtt() {
                s.receive(&l, Path::Mqtt, &mut writer)?;
            }
            s.expire();
            writer.flush()?;
        }

        if last_checkin.elapsed() >= checkin_every {
            let s = sim.lock().unwrap_or_else(|e| e.into_inner());
            let mut n = 0;
            for f in s.frames.keys() {
                for l in s.checkin_lines(f) {
                    writeln!(writer, "{l}")?;
                    n += 1;
                }
            }
            writer.flush()?;
            let closed: usize = s.frames.values().map(|f| f.closed.len()).sum();
            eprintln!("check-in: {} frames, {closed} crosspoints closed, {n} lines", s.frames.len());
            last_checkin = Instant::now();
        }
    }
}
