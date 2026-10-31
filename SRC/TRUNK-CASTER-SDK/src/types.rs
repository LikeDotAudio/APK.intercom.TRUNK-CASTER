//! Every JSON shape exchanged between Trunk-Caster components.
//!
//! Naming: a **frame** is a virtual intercom matrix advertised per
//! protocol (56 user ports + 8 casters). A **caster** is a trunk port. A
//! **trunk** is a link between two casters on two frames carrying up to
//! `channels_per_trunk` conversations. A **connection** is one conversation
//! routed over one or more trunks (hops). A **panel** is a user port on a
//! frame. A **crosspoint** is a closed input→output switch inside one
//! frame's matrix.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Repertoire: protocols and their vendor implementations
// ---------------------------------------------------------------------------

/// Broad family a protocol belongs to. Used for grouping in advertisements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Family {
    /// Analog party-line / point-to-point audio (2-Wire, 4-Wire).
    AnalogAudio,
    /// Audio over IP (Dante, AES67, Livewire, OMNEO, RVON, IVC-32).
    AudioOverIp,
    /// Telephony-style signalling (SIP).
    Telephony,
    /// Discrete control and monitoring (GPIO, SNMP).
    Control,
    /// Wireless beltpack systems (FreeSpeak, Bolero, TETRA).
    Wireless,
    /// Video / media transport (SMPTE-2110, MediorNet).
    MediaTransport,
    /// Vendor-specific partyline or digital variants not otherwise classed.
    Other,
}

impl Family {
    pub fn label(self) -> &'static str {
        match self {
            Family::AnalogAudio => "Analog audio",
            Family::AudioOverIp => "Audio over IP",
            Family::Telephony => "Telephony",
            Family::Control => "Control",
            Family::Wireless => "Wireless",
            Family::MediaTransport => "Media transport",
            Family::Other => "Other",
        }
    }
}

/// What the runtime learned from reading one manual.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ManualDigest {
    /// The `**Type:**` line, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Body of the "Trunking notes" section, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trunking_notes: Option<String>,
    /// Body of the "Talking to the panel" section, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_notes: Option<String>,
    /// Section headings found, in order.
    #[serde(default)]
    pub sections: Vec<String>,
}

/// One vendor's implementation of a protocol, as found in the manuals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Implementation {
    /// Vendor folder name, e.g. "Riedel".
    pub vendor: String,
    /// Vendor flavour of the protocol, e.g. "Performer" for Riedel 2-Wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    /// Manuals and API references found, relative to the protocol folder.
    pub documents: Vec<PathBuf>,
    /// Where the documents live (absolute).
    pub source: PathBuf,
    #[serde(default)]
    pub digest: ManualDigest,
}

/// A protocol in the discovered repertoire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Protocol {
    /// Stable kebab-case identifier, e.g. "dante", "2-wire".
    pub id: String,
    /// Human-readable name, e.g. "Dante".
    pub name: String,
    pub family: Family,
    /// Every vendor that implements this protocol, in discovery order.
    pub implementations: Vec<Implementation>,
    /// Brand-neutral manuals for the protocol itself (a folder named after
    /// the protocol under KNOWN PROTOCOLS with documents directly inside).
    #[serde(default)]
    pub documents: Vec<PathBuf>,
    #[serde(default)]
    pub digest: ManualDigest,
}

impl Protocol {
    pub fn vendors(&self) -> Vec<&str> {
        self.implementations.iter().map(|i| i.vendor.as_str()).collect()
    }
    pub fn document_count(&self) -> usize {
        self.documents.len() + self.implementations.iter().map(|i| i.documents.len()).sum::<usize>()
    }

    /// The `**Type:**` line: the protocol's own manual first, then any vendor's.
    pub fn kind(&self) -> Option<&str> {
        self.digest.kind.as_deref().or_else(|| self.implementations.iter().find_map(|i| i.digest.kind.as_deref()))
    }
}

// ---------------------------------------------------------------------------
// Fleet shape and frames
// ---------------------------------------------------------------------------

/// Shape of the fleet the runtime advertises.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Shape {
    /// Frames advertised per discovered protocol.
    pub frames_per_protocol: usize,
    /// User (panel) ports per frame.
    pub user_ports: usize,
    /// Casters (trunk ports) per frame.
    pub casters_per_frame: usize,
    /// Conversations one trunk link can carry at once.
    pub channels_per_trunk: usize,
}

impl Default for Shape {
    fn default() -> Self {
        Shape { frames_per_protocol: 10, user_ports: 56, casters_per_frame: 8, channels_per_trunk: 8 }
    }
}

impl Shape {
    /// Total matrix size: user ports plus casters.
    pub fn matrix_size(&self) -> usize {
        self.user_ports + self.casters_per_frame
    }
}

/// A vendor's colour and emoji. Flows carry it so you can see at a glance
/// whose iron a call is riding, even though trunks are addressed by
/// protocol, never by brand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Badge {
    pub vendor: String,
    pub emoji: String,
    pub color: String,
}

pub fn vendor_badge(vendor: &str) -> Badge {
    let v = vendor.to_ascii_lowercase();
    let (emoji, color) = if v.contains("rts") {
        ("🟣", "#8957e5")
    } else if v.contains("clear") {
        ("🔵", "#1f6feb")
    } else if v.contains("riedel") {
        ("🔴", "#c62828")
    } else if v.contains("telos") || v.contains("telex") {
        ("🟡", "#f6c343")
    } else if v.contains("intracom") {
        ("🟢", "#1a7f37")
    } else if v.contains("ward") {
        ("🟠", "#e3a35a")
    } else if v.is_empty() || v.contains("relay") {
        ("⚪", "#cfd6e4")
    } else {
        ("⚫", "#9aa3ad")
    };
    Badge { vendor: vendor.to_string(), emoji: emoji.into(), color: color.into() }
}

/// A caster (trunk port) as advertised.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasterAd {
    pub index: usize,
    /// "free" or "trunked".
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trunk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_frame: Option<String>,
}

/// A frame advertised by the runtime. Identity is `<protocol>-<nn>`.
/// This is the JSON one device posts about itself in TRUNK-ADVERTISEMENT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub wire_version: u32,
    pub id: String,
    pub protocol: String,
    pub protocol_name: String,
    pub family: Family,
    /// Where the frame lives. Fills the SITE field of its Ward-Beck lines.
    #[serde(default)]
    pub site: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    /// Vendors that implement this protocol. Informational only: a trunk
    /// is never addressed by brand.
    pub implemented_by: Vec<String>,
    /// The vendor whose iron this particular frame is (one of
    /// `implemented_by`, assigned round-robin), with its colour and emoji.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<Badge>,
    pub user_ports: usize,
    pub casters: usize,
    pub channels_per_trunk: usize,
    /// Live caster status at the time of advertising.
    #[serde(default)]
    pub caster_status: Vec<CasterAd>,
    #[serde(default)]
    pub free_casters: usize,
    /// User ports renamed after the people who called through them,
    /// keyed `U<nn>`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub port_names: std::collections::BTreeMap<String, String>,
    /// The same names cut for 6-, 8- and 16-character panels.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub port_labels: std::collections::BTreeMap<String, crate::labels::Label>,
    /// Who is on this frame right now, keyed `U<nn>`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub live_ports: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connection: Option<LastActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seconds_since_last_connection: Option<u64>,
    #[serde(default)]
    pub advertised_at: String,
    /// Where the runtime that advertises this frame can be reached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

// ---------------------------------------------------------------------------
// Requests, replies, connections
// ---------------------------------------------------------------------------

