//! TRUNK-USAGE/bookings.json: the booking timeline. A booking holds one
//! port on a frame (a panel, or an input such as a program feed) for a
//! program from a start to an end on the simulated clock. When the start
//! comes the runtime makes the call to the far end (if there is one) and
//! holds it until the end; a daily booking then re-arms for the next day.
//!
//! Bookings come from the panel editor and from the simulated traffic,
//! which books ahead the way a booking desk does.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Finished bookings are kept this long (simulated seconds) for the timeline.
pub const KEEP_DONE_SECONDS: f64 = 6.0 * 3600.0;
/// Upcoming simulator bookings never exceed this many.
pub const SIM_UPCOMING_CAP: usize = 300;
/// The file never holds more than this many bookings.
const TOTAL_CAP: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PortKind {
    /// A user panel: someone talks and listens on it.
    #[default]
    Panel,
    /// An input attached to the frame: a program feed, a line, a source.
    Input,
}

impl PortKind {
    pub fn label(self) -> &'static str {
        match self {
            PortKind::Panel => "panel",
            PortKind::Input => "input",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BookingStatus {
    #[default]
    Booked,
    OnAir,
    Done,
    /// The start came but the call was refused (or the port was taken).
    Failed,
    /// The window passed while the runtime could not start it (daily reset).
    Missed,
}

impl BookingStatus {
    pub fn label(self) -> &'static str {
        match self {
            BookingStatus::Booked => "booked",
            BookingStatus::OnAir => "on air",
            BookingStatus::Done => "done",
            BookingStatus::Failed => "failed",
            BookingStatus::Missed => "missed",
        }
    }
    pub fn finished(self) -> bool {
        matches!(self, BookingStatus::Done | BookingStatus::Failed | BookingStatus::Missed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Booking {
    pub id: String,
    pub frame: String,
    pub port: usize,
    #[serde(default)]
    pub kind: PortKind,
    pub program: String,
    pub who: String,
    /// The far frame the call goes to; none: the port is held locally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// On the absolute simulated clock: seconds since midnight UTC of
    /// simulated day 0 (`Runtime::clock_abs`).
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub daily: bool,
    /// "editor" or "simulator".
    pub source: String,
    #[serde(default)]
    pub status: BookingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: String,
}

impl Booking {
    pub fn overlaps(&self, start: f64, end: f64) -> bool {
        self.start < end && start < self.end
    }
}

/// What the editor (or the API) asks for.
#[derive(Debug, Clone, Deserialize)]
pub struct BookingAsk {
    pub frame: String,
    pub port: usize,
    #[serde(default)]
    pub kind: PortKind,
    pub program: String,
    #[serde(default)]
    pub who: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// Start, in the frame's local time of day, hours (9.5 = 09:30).
    pub start_hour: f64,
    pub minutes: f64,
    #[serde(default)]
    pub daily: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Bookings {
    #[serde(default)]
    pub next_id: u64,
    #[serde(default)]
    pub list: Vec<Booking>,
    /// The absolute clock when the file was written, so the bookings can
    /// be carried over whole days when the clock is anchored afresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock_at_save: Option<f64>,
    #[serde(skip)]
    pub dirty: bool,
}

impl Bookings {
    pub fn load(path: &Path) -> Bookings {
        crate::util::read_json(path).unwrap_or_default()
    }

    /// The clock was anchored afresh at boot: move every booking on by the
    /// whole days that passed, so each keeps its time of day. Time lost
    /// inside a day is real: what fell into it is missed.
    pub fn rebase(&mut self, now: f64) {
        let Some(saved) = self.clock_at_save else { return };
        let days = ((now - saved) / 86_400.0).floor() * 86_400.0;
        if days != 0.0 {
            for b in &mut self.list {
                b.start += days;
                b.end += days;
            }
            self.dirty = true;
        }
    }

    pub fn new_id(&mut self, source: &str) -> String {
        self.next_id += 1;
        format!("{}-{:05}", if source == "simulator" { "sbk" } else { "bk" }, self.next_id)
    }

    /// A booking already holding this port at any time in the window.
    pub fn clash(&self, frame: &str, port: usize, start: f64, end: f64) -> Option<&Booking> {
        self.list.iter().find(|b| b.frame == frame && b.port == port && !b.status.finished() && b.overlaps(start, end))
    }

    pub fn add(&mut self, b: Booking) {
        self.list.push(b);
        self.list.sort_by(|a, b| a.start.total_cmp(&b.start));
        self.dirty = true;
    }

    pub fn of_port<'a>(&'a self, frame: &'a str, port: usize) -> impl Iterator<Item = &'a Booking> + 'a {
        self.list.iter().filter(move |b| b.frame == frame && b.port == port)
    }

    pub fn sim_upcoming(&self) -> usize {
        self.list.iter().filter(|b| b.source == "simulator" && b.status == BookingStatus::Booked).count()
    }

    /// Drop finished bookings older than the keep window, oldest first
    /// when over the cap.
    pub fn prune(&mut self, now: f64) {
        let before = self.list.len();
        self.list.retain(|b| !(b.status.finished() && b.end < now - KEEP_DONE_SECONDS));
        if self.list.len() > TOTAL_CAP {
            let over = self.list.len() - TOTAL_CAP;
            let mut dropped = 0;
            self.list.retain(|b| {
                if dropped < over && b.status.finished() {
                    dropped += 1;
                    false
                } else {
                    true
                }
            });
        }
        if self.list.len() != before {
            self.dirty = true;
        }
    }
}
