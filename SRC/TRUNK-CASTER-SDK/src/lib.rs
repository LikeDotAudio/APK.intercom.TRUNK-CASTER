//! # Trunk-Caster SDK
//!
//! Everything in Trunk-Caster connects through this crate. It owns:
//!
//! * the **message types** every folder exchanges as JSON ([`types`]),
//! * the **folder contract**: which folder holds what ([`folders`]),
//! * **clients** for talking to a running runtime, by dropping files or
//!   over its local HTTP port ([`client`]).
//!
//! The runtime (`RUST-RUNTIME`) depends on this crate; so should any
//! panel, frame, simulator or tool that wants a trunk. Nothing here knows
//! about a brand: a trunk is identified by protocol and frame, never by
//! vendor.

pub mod client;
pub mod folders;
pub mod labels;
pub mod mqtt;
pub mod sites;
pub mod types;
pub mod voice;
pub mod wardbeck;

pub use labels::Label;
pub use sites::{continent_of, ocean_between, Site, Sites, Tier};
pub use types::*;
pub use wardbeck::{Line as WbLine, Switch};

/// Wire-format version. Bump when a JSON shape changes incompatibly.
pub const WIRE_VERSION: u32 = 1;