/// A seeker asking for a trunk. Dropped as `<id>.json` into
/// TRUNK-CASTER-INTERFACE, or POSTed to `/api/request`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    /// Caller-chosen id. If omitted, the runtime assigns one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Who is asking (a person, a panel, a system).
    pub who: String,
    /// Frame the conversation starts on.
    pub from: String,
    /// Frame the conversation must reach.
    pub to: String,
    /// User port on `from`; lowest free port if omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_port: Option<usize>,
    /// User port on `to`; lowest free port if omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_port: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
    /// Hold time in simulated seconds. Omitted means: until the request
    /// file is removed or `/api/release` is called.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_seconds: Option<f64>,
    /// GPIO commands to send down the same trunk path as soon as the
    /// connection is granted (call light, tally, relay).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gpio: Vec<GpioCommand>,
}

/// What each GPIO pin does: the intercom key functions. A command carries
/// the pin; the function follows from it (or is named explicitly).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GpioFunction {
    /// Pin 1: blink the panel's light at both ends.
    BlinkPanel,
    /// Pin 2: check the status of the lights on the frames of this call.
    CheckLights,
    /// Pin 3: latch the key: the line stays up, never parked or swept.
    SetLatch,
    /// Pin 4: listen: the line is listen-only.
    SetListen,
    /// Pin 5: unlatch.
    UnsetLatch,
    /// Pin 6: clear: latch and listen off, lease reset.
    Clear,
    /// Pin 7: last caller: who last called each end, shown on the light.
    LastCaller,
    /// Pin 8: ping, acknowledged and logged, nothing else.
    Ping,
}

impl GpioFunction {
    pub fn from_pin(pin: u32) -> GpioFunction {
        match pin {
            1 => GpioFunction::BlinkPanel,
            2 => GpioFunction::CheckLights,
            3 => GpioFunction::SetLatch,
            4 => GpioFunction::SetListen,
            5 => GpioFunction::UnsetLatch,
            6 => GpioFunction::Clear,
            7 => GpioFunction::LastCaller,
            _ => GpioFunction::Ping,
        }
    }
    pub fn pin(self) -> u32 {
        match self {
            GpioFunction::BlinkPanel => 1,
            GpioFunction::CheckLights => 2,
            GpioFunction::SetLatch => 3,
            GpioFunction::SetListen => 4,
            GpioFunction::UnsetLatch => 5,
            GpioFunction::Clear => 6,
            GpioFunction::LastCaller => 7,
            GpioFunction::Ping => 8,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            GpioFunction::BlinkPanel => "blink panel",
            GpioFunction::CheckLights => "check lights",
            GpioFunction::SetLatch => "set latch",
            GpioFunction::SetListen => "set listen",
            GpioFunction::UnsetLatch => "unset latch",
            GpioFunction::Clear => "clear",
            GpioFunction::LastCaller => "last caller",
            GpioFunction::Ping => "ping",
        }
    }
    pub fn all() -> [GpioFunction; 8] {
        [
            GpioFunction::BlinkPanel,
            GpioFunction::CheckLights,
            GpioFunction::SetLatch,
            GpioFunction::SetListen,
            GpioFunction::UnsetLatch,
            GpioFunction::Clear,
            GpioFunction::LastCaller,
            GpioFunction::Ping,
        ]
    }
}

/// A GPIO command that travels through the trunk caster along a
/// connection's path. POST `/api/gpio` or include in a `Request`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioCommand {
    /// Connection to ride on. Filled in by the runtime when sent with a
    /// request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    pub pin: u32,
    /// Closed (true) or open (false).
    pub state: bool,
    /// The key function; derived from the pin when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<GpioFunction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A GPIO command as delivered: one line of `gpio.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpioEvent {
    pub seq: u64,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim_time: Option<f64>,
    pub connection: String,
    pub who: String,
    pub pin: u32,
    pub state: bool,
    pub from_frame: String,
    pub to_frame: String,
    /// Frames the command passed through, endpoints included.
    pub path: Vec<String>,
    pub trunks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// What the pin did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<GpioFunction>,
    /// What came back: light states for check-lights, the last callers for
    /// last-caller, the latch/listen state after a set or clear.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

/// Rename a user port. POST `/api/rename`. The 6/8/16 cuts are derived
/// from `name` unless given explicitly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rename {
    pub frame: String,
    pub port: usize,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l6: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l8: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l16: Option<String>,
}

/// Logged whenever a name is longer than a 6- or 8-character panel shows:
/// one line of `TRUNK-USERS/labels.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelEvent {
    pub seq: u64,
    pub at: String,
    pub frame: String,
    pub port: String,
    pub label: crate::labels::Label,
    /// "over6", "over8" or "over6,over8".
    pub over: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    pub origin: String,
}

/// A local sound device seen by the relay page (browser side).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundDevice {
    pub device_id: String,
    pub label: String,
    /// "input" or "output".
    pub kind: String,
}

/// Bind a local sound device to a relay port. POST `/api/relay/bind`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayBinding {
    pub matrix: String,
    pub port: usize,
    pub device_id: String,
    pub device_label: String,
    pub kind: String,
}

/// Something the local sound card relay noticed: a level over the
/// threshold, a device appearing or a binding. POST `/api/relay/event`,
/// appended to `TRUNK-RELAY/events.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEvent {
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub at: String,
    /// "over", "device", "bind", "unbind".
    pub kind: String,
    pub device_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matrix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<usize>,
    /// Peak level in dBFS when `kind == "over"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak_dbfs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold_dbfs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// How a rename reaches one vendor's equipment. Lives in
/// `TRUNK-CASTER-SDK/vendor-policy.json`, keyed by vendor folder name, with
/// a `default` entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameTransport {
    /// "sdk" (stays inside Trunk-Caster), "snmp" (SNMP SET), "native"
    /// (vendor API, not yet wired).
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Host or host:port to send to. None = build the PDU, log it, do not send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// OID prefix; the user-port index is appended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VendorPolicy {
    pub renames: std::collections::BTreeMap<String, RenameTransport>,
}

impl Default for VendorPolicy {
    fn default() -> Self {
        let mut renames = std::collections::BTreeMap::new();
        renames.insert(
            "default".to_string(),
            RenameTransport {
                transport: "sdk".into(),
                version: None,
                community: None,
                port: None,
                target: None,
                oid: None,
                note: Some("Rename is kept inside Trunk-Caster and shown in advertisements.".into()),
            },
        );
        renames.insert(
            "RTS".to_string(),
            RenameTransport {
                transport: "snmp".into(),
                version: Some("2c".into()),
                community: Some("private".into()),
                port: Some(161),
                target: None,
                oid: Some("1.3.6.1.4.1.99999.1.2.1.3".into()),
                note: Some(
                    "RTS port label over SNMP SET (ODIN/ADAM). The RTS SNMP manual lists monitoring only: \
                     confirm the writable port-name OID against the RTS MIB and set `target` to the frame's address."
                        .into(),
                ),
            },
        );
        VendorPolicy { renames }
    }
}

impl VendorPolicy {
    pub fn for_vendor(&self, vendor: &str) -> Option<&RenameTransport> {
        self.renames.get(vendor).or_else(|| self.renames.get("default"))
    }
}

/// One rename as dispatched to one vendor: a line of `renames.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameDispatch {
    pub seq: u64,
    pub at: String,
    pub frame: String,
    pub port: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_name: Option<String>,
    pub new_name: String,
    pub vendor: String,
    pub transport: String,
    /// Human-readable description of what was built, e.g. the OID and value.
    pub detail: String,
    /// Encoded packet, hex, when the transport builds one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub sent: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
}

