//! TRUNK-RELAY: the relay hosted on this computer. Its matrices are real
//! frames of protocol `relay`, so the caster can route anything to and
//! from the local audio ports. `relay.json` says what the relay offers,
//! `state.json` says how it is patched right now.

use crate::crosspoints::user_port;
use crate::runtime::Runtime;
use crate::util;
use std::io;
use trunk_caster_sdk::folders::Layout;
use trunk_caster_sdk::*;

pub const PROTOCOL: &str = "relay";

/// Read the relay config, creating the default if it is missing.
pub fn load_config(layout: &Layout) -> io::Result<RelayConfig> {
    let path = layout.relay_config();
    match util::read_json::<RelayConfig>(&path) {
        Ok(c) => Ok(c),
        Err(_) => {
            let c = RelayConfig::default();
            util::write_json(&path, &c)?;
            Ok(c)
        }
    }
}

pub fn save_config(layout: &Layout, cfg: &RelayConfig) -> io::Result<()> {
    util::write_json(&layout.relay_config(), cfg)
}

/// The relay's matrices as frames.
pub fn frames(cfg: &RelayConfig, shape: &Shape, endpoint: &str) -> Vec<Frame> {
    cfg.matrices
        .iter()
        .map(|m| Frame {
            wire_version: WIRE_VERSION,
            id: m.id.clone(),
            protocol: PROTOCOL.into(),
            protocol_name: cfg.protocol_name.clone(),
            family: Family::Other,
            site: String::new(),
            country: None,
            continent: None,
            lat: None,
            lon: None,
            implemented_by: vec![cfg.host.clone()],
            badge: Some(vendor_badge("relay")),
            user_ports: m.io,
            casters: m.casters,
            channels_per_trunk: shape.channels_per_trunk,
            caster_status: Vec::new(),
            free_casters: m.casters,
            port_names: Default::default(),
            port_labels: Default::default(),
            live_ports: Default::default(),
            last_connection: None,
            seconds_since_last_connection: None,
            advertised_at: String::new(),
            endpoint: Some(endpoint.into()),
        })
        .collect()
}

/// Snapshot of how the relay is patched.
pub fn snapshot(rt: &Runtime) -> RelaySnapshot {
    let now = util::now_unix();
    let st = &rt.state;
    let matrices = rt
        .relay
        .matrices
        .iter()
        .map(|m| {
            let ports = (0..m.io)
                .map(|i| {
                    let label = user_port(i);
                    let conn = st.connections.iter().find(|c| {
                        (c.from_frame == m.id && c.from_port == i) || (c.to_frame == m.id && c.to_port == i)
                    });
                    let connected_to = conn.map(|c| {
                        if c.from_frame == m.id && c.from_port == i {
                            format!("{}:{}", c.to_frame, user_port(c.to_port))
                        } else {
                            format!("{}:{}", c.from_frame, user_port(c.from_port))
                        }
                    });
                    RelayPort {
                        port: label.clone(),
                        name: st.port_name(&m.id, i).map(String::from).or_else(|| m.port_names.get(&label).cloned()),
                        live_who: conn.map(|c| c.who.clone()),
                        connected_to,
                        connection: conn.map(|c| c.id.clone()),
                        connected_seconds: conn.map(|c| c.connected_for(now)),
                        binding: m.bindings.get(&label).cloned(),
                    }
                })
                .collect();
            let mut crosspoints: Vec<Crosspoint> = rt.crosspoints.current.iter().filter(|c| c.frame == m.id).cloned().collect();
            crosspoints.sort_by(|a, b| (&a.input, &a.output).cmp(&(&b.input, &b.output)));
            RelayMatrixState {
                id: m.id.clone(),
                label: m.label.clone(),
                io: m.io,
                casters: m.casters,
                ports,
                caster_status: st.caster_ads(&m.id),
                crosspoints,
            }
        })
        .collect();
    RelaySnapshot { wire_version: WIRE_VERSION, host: rt.relay.host.clone(), updated_at: util::iso(now), matrices }
}
