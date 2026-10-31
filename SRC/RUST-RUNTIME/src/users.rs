//! TRUNK-USERS: one JSON per request ever made (who, whom, when, why,
//! where, how) plus an HTML log.

use crate::util;
use std::fs;
use std::io;
use std::path::Path;
use trunk_caster_sdk::{Connection, How, ReplyStatus, Request, UserRecord, WIRE_VERSION};

pub fn record_path(dir: &Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.json"))
}

pub fn from_request(id: &str, req: &Request, origin: &str, outcome: &Result<Connection, String>) -> UserRecord {
    let whom = match outcome {
        Ok(c) => format!("{}:{}", c.to_frame, crate::crosspoints::user_port(c.to_port)),
        Err(_) => req.to.clone(),
    };
    let from = match outcome {
        Ok(c) => format!("{}:{}", c.from_frame, crate::crosspoints::user_port(c.from_port)),
        Err(_) => req.from.clone(),
    };
    UserRecord {
        wire_version: WIRE_VERSION,
        id: id.to_string(),
        who: req.who.clone(),
        whom,
        from,
        when: util::now_iso(),
        why: req.why.clone(),
        where_: req.where_.clone(),
        how: outcome.as_ref().ok().map(|c| How {
            kind: c.kind,
            hops: c.hops.clone(),
            via: c.via_frames().into_iter().map(String::from).collect(),
        }),
        status: if outcome.is_ok() { ReplyStatus::Granted } else { ReplyStatus::Denied },
        reason: outcome.as_ref().err().cloned(),
        origin: origin.to_string(),
        released_at: None,
        connected_seconds: None,
        connected_sim_seconds: None,
        gpio_sent: 0,
    }
}

/// Fill in the release fields on a record, in memory.
pub fn apply_release(rec: &mut UserRecord, conn: &Connection, sim_now: f64) {
    let now = util::now_unix();
    rec.status = ReplyStatus::Released;
    rec.released_at = Some(util::iso(now));
    rec.connected_seconds = Some(conn.connected_for(now));
    rec.connected_sim_seconds = Some(conn.connected_for_sim(sim_now));
    rec.gpio_sent = conn.gpio_sent;
}

pub fn mark_released(dir: &Path, conn: &Connection, sim_now: f64) -> io::Result<()> {
    let p = record_path(dir, &conn.id);
    if let Ok(mut rec) = util::read_json::<UserRecord>(&p) {
        apply_release(&mut rec, conn, sim_now);
        util::write_json(&p, &rec)?;
    }
    Ok(())
}

/// The newest `n` records, newest first. Only file *names* are listed (no
/// per-file stat, which is a round trip each over a Docker or OneDrive
/// mount) and only those `n` files are read, so a folder with tens of
/// thousands of records does not stall boot. Record ids carry a unix
/// time (`req-<unix>-…`, `sim-<boot>-…`), so a name sort is a time sort.
pub fn recent(dir: &Path, n: usize) -> Vec<UserRecord> {
    let mut names: Vec<String> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|f| f.ends_with(".json"))
            .collect(),
        Err(_) => Vec::new(),
    };
    // Newest first: sort by the numeric time embedded in the name, then name.
    let stamp = |s: &str| s.split('-').nth(1).and_then(|t| t.parse::<u64>().ok()).unwrap_or(0);
    names.sort_by(|a, b| stamp(b).cmp(&stamp(a)).then(b.cmp(a)));
    let mut out: Vec<UserRecord> = names.into_iter().take(n).filter_map(|f| util::read_json::<UserRecord>(&dir.join(f)).ok()).collect();
    out.sort_by(|a, b| b.when.cmp(&a.when).then(b.id.cmp(&a.id)));
    out
}

/// Ids of simulator records on disk (file names starting `sim-`), oldest
/// first by name. No file is read.
pub fn sim_ids_on_disk(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| n.starts_with("sim-") && n.ends_with(".json"))
            .map(|n| n.trim_end_matches(".json").to_string())
            .collect(),
        Err(_) => Vec::new(),
    };
    ids.sort();
    ids
}

/// All records, newest first.
#[allow(dead_code)]
pub fn load_all(dir: &Path) -> Vec<UserRecord> {
    let mut out: Vec<UserRecord> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |x| x == "json"))
            .filter_map(|p| util::read_json::<UserRecord>(&p).ok())
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| b.when.cmp(&a.when).then(b.id.cmp(&a.id)));
    out
}

#[allow(dead_code)]
pub fn remove(dir: &Path, id: &str) -> bool {
    fs::remove_file(record_path(dir, id)).is_ok()
}