/// When a frame last carried a connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastActivity {
    pub at: String,
    pub unix: u64,
    pub sim_time: f64,
    pub who: String,
    pub connection: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteKind {
    Direct,
    Via,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hop {
    pub trunk: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub who: String,
    pub from_frame: String,
    pub from_port: usize,
    pub to_frame: String,
    pub to_port: usize,
    pub kind: RouteKind,
    pub hops: Vec<Hop>,
    pub granted_at: String,
    #[serde(default)]
    pub granted_unix: u64,
    #[serde(default)]
    pub granted_sim: f64,
    /// What the connection is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
    /// "interface", "http" or "simulator".
    pub origin: String,
    /// Simulated-clock expiry, if the simulator owns this connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_sim: Option<f64>,
    /// GPIO commands delivered over this connection so far.
    #[serde(default)]
    pub gpio_sent: u32,
    /// Volume adjustment per hop, dB, aligned with `hops` (0 = unity).
    #[serde(default)]
    pub hop_gains_db: Vec<f64>,
    /// Parked: the call ended but the line stays connected and muted until
    /// the next round-robin sweep.
    #[serde(default)]
    pub muted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted_at_sim: Option<f64>,
    /// How many times this parked line was picked up again before a sweep.
    #[serde(default)]
    pub reconnects: u32,
    /// Simulated time the line was last used (granted, picked up again,
    /// GPIO sent). The green lease counts down from here.
    #[serde(default)]
    pub last_used_sim: f64,
    /// Key latched: the line stays up, never parked, swept or reclaimed.
    #[serde(default)]
    pub latched: bool,
    /// Listen-only.
    #[serde(default)]
    pub listen: bool,
}

impl Connection {
    /// Seconds of lease left: green while positive, red ("may be dead") at
    /// or below zero.
    pub fn lease_left(&self, sim_now: f64, lease_seconds: f64) -> f64 {
        lease_seconds - (sim_now - self.last_used_sim)
    }
    /// Wall-clock seconds this connection has been up.
    pub fn connected_for(&self, now_unix: u64) -> u64 {
        now_unix.saturating_sub(self.granted_unix)
    }
    /// Simulated seconds this connection has been up.
    pub fn connected_for_sim(&self, sim_now: f64) -> f64 {
        (sim_now - self.granted_sim).max(0.0)
    }
    /// Intermediate frames, in order.
    pub fn via_frames(&self) -> Vec<&str> {
        self.hops.iter().skip(1).map(|h| h.from.as_str()).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplyStatus {
    Granted,
    Denied,
    Released,
}

/// The runtime's answer, written as `<id>.reply.json` next to the request
/// or returned from `/api/request`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reply {
    pub wire_version: u32,
    pub id: String,
    pub status: ReplyStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<Connection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub replied_at: String,
}

/// A trunk link between two casters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trunk {
    pub id: String,
    pub a_frame: String,
    pub a_caster: usize,
    pub b_frame: String,
    pub b_caster: usize,
    pub capacity: usize,
    pub connections: Vec<String>,
    pub created_at: String,
    /// Volume adjustment at the A caster, dB (0 = unity).
    #[serde(default)]
    pub gain_a_db: f64,
    /// Volume adjustment at the B caster, dB.
    #[serde(default)]
    pub gain_b_db: f64,
}

/// Adjust volume at one point. POST `/api/gain`. Give `trunk` + `end`
/// ("a" or "b") for a caster, or `connection` + `hop` for one hop of one
/// call, or `frame` + `input` + `output` for one crosspoint inside a frame
/// (the TAPS and Mixes faders). `db` is absolute; 0 is unity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GainSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trunk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hop: Option<usize>,
    pub db: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
}

/// One line of `TRUNK-USAGE/gains.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GainEvent {
    pub seq: u64,
    pub at: String,
    pub set: GainSet,
    pub was_db: f64,
    /// Total gain along the affected call(s) after the change, by connection id.
    pub path_gain_db: std::collections::BTreeMap<String, f64>,
}

// ---------------------------------------------------------------------------
// TAPS and Mixes, voices, bandwidth (GET /api/taps, /api/voices, /api/bandwidth)
// ---------------------------------------------------------------------------

/// One little fader: one closed crosspoint inside a frame, the thing coming
/// in on `input` crossed to `output`. Set it with `POST /api/gain`
/// `{frame, input, output, db}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TapFader {
    pub input: String,
    pub output: String,
    pub connection: String,
    #[serde(default)]
    pub who: String,
    /// -60..+20, 0 is unity.
    pub db: f64,
}

/// One frame's strip on the mixer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TapStrip {
    pub frame: String,
    pub site: String,
    pub protocol: String,
    #[serde(default)]
    pub vendor: String,
    /// The espeak-ng voice the frame speaks in (`voice::accent_of`).
    pub accent: String,
    /// What the frame's voice puts on the wire right now, both cuts.
    pub kbps: f64,
    pub faders: Vec<TapFader>,
}

/// `GET /api/taps`: the whole mixer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Taps {
    pub frames: usize,
    pub crosspoints: usize,
    /// Crosspoints off unity.
    pub trimmed: usize,
    pub strips: Vec<TapStrip>,
}

/// `POST /api/taps/unity` `{frame?, who?}`: every crosspoint (of one frame,
/// or of all) back to 0 dB.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TapsUnity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
}

/// The reply to `POST /api/taps/unity`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TapsUnityResult {
    pub reset: usize,
}

/// `GET /api/voices/<frame>`: one frame's voice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameVoice {
    pub frame: String,
    pub site: String,
    pub country: String,
    pub airport: String,
    pub accent: String,
    pub kbps: f64,
    /// Bytes heard from this frame since the caster started.
    pub bytes: u64,
    /// The newest re-assembled recordings, and where to fetch their WAVs.
    pub ident: Option<crate::voice::Assembled>,
    pub call: Option<crate::voice::Assembled>,
    pub ident_wav: Option<String>,
    pub call_wav: Option<String>,
}

/// `GET /api/voices`: everything heard so far.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceSummary {
    pub chunks_in: u64,
    pub bad_chunks: u64,
    pub recordings: u64,
    pub corrected_seconds: u64,
    pub lost_seconds: u64,
    /// Recordings still waiting for chunks.
    pub waiting: usize,
    pub kbps: f64,
    pub talking: usize,
    pub by_protocol_kbps: std::collections::BTreeMap<String, f64>,
    pub link: Option<crate::mqtt::LinkStats>,
    pub latest: Vec<crate::voice::Assembled>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolLoad {
    pub protocol: String,
    pub talking: usize,
    pub kbps: f64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameLoad {
    pub frame: String,
    pub protocol: String,
    pub calls: usize,
    pub kbps: f64,
    pub bytes: u64,
}

/// One trunk's share of the voice: every call it carries brings the voices of
/// both its ends (each frame's rate shared between its calls).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrunkLoad {
    pub trunk: String,
    pub a_frame: String,
    pub b_frame: String,
    pub calls: usize,
    pub capacity: usize,
    pub kbps: f64,
    pub kbps_per_channel: f64,
}

/// `GET /api/bandwidth`: the bandwidth simulation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bandwidth {
    /// Seconds the rates average over.
    pub window_s: u64,
    /// Voice on the wire into the caster, both cuts, kbit/s.
    pub kbps: f64,
    /// The same voice summed over every trunk hop it rides.
    pub carried_kbps: f64,
    pub talking: usize,
    pub bytes: u64,
    pub by_protocol: Vec<ProtocolLoad>,
    /// Busiest first.
    pub frames: Vec<FrameLoad>,
    /// Busiest first.
    pub trunks: Vec<TrunkLoad>,
}

/// `GET /api/airports`: every site with its airport code and accent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Airport {
    pub site: String,
    pub country: String,
    pub airport: String,
    /// The accent of the site (variant left out: each frame adds its own).
    pub accent: String,
}

