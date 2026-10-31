//! Fleet construction.
//!
//! With sites: every site hosts frames by tier (capital 10, province 1,
//! smaller city an 8x8 plus a 2x2). Frame k at a site takes protocol
//! `protocols[(site_index + k) % P]`, so a capital's ten frames cover ten
//! protocols and the provinces rotate through them. Frame ids are
//! `<site-slug>-<nn>` and each frame carries its site, country and
//! coordinates, so the globe can place it and Ward-Beck lines carry the
//! SITE.
//!
//! Without sites (an empty `sites.json`): `frames_per_protocol` identical
//! frames per protocol, ids `<protocol>-<nn>`, all at the caster's site.

use crate::discover::Repertoire;
use trunk_caster_sdk::{vendor_badge, Badge, Frame, Protocol, Shape, Sites, WIRE_VERSION};

pub fn frame_id(prefix: &str, index: usize) -> String {
    format!("{prefix}-{index:02}")
}

pub fn new_frame(protocol: &Protocol, id: String, user_ports: usize, casters: usize, shape: &Shape, endpoint: Option<&str>) -> Frame {
    Frame {
        wire_version: WIRE_VERSION,
        id,
        protocol: protocol.id.clone(),
        protocol_name: protocol.name.clone(),
        family: protocol.family,
        site: String::new(),
        country: None,
        continent: None,
        lat: None,
        lon: None,
        implemented_by: protocol.vendors().into_iter().map(String::from).collect(),
        badge: None,
        user_ports,
        casters,
        channels_per_trunk: shape.channels_per_trunk,
        caster_status: Vec::new(),
        free_casters: casters,
        port_names: Default::default(),
        port_labels: Default::default(),
        live_ports: Default::default(),
        last_connection: None,
        seconds_since_last_connection: None,
        advertised_at: String::new(),
        endpoint: endpoint.map(String::from),
    }
}

/// The vendor whose iron the n-th frame of a protocol is: round-robin over
/// the vendors that implement it.
fn badge_for(protocol: &Protocol, n: usize) -> Option<Badge> {
    let vendors = protocol.vendors();
    if vendors.is_empty() {
        return None;
    }
    Some(vendor_badge(vendors[n % vendors.len()]))
}

/// Build the fleet.
pub fn fleet(rep: &Repertoire, shape: &Shape, endpoint: Option<&str>, sites: &Sites, home_site: &str) -> Vec<Frame> {
    if rep.protocols.is_empty() {
        return Vec::new();
    }
    if sites.sites.is_empty() {
        return rep
            .protocols
            .iter()
            .flat_map(|p| {
                (1..=shape.frames_per_protocol).map(move |i| {
                    let mut f = new_frame(p, frame_id(&p.id, i), shape.user_ports, shape.casters_per_frame, shape, endpoint);
                    f.site = home_site.to_string();
                    f.badge = badge_for(p, i);
                    f
                })
            })
            .collect();
    }

    let protos = &rep.protocols;
    let mut per_protocol_count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    let mut out = Vec::new();
    for (si, site) in sites.sites.iter().enumerate() {
        let n = if site.frames == 0 { site.tier.default_frames() } else { site.frames };
        for k in 0..n {
            let p = &protos[(si + k) % protos.len()];
            let (up, cs) = site.tier.frame_shape(k).unwrap_or((shape.user_ports, shape.casters_per_frame));
            let mut f = new_frame(p, frame_id(&site.slug, k + 1), up, cs, shape, endpoint);
            let count = per_protocol_count.entry(p.id.as_str()).or_default();
            f.badge = badge_for(p, *count);
            *count += 1;
            f.site = site.name.clone();
            f.country = Some(site.country.clone());
            f.continent = Some(if site.continent.is_empty() { trunk_caster_sdk::continent_of(&site.country).to_string() } else { site.continent.clone() });
            f.lat = Some(site.lat);
            f.lon = Some(site.lon);
            out.push(f);
        }
    }
    out
}
