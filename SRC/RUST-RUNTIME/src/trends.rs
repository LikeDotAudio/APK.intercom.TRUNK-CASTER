//! TRUNK-GLOBAL/trends.json: how often every trunk (a pair of frames) has
//! carried a call, by simulated day and hour of day, and the days it was
//! *locked*: held by one call for an hour or more. The globe colours each
//! trunk by its use count and shows the trend: a trunk locked day after
//! day at the same hour is a habit, and the globe says so.
//!
//! A trunk is keyed by its two frames, not by its trunk id, so the history
//! survives the trunk being torn down and rebuilt between the same casters.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use trunk_caster_sdk::Connection;

/// Held this long (simulated seconds) and a trunk counts as locked.
pub const LOCK_SECONDS: f64 = 3600.0;
/// Days of history kept per trunk.
pub const DAYS_KEPT: usize = 30;
/// Days shown in the trend sparklines.
pub const DAYS_SHOWN: usize = 14;
/// Trunks sent to the pages, most habitual first.
const SUMMARY_CAP: usize = 400;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DayStat {
    /// Calls that rode this trunk on this day.
    pub uses: u32,
    /// Simulated seconds of hold released on this day.
    pub held: f64,
    /// Some call held it for an hour or more on this day.
    pub locked: bool,
    /// The longest single hold seen on this day (simulated seconds).
    pub longest: f64,
    /// Bitmask of the hours (0..24) in which a lock was in force.
    #[serde(default)]
    pub lock_hours: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrunkHistory {
    pub a: String,
    pub b: String,
    /// Calls that ever rode this trunk.
    pub uses: u64,
    /// Per simulated day (days since the simulated epoch).
    pub days: BTreeMap<i64, DayStat>,
    /// Uses by simulated hour of day.
    pub hours: [u32; 24],
    /// Longest hold ever (simulated seconds).
    pub longest: f64,
    pub first_used: String,
    pub last_used: String,
    pub last_used_sim: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Trends {
    #[serde(default)]
    pub trunks: BTreeMap<String, TrunkHistory>,
    #[serde(skip)]
    pub dirty: bool,
}

/// One trunk summarised for the globe.
#[derive(Debug, Clone, Serialize)]
pub struct TrunkTrend {
    pub a: String,
    pub b: String,
    pub uses: u64,
    /// Consecutive days locked, ending today or yesterday.
    pub streak: u32,
    /// Days locked in the window shown.
    pub locked_days: u32,
    pub locked_today: bool,
    /// Uses on each of the last DAYS_SHOWN days, oldest first.
    pub days: Vec<u32>,
    /// Locked on each of those days.
    pub locked: Vec<bool>,
    /// Simulated hours of hold on each of those days.
    pub held: Vec<f64>,
    pub hours: [u32; 24],
    /// Hours of the day a lock is usually in force: how many of the shown
    /// days were locked in each hour.
    pub lock_hours: [u8; 24],
    pub longest: f64,
    pub last_used: String,
}

/// Simulated seconds a call was really in use: from its grant until it was
/// parked or its hold ran out, whichever came first. A latched line is in
/// use until now. Parked time does not count, and neither does the slack
/// of a coarse tick at high simulation speed.
pub fn active_hold(c: &Connection, sim_now: f64) -> f64 {
    let mut end = sim_now;
    if let Some(m) = c.muted_at_sim {
        if c.muted {
            end = end.min(m);
        }
    }
    if !c.latched {
        if let Some(e) = c.expires_at_sim {
            end = end.min(e);
        }
    }
    (end - c.granted_sim).max(0.0)
}

pub fn key(a: &str, b: &str) -> String {
    if a <= b {
        format!("{a}|{b}")
    } else {
        format!("{b}|{a}")
    }
}

impl Trends {
    pub fn load(path: &Path) -> Trends {
        crate::util::read_json::<Trends>(path).unwrap_or_default()
    }

    fn entry(&mut self, a: &str, b: &str, now_iso: &str, sim: f64) -> &mut TrunkHistory {
        let k = key(a, b);
        let (a, b) = if a <= b { (a, b) } else { (b, a) };
        self.trunks.entry(k).or_insert_with(|| TrunkHistory {
            a: a.to_string(),
            b: b.to_string(),
            uses: 0,
            days: BTreeMap::new(),
            hours: [0; 24],
            longest: 0.0,
            first_used: now_iso.to_string(),
            last_used: now_iso.to_string(),
            last_used_sim: sim,
        })
    }

    /// A call was granted (or a parked line picked up): every hop's trunk
    /// was used once more.
    pub fn used(&mut self, conn: &Connection, day: i64, hour: usize, now_iso: &str, sim: f64) {
        for h in &conn.hops {
            let e = self.entry(&h.from, &h.to, now_iso, sim);
            e.uses += 1;
            e.hours[hour.min(23)] += 1;
            e.last_used = now_iso.to_string();
            e.last_used_sim = sim;
            let d = e.days.entry(day).or_default();
            d.uses += 1;
            Self::prune(&mut e.days);
        }
        self.dirty = true;
    }

    /// A call was released at simulated time `sim`.
    pub fn released(&mut self, conn: &Connection, day: i64, now_iso: &str, sim: f64) {
        let held = active_hold(conn, sim);
        for h in &conn.hops {
            let e = self.entry(&h.from, &h.to, now_iso, sim);
            e.longest = e.longest.max(held);
            let d = e.days.entry(day).or_default();
            d.held += held;
            d.longest = d.longest.max(held);
            if held >= LOCK_SECONDS {
                d.locked = true;
            }
            Self::prune(&mut e.days);
        }
        self.dirty = true;
    }

    /// Look at the calls up right now: any held for an hour or more locks
    /// its trunks for today, in this hour.
    pub fn observe(&mut self, conns: &[Connection], sim_now: f64, day: i64, hour: usize, now_iso: &str) {
        let bit = 1u32 << hour.min(23);
        let mut dirty = false;
        for c in conns {
            let held = active_hold(c, sim_now);
            if held < LOCK_SECONDS {
                continue;
            }
            for h in &c.hops {
                let e = self.entry(&h.from, &h.to, now_iso, sim_now);
                e.longest = e.longest.max(held);
                let d = e.days.entry(day).or_default();
                d.longest = d.longest.max(held);
                if !d.locked || d.lock_hours & bit == 0 {
                    d.locked = true;
                    d.lock_hours |= bit;
                    dirty = true;
                }
                Self::prune(&mut e.days);
            }
        }
        self.dirty |= dirty;
    }

    fn prune(days: &mut BTreeMap<i64, DayStat>) {
        while days.len() > DAYS_KEPT {
            let first = *days.keys().next().unwrap();
            days.remove(&first);
        }
    }

    /// Consecutive locked days ending today, or yesterday if today has not
    /// locked yet.
    pub fn streak(h: &TrunkHistory, today: i64) -> u32 {
        let locked = |d: i64| h.days.get(&d).map_or(false, |s| s.locked);
        let mut d = if locked(today) { today } else { today - 1 };
        let mut n = 0;
        while locked(d) {
            n += 1;
            d -= 1;
        }
        n
    }

    pub fn trend_of(h: &TrunkHistory, today: i64) -> TrunkTrend {
        let from = today - DAYS_SHOWN as i64 + 1;
        let mut days = Vec::with_capacity(DAYS_SHOWN);
        let mut locked = Vec::with_capacity(DAYS_SHOWN);
        let mut held = Vec::with_capacity(DAYS_SHOWN);
        let mut lock_hours = [0u8; 24];
        for d in from..=today {
            match h.days.get(&d) {
                Some(s) => {
                    days.push(s.uses);
                    locked.push(s.locked);
                    held.push(s.held / 3600.0);
                    for hr in 0..24 {
                        if s.lock_hours & (1 << hr) != 0 {
                            lock_hours[hr] += 1;
                        }
                    }
                }
                None => {
                    days.push(0);
                    locked.push(false);
                    held.push(0.0);
                }
            }
        }
        TrunkTrend {
            a: h.a.clone(),
            b: h.b.clone(),
            uses: h.uses,
            streak: Self::streak(h, today),
            locked_days: locked.iter().filter(|l| **l).count() as u32,
            locked_today: h.days.get(&today).map_or(false, |s| s.locked),
            days,
            locked,
            held,
            hours: h.hours,
            lock_hours,
            longest: h.longest,
            last_used: h.last_used.clone(),
        }
    }

    pub fn uses_of(&self, a: &str, b: &str) -> u64 {
        self.trunks.get(&key(a, b)).map_or(0, |h| h.uses)
    }

    pub fn streak_of(&self, a: &str, b: &str, today: i64) -> u32 {
        self.trunks.get(&key(a, b)).map_or(0, |h| Self::streak(h, today))
    }

    /// Every trunk's trend, the habits first: longest streak, then most used.
    pub fn summary(&self, today: i64) -> Vec<TrunkTrend> {
        let mut v: Vec<TrunkTrend> = self.trunks.values().map(|h| Self::trend_of(h, today)).collect();
        v.sort_by(|x, y| y.streak.cmp(&x.streak).then(y.locked_days.cmp(&x.locked_days)).then(y.uses.cmp(&x.uses)).then(x.a.cmp(&y.a)));
        v.truncate(SUMMARY_CAP);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trunk_caster_sdk::{Hop, RouteKind};

    fn conn(hops: &[(&str, &str)]) -> Connection {
        Connection {
            id: "c1".into(),
            who: "anna".into(),
            from_frame: hops[0].0.into(),
            from_port: 1,
            to_frame: hops[hops.len() - 1].1.into(),
            to_port: 2,
            kind: if hops.len() == 1 { RouteKind::Direct } else { RouteKind::Via },
            hops: hops.iter().enumerate().map(|(i, (f, t))| Hop { trunk: format!("T{i}"), from: f.to_string(), to: t.to_string() }).collect(),
            granted_at: String::new(),
            granted_unix: 0,
            granted_sim: 0.0,
            why: None,
            where_: None,
            origin: "test".into(),
            expires_at_sim: None,
            gpio_sent: 0,
            hop_gains_db: vec![0.0; hops.len()],
            muted: false,
            muted_at_sim: None,
            reconnects: 0,
            last_used_sim: 0.0,
            latched: false,
            listen: false,
        }
    }

    #[test]
    fn counts_uses_per_hop_and_keys_pairs_both_ways() {
        let mut t = Trends::default();
        t.used(&conn(&[("a", "b"), ("b", "c")]), 10, 9, "now", 0.0);
        t.used(&conn(&[("b", "a")]), 10, 9, "now", 0.0);
        assert_eq!(t.uses_of("a", "b"), 2);
        assert_eq!(t.uses_of("c", "b"), 1);
        assert_eq!(t.trunks["a|b"].hours[9], 2);
        assert_eq!(t.trunks["a|b"].days[&10].uses, 2);
    }

    #[test]
    fn a_long_hold_locks_the_day_and_streaks_run_day_by_day() {
        let mut t = Trends::default();
        let c = conn(&[("a", "b")]);
        t.used(&c, 1, 14, "now", 0.0);
        t.released(&c, 1, "now", 2.0 * 3600.0);
        t.used(&c, 2, 14, "now", 0.0);
        t.released(&c, 2, "now", 90.0 * 60.0);
        t.used(&c, 3, 14, "now", 0.0);
        t.released(&c, 3, "now", 600.0); // short: day 3 not locked
        let h = &t.trunks["a|b"];
        assert!(h.days[&1].locked && h.days[&2].locked && !h.days[&3].locked);
        assert_eq!(Trends::streak(h, 2), 2);
        // Day 3 not locked yet: the streak still counts yesterday's run.
        assert_eq!(Trends::streak(h, 3), 2);
        assert_eq!(Trends::streak(h, 4), 0);
        // A call held for an hour and still up locks today, in this hour.
        t.observe(&[c.clone()], 3600.0, 3, 15, "now");
        let h = &t.trunks["a|b"];
        assert!(h.days[&3].locked);
        assert_eq!(h.days[&3].lock_hours, 1 << 15);
        assert_eq!(Trends::streak(h, 3), 3);
        let tr = Trends::trend_of(h, 3);
        assert_eq!(tr.streak, 3);
        assert_eq!(tr.locked_days, 3);
        assert_eq!(tr.lock_hours[15], 1);
        assert_eq!(tr.days.len(), DAYS_SHOWN);
        assert_eq!(tr.days[DAYS_SHOWN - 1], 1);
    }

    #[test]
    fn parked_time_and_tick_slack_do_not_lock() {
        let mut t = Trends::default();
        let mut c = conn(&[("a", "b")]);
        // Held two minutes, then parked; released five hours later.
        c.expires_at_sim = Some(120.0);
        c.muted = true;
        c.muted_at_sim = Some(120.0);
        t.used(&c, 0, 0, "now", 0.0);
        t.released(&c, 0, "now", 5.0 * 3600.0);
        assert!(!t.trunks["a|b"].days[&0].locked);
        assert_eq!(t.trunks["a|b"].longest, 120.0);
        // A latched line is in use the whole time.
        let mut l = conn(&[("c", "d")]);
        l.latched = true;
        l.expires_at_sim = Some(60.0);
        t.observe(&[l], 2.0 * 3600.0, 0, 2, "now");
        assert!(t.trunks["c|d"].days[&0].locked);
    }

    #[test]
    fn history_is_pruned_to_the_days_kept() {
        let mut t = Trends::default();
        let c = conn(&[("a", "b")]);
        for d in 0..(DAYS_KEPT as i64 + 10) {
            t.used(&c, d, 0, "now", 0.0);
        }
        assert_eq!(t.trunks["a|b"].days.len(), DAYS_KEPT);
        assert_eq!(t.trunks["a|b"].uses, DAYS_KEPT as u64 + 10);
    }
}
