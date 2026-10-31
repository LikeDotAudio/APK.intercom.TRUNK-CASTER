//! MQTT: the second transport between the caster and the simulators.
//!
//! The Ward-Beck TCP port is the high-speed path. Every crosspoint line the
//! caster sends down it is also published to an MQTT broker, and a frame
//! applies a line only when the same line has arrived over both: the request
//! is validated twice, by two independent paths. Echoes (acks) and
//! rejections come back over MQTT as well.
//!
//! ```text
//! trunk-caster/<protocol>/<frame>/line     caster → frame   one Ward-Beck line
//! trunk-caster/<protocol>/<frame>/ack      frame → caster   the line, applied (double validated)
//! trunk-caster/<protocol>/<frame>/reject   frame → caster   "<reason>|<line>"
//! ```
//!
//! A minimal MQTT 3.1.1 client on std only: CONNECT, SUBSCRIBE and PUBLISH
//! at QoS 0, PINGREQ keep-alive, and a background thread that reconnects.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Root of every Trunk-Caster topic.
pub const ROOT: &str = "trunk-caster";
const KEEPALIVE_S: u16 = 30;

pub fn line_topic(protocol: &str, frame: &str) -> String {
    format!("{ROOT}/{protocol}/{frame}/line")
}
pub fn ack_topic(protocol: &str, frame: &str) -> String {
    format!("{ROOT}/{protocol}/{frame}/ack")
}
pub fn reject_topic(protocol: &str, frame: &str) -> String {
    format!("{ROOT}/{protocol}/{frame}/reject")
}

/// Split `trunk-caster/<protocol>/<frame>/<kind>` into (protocol, frame, kind).
pub fn parse_topic(topic: &str) -> Option<(&str, &str, &str)> {
    let mut p = topic.split('/');
    if p.next()? != ROOT {
        return None;
    }
    let (proto, frame, kind) = (p.next()?, p.next()?, p.next()?);
    if p.next().is_some() {
        return None;
    }
    Some((proto, frame, kind))
}

// ---------------------------------------------------------------------------
// Packets
// ---------------------------------------------------------------------------

fn put_str(b: &mut Vec<u8>, s: &str) {
    b.extend_from_slice(&(s.len() as u16).to_be_bytes());
    b.extend_from_slice(s.as_bytes());
}

fn packet(header: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![header];
    let mut n = body.len();
    loop {
        let mut byte = (n % 128) as u8;
        n /= 128;
        if n > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if n == 0 {
            break;
        }
    }
    out.extend_from_slice(body);
    out
}

fn connect_packet(client_id: &str) -> Vec<u8> {
    let mut b = Vec::new();
    put_str(&mut b, "MQTT");
    b.push(4); // protocol level 3.1.1
    b.push(0x02); // clean session
    b.extend_from_slice(&KEEPALIVE_S.to_be_bytes());
    put_str(&mut b, client_id);
    packet(0x10, &b)
}

fn subscribe_packet(id: u16, filters: &[String]) -> Vec<u8> {
    let mut b = id.to_be_bytes().to_vec();
    for f in filters {
        put_str(&mut b, f);
        b.push(0); // QoS 0
    }
    packet(0x82, &b)
}

fn publish_packet(topic: &str, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    put_str(&mut b, topic);
    b.extend_from_slice(payload);
    packet(0x30, &b)
}

/// Read one packet: (first byte, body).
fn read_packet(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut h = [0u8; 1];
    r.read_exact(&mut h)?;
    let (mut len, mut mult) = (0usize, 1usize);
    for _ in 0..4 {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        len += (b[0] & 0x7f) as usize * mult;
        if b[0] & 0x80 == 0 {
            break;
        }
        mult *= 128;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    Ok((h[0], body))
}

/// Take one whole packet off the front of `buf`, if one has fully arrived.
/// Reads with a timeout can stop mid-packet; the rest stays buffered.
fn take_packet(buf: &mut Vec<u8>) -> Option<(u8, Vec<u8>)> {
    let (mut len, mut mult, mut i) = (0usize, 1usize, 1usize);
    loop {
        let b = *buf.get(i)?;
        len += (b & 0x7f) as usize * mult;
        i += 1;
        if b & 0x80 == 0 || i > 4 {
            break;
        }
        mult *= 128;
    }
    if buf.len() < i + len {
        return None;
    }
    let header = buf[0];
    let body = buf[i..i + len].to_vec();
    buf.drain(..i + len);
    Some((header, body))
}

/// The topic and payload of a PUBLISH body (QoS 0 has no packet id).
fn parse_publish(header: u8, body: &[u8]) -> Option<(String, String)> {
    if body.len() < 2 {
        return None;
    }
    let tl = u16::from_be_bytes([body[0], body[1]]) as usize;
    let topic = std::str::from_utf8(body.get(2..2 + tl)?).ok()?.to_string();
    let skip = if (header >> 1) & 0x03 > 0 { 2 } else { 0 };
    let payload = String::from_utf8_lossy(body.get(2 + tl + skip..)?).into_owned();
    Some((topic, payload))
}

// ---------------------------------------------------------------------------
// Link: a reconnecting client shared between threads
// ---------------------------------------------------------------------------

#[derive(Default)]
struct LinkState {
    writer: Option<TcpStream>,
    inbox: VecDeque<(String, String)>,
    connected: bool,
    published: u64,
    received: u64,
    connects: u64,
}

/// A connection to the broker that keeps itself up. Messages arriving on the
/// subscribed filters queue in an inbox the owner drains.
#[derive(Clone)]
pub struct Link {
    pub broker: String,
    state: Arc<Mutex<LinkState>>,
}

/// Counters for status pages.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct LinkStats {
    pub broker: String,
    pub connected: bool,
    pub published: u64,
    pub received: u64,
    pub connects: u64,
}

