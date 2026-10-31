//! TAPS and Mixes, voices and bandwidth through the SDK's HTTP client.
//!
//! ```text
//! cargo run --example taps_and_voices -- 127.0.0.1:8080
//! ```
//!
//! Reads the mixer, trims one crosspoint by -6 dB and puts it back, reads a
//! frame's voice and saves its WAV, and prints the bandwidth simulation.

use trunk_caster_sdk::client::HttpClient;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:8080".into());
    let hc = HttpClient::new(addr);

    let taps = hc.taps()?;
    println!("TAPS and Mixes: {} frames, {} crosspoints, {} off unity", taps.frames, taps.crosspoints, taps.trimmed);
    let Some((strip, fader)) = taps.strips.iter().find_map(|s| s.faders.first().map(|f| (s, f))) else {
        println!("no crosspoint closed right now");
        return Ok(());
    };
    println!("  {} ({}, {}) speaks in {} at {:.0} kbit/s", strip.frame, strip.site, strip.protocol, strip.accent, strip.kbps);

    let ev = hc.set_crosspoint_gain(&strip.frame, &fader.input, &fader.output, -6.0)?;
    println!("  {} {} -> {}: {:+.1} dB (was {:+.1})", strip.frame, fader.input, fader.output, ev.set.db, ev.was_db);
    let back = hc.tap_strip(&strip.frame)?;
    let now = back.faders.iter().find(|f| f.input == fader.input && f.output == fader.output).map(|f| f.db);
    println!("  read back: {now:?} dB");
    let unity = hc.taps_unity(Some(&strip.frame))?;
    println!("  unity: {} crosspoint(s) reset", unity.reset);

    let v = hc.voice(&strip.frame)?;
    println!("voice of {}: {}, {}, airport {}, accent {}, {:.0} kbit/s", v.frame, v.site, v.country, v.airport, v.accent, v.kbps);
    if let Some(a) = v.call.as_ref().or(v.ident.as_ref()) {
        println!("  says ({}, {} s, {} corrected, {} lost): {}", a.kind, a.seconds, a.corrected_from_5s, a.lost, a.text);
        let wav = hc.voice_wav(&v.frame, &a.kind)?;
        let path = std::env::temp_dir().join(format!("{}-{}.wav", v.frame, a.kind));
        std::fs::write(&path, &wav)?;
        println!("  saved {} bytes to {}", wav.len(), path.display());
    }

    let bw = hc.bandwidth()?;
    println!(
        "bandwidth: {:.1} Mbit/s on the wire from {} frames talking, {:.1} Mbit/s carried on trunks",
        bw.kbps / 1000.0,
        bw.talking,
        bw.carried_kbps / 1000.0
    );
    for t in bw.trunks.iter().take(3) {
        println!("  {} {} <-> {}: {} of {} calls, {:.0} kbit/s", t.trunk, t.a_frame, t.b_frame, t.calls, t.capacity, t.kbps);
    }
    let airports = hc.airports()?;
    println!("{} sites with airport codes, e.g. {:?}", airports.len(), airports.iter().take(3).map(|a| format!("{} {}", a.site, a.airport)).collect::<Vec<_>>());
    Ok(())
}