impl Trunk {
    pub fn used(&self) -> usize {
        self.connections.len()
    }
    pub fn free(&self) -> usize {
        self.capacity.saturating_sub(self.used())
    }
    pub fn joins(&self, x: &str, y: &str) -> bool {
        (self.a_frame == x && self.b_frame == y) || (self.a_frame == y && self.b_frame == x)
    }
    pub fn touches(&self, f: &str) -> bool {
        self.a_frame == f || self.b_frame == f
    }
    /// Caster used on `frame`, if this trunk touches it.
    pub fn caster_on(&self, frame: &str) -> Option<usize> {
        if self.a_frame == frame {
            Some(self.a_caster)
        } else if self.b_frame == frame {
            Some(self.b_caster)
        } else {
            None
        }
    }
    pub fn peer_of(&self, frame: &str) -> Option<&str> {
        if self.a_frame == frame {
            Some(&self.b_frame)
        } else if self.b_frame == frame {
            Some(&self.a_frame)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// TRUNK-USERS: who asked whom, when, why, where, how
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct How {
    pub kind: RouteKind,
    pub hops: Vec<Hop>,
    pub via: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRecord {
    pub wire_version: u32,
    pub id: String,
    pub who: String,
    /// The frame (and panel port) being reached.
    pub whom: String,
    pub from: String,
    pub when: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how: Option<How>,
    pub status: ReplyStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    /// Wall-clock seconds the connection lasted, filled on release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_seconds: Option<u64>,
    /// Simulated seconds the connection lasted, filled on release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_sim_seconds: Option<f64>,
    #[serde(default)]
    pub gpio_sent: u32,
}

// ---------------------------------------------------------------------------
// TRUNK-CROSS POINTS
// ---------------------------------------------------------------------------

/// A closed crosspoint inside one frame. Ports are named `U<nn>` for user
/// ports and `C<n>` for casters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Crosspoint {
    pub frame: String,
    pub input: String,
    pub output: String,
    pub connection: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeltaOp {
    Set,
    Clear,
}

/// One line of `deltas.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrosspointEvent {
    pub seq: u64,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim_time: Option<f64>,
    pub op: DeltaOp,
    #[serde(flatten)]
    pub crosspoint: Crosspoint,
}

/// Editable from the crosspoint display (`/api/crosspoints/settings`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrosspointSettings {
    /// The delta log ends after this many events.
    pub max_events: u64,
    /// Every frame restates its closed crosspoints (Ward-Beck check-in)
    /// this often, in wall-clock seconds.
    #[serde(default = "default_checkin")]
    pub checkin_every_seconds: f64,
}

fn default_checkin() -> f64 {
    30.0
}

impl Default for CrosspointSettings {
    fn default() -> Self {
        CrosspointSettings { max_events: 1000, checkin_every_seconds: default_checkin() }
    }
}

/// Snapshot written to `crosspoints.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrosspointSnapshot {
    pub wire_version: u32,
    pub updated_at: String,
    pub settings: CrosspointSettings,
    pub events_logged: u64,
    /// True once `events_logged >= settings.max_events`; the log stops.
    pub log_ended: bool,
    pub crosspoints: Vec<Crosspoint>,
}

/// Someone looking for a panel. Dropped as `seeks/<id>.json` or POSTed to
/// `/api/panel-seek`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelSeek {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub who: String,
    /// Frame the seeker is on.
    pub from: String,
    /// Frame that hosts the wanted panel.
    pub panel_frame: String,
    /// User port of the wanted panel, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_port: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// One trunk route the seeker is allowed to take.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowedTrunk {
    pub kind: RouteKind,
    /// Frames along the path, endpoints included.
    pub path: Vec<String>,
    /// Existing trunk ids reused along the path (None = new trunk needed).
    pub trunks: Vec<Option<String>>,
    pub new_trunks_needed: usize,
    pub free_channels: usize,
}

/// The runtime's advertisement of a seek and what it is allowed to use.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PanelOffer {
    pub wire_version: u32,
    pub seek: PanelSeek,
    pub seek_id: String,
    pub offered_at: String,
    pub allowed_trunks: Vec<AllowedTrunk>,
}

// ---------------------------------------------------------------------------
// TRUNK-SIMULATOR
// ---------------------------------------------------------------------------

/// The fader. Edit `fader.json` or POST `/api/fader`; the runtime re-reads
/// it every tick.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fader {
    /// Simulated seconds per wall-clock second. 0 pauses the clock.
    pub speed: f64,
    /// Synthetic requests per simulated minute.
    pub requests_per_minute: f64,
    /// Mean hold time of a synthetic connection, simulated seconds.
    pub mean_hold_seconds: f64,
    /// Every active connection cross-checks itself at this rate.
    pub crosscheck_every_seconds: f64,
    /// A timeline sample is taken at this rate (simulated seconds).
    pub sample_every_seconds: f64,
    /// Synthetic load on/off. Real requests are always served.
    pub running: bool,
    /// RNG seed for reproducible runs.
    pub seed: u64,
    /// The broadcast day: how the load moves through the news cycle.
    #[serde(default)]
    pub day: DaySchedule,
    /// Park and sweep: a finished call stays connected but muted until the
    /// next round-robin sweep, which runs this often (simulated seconds).
    /// Calling the same place again before the sweep unmutes instantly.
    #[serde(default = "default_round_robin")]
    pub round_robin_seconds: f64,
    /// The green lease on a line, simulated seconds (15 minutes). Using the
    /// line resets it; when it runs out the line shows red ("may be dead"),
    /// its bandwidth goes on hold and it is the first to be reclaimed.
    #[serde(default = "default_lease")]
    pub lease_seconds: f64,
    /// The event preset these settings came from; empty when set by hand.
    #[serde(default)]
    pub preset: String,
    /// Productions: a studio made available with a fixed number of trunks
    /// and a flood of callers aimed at it.
    #[serde(default)]
    pub productions: Vec<Production>,
    /// Bookings the simulated traffic places on the timeline per simulated
    /// hour: a port held for a program a little ahead of time.
    #[serde(default = "default_bookings_per_hour")]
    pub bookings_per_hour: f64,
    /// Calls inside the building: per simulated hour, every site with more
    /// than one frame calls between its own frames this often. Flat, not
    /// shaped by the news cycle.
    #[serde(default = "default_in_building")]
    pub in_building_calls_per_hour: f64,
}

/// A production: one studio made available with `trunks` trunks and
/// `calls_per_minute` callers aimed at it from everywhere else while it is
/// on air. The studio's trunks are the bottleneck: once they are all busy
/// every further caller gets a busy signal (a denial), like a phone-in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Production {
    pub enabled: bool,
    pub name: String,
    /// Frame id of the studio (`london-01`). Empty: the runtime picks a
    /// capital frame when the production is applied.
    #[serde(default)]
    pub studio: String,
    /// Trunks (casters) made available to the production at the studio.
    pub trunks: usize,
    /// Callers per simulated minute while on air.
    pub calls_per_minute: f64,
    /// Mean time a caller stays on, simulated seconds.
    pub mean_hold_seconds: f64,
    /// On air from this hour to that hour, studio local time; -1 = all day.
    pub start_hour: f64,
    pub end_hour: f64,
    /// A segment that repeats inside that window: on air for `for_minutes`
    /// from `at_minute` of every `every_minutes` (a phone-in at :30 of every
    /// hour, between the news: 60, 30, 30). 0 = on air the whole window.
    #[serde(default)]
    pub every_minutes: f64,
    #[serde(default)]
    pub at_minute: f64,
    #[serde(default)]
    pub for_minutes: f64,
}

impl Production {
    /// Is the production on air at this local time of day (seconds)?
    pub fn on_air_at(&self, local_tod_secs: f64) -> bool {
        if !self.enabled {
            return false;
        }
        let tod = local_tod_secs.rem_euclid(86_400.0);
        if self.every_minutes > 0.0 && ((tod / 60.0 - self.at_minute).rem_euclid(self.every_minutes)) >= self.for_minutes {
            return false;
        }
        if self.start_hour < 0.0 || self.end_hour < 0.0 {
            return true;
        }
        let h = tod / 3600.0;
        if self.start_hour <= self.end_hour {
            h >= self.start_hour && h < self.end_hour
        } else {
            h >= self.start_hour || h < self.end_hour
        }
    }
}

/// One production's counters at a sample.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProductionSample {
    /// Callers that tried since the production was applied.
    pub offered: u64,
    pub answered: u64,
    /// Busy signals: every trunk at the studio was taken.
    pub busy: u64,
    /// Callers on the line right now.
    pub live: usize,
    /// Trunks in use at the studio right now, of `trunks` made available.
    pub trunks_used: usize,
    pub trunks: usize,
    pub on_air: bool,
    pub studio: String,
}

