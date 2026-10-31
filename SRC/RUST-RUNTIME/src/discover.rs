//! Discovery of the known-protocol repertoire from the on-disk tree.
//!
//! `KNOWN PROTOCOLS/` may hold three kinds of folder, and they can be mixed:
//!
//! ```text
//! KNOWN PROTOCOLS/<Vendor>/<Protocol>/<manuals...>     a vendor and what it implements
//! KNOWN PROTOCOLS/<Protocol>/<manuals...>              the protocol itself, brand-neutral
//! KNOWN PROTOCOLS/<Group>/<Vendor>/<Protocol>/...      a grouping folder (e.g. "VENDOR")
//! <root>/<Vendor>/<Protocol>/<manuals...>              vendor folders beside KNOWN PROTOCOLS
//! ```
//!
//! Vendors are merged away: the result is one entry per protocol listing
//! every vendor that implements it plus the protocol's own documents.
//! Folders starting with `.` or `_` (tooling, caches) are ignored.

use crate::protocol::{canonicalize, digest_manual, is_known};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use trunk_caster_sdk::folders::{self, Layout};
use trunk_caster_sdk::{Implementation, ManualDigest, Protocol};
use walkdir::WalkDir;

/// The discovered repertoire.
#[derive(Debug, Clone, Serialize)]
pub struct Repertoire {
    pub root: PathBuf,
    /// Every vendor folder seen, including those with no protocol folders yet.
    pub vendors: Vec<String>,
    /// Protocols sorted by id.
    pub protocols: Vec<Protocol>,
    /// Per-vendor trunk interface documents (TRUNK-* folders under a vendor).
    pub vendor_trunk_docs: BTreeMap<String, Vec<PathBuf>>,
    pub documents: usize,
}

enum Entry {
    Vendor(PathBuf),
    ProtocolDocs(PathBuf),
    Group(PathBuf),
}

/// What a folder under KNOWN PROTOCOLS is.
fn classify(dir: &Path) -> Entry {
    let subs = sorted_dirs(dir).unwrap_or_default();
    let has_known_protocol_sub = subs.iter().any(|s| is_known(&file_name(s)));
    if has_known_protocol_sub {
        return Entry::Vendor(dir.to_path_buf());
    }
    if subs.iter().any(looks_like_vendor) {
        return Entry::Group(dir.to_path_buf());
    }
    // No vendor structure below: this folder is about one protocol.
    Entry::ProtocolDocs(dir.to_path_buf())
}