impl Link {
    /// Connect to `broker` (host:port) in the background and subscribe to
    /// `filters` on every (re)connect.
    pub fn start(broker: &str, client_id: &str, filters: Vec<String>) -> Link {
        let link = Link { broker: broker.to_string(), state: Arc::new(Mutex::new(LinkState::default())) };
        let me = link.clone();
        let id = client_id.to_string();
        thread::spawn(move || {
            let mut backoff = 1u64;
            loop {
                match me.session(&id, &filters) {
                    Ok(()) => backoff = 1,
                    Err(e) => eprintln!("mqtt {}: {e}; retrying in {backoff}s", me.broker),
                }
                me.lock().connected = false;
                me.lock().writer = None;
                thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(30);
            }
        });
        link
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LinkState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn session(&self, client_id: &str, filters: &[String]) -> io::Result<()> {
        let mut s = TcpStream::connect(&self.broker)?;
        s.set_nodelay(true)?;
        s.write_all(&connect_packet(client_id))?;
        s.set_read_timeout(Some(Duration::from_secs(5)))?;
        let (h, body) = read_packet(&mut s)?;
        if h >> 4 != 2 || body.get(1) != Some(&0) {
            return Err(io::Error::other(format!("broker refused the connection (code {:?})", body.get(1))));
        }
        if !filters.is_empty() {
            s.write_all(&subscribe_packet(1, filters))?;
        }
        {
            let mut st = self.lock();
            st.writer = Some(s.try_clone()?);
            st.connected = true;
            st.connects += 1;
        }
        eprintln!("mqtt connected to {} as {client_id}", self.broker);
        s.set_read_timeout(Some(Duration::from_secs(1)))?;
        let mut last_ping = Instant::now();
        let (mut buf, mut chunk) = (Vec::new(), vec![0u8; 64 * 1024]);
        loop {
            match s.read(&mut chunk) {
                Ok(0) => return Err(io::Error::other("broker closed the connection")),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut => {}
                Err(e) => return Err(e),
            }
            while let Some((h, body)) = take_packet(&mut buf) {
                // Only PUBLISH matters; SUBACK and PINGRESP are skipped.
                if h >> 4 != 3 {
                    continue;
                }
                if let Some(m) = parse_publish(h, &body) {
                    let mut st = self.lock();
                    st.received += 1;
                    st.inbox.push_back(m);
                    if st.inbox.len() > 50_000 {
                        st.inbox.pop_front();
                    }
                }
            }
            if last_ping.elapsed() >= Duration::from_secs(KEEPALIVE_S as u64 / 2) {
                let mut st = self.lock();
                let ok = st.writer.as_mut().map(|w| w.write_all(&[0xC0, 0x00]).is_ok()).unwrap_or(false);
                if !ok {
                    return Err(io::Error::other("ping failed"));
                }
                last_ping = Instant::now();
            }
        }
    }

    /// Publish at QoS 0. False when the broker is not connected.
    pub fn publish(&self, topic: &str, payload: &str) -> bool {
        let mut st = self.lock();
        let Some(w) = st.writer.as_mut() else { return false };
        if w.write_all(&publish_packet(topic, payload.as_bytes())).is_err() {
            st.writer = None;
            st.connected = false;
            return false;
        }
        st.published += 1;
        true
    }

    /// Take every message received so far.
    pub fn drain(&self) -> Vec<(String, String)> {
        self.lock().inbox.drain(..).collect()
    }

    pub fn connected(&self) -> bool {
        self.lock().connected
    }

    /// Wait up to `max` for the first connection.
    pub fn wait_connected(&self, max: Duration) -> bool {
        let t = Instant::now();
        while t.elapsed() < max {
            if self.connected() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.connected()
    }

    pub fn stats(&self) -> LinkStats {
        let st = self.lock();
        LinkStats { broker: self.broker.clone(), connected: st.connected, published: st.published, received: st.received, connects: st.connects }
    }
}

// ---------------------------------------------------------------------------
// Double validation
// ---------------------------------------------------------------------------

/// Which path a copy of a request came over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Path {
    Tcp,
    Mqtt,
}

/// Pairs copies of the same request arriving over the two transports. A
/// request is released only when it has been seen on both; a copy whose twin
/// does not arrive within the window expires as a rejection.
///
/// Identical lines may legitimately repeat (CLOSE, OPEN, CLOSE …), so each
/// text keeps a queue of unmatched arrival times per path. Both transports
/// are ordered, so pairs complete in the order the slower path delivers.
pub struct Validator {
    window: Duration,
    pending: std::collections::HashMap<String, (VecDeque<Instant>, VecDeque<Instant>)>,
    pub validated: u64,
    pub rejected: u64,
}

impl Validator {
    pub fn new(window: Duration) -> Self {
        Validator { window, pending: Default::default(), validated: 0, rejected: 0 }
    }