/// What a production achieved over a run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProductionSummary {
    pub studio: String,
    pub trunks: usize,
    pub offered: u64,
    pub answered: u64,
    pub busy: u64,
    pub peak_live: usize,
    /// Sim time of the first busy signal, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_busy_sim: Option<f64>,
}

/// An event preset: a complete fader for something worth watching, and the
/// one major event of its day. Pressing it puts the clock `lead_hours`
/// before that event, so the surge starts in front of you.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub fader: Fader,
    /// When the major event starts, hours: local time at the first
    /// production's studio (or the anchor zone when there is none), or UTC
    /// when `surge_utc`.
    pub surge_hour: f64,
    #[serde(default)]
    pub surge_utc: bool,
    /// How long before the event the clock starts, hours.
    pub lead_hours: f64,
}

impl Preset {
    /// The UTC hour to start the clock at, given the local offset (hours)
    /// of the place the event happens.
    pub fn start_utc_hour(&self, local_offset_hours: f64) -> f64 {
        let off = if self.surge_utc { 0.0 } else { local_offset_hours };
        (self.surge_hour - self.lead_hours - off).rem_euclid(24.0)
    }
}

/// The event presets, one major event per day each. `base` supplies what a
/// preset does not set: seed, round robin, lease, sampling.
pub fn presets(base: &Fader) -> Vec<Preset> {
    let day = |hourly: f64, radio: f64, casts: &[(f64, f64)], overnight: f64, blackout: bool| DaySchedule {
        enabled: true,
        start_hour: -1.0,
        hourly_news: hourly,
        radio_prep: radio,
        newscasts: casts.iter().map(|(h, p)| Newscast { hour: *h, peak: *p }).collect(),
        overnight,
        blackout: Blackout { enabled: blackout, ..base.day.blackout },
        // A preset is its own one major event: no Olympics on top.
        olympics: Olympics { enabled: false, ..base.day.olympics.clone() },
    };
    let prod = |name: &str, trunks: usize, cpm: f64, hold: f64, start: f64, end: f64| Production {
        enabled: true,
        name: name.into(),
        studio: String::new(),
        trunks,
        calls_per_minute: cpm,
        mean_hold_seconds: hold,
        start_hour: start,
        end_hour: end,
        every_minutes: 0.0,
        at_minute: 0.0,
        for_minutes: 0.0,
    };
    // (surge hour, lead hours, surge in UTC)
    type Surge = (f64, f64, bool);
    let f = |id: &str, name: &str, blurb: &str, speed: f64, rpm: f64, hold: f64, (surge_hour, lead_hours, surge_utc): Surge, day: DaySchedule, productions: Vec<Production>| Preset {
        id: id.into(),
        name: name.into(),
        blurb: blurb.into(),
        fader: Fader {
            speed,
            requests_per_minute: rpm,
            mean_hold_seconds: hold,
            crosscheck_every_seconds: base.crosscheck_every_seconds,
            sample_every_seconds: base.sample_every_seconds,
            running: true,
            seed: base.seed,
            day,
            round_robin_seconds: base.round_robin_seconds,
            lease_seconds: base.lease_seconds,
            preset: id.into(),
            productions,
            bookings_per_hour: base.bookings_per_hour,
            in_building_calls_per_hour: base.in_building_calls_per_hour,
        },
        surge_hour,
        surge_utc,
        lead_hours,
    };
    // A newscast builds for an hour: start an hour early to watch it climb.
    // A production switches on at its hour: start a quarter hour early.
    let local = |h: f64, lead: f64| (h, lead, false);
    // The routine day: hourly rushes and radio prep, no newscast.
    let routine = day(3.0, 2.0, &[], 0.3, true);
    vec![
        f("broadcast-day", "Broadcast day", "The news cycle as it is: hourly rushes, radio prep, quiet overnight, and the one big newscast at 18:00 local. Starts at 17:00.", 120.0, 6000.0, 120.0, local(18.0, 1.0), day(3.0, 2.0, &[(18.0, 6.0)], 0.3, true), vec![]),
        f("quiet-night", "Quiet night", "Overnight: a trickle of calls, long holds, nothing scheduled. Starts at 01:00 local. Watch parked lines and leases.", 60.0, 600.0, 400.0, local(1.0, 0.0), day(1.5, 1.2, &[], 0.3, true), vec![]),
        f("morning-drive", "Morning drive", "Every station on the air at once, short calls, the 06:00 newscast on top. Starts at 05:00 local.", 120.0, 7000.0, 90.0, local(6.0, 1.0), day(4.0, 3.0, &[(6.0, 6.0)], 0.3, true), vec![]),
        f("breaking-news", "Breaking news", "The story breaks at 16:00 local: hourly rushes at ×8, the newscast at ×10, callers everywhere. Starts at 15:00.", 120.0, 9000.0, 100.0, local(16.0, 1.0), day(8.0, 3.0, &[(16.0, 10.0)], 0.6, true), vec![]),
        f("phone-in", "Phone-in show", "One studio, 8 trunks made available, 2000 callers a minute from 09:00 to 12:00 local. Starts at 08:45. Most of them hear busy.", 120.0, 3000.0, 120.0, local(9.0, 0.25), routine.clone(), vec![prod("Phone-in", 8, 2000.0, 90.0, 9.0, 12.0)]),
        f("election-night", "Election night", "The results desk: 8 trunks, 3000 callers a minute from 18:00 local until 02:00, the 18:00 results newscast at ×8. Starts at 17:00.", 120.0, 6000.0, 150.0, local(18.0, 1.0), day(6.0, 2.0, &[(18.0, 8.0)], 0.8, true), vec![prod("Results desk", 8, 3000.0, 150.0, 18.0, 2.0)]),
        f("telethon", "Telethon", "Two studios, 8 trunks each, 4000 callers a minute into each from 09:00 to 21:00 local. Starts at 08:45. The trunks are the bottleneck.", 120.0, 3000.0, 120.0, local(9.0, 0.25), routine.clone(), vec![prod("Telethon A", 8, 4000.0, 180.0, 9.0, 21.0), prod("Telethon B", 8, 4000.0, 180.0, 9.0, 21.0)]),
        f("world-cup-final", "World Cup final", "Three studios on three continents, 8 trunks each, 5000 callers a minute into each for the two hours of the match, 15:00 to 17:00 local, the final whistle newscast at ×10. Starts at 14:45.", 120.0, 8000.0, 120.0, local(15.0, 0.25), day(5.0, 2.0, &[(17.0, 10.0)], 0.6, true), vec![prod("Stadium desk", 8, 5000.0, 120.0, 15.0, 17.0), prod("Studio two", 8, 5000.0, 120.0, 15.0, 17.0), prod("Studio three", 8, 5000.0, 120.0, 15.0, 17.0)]),
        f("daily-reset", "Daily reset drill", "Starts at 10:55 UTC: five minutes later everything disconnects, at 12:00 it all comes back. Watch the reconnect wave.", 60.0, 6000.0, 120.0, (11.0, 5.0 / 60.0, true), routine.clone(), vec![]),
        f("flat-load", "Flat load", "No news cycle: a steady 3000 requests a minute from 12:00 local. The control group.", 120.0, 3000.0, 120.0, local(12.0, 0.0), DaySchedule { enabled: false, ..routine.clone() }, vec![]),
        f("stress", "Stress test", "20000 requests a minute, one-minute holds, four times faster, from 12:00 local. Find the ceiling.", 240.0, 20000.0, 60.0, local(12.0, 0.0), DaySchedule { enabled: false, ..routine.clone() }, vec![]),
    ]
}

fn default_round_robin() -> f64 {
    60.0
}

fn default_bookings_per_hour() -> f64 {
    12.0
}

fn default_lease() -> f64 {
    900.0
}

fn default_in_building() -> f64 {
    100.0
}

