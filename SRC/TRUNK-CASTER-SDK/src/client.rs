//! Clients for a running Trunk-Caster runtime.
//!
//! * [`FileClient`] speaks the folder contract: it drops request files and
//!   waits for the reply file. It needs no network and works from any
//!   process that can see the project root.
//! * [`HttpClient`] talks to the runtime's local HTTP port with plain
//!   `std::net`, no extra dependencies.

use crate::folders::Layout;
use crate::types::*;
use crate::WIRE_VERSION;
use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    Json(serde_json::Error),
    Timeout,
    Http(u16, String),
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "io: {e}"),
            Error::Json(e) => write!(f, "json: {e}"),
            Error::Timeout => write!(f, "timed out waiting for the runtime"),
            Error::Http(code, body) => write!(f, "http {code}: {body}"),
        }
    }
}
impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------------------

/// Folder-based client.
#[derive(Debug, Clone)]
pub struct FileClient {
    pub layout: Layout,
}

impl FileClient {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        FileClient { layout: Layout::new(root) }
    }

    /// Every frame currently advertised.
    pub fn advertisements(&self) -> Result<Vec<Frame>> {
        let mut out = Vec::new();
        let dir = self.layout.advertisement();
        if !dir.is_dir() {
            return Ok(out);
        }
        for e in fs::read_dir(dir)?.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.extension().map_or(false, |x| x == "json") {
                if let Ok(f) = serde_json::from_str::<Frame>(&fs::read_to_string(&p)?) {
                    out.push(f);
                }
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    /// Drop a request and wait up to `timeout` for the reply.
    pub fn request(&self, mut req: Request, timeout: Duration) -> Result<Reply> {
        let id = req.id.clone().unwrap_or_else(|| format!("req-{}", unique_suffix()));
        req.id = Some(id.clone());
        let dir = self.layout.interface();
        fs::create_dir_all(&dir)?;
        let req_path = dir.join(format!("{id}.json"));
        let reply_path = dir.join(format!("{id}.reply.json"));
        let _ = fs::remove_file(&reply_path);
        fs::write(&req_path, serde_json::to_string_pretty(&req)?)?;

        let start = Instant::now();
        loop {
            if reply_path.is_file() {
                let text = fs::read_to_string(&reply_path)?;
                if let Ok(reply) = serde_json::from_str::<Reply>(&text) {
                    return Ok(reply);
                }
            }
            if start.elapsed() > timeout {
                return Err(Error::Timeout);
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// Release a connection by removing its request file. The runtime tears
    /// the connection down on its next tick.
    pub fn release(&self, id: &str) -> Result<()> {
        let p = self.layout.interface().join(format!("{id}.json"));
        match fs::remove_file(p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn fader(&self) -> Result<Fader> {
        Ok(serde_json::from_str(&fs::read_to_string(self.layout.fader())?)?)
    }

    pub fn set_fader(&self, fader: &Fader) -> Result<()> {
        fs::create_dir_all(self.layout.simulator())?;
        fs::write(self.layout.fader(), serde_json::to_string_pretty(fader)?)?;
        Ok(())
    }

    pub fn seek_panel(&self, mut seek: PanelSeek, timeout: Duration) -> Result<PanelOffer> {
        let id = seek.id.clone().unwrap_or_else(|| format!("seek-{}", unique_suffix()));
        seek.id = Some(id.clone());
        let dir = self.layout.seeks_dir();
        fs::create_dir_all(&dir)?;
        let offer_path = dir.join(format!("{id}.offer.json"));
        let _ = fs::remove_file(&offer_path);
        fs::write(dir.join(format!("{id}.json")), serde_json::to_string_pretty(&seek)?)?;
        let start = Instant::now();
        loop {
            if offer_path.is_file() {
                if let Ok(o) = serde_json::from_str::<PanelOffer>(&fs::read_to_string(&offer_path)?) {
                    return Ok(o);
                }
            }
            if start.elapsed() > timeout {
                return Err(Error::Timeout);
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
}

fn unique_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}", nanos, std::process::id())
}

// ---------------------------------------------------------------------------

/// HTTP client for the runtime's local port (default `127.0.0.1:7878`).
#[derive(Debug, Clone)]
pub struct HttpClient {
    pub addr: String,
}

impl HttpClient {
    pub fn new(addr: impl Into<String>) -> Self {
        HttpClient { addr: addr.into() }
    }

    pub fn status(&self) -> Result<Status> {
        self.get("/api/status")
    }

    pub fn advertisements(&self) -> Result<Vec<Frame>> {
        self.get("/api/advertisements")
    }

    pub fn request(&self, req: &Request) -> Result<Reply> {
        self.post("/api/request", req)
    }

    pub fn release(&self, id: &str) -> Result<Reply> {
        self.post("/api/release", &serde_json::json!({ "id": id }))
    }

    pub fn fader(&self) -> Result<Fader> {
        self.get("/api/fader")
    }

    pub fn set_fader(&self, fader: &Fader) -> Result<Fader> {
        self.post("/api/fader", fader)
    }

    pub fn seek_panel(&self, seek: &PanelSeek) -> Result<PanelOffer> {
        self.post("/api/panel-seek", seek)
    }

    pub fn crosspoint_settings(&self, s: &CrosspointSettings) -> Result<CrosspointSettings> {
        self.post("/api/crosspoints/settings", s)
    }

    /// Send a GPIO command down a live connection's trunk path.
    pub fn gpio(&self, cmd: &GpioCommand) -> Result<GpioEvent> {
        self.post("/api/gpio", cmd)
    }

    /// Rename a user port.
    pub fn rename(&self, r: &Rename) -> Result<Rename> {
        self.post("/api/rename", r)
    }

    // --- TAPS and Mixes, voices, bandwidth ---

    /// The whole TAPS and Mixes mixer: a strip per connected frame, a fader
    /// per closed crosspoint.
    pub fn taps(&self) -> Result<Taps> {
        self.get("/api/taps")
    }

    /// One frame's strip.
    pub fn tap_strip(&self, frame: &str) -> Result<TapStrip> {
        self.get(&format!("/api/taps/{frame}"))
    }

    /// Set one crosspoint's fader (the thing coming in on `input`, crossed
    /// to `output`), in dB, -60..+20.
    pub fn set_crosspoint_gain(&self, frame: &str, input: &str, output: &str, db: f64) -> Result<GainEvent> {
        let set = GainSet {
            frame: Some(frame.into()),
            input: Some(input.into()),
            output: Some(output.into()),
            trunk: None,
            end: None,
            connection: None,
            hop: None,
            db,
            who: Some("sdk".into()),
        };
        self.post("/api/gain", &set)
    }

    /// Any gain point: a caster end, a hop, or a crosspoint.
    pub fn set_gain(&self, set: &GainSet) -> Result<GainEvent> {
        self.post("/api/gain", set)
    }

    /// Every crosspoint (of `frame`, or of all frames) back to unity.
    pub fn taps_unity(&self, frame: Option<&str>) -> Result<TapsUnityResult> {
        self.post("/api/taps/unity", &TapsUnity { frame: frame.map(str::to_string), who: Some("sdk".into()) })
    }

    /// Everything the caster has heard of the frames' voices.
    pub fn voices(&self) -> Result<VoiceSummary> {
        self.get("/api/voices")
    }

    /// One frame's voice: accent, live rate, newest ident and call.
    pub fn voice(&self, frame: &str) -> Result<FrameVoice> {
        self.get(&format!("/api/voices/{frame}"))
    }

    /// A re-assembled recording as WAV bytes; `kind` is "ident" or "call".
    pub fn voice_wav(&self, frame: &str, kind: &str) -> Result<Vec<u8>> {
        let (code, body) = self.send_bytes("GET", &format!("/voices/{frame}-{kind}.wav"), None)?;
        if code / 100 != 2 {
            return Err(Error::Http(code, String::from_utf8_lossy(&body).into_owned()));
        }
        Ok(body)
    }

    /// The bandwidth simulation: the voice on the wire, by protocol, frame
    /// and trunk.
    pub fn bandwidth(&self) -> Result<Bandwidth> {
        self.get("/api/bandwidth")
    }

    /// Every site with its airport code and accent.
    pub fn airports(&self) -> Result<Vec<Airport>> {
        self.get("/api/airports")
    }

    fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let (code, body) = self.send("GET", path, None)?;
        if code / 100 != 2 {
            return Err(Error::Http(code, body));
        }
        Ok(serde_json::from_str(&body)?)
    }

    fn post<B: serde::Serialize, T: serde::de::DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        let json = serde_json::to_string(body)?;
        let (code, body) = self.send("POST", path, Some(&json))?;
        if code / 100 != 2 {
            return Err(Error::Http(code, body));
        }
        Ok(serde_json::from_str(&body)?)
    }

    fn send(&self, method: &str, path: &str, body: Option<&str>) -> Result<(u16, String)> {
        let (code, raw) = self.send_bytes(method, path, body)?;
        Ok((code, String::from_utf8_lossy(&raw).into_owned()))
    }

    /// One request; the body comes back as bytes (a WAV is not text).
    fn send_bytes(&self, method: &str, path: &str, body: Option<&str>) -> Result<(u16, Vec<u8>)> {
        let mut stream = TcpStream::connect(&self.addr)?;
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        let body = body.unwrap_or("");
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.addr,
            body.len()
        );
        stream.write_all(req.as_bytes())?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw)?;
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(raw.len());
        let head = String::from_utf8_lossy(&raw[..split]);
        let code = head
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        Ok((code, raw.get(split + 4..).unwrap_or_default().to_vec()))
    }
}

/// Convenience: a request builder with the wire version filled in.
pub fn request(who: &str, from: &str, to: &str) -> Request {
    Request {
        id: None,
        who: who.into(),
        from: from.into(),
        to: to.into(),
        from_port: None,
        to_port: None,
        why: None,
        where_: None,
        hold_seconds: None,
        gpio: Vec::new(),
    }
}

/// Convenience: a reply.
pub fn reply(id: &str, status: ReplyStatus, connection: Option<Connection>, reason: Option<String>, now: String) -> Reply {
    Reply { wire_version: WIRE_VERSION, id: id.into(), status, connection, reason, replied_at: now }
}
