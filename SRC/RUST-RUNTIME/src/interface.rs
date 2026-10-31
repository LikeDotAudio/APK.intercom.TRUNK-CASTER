//! TRUNK-CASTER-INTERFACE: seekers drop `<id>.json`, the runtime answers
//! with `<id>.reply.json`. Removing the request releases the connection.
//! The same shape applies to panel seeks in `TRUNK-CROSS POINTS/seeks`.

use crate::util;
use serde::de::DeserializeOwned;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub struct Pending<T> {
    /// Id taken from the file name (`<id>.json`).
    pub id: String,
    #[allow(dead_code)]
    pub path: PathBuf,
    pub body: T,
}

/// Every `<id>.json` in `dir` that is not a reply/offer and parses as `T`.
/// Files that fail to parse are reported so a bad request is visible.
pub fn scan<T: DeserializeOwned>(dir: &Path, answer_suffix: &str) -> io::Result<(Vec<Pending<T>>, Vec<(PathBuf, String)>)> {
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    if !dir.is_dir() {
        return Ok((ok, bad));
    }
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    paths.sort();
    for p in paths {
        let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if !name.ends_with(".json") || name.ends_with(answer_suffix) || name.ends_with(".tmp") {
            continue;
        }
        let id = name.trim_end_matches(".json").to_string();
        match util::read_json::<T>(&p) {
            Ok(body) => ok.push(Pending { id, path: p, body }),
            Err(e) => bad.push((p, e.to_string())),
        }
    }
    Ok((ok, bad))
}

pub fn answer_path(dir: &Path, id: &str, answer_suffix: &str) -> PathBuf {
    dir.join(format!("{id}{answer_suffix}"))
}

pub fn remove_answer(dir: &Path, id: &str, answer_suffix: &str) {
    let _ = fs::remove_file(answer_path(dir, id, answer_suffix));
}

pub const REPLY_SUFFIX: &str = ".reply.json";
pub const OFFER_SUFFIX: &str = ".offer.json";