impl Default for Fader {
    fn default() -> Self {
        Fader {
            speed: 1.0,
            requests_per_minute: 30.0,
            // An average call lasts ten minutes.
            mean_hold_seconds: 600.0,
            crosscheck_every_seconds: 5.0,
            sample_every_seconds: 5.0,
            running: true,
            seed: 7,
            day: DaySchedule::default(),
            round_robin_seconds: default_round_robin(),
            lease_seconds: default_lease(),
            preset: String::new(),
            productions: Vec::new(),
            bookings_per_hour: default_bookings_per_hour(),
            in_building_calls_per_hour: default_in_building(),
        }
    }
}

/// The daily reset: at `start_hour` (UTC on the simulated clock) everything
/// disconnects and every sender is reset; at `end_hour` traffic reconnects.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Blackout {
    pub enabled: bool,
    pub start_hour: f64,
    pub end_hour: f64,
}

impl Default for Blackout {
    fn default() -> Self {
        Blackout { enabled: true, start_hour: 11.0, end_hour: 12.0 }
    }
}

impl Blackout {
    pub fn active_at(&self, utc_tod_secs: f64) -> bool {
        if !self.enabled {
            return false;
        }
        let h = utc_tod_secs.rem_euclid(86_400.0) / 3600.0;
        if self.start_hour <= self.end_hour {
            h >= self.start_hour && h < self.end_hour
        } else {
            h >= self.start_hour || h < self.end_hour
        }
    }
}

/// A newscast surge: builds for an hour, peaks the last quarter before and
/// the first half hour after `hour`, fades by one hour after.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Newscast {
    /// Local hour, 0..24 (18.0 = 6pm).
    pub hour: f64,
    /// Peak multiplier.
    pub peak: f64,
}

/// The news cycle. `requests_per_minute` is the quiet baseline; these
/// multipliers shape it through the day. Every site follows its own local
/// time (solar time from its longitude), so the surges sweep around the
/// globe with the sun: usage per region.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaySchedule {
    pub enabled: bool,
    /// Simulated UTC time of day at sim_time 0, in hours (e.g. 6.0 = 06:00).
    /// Negative means "the wall clock's time of day when the runtime booted".
    pub start_hour: f64,
    /// Hourly news rush, :55 to :10, peaking on the hour.
    pub hourly_news: f64,
    /// Radio prep on the hours and halves, :25 to :35 and :55 to :05.
    pub radio_prep: f64,
    /// The newscasts: 06:00, 12:00 and the big one at 18:00 by default.
    #[serde(default = "default_newscasts")]
    pub newscasts: Vec<Newscast>,
    /// Overnight (00:00 to 05:00) multiplier.
    pub overnight: f64,
    /// Daily disconnect-all at 11:00 UTC, reconnect at 12:00.
    #[serde(default)]
    pub blackout: Blackout,
    /// The Olympics, once a day at one UTC moment for the whole globe.
    #[serde(default)]
    pub olympics: Olympics,
}

/// The Olympics: once a day at `hour` UTC for `hours` hours. Television
/// and radio follow the sun, site by site; the Games happen at one moment,
/// so every site surges at once. The venue studio (`venue`, a frame id;
/// empty: the runtime picks a capital) takes callers from everywhere like a
/// production.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Olympics {
    pub enabled: bool,
    /// UTC hour the event goes on air, 0..24.
    pub hour: f64,
    /// How long it is on air, hours.
    pub hours: f64,
    /// Load multiplier at every site while it is on air.
    pub peak: f64,
    #[serde(default)]
    pub venue: String,
    pub trunks: usize,
    /// Callers per simulated minute into the venue while on air.
    pub calls_per_minute: f64,
    pub mean_hold_seconds: f64,
}

impl Default for Olympics {
    fn default() -> Self {
        Olympics { enabled: true, hour: 19.0, hours: 2.0, peak: 5.0, venue: String::new(), trunks: 8, calls_per_minute: 3000.0, mean_hold_seconds: 120.0 }
    }
}

impl Olympics {
    /// Hours since the event went on air at this UTC time of day, if within
    /// the day's window (half an hour of build-up before, half after).
    fn since(&self, utc_tod_secs: f64) -> f64 {
        let x = (utc_tod_secs / 3600.0 - self.hour).rem_euclid(24.0);
        if x > 12.0 {
            x - 24.0
        } else {
            x
        }
    }

    /// Is the event on air at this UTC time of day?
    pub fn on_air_at(&self, utc_tod_secs: f64) -> bool {
        let x = self.since(utc_tod_secs);
        self.enabled && x >= 0.0 && x < self.hours
    }

    /// The global surge at this UTC time of day: builds for half an hour,
    /// holds `peak` while on air, fades over half an hour.
    pub fn multiplier(&self, utc_tod_secs: f64) -> f64 {
        if !self.enabled {
            return 1.0;
        }
        let x = self.since(utc_tod_secs);
        if x < -0.5 || x > self.hours + 0.5 {
            1.0
        } else if x < 0.0 {
            1.0 + (self.peak - 1.0) * ((x + 0.5) / 0.5)
        } else if x <= self.hours {
            self.peak
        } else {
            1.0 + (self.peak - 1.0) * (1.0 - (x - self.hours) / 0.5)
        }
    }
}

fn default_newscasts() -> Vec<Newscast> {
    vec![Newscast { hour: 6.0, peak: 4.0 }, Newscast { hour: 12.0, peak: 4.0 }, Newscast { hour: 18.0, peak: 6.0 }]
}

impl Default for DaySchedule {
    fn default() -> Self {
        DaySchedule { enabled: true, start_hour: -1.0, hourly_news: 3.0, radio_prep: 2.0, newscasts: default_newscasts(), overnight: 0.3, blackout: Blackout::default(), olympics: Olympics::default() }
    }
}

impl DaySchedule {
    /// Load multiplier at a local time of day (seconds since midnight).
    pub fn multiplier(&self, tod_secs: f64) -> f64 {
        if !self.enabled {
            return 1.0;
        }
        let tod = tod_secs.rem_euclid(86_400.0);
        let hour = tod / 3600.0;
        let minute = (tod % 3600.0) / 60.0;
        let mut m = 1.0_f64;

        // Overnight quiet.
        if hour < 5.0 {
            m *= self.overnight;
        }
        // Hourly news rush: triangle from :55 up to :00 and down to :10.
        let dist_to_hour = minute.min(60.0 - minute);
        if minute >= 55.0 {
            m = m.max(1.0 + (self.hourly_news - 1.0) * ((minute - 55.0) / 5.0));
        } else if minute <= 10.0 {
            m = m.max(1.0 + (self.hourly_news - 1.0) * (1.0 - minute / 10.0));
        }
        // Radio prep: bumps around :00 and :30.
        let dist_to_half = (minute - 30.0).abs();
        for d in [dist_to_hour, dist_to_half] {
            if d <= 5.0 {
                m = m.max(1.0 + (self.radio_prep - 1.0) * (1.0 - d / 5.0));
            }
        }
        // Newscasts.
        for n in &self.newscasts {
            let mut x = hour - n.hour;
            if x > 12.0 {
                x -= 24.0;
            } else if x < -12.0 {
                x += 24.0;
            }
            let v = if !(-1.0..=1.0).contains(&x) {
                1.0
            } else if x < -0.25 {
                1.0 + (n.peak - 1.0) * ((x + 1.0) / 0.75)
            } else if x <= 0.5 {
                n.peak
            } else {
                1.0 + (n.peak - 1.0) * (1.0 - (x - 0.5) / 0.5)
            };
            m = m.max(v);
        }
        m
    }

    /// Local time of day at a longitude for a UTC time of day: solar time,
    /// one hour per 15 degrees, no daylight saving.
    pub fn local_tod(utc_tod_secs: f64, lon: f64) -> f64 {
        (utc_tod_secs + lon / 15.0 * 3600.0).rem_euclid(86_400.0)
    }

