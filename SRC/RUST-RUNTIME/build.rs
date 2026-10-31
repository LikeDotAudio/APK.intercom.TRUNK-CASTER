//! Stamps every build with an id (version + build time) so open pages can
//! tell when a new version is serving: they flush their cache and reload.

use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("cargo:rustc-env=TC_BUILD={}+{secs}", std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=../TRUNK-CASTER-SDK/src");
}
