//! The folder contract. Every component finds its way around the
//! Trunk-Caster project root using these names and nothing else.

use std::path::{Path, PathBuf};

/// Manuals and API references, one folder per vendor, one sub-folder per
/// protocol. Vendor folders may also sit directly under the project root.
pub const KNOWN_PROTOCOLS: &str = "KNOWN PROTOCOLS";
/// One JSON file per advertised frame, written by the runtime.
pub const ADVERTISEMENT: &str = "TRUNK-ADVERTISEMENT";
/// Seekers drop `<id>.json` requests here; the runtime answers with
/// `<id>.reply.json`. Deleting the request releases the connection.
pub const INTERFACE: &str = "TRUNK-CASTER-INTERFACE";
/// `state.json` (all frames, trunks, connections) and `index.html`.
pub const USAGE: &str = "TRUNK-USAGE";
/// One JSON per request ever made: who, whom, when, why, where, how.
/// Plus `index.html`.
pub const USERS: &str = "TRUNK-USERS";
/// `crosspoints.json`, `deltas.jsonl`, `settings.json`, `seeking.json`,
/// `seeks/<id>.json` and `seeks/<id>.offer.json`, `index.html`.
pub const CROSS_POINTS: &str = "TRUNK-CROSS POINTS";
/// `fader.json` (speed and load), `timeline.json`, `index.html`.
pub const SIMULATOR: &str = "TRUNK-SIMULATOR";
/// The relay hosted on this computer: `relay.json` (what it offers),
/// `state.json` (how it is patched) and `index.html`.
pub const RELAY: &str = "TRUNK-RELAY";
/// The globe is managed here: `sites.json` (capitals, provinces, cities and
/// their coordinates), `globe.json` (how it is drawn), `index.html` (the
/// globe), `regions.json` (usage per region) and `preferences.jsonl`
/// (every user preference ever set).
pub const GLOBAL: &str = "TRUNK-GLOBAL";
/// This crate, plus the plans for every component.
pub const SDK: &str = "TRUNK-CASTER-SDK";
/// The runtime binary crate.
pub const RUNTIME: &str = "RUST-RUNTIME";

/// Folders that are never treated as a vendor when scanning the root.
pub const RESERVED: &[&str] = &[
    KNOWN_PROTOCOLS,
    ADVERTISEMENT,
    INTERFACE,
    USAGE,
    USERS,
    CROSS_POINTS,
    SIMULATOR,
    RELAY,
    GLOBAL,
    SDK,
    RUNTIME,
];

pub fn is_reserved(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&upper)) || upper.starts_with("TRUNK-")
}