    /// Multiplier for a site at `lon` when UTC time of day is `utc_tod_secs`.
    /// Television and radio by the site's own clock, the Olympics by UTC.
    pub fn multiplier_at(&self, utc_tod_secs: f64, lon: f64) -> f64 {
        let m = self.multiplier(Self::local_tod(utc_tod_secs, lon));
        if self.enabled {
            m.max(self.olympics.multiplier(utc_tod_secs))
        } else {
            m
        }
    }

    pub fn biggest_peak(&self) -> f64 {
        self.newscasts.iter().map(|n| n.peak).fold(1.0, f64::max).max(self.hourly_news).max(self.radio_prep).max(if self.olympics.enabled { self.olympics.peak } else { 1.0 })
    }
}

/// One point on the usage graph.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Sample {
    pub sim_time: f64,
    pub wall_time: String,
    pub active: usize,
    pub active_via: usize,
    pub trunks: usize,
    pub granted_total: u64,
    pub granted_via_total: u64,
    pub denied_total: u64,
    pub released_total: u64,
    pub channel_utilization: f64,
    pub caster_utilization: f64,
    pub crosschecks_ok: u64,
    pub crosschecks_failed: u64,
    /// Simulated time of day, seconds since midnight.
    #[serde(default)]
    pub time_of_day: f64,
    /// Load multiplier from the day schedule at this sample.
    #[serde(default = "one")]
    pub load_multiplier: f64,
    /// Lines parked (connected but muted) at this sample.
    #[serde(default)]
    pub muted: usize,
    #[serde(default)]
    pub blackout: bool,
    /// Live calls touching each continent at this sample.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub continents: std::collections::BTreeMap<String, usize>,
    /// Every production's counters at this sample, by production name.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub productions: std::collections::BTreeMap<String, ProductionSample>,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Timeline {
    pub wire_version: u32,
    pub samples: Vec<Sample>,
}

// ---------------------------------------------------------------------------
// TRUNK-RELAY: a relay hosted on this computer
// ---------------------------------------------------------------------------

/// One matrix of the local relay: `io` local inputs/outputs against
/// `casters` trunk ports into the caster. Appears as a frame of protocol
/// `relay`, so anything can be routed to and from it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayMatrix {
    pub id: String,
    pub label: String,
    pub io: usize,
    pub casters: usize,
    /// Names for the local ports, keyed `U<nn>` (e.g. "Mic", "Headphones").
    #[serde(default)]
    pub port_names: std::collections::BTreeMap<String, String>,
    /// Local sound devices bound to ports, keyed `U<nn>`.
    #[serde(default)]
    pub bindings: std::collections::BTreeMap<String, RelayBinding>,
}

/// `TRUNK-RELAY/relay.json`: what this computer offers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    pub host: String,
    #[serde(default = "default_relay_name")]
    pub protocol_name: String,
    pub matrices: Vec<RelayMatrix>,
    /// VU meters log an event when a device's peak goes over this (dBFS).
    #[serde(default = "default_threshold")]
    pub over_threshold_dbfs: f64,
}

fn default_relay_name() -> String {
    "Local Sound Card Relay".into()
}

fn default_threshold() -> f64 {
    -6.0
}

impl Default for RelayConfig {
    fn default() -> Self {
        let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "this-computer".into());
        let m = |id: &str, label: &str, io: usize, casters: usize| RelayMatrix {
            id: id.into(),
            label: label.into(),
            io,
            casters,
            port_names: std::collections::BTreeMap::new(),
            bindings: std::collections::BTreeMap::new(),
        };
        // The 2x2 is the person at this computer: it carries their Windows
        // user name and is where their microphone and speakers land.
        let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "local".into());
        let mut me = m("relay-2x2", &user, 2, 2);
        me.port_names.insert("U00".into(), format!("{user} mic"));
        me.port_names.insert("U01".into(), format!("{user} speakers"));
        RelayConfig {
            host,
            protocol_name: default_relay_name(),
            matrices: vec![m("relay-a", "Relay 8x8 A", 8, 8), m("relay-b", "Relay 8x8 B", 8, 8), me],
            over_threshold_dbfs: default_threshold(),
        }
    }
}

/// One local port of a relay matrix, as it stands now.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayPort {
    pub port: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_who: Option<String>,
    /// Far end as `frame:U<nn>`, when connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<RelayBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayMatrixState {
    pub id: String,
    pub label: String,
    pub io: usize,
    pub casters: usize,
    pub ports: Vec<RelayPort>,
    pub caster_status: Vec<CasterAd>,
    pub crosspoints: Vec<Crosspoint>,
}

/// `TRUNK-RELAY/state.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelaySnapshot {
    pub wire_version: u32,
    pub host: String,
    pub updated_at: String,
    pub matrices: Vec<RelayMatrixState>,
}

// ---------------------------------------------------------------------------
// Remote frames: simulators (or real frames) speaking Ward-Beck over TCP
// ---------------------------------------------------------------------------

/// A frame hosted by a remote process that connected to the caster's
/// Ward-Beck port, announced the frame with a CHECKIN line, and now
/// receives CLOSE/OPEN lines for it and echoes them back.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFrame {
    pub frame: String,
    pub peer: String,
    pub connected_at: String,
    pub last_seen: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checkin: Option<String>,
    /// Crosspoints the remote says it has closed, from its last check-in.
    #[serde(default)]
    pub reported_closed: usize,
    /// Lines we sent it.
    #[serde(default)]
    pub lines_sent: u64,
    /// Lines it echoed back.
    #[serde(default)]
    pub acks: u64,
    #[serde(default)]
    pub checkins: u64,
    /// Lines it acknowledged over MQTT: applied only after the copy over
    /// the Ward-Beck port and the copy over MQTT agreed.
    #[serde(default)]
    pub mqtt_acks: u64,
    /// Lines it rejected because only one transport delivered them.
    #[serde(default)]
    pub rejects: u64,
    pub connected: bool,
    /// The host the simulator announced itself from: its Docker container
    /// name (`sim-dante`) or machine name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

// ---------------------------------------------------------------------------
// TRUNK-GLOBAL: the globe and the user's preferences
// ---------------------------------------------------------------------------

/// How the globe is drawn. `TRUNK-GLOBAL/globe.json`, editable from the page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobeConfig {
    /// Degrees of rotation per second. 0 holds still.
    pub rotate_deg_per_s: f64,
    /// Tilt in degrees; negative looks slightly down on the globe.
    pub tilt_deg: f64,
    pub show_capitals: bool,
    pub show_provinces: bool,
    pub show_cities: bool,
    /// Draw a graticule every this many degrees.
    pub graticule_deg: f64,
    /// "globe" (orthographic sphere) or "map" (flat equirectangular).
    #[serde(default = "default_projection")]
    pub projection: String,
    /// Zoom factor, 1 = whole globe in view.
    #[serde(default = "one")]
    pub zoom: f64,
    /// The clocks across the bottom of every page. The anchor zone is the
    /// one the broadcast-day strip is labelled in.
    #[serde(default = "default_zones")]
    pub zones: Vec<Zone>,
}

/// A world clock in the footer. Offsets are fixed (no daylight saving):
/// Saskatchewan is the anchor precisely because it never changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Zone {
    pub name: String,
    pub offset_hours: f64,
    #[serde(default)]
    pub anchor: bool,
}

fn default_zones() -> Vec<Zone> {
    let z = |name: &str, offset_hours: f64, anchor: bool| Zone { name: name.into(), offset_hours, anchor };
    vec![
        z("Los Angeles", -8.0, false),
        z("Saskatchewan", -6.0, true),
        z("New York", -5.0, false),
        z("London", 0.0, false),
        z("Paris", 1.0, false),
        z("Kyiv", 2.0, false),
        z("Riyadh", 3.0, false),
        z("Dubai", 4.0, false),
        z("New Delhi", 5.5, false),
        z("Tokyo", 9.0, false),
        z("Sydney", 10.0, false),
    ]
}

impl GlobeConfig {
    pub fn anchor(&self) -> Zone {
        self.zones.iter().find(|z| z.anchor).cloned().unwrap_or_else(|| default_zones()[1].clone())
    }
}