pub fn discover(layout: &Layout) -> io::Result<Repertoire> {
    let mut vendor_dirs: Vec<PathBuf> = Vec::new();
    let mut protocol_doc_dirs: Vec<PathBuf> = Vec::new();

    let known = layout.known_protocols();
    if known.is_dir() {
        for d in sorted_dirs(&known)? {
            if is_noise(&file_name(&d)) {
                continue;
            }
            match classify(&d) {
                Entry::Vendor(v) => vendor_dirs.push(v),
                Entry::ProtocolDocs(p) => protocol_doc_dirs.push(p),
                Entry::Group(g) => {
                    for v in sorted_dirs(&g)? {
                        if is_noise(&file_name(&v)) {
                            continue;
                        }
                        match classify(&v) {
                            Entry::Vendor(v) => vendor_dirs.push(v),
                            Entry::ProtocolDocs(p) => protocol_doc_dirs.push(p),
                            Entry::Group(_) => {}
                        }
                    }
                }
            }
        }
    }
    for d in sorted_dirs(&layout.root)? {
        let name = file_name(&d);
        if !folders::is_reserved(&name) && !is_noise(&name) && looks_like_vendor(&d) {
            vendor_dirs.push(d);
        }
    }

    let mut vendors: Vec<String> = Vec::new();
    let mut by_id: BTreeMap<String, Protocol> = BTreeMap::new();
    let mut vendor_trunk_docs: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let mut documents = 0;

    let entry_for = |by_id: &mut BTreeMap<String, Protocol>, canon: &crate::protocol::Canonical| -> *mut Protocol {
        by_id.entry(canon.id.clone()).or_insert_with(|| Protocol {
            id: canon.id.clone(),
            name: canon.name.clone(),
            family: canon.family,
            implementations: Vec::new(),
            documents: Vec::new(),
            digest: ManualDigest::default(),
        })
    };

    // Brand-neutral protocol folders.
    for dir in protocol_doc_dirs {
        let folder = file_name(&dir);
        let Some((canon, _flavor)) = canonicalize(&folder) else { continue };
        let docs = collect_documents(&dir);
        if docs.is_empty() {
            continue;
        }
        documents += docs.len();
        let digest = digest_all(&dir, &docs);
        let p = entry_for(&mut by_id, &canon);
        // SAFETY: the pointer comes from the map we hold exclusively here and
        // is used before any other mutation of the map.
        let p = unsafe { &mut *p };
        p.documents.extend(docs);
        merge_digest(&mut p.digest, digest);
    }

    // Vendors and what they implement.
    for vendor_dir in vendor_dirs {
        let vendor = file_name(&vendor_dir);
        if !vendors.contains(&vendor) {
            vendors.push(vendor.clone());
        }
        for proto_dir in sorted_dirs(&vendor_dir)? {
            let folder = file_name(&proto_dir);
            if is_noise(&folder) {
                continue;
            }
            let docs = collect_documents(&proto_dir);
            documents += docs.len();
            match canonicalize(&folder) {
                None => {
                    let rel = PathBuf::from(&folder);
                    vendor_trunk_docs.entry(vendor.clone()).or_default().extend(docs.into_iter().map(|d| rel.join(d)));
                }
                Some((canon, flavor)) => {
                    let digest = digest_all(&proto_dir, &docs);
                    let p = entry_for(&mut by_id, &canon);
                    let p = unsafe { &mut *p };
                    if let Some(existing) = p.implementations.iter_mut().find(|i| i.vendor == vendor) {
                        existing.documents.extend(docs);
                        merge_digest(&mut existing.digest, digest);
                    } else {
                        p.implementations.push(Implementation { vendor: vendor.clone(), flavor, documents: docs, source: proto_dir.clone(), digest });
                    }
                }
            }
        }
    }

    Ok(Repertoire { root: layout.root.clone(), vendors, protocols: by_id.into_values().collect(), vendor_trunk_docs, documents })
}

/// Tooling and hidden folders are never protocols or vendors.
fn is_noise(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('_') || name.eq_ignore_ascii_case("target") || name.eq_ignore_ascii_case("node_modules")
}

/// A folder is a vendor if at least one sub-folder is a *known* protocol,
/// so a stray folder of scripts never becomes a vendor by accident.
fn looks_like_vendor(dir: &PathBuf) -> bool {
    sorted_dirs(dir).map(|subs| subs.iter().any(|s| is_known(&file_name(s)))).unwrap_or(false)
}

fn merge_digest(into: &mut ManualDigest, from: ManualDigest) {
    if into.kind.is_none() {
        into.kind = from.kind;
    }
    if into.trunking_notes.is_none() {
        into.trunking_notes = from.trunking_notes;
    }
    if into.panel_notes.is_none() {
        into.panel_notes = from.panel_notes;
    }
    for s in from.sections {
        if !into.sections.contains(&s) {
            into.sections.push(s);
        }
    }
}

fn digest_all(dir: &Path, docs: &[PathBuf]) -> ManualDigest {
    let mut merged = ManualDigest::default();
    for d in docs {
        let p = dir.join(d);
        let is_text = p
            .extension()
            .map_or(false, |e| matches!(e.to_string_lossy().to_ascii_lowercase().as_str(), "md" | "txt" | "markdown"));
        if !is_text {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&p) {
            merge_digest(&mut merged, digest_manual(&text));
        }
    }
    merged
}

fn sorted_dirs(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)?.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    Ok(dirs)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Every regular file under `dir`, relative to it, sorted. Noise folders
/// (caches) are skipped.
fn collect_documents(dir: &Path) -> Vec<PathBuf> {
    let mut docs: Vec<PathBuf> = WalkDir::new(dir)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !is_noise(&e.file_name().to_string_lossy()))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.path().strip_prefix(dir).ok().map(Path::to_path_buf))
        .collect();
    docs.sort();
    docs
}