/// Typed view of a project root.
#[derive(Debug, Clone)]
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Layout { root: root.into() }
    }

    /// Walk up from `start` until a directory containing KNOWN PROTOCOLS is found.
    pub fn find(start: &Path) -> Option<Layout> {
        let mut cur = Some(start);
        while let Some(dir) = cur {
            if dir.join(KNOWN_PROTOCOLS).is_dir() {
                return Some(Layout::new(dir));
            }
            cur = dir.parent();
        }
        None
    }

    pub fn known_protocols(&self) -> PathBuf {
        self.root.join(KNOWN_PROTOCOLS)
    }
    pub fn advertisement(&self) -> PathBuf {
        self.root.join(ADVERTISEMENT)
    }
    pub fn interface(&self) -> PathBuf {
        self.root.join(INTERFACE)
    }
    pub fn usage(&self) -> PathBuf {
        self.root.join(USAGE)
    }
    pub fn users(&self) -> PathBuf {
        self.root.join(USERS)
    }
    pub fn cross_points(&self) -> PathBuf {
        self.root.join(CROSS_POINTS)
    }
    pub fn simulator(&self) -> PathBuf {
        self.root.join(SIMULATOR)
    }
    pub fn sdk(&self) -> PathBuf {
        self.root.join(SDK)
    }
    pub fn relay(&self) -> PathBuf {
        self.root.join(RELAY)
    }
    pub fn relay_config(&self) -> PathBuf {
        self.relay().join("relay.json")
    }
    pub fn relay_state(&self) -> PathBuf {
        self.relay().join("state.json")
    }

    // Well-known files.
    /// The booking timeline: ports held for programs, from the panel
    /// editor and the simulated traffic.
    pub fn bookings_json(&self) -> PathBuf {
        self.usage().join("bookings.json")
    }
    pub fn usage_state(&self) -> PathBuf {
        self.usage().join("state.json")
    }
    pub fn crosspoints_json(&self) -> PathBuf {
        self.cross_points().join("crosspoints.json")
    }
    pub fn crosspoint_deltas(&self) -> PathBuf {
        self.cross_points().join("deltas.jsonl")
    }
    pub fn crosspoint_settings(&self) -> PathBuf {
        self.cross_points().join("settings.json")
    }
    pub fn seeking_json(&self) -> PathBuf {
        self.cross_points().join("seeking.json")
    }
    pub fn gpio_log(&self) -> PathBuf {
        self.cross_points().join("gpio.jsonl")
    }
    pub fn renames_log(&self) -> PathBuf {
        self.cross_points().join("renames.jsonl")
    }
    /// Every crosspoint delta and check-in as Ward-Beck lines, appended.
    pub fn wardbeck_log(&self) -> PathBuf {
        self.cross_points().join("wardbeck.log")
    }
    /// The latest check-in: full state of every frame as Ward-Beck lines.
    pub fn checkin_file(&self) -> PathBuf {
        self.cross_points().join("checkin.wb")
    }
    pub fn vendor_policy(&self) -> PathBuf {
        self.sdk().join("vendor-policy.json")
    }
    pub fn global(&self) -> PathBuf {
        self.root.join(GLOBAL)
    }
    /// Where frames live on the globe: capitals (10 frames), provinces (1),
    /// smaller cities (8x8 + 2x2).
    pub fn sites(&self) -> PathBuf {
        self.global().join("sites.json")
    }
    /// How the globe is drawn.
    pub fn globe_config(&self) -> PathBuf {
        self.global().join("globe.json")
    }
    /// Usage per region, rewritten with every persist.
    pub fn regions_json(&self) -> PathBuf {
        self.global().join("regions.json")
    }
    /// Every user preference ever set, one line each.
    pub fn preferences(&self) -> PathBuf {
        self.global().join("preferences.jsonl")
    }
    /// How often every trunk was used, by simulated day and hour, and the
    /// days it was locked for an hour or more.
    pub fn trends_json(&self) -> PathBuf {
        self.global().join("trends.json")
    }
    /// Panel-label events: names longer than a 6- or 8-character panel.
    pub fn label_events(&self) -> PathBuf {
        self.users().join("labels.jsonl")
    }
    /// Relay sound-device events (levels over the threshold, bindings).
    pub fn relay_events(&self) -> PathBuf {
        self.relay().join("events.jsonl")
    }
    pub fn space_html(&self) -> PathBuf {
        self.usage().join("space.html")
    }
    pub fn seeks_dir(&self) -> PathBuf {
        self.cross_points().join("seeks")
    }
    pub fn fader(&self) -> PathBuf {
        self.simulator().join("fader.json")
    }
    pub fn timeline(&self) -> PathBuf {
        self.simulator().join("timeline.json")
    }
    /// One file per simulation run (a stretch between parameter changes).
    pub fn runs_dir(&self) -> PathBuf {
        self.simulator().join("runs")
    }
    /// Summaries of every run, newest first.
    pub fn runs_index(&self) -> PathBuf {
        self.simulator().join("runs.json")
    }
    /// Captures: telemetry recorded between START and STOP, one file each.
    pub fn captures_dir(&self) -> PathBuf {
        self.simulator().join("captures")
    }
}