fn default_projection() -> String {
    "both".into()
}

impl Default for GlobeConfig {
    fn default() -> Self {
        GlobeConfig {
            rotate_deg_per_s: 2.5,
            tilt_deg: -18.0,
            show_capitals: true,
            show_provinces: true,
            show_cities: true,
            graticule_deg: 30.0,
            projection: default_projection(),
            zoom: 1.0,
            zones: default_zones(),
        }
    }
}

/// One line of `TRUNK-GLOBAL/preferences.jsonl`: something a user set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preference {
    pub seq: u64,
    pub at: String,
    /// "fader", "fader-quick", "clock", "gain", "rename", "relay-bind",
    /// "relay-unbind", "crosspoint-settings", "crosspoint-reset", "globe".
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    pub value: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Simulation recorder
// ---------------------------------------------------------------------------

/// What one run of the simulation achieved. A run is the stretch between two
/// parameter changes: change the fader and a new run begins, so every metric
/// belongs to the parameters that produced it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RunSummary {
    pub samples: usize,
    pub duration_sim_seconds: f64,
    pub granted: u64,
    pub granted_via: u64,
    pub denied: u64,
    pub released: u64,
    pub peak_live: usize,
    pub avg_live: f64,
    pub peak_muted: usize,
    pub avg_channel_utilization: f64,
    pub max_channel_utilization: f64,
    pub avg_caster_utilization: f64,
    pub crosschecks_failed: u64,
    pub blackout_samples: usize,
    /// What each production achieved over the run, by name.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub productions: std::collections::BTreeMap<String, ProductionSummary>,
}

/// `TRUNK-SIMULATOR/runs/<id>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimRun {
    pub wire_version: u32,
    pub id: String,
    pub started_at: String,
    pub started_sim: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_sim: Option<f64>,
    /// Why the run started: "boot", "fader", "clock", "blackout-end".
    pub reason: String,
    /// The parameters this run ran under.
    pub fader: Fader,
    pub frames: usize,
    pub sites: usize,
    pub summary: RunSummary,
    #[serde(default)]
    pub samples: Vec<Sample>,
}

/// One person in the phone book: everyone who has called, and where.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoneBookEntry {
    pub who: String,
    pub label: crate::labels::Label,
    /// Panels that carry this name right now, `frame:Unn`.
    pub panels: Vec<String>,
    /// Sites those panels are at.
    pub sites: Vec<String>,
    pub calls: usize,
    pub live_now: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_called: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<Badge>,
}

// ---------------------------------------------------------------------------
// Capture and analysis
// ---------------------------------------------------------------------------

/// One check-in of a capture: what happened in a window of the simulated
/// day (an hour, a half hour or a quarter hour).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Bucket {
    /// Start of the window, simulated seconds.
    pub start_sim: f64,
    /// Start of the window as a UTC clock on the simulated day, "HH:MM".
    pub clock: String,
    pub samples: usize,
    pub avg_live: f64,
    pub peak_live: usize,
    pub avg_muted: f64,
    pub granted: u64,
    pub denied: u64,
    pub released: u64,
    pub avg_channel_utilization: f64,
    pub max_channel_utilization: f64,
    pub avg_load: f64,
    pub blackout: bool,
    pub crosschecks_failed: u64,
}

/// The same capture summarized three ways.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CaptureBuckets {
    pub hour: Vec<Bucket>,
    pub half_hour: Vec<Bucket>,
    pub quarter_hour: Vec<Bucket>,
}

/// A capture: telemetry recorded between START and STOP, kept as a file in
/// `TRUNK-SIMULATOR/captures/` for offline analysis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capture {
    pub wire_version: u32,
    pub id: String,
    pub note: String,
    pub started_at: String,
    pub started_sim: f64,
    pub started_clock: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_sim: Option<f64>,
    pub fader: Fader,
    pub frames: usize,
    pub sites: usize,
    pub summary: RunSummary,
    #[serde(default)]
    pub buckets: CaptureBuckets,
    #[serde(default)]
    pub samples: Vec<Sample>,
}

/// Runtime-wide status returned from `/api/status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Status {
    pub wire_version: u32,
    pub root: PathBuf,
    pub endpoint: String,
    pub shape: Shape,
    pub protocols: usize,
    pub frames: usize,
    pub trunks: usize,
    pub connections: usize,
    pub sim_time: f64,
    pub fader: Fader,
    pub updated_at: String,
    /// Frames hosted by remote processes on the Ward-Beck port.
    #[serde(default)]
    pub remote_frames: usize,
    #[serde(default)]
    pub remotes_connected: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wb_endpoint: Option<String>,
    #[serde(default)]
    pub sites: usize,
    #[serde(default)]
    pub clock: String,
    /// True during the daily disconnect window.
    #[serde(default)]
    pub blackout: bool,
    #[serde(default)]
    pub muted: usize,
    /// Id of the capture in progress, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capturing: Option<String>,
    /// The MQTT transport running in parallel with the Ward-Beck port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mqtt: Option<crate::mqtt::LinkStats>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeating_segment_is_on_air_at_the_half_hours_only() {
        let p: Production = serde_json::from_str(r#"{"enabled":true,"name":"Phone-in","trunks":8,"calls_per_minute":20,"mean_hold_seconds":180,"start_hour":6,"end_hour":24,"every_minutes":60,"at_minute":30,"for_minutes":30}"#).unwrap();
        let at = |h: f64, m: f64| (h * 60.0 + m) * 60.0;
        assert!(p.on_air_at(at(9.0, 30.0)) && p.on_air_at(at(9.0, 59.0)));
        assert!(!p.on_air_at(at(9.0, 0.0)) && !p.on_air_at(at(9.0, 29.0)));
        assert!(!p.on_air_at(at(5.0, 45.0)), "outside the 06-24 window");
        // Old fader files have no segment fields: on air the whole window.
        let old: Production = serde_json::from_str(r#"{"enabled":true,"name":"x","trunks":1,"calls_per_minute":1,"mean_hold_seconds":1,"start_hour":6,"end_hour":24}"#).unwrap();
        assert!(old.on_air_at(at(9.0, 0.0)));
    }

    #[test]
    fn presets_start_before_their_one_event() {
        let all = presets(&Fader::default());
        // Saskatchewan (UTC-6): the 18:00 newscast, an hour early, is 23:00 UTC.
        let day = all.iter().find(|p| p.id == "broadcast-day").unwrap();
        assert_eq!(day.start_utc_hour(-6.0), 23.0);
        // The reset drill is in UTC wherever you are.
        let reset = all.iter().find(|p| p.id == "daily-reset").unwrap();
        assert!((reset.start_utc_hour(9.0) - (11.0 - 5.0 / 60.0)).abs() < 1e-9);
        for p in &all {
            assert!(p.fader.day.newscasts.len() <= 1 && !p.fader.day.olympics.enabled, "{} has more than one major event", p.id);
        }
    }

    #[test]
    fn olympics_surge_everywhere_at_once() {
        let d = DaySchedule::default();
        let at = |h: f64| h * 3600.0;
        // 19:00 UTC for two hours: Tokyo and Lima surge together.
        for lon in [139.7, -77.0] {
            assert_eq!(d.multiplier_at(at(20.0), lon).max(d.olympics.peak), d.multiplier_at(at(20.0), lon));
        }
        assert!(d.olympics.on_air_at(at(19.0)) && !d.olympics.on_air_at(at(21.0)));
        // Half an hour of build-up, nothing the rest of the day.
        assert!((d.olympics.multiplier(at(18.75)) - 3.0).abs() < 1e-9);
        assert_eq!(d.olympics.multiplier(at(7.0)), 1.0);
        // Older fader files pick up the defaults.
        let f: Fader = serde_json::from_str(&serde_json::to_string(&Fader::default()).unwrap().replace(",\"in_building_calls_per_hour\":100.0", "")).unwrap();
        assert_eq!(f.in_building_calls_per_hour, 100.0);
    }
}
