//! Protocol identity and manual reading.
//!
//! The runtime speaks by protocol, not by brand: a protocol is the thing
//! that gets advertised and trunked, and a vendor is just one
//! implementation of it found in the repertoire.

use trunk_caster_sdk::{Family, ManualDigest};

/// Canonical identity derived from a protocol folder name.
#[derive(Debug, Clone)]
pub struct Canonical {
    pub id: String,
    pub name: String,
    pub family: Family,
}

impl Canonical {
    fn new(id: &str, name: &str, family: Family) -> Self {
        Canonical { id: id.to_string(), name: name.to_string(), family }
    }
}

/// Map a folder name under `<Vendor>/` to a canonical protocol plus an
/// optional vendor flavour. Returns `None` for folders that are not
/// protocols (e.g. the per-vendor TRUNK-* interface docs).
pub fn canonicalize(folder: &str) -> Option<(Canonical, Option<String>)> {
    let trimmed = folder.trim();
    let lower = trimmed.to_ascii_lowercase();

    if lower.starts_with("trunk-") {
        return None;
    }

    // Flavoured 2-Wire variants: "2-Wire-Encore", "2-Wire-TW", "2-Wire-Performer".
    if let Some(rest) = lower.strip_prefix("2-wire") {
        let flavor_len = rest.trim_start_matches('-').len();
        let flavor = if flavor_len == 0 {
            None
        } else {
            Some(trimmed[trimmed.len() - flavor_len..].to_string())
        };
        return Some((Canonical::new("2-wire", "2-Wire", Family::AnalogAudio), flavor));
    }

    use Family::*;
    let c = match lower.as_str() {
        "4-wire" => Canonical::new("4-wire", "4-Wire", AnalogAudio),
        "dante" => Canonical::new("dante", "Dante", AudioOverIp),
        "aes67" => Canonical::new("aes67", "AES67", AudioOverIp),
        "livewire" => Canonical::new("livewire", "Livewire", AudioOverIp),
        "omneo" => Canonical::new("omneo", "OMNEO", AudioOverIp),
        "rvon" => Canonical::new("rvon", "RVON", AudioOverIp),
        "ivc-32-ip" => Canonical::new("ivc-32", "IVC-32 IP", AudioOverIp),
        "sip" => Canonical::new("sip", "SIP", Telephony),
        "gpio" => Canonical::new("gpio", "GPIO", Control),
        "snmp" => Canonical::new("snmp", "SNMP", Control),
        "freespeak-dect" => Canonical::new("freespeak-dect", "FreeSpeak DECT", Wireless),
        "bolero-dect" => Canonical::new("bolero-dect", "Bolero DECT", Wireless),
        "tetra" => Canonical::new("tetra", "TETRA", Wireless),
        "smpte-2110" => Canonical::new("smpte-2110", "SMPTE ST 2110", MediaTransport),
        "mediornet" => Canonical::new("mediornet", "MediorNet", MediaTransport),
        "helixnet" => Canonical::new("helixnet", "HelixNet", Other),
        "audiocom" => Canonical::new("audiocom", "Audiocom", Other),
        "omega clearcom" => Canonical::new("omega", "Omega", Other),
        "crosspoint-line" => Canonical::new("wardbeck-line", "Ward-Beck Line", Control),
        _ => unknown(trimmed),
    };
    Some((c, None))
}

/// True when the folder name maps to a protocol we know by name (not the
/// keep-unknown fallback).
pub fn is_known(folder: &str) -> bool {
    let lower = folder.trim().to_ascii_lowercase();
    if lower.starts_with("2-wire") {
        return true;
    }
    matches!(
        lower.as_str(),
        "4-wire" | "dante" | "aes67" | "livewire" | "omneo" | "rvon" | "ivc-32-ip" | "sip" | "gpio" | "snmp"
            | "freespeak-dect" | "bolero-dect" | "tetra" | "smpte-2110" | "mediornet" | "helixnet" | "audiocom"
            | "omega clearcom" | "crosspoint-line"
    )
}

/// Unknown folder: keep it as a protocol under a slugified id so nothing
/// in the repertoire is silently dropped.
fn unknown(folder: &str) -> Canonical {
    let slug: String = folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    Canonical { id: slug, name: folder.to_string(), family: Family::Other }
}

/// Read what a vendor manual says. Manuals are Markdown with a
/// `**Type:**` line and `##` sections such as "Trunking notes" and
/// "Talking to the panel".
pub fn digest_manual(text: &str) -> ManualDigest {
    let mut d = ManualDigest::default();
    let mut current: Option<String> = None;
    let mut body: Vec<String> = Vec::new();

    let flush = |d: &mut ManualDigest, heading: &Option<String>, body: &mut Vec<String>| {
        if let Some(h) = heading {
            let text = body.join("\n").trim().to_string();
            let key = h.to_ascii_lowercase();
            if key.contains("trunking") {
                d.trunking_notes = Some(text);
            } else if key.contains("panel") {
                d.panel_notes = Some(text);
            }
        }
        body.clear();
    };

    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("**Type:**") {
            d.kind = Some(rest.trim().to_string());
            continue;
        }
        if let Some(h) = t.strip_prefix("## ") {
            flush(&mut d, &current, &mut body);
            current = Some(h.trim().to_string());
            d.sections.push(h.trim().to_string());
            continue;
        }
        if t.starts_with("# ") {
            continue;
        }
        if current.is_some() {
            body.push(t.to_string());
        }
    }
    flush(&mut d, &current, &mut body);
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_wire_flavours_collapse_to_one_protocol() {
        for (folder, flavor) in [
            ("2-Wire", None),
            ("2-Wire-Encore", Some("Encore")),
            ("2-Wire-TW", Some("TW")),
            ("2-Wire-Performer", Some("Performer")),
        ] {
            let (c, f) = canonicalize(folder).unwrap();
            assert_eq!(c.id, "2-wire");
            assert_eq!(f.as_deref(), flavor);
        }
    }

    #[test]
    fn trunk_folders_are_not_protocols() {
        assert!(canonicalize("TRUNK-USERS").is_none());
        assert!(canonicalize("TRUNK-CASTER-INTERFACE").is_none());
    }

    #[test]
    fn unknown_folders_are_kept() {
        let (c, _) = canonicalize("Some New Thing").unwrap();
        assert_eq!(c.id, "some-new-thing");
        assert_eq!(c.family, Family::Other);
    }

    #[test]
    fn digest_reads_type_and_sections() {
        let md = "# V - Dante\n\n**Type:** IP audio.\n\n## Talking to the panel\n- keyed\n\n## Trunking notes\nEasy trunk.\n";
        let d = digest_manual(md);
        assert_eq!(d.kind.as_deref(), Some("IP audio."));
        assert_eq!(d.trunking_notes.as_deref(), Some("Easy trunk."));
        assert_eq!(d.panel_notes.as_deref(), Some("- keyed"));
        assert_eq!(d.sections, vec!["Talking to the panel", "Trunking notes"]);
    }
}