    /// Offer one copy. Returns true when this copy completes a pair: the
    /// request is double validated and may be applied.
    pub fn offer(&mut self, text: &str, path: Path) -> bool {
        let e = self.pending.entry(text.to_string()).or_default();
        let (mine, twin) = match path {
            Path::Tcp => (&mut e.0, &mut e.1),
            Path::Mqtt => (&mut e.1, &mut e.0),
        };
        if twin.pop_front().is_some() {
            if e.0.is_empty() && e.1.is_empty() {
                self.pending.remove(text);
            }
            self.validated += 1;
            return true;
        }
        mine.push_back(Instant::now());
        false
    }

    /// Copies that waited past the window without a twin: (text, path they
    /// arrived on). They are dropped and counted as rejected.
    pub fn expire(&mut self) -> Vec<(String, Path)> {
        let now = Instant::now();
        let w = self.window;
        let mut out = Vec::new();
        self.pending.retain(|text, (tcp, mqtt)| {
            for (q, p) in [(&mut *tcp, Path::Tcp), (&mut *mqtt, Path::Mqtt)] {
                while q.front().is_some_and(|t| now.duration_since(*t) > w) {
                    q.pop_front();
                    out.push((text.clone(), p));
                }
            }
            !(tcp.is_empty() && mqtt.is_empty())
        });
        self.rejected += out.len() as u64;
        out
    }

    pub fn waiting(&self) -> usize {
        self.pending.values().map(|(a, b)| a.len() + b.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_across_paths_only() {
        let mut v = Validator::new(Duration::from_secs(5));
        assert!(!v.offer("A", Path::Tcp));
        assert!(!v.offer("A", Path::Tcp));
        assert!(v.offer("A", Path::Mqtt));
        assert!(v.offer("A", Path::Mqtt));
        assert!(!v.offer("A", Path::Mqtt));
        assert_eq!(v.validated, 2);
        assert_eq!(v.waiting(), 1);
    }

    #[test]
    fn lone_copy_expires() {
        let mut v = Validator::new(Duration::from_millis(0));
        assert!(!v.offer("B", Path::Mqtt));
        thread::sleep(Duration::from_millis(5));
        let gone = v.expire();
        assert_eq!(gone, vec![("B".to_string(), Path::Mqtt)]);
        assert_eq!(v.rejected, 1);
        assert_eq!(v.waiting(), 0);
    }

    #[test]
    fn packets_round_trip() {
        let p = publish_packet("trunk-caster/dante/dante-01/line", b"HQ,dante-01");
        let (h, body) = read_packet(&mut &p[..]).unwrap();
        assert_eq!(parse_publish(h, &body), Some(("trunk-caster/dante/dante-01/line".into(), "HQ,dante-01".into())));
        assert_eq!(parse_topic("trunk-caster/2-wire/2-wire-03/ack"), Some(("2-wire", "2-wire-03", "ack")));
        // Remaining length over 127 uses two bytes.
        let big = publish_packet("t", &[b'x'; 300]);
        let (_, body) = read_packet(&mut &big[..]).unwrap();
        assert_eq!(body.len(), 3 + 300);
    }

    #[test]
    fn partial_packets_wait_for_the_rest() {
        let mut stream = publish_packet("a/b", b"one");
        stream.extend(publish_packet("a/c", &[b'y'; 200]));
        let mut buf = Vec::new();
        let mut got = Vec::new();
        for byte in stream {
            buf.push(byte);
            while let Some((h, body)) = take_packet(&mut buf) {
                got.push(parse_publish(h, &body).unwrap().0);
            }
        }
        assert_eq!(got, vec!["a/b".to_string(), "a/c".to_string()]);
        assert!(buf.is_empty());
    }
}
