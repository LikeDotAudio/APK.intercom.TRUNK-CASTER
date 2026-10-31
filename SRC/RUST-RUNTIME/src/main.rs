//! Trunk-Caster runtime.
//!
//! ```text
//! trunk-caster [options] <command>
//!
//! commands
//!   discover     read the manuals and print the protocol repertoire
//!   advertise    write one advertisement per frame and render the pages, then exit
//!   serve        run: serve requests, simulate, cross-check, graph (default)
//!   status       print a status summary and exit
//!
//! options
//!   --root <dir>        project root (default: walk up from cwd to find KNOWN PROTOCOLS)
//!   --port <n>          HTTP port (default 7878); --no-http disables the server
//!   --frames <n>        frames per protocol (default 10)
//!   --user-ports <n>    user ports per frame (default 56)
//!   --casters <n>       casters per frame (default 8)
//!   --channels <n>      channels per trunk (default 8)
//!   --once              serve: run a single tick and exit
//!   --ticks <n>         serve: run n ticks and exit
//!   --tick-ms <n>       tick period in ms (default 250)
//! ```

mod analyzer;
mod bookings;
mod crosspoints;
mod discover;
mod frame;
mod html;
mod http;
mod interface;
mod protocol;
mod recorder;
mod relay;
mod report;
mod routing;
mod runtime;
mod simulate;
mod snmp;
mod trends;
mod users;
mod util;
mod voices;
mod wb;
mod ws;

use runtime::Runtime;
use std::path::PathBuf;
use std::process;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use trunk_caster_sdk::folders::Layout;
use trunk_caster_sdk::Shape;

struct Opts {
    root: Option<PathBuf>,
    site: String,
    bind: String,
    public_url: Option<String>,
    port: u16,
    wb_port: u16,
    wb: bool,
    /// MQTT broker (host:port) carrying a second copy of every Ward-Beck line.
    mqtt: Option<String>,
    http: bool,
    shape: Shape,
    once: bool,
    ticks: Option<u64>,
    tick_ms: u64,
    days: u32,
    first_day: u32,
    every: f64,
    out: Option<PathBuf>,
    fader: Option<PathBuf>,
    command: String,
}

fn parse_args() -> Opts {
    // Environment variables give defaults so a container needs no flags:
    // TRUNK_ROOT, TRUNK_SITE, TRUNK_BIND, TRUNK_PORT, TRUNK_PUBLIC_URL.
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let mut o = Opts {
        root: env("TRUNK_ROOT").map(PathBuf::from),
        site: env("TRUNK_SITE").unwrap_or_else(|| "trunk-caster".into()),
        bind: env("TRUNK_BIND").unwrap_or_else(|| "127.0.0.1".into()),
        public_url: env("TRUNK_PUBLIC_URL"),
        port: env("TRUNK_PORT").and_then(|p| p.parse().ok()).unwrap_or(7878),
        wb_port: env("TRUNK_WB_PORT").and_then(|p| p.parse().ok()).unwrap_or(7879),
        wb: true,
        mqtt: env("TRUNK_MQTT"),
        http: true,
        shape: Shape::default(),
        once: false,
        ticks: None,
        tick_ms: 250,
        days: 365,
        first_day: 0,
        every: 1800.0,
        out: None,
        fader: None,
        command: "serve".into(),
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = |name: &str| -> String {
            args.next().unwrap_or_else(|| {
                eprintln!("{name} needs a value");
                process::exit(2)
            })
        };
        match a.as_str() {
            "--root" => o.root = Some(PathBuf::from(val("--root"))),
            "--site" => o.site = val("--site"),
            "--bind" => o.bind = val("--bind"),
            "--wb-port" => o.wb_port = val("--wb-port").parse().unwrap_or(7879),
            "--no-wb" => o.wb = false,
            "--mqtt" => o.mqtt = Some(val("--mqtt")).filter(|v| !v.is_empty() && v != "off"),
            "--public-url" => o.public_url = Some(val("--public-url")),
            "--port" => o.port = val("--port").parse().unwrap_or(7878),
            "--no-http" => o.http = false,
            "--frames" => o.shape.frames_per_protocol = val("--frames").parse().unwrap_or(10),
            "--user-ports" => o.shape.user_ports = val("--user-ports").parse().unwrap_or(56),
            "--casters" => o.shape.casters_per_frame = val("--casters").parse().unwrap_or(8),
            "--channels" => o.shape.channels_per_trunk = val("--channels").parse().unwrap_or(8),
            "--once" => o.once = true,
            "--ticks" => o.ticks = val("--ticks").parse().ok(),
            "--tick-ms" => o.tick_ms = val("--tick-ms").parse().unwrap_or(250),
            "--days" => o.days = val("--days").parse().unwrap_or(365),
            "--first-day" => o.first_day = val("--first-day").parse().unwrap_or(0),
            "--every" => o.every = val("--every").parse::<f64>().unwrap_or(1800.0).max(1.0),
            "--out" => o.out = Some(PathBuf::from(val("--out"))),
            "--fader" => o.fader = Some(PathBuf::from(val("--fader"))),
            "-h" | "--help" => {
                println!("{}", HELP);
                process::exit(0);
            }
            c if !c.starts_with('-') => o.command = c.to_string(),
            other => {
                eprintln!("unknown option {other}");
                process::exit(2);
            }
        }
    }
    o
}

const HELP: &str = "trunk-caster [options] <discover|advertise|serve|status>
  --root <dir>  --site <name>  --bind <addr>  --port <n>  --public-url <url>  --no-http
  --wb-port <n>  --no-wb  (Ward-Beck TCP port for remote frames, default 7879)
  --mqtt <host:port>  (broker carrying a second copy of every line; remotes apply only what both paths agree on)
  --frames <n>  --user-ports <n>  --casters <n>  --channels <n>  --once  --ticks <n>  --tick-ms <n>
  simulate --days <n> --first-day <n> --every <sim s> --out <dir> --fader <file>  (headless year for the replay site; default 365 days, a frame every 1800 s, into TRUNK-GLOBAL/replay)
  compose  (print docker-compose services: one simulator container per protocol)
  env: TRUNK_ROOT TRUNK_SITE TRUNK_BIND TRUNK_PORT TRUNK_WB_PORT TRUNK_MQTT TRUNK_PUBLIC_URL TRUNK_VOICES_DIR";

fn main() {
    let opts = parse_args();
    let start = opts
        .root
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let Some(layout) = Layout::find(&start) else {
        eprintln!("no 'KNOWN PROTOCOLS' folder found at or above {}", start.display());
        process::exit(1);
    };
    // What the pages and advertisements print as the place to reach us.
    // Inside a container we bind 0.0.0.0 but are reached at the host's port.
    let endpoint = opts.public_url.clone().unwrap_or_else(|| {
        let host = if opts.bind == "0.0.0.0" || opts.bind == "::" { "localhost" } else { opts.bind.as_str() };
        format!("http://{host}:{}", opts.port)
    });

    match opts.command.as_str() {
        "discover" => {
            let rep = discover::discover(&layout).unwrap_or_else(die);
            println!("root: {}", rep.root.display());
            println!("vendors: {}", rep.vendors.join(", "));
            println!("manuals read: {}", rep.documents);
            println!();
            println!("{:<16} {:<16} {:<16} vendors", "protocol", "id", "family");
            for p in &rep.protocols {
                let vendors: Vec<String> = p
                    .implementations
                    .iter()
                    .map(|i| match &i.flavor {
                        Some(f) => format!("{} ({f})", i.vendor),
                        None => i.vendor.clone(),
                    })
                    .collect();
                println!("{:<16} {:<16} {:<16} {}", p.name, p.id, p.family.label(), vendors.join(", "));
            }
            println!();
            println!("{} protocols -> {} frames of {}+{} ports",
                rep.protocols.len(),
                rep.protocols.len() * opts.shape.frames_per_protocol,
                opts.shape.user_ports,
                opts.shape.casters_per_frame
            );
        }
        "advertise" => {
            let mut rt = Runtime::boot(layout, opts.shape, endpoint, opts.site.clone()).unwrap_or_else(die);
            rt.persist_all().unwrap_or_else(die);
            for p in Runtime::flush(rt.take_writes()) {
                let _ = std::fs::remove_file(p);
            }
            println!(
                "advertised {} frames for {} protocols into {}",
                rt.state.frames.len(),
                rt.repertoire.protocols.len(),
                rt.layout.advertisement().display()
            );
        }
        "status" => {
            let rt = Runtime::boot(layout, opts.shape, endpoint, opts.site.clone()).unwrap_or_else(die);
            println!("{}", serde_json::to_string_pretty(&rt.status()).unwrap_or_default());
        }
        "simulate" => {
            let out = opts.out.clone().unwrap_or_else(|| layout.global().join("replay"));
            let so = simulate::SimOpts { days: opts.days, first_day: opts.first_day, every: opts.every, tick_ms: opts.tick_ms, out, fader: opts.fader.clone() };
            simulate::run(&layout, opts.shape, endpoint, opts.site.clone(), &so).unwrap_or_else(die);
        }
        "compose" => {
            let rep = discover::discover(&layout).unwrap_or_else(die);
            print!("{}", compose_services(&rep, &opts));
        }
        "serve" => {
            let mut rt = Runtime::boot(layout, opts.shape, endpoint.clone(), opts.site.clone()).unwrap_or_else(die);
            if opts.wb {
                let addr = format!("{}:{}", opts.bind, opts.wb_port);
                match rt.listen_wb(&addr) {
                    Ok(()) => eprintln!("Ward-Beck port open on {addr}: remote frames connect here"),
                    Err(e) => eprintln!("Ward-Beck port not opened ({e})"),
                }
                if let Some(broker) = &opts.mqtt {
                    rt.hub.attach_mqtt(broker, &format!("caster-{}", opts.site));
                    crate::voices::Voices::listen(&rt.voices, broker, &format!("caster-voice-{}", opts.site));
                    eprintln!("MQTT in parallel via {broker}: remotes double validate every line");
                }
            }
            let shared = Arc::new(Mutex::new(rt));
            if opts.http {
                let addr = format!("{}:{}", opts.bind, opts.port);
                match http::serve(shared.clone(), addr.clone()) {
                    Ok(()) => eprintln!("listening on {addr}; pages and API at {endpoint}"),
                    Err(e) => eprintln!("HTTP server not started ({e}); folders still work"),
                }
            }
            run_loop(shared, &opts);
        }
        other => {
            eprintln!("unknown command {other}\n{HELP}");
            process::exit(2);
        }
    }
}

fn run_loop(shared: Arc<Mutex<Runtime>>, opts: &Opts) {
    let period = Duration::from_millis(opts.tick_ms.max(20));
    let mut last = Instant::now();
    let mut n: u64 = 0;
    let limit = if opts.once { Some(1) } else { opts.ticks };
    // The janitor: deletes old files in the background, a few at a time,
    // so tens of thousands of stale records on a slow mount never stall us.
    let (janitor, bin) = std::sync::mpsc::channel::<Vec<PathBuf>>();
    thread::spawn(move || {
        let mut done = 0usize;
        while let Ok(batch) = bin.recv() {
            for p in batch {
                let _ = std::fs::remove_file(&p);
                done += 1;
                if done % 1000 == 0 {
                    eprintln!("janitor: removed {done} old files so far");
                }
            }
        }
    });
    loop {
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64();
        last = now;
        let (writes, finished) = {
            let mut rt = shared.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(e) = rt.tick(dt) {
                eprintln!("tick error: {e}");
            }
            n += 1;
            let finished = limit.map_or(false, |l| n >= l);
            if finished {
                let _ = rt.persist_all();
            }
            (rt.take_writes(), finished)
        };
        // Disk I/O happens here, with the lock released, so the HTTP and
        // Ward-Beck threads are never starved by a slow volume.
        let deletes = Runtime::flush(writes);
        if !deletes.is_empty() {
            let _ = janitor.send(deletes);
        }
        if finished {
            return;
        }
        let spent = now.elapsed();
        if spent < period {
            thread::sleep(period - spent);
        }
    }
}

/// docker-compose services: the caster plus one frame-sim container per
/// discovered protocol, each speaking Ward-Beck lines to the caster.
fn compose_services(rep: &discover::Repertoire, opts: &Opts) -> String {
    let mut s = String::new();
    s.push_str("# Generated by `trunk-caster compose`. One simulator container per protocol;\n");
    s.push_str("# each speaks Ward-Beck crosspoint lines to the caster on its Ward-Beck port\n");
    s.push_str("# and takes a second copy of every line from the MQTT broker; a line is\n");
    s.push_str("# applied only when both copies agree.\n");
    s.push_str("# Re-run the command when manuals are added, then `docker compose up -d`.\n\n");
    s.push_str("services:\n");
    // The simulator image is built once (frame-sim-image in docker-compose.yml);
    // every simulator just runs it with its own protocol.
    for p in &rep.protocols {
        s.push_str(&format!(
            "  sim-{id}:\n    image: trunk-caster-frame-sim:latest\n    container_name: sim-{id}\n    hostname: sim-{id}\n    restart: unless-stopped\n    depends_on:\n      - trunk-caster\n      - frame-sim-image\n      - mqtt\n    environment:\n      SIM_PROTOCOL: {id}\n      SIM_NAME: sim-{id}\n      SIM_SITE: ${{TRUNK_SITE:-HQ}}\n      SIM_CASTER: trunk-caster:{wb}\n      SIM_CHECKIN_SECONDS: \"20\"\n      SIM_MQTT: mqtt:1883\n    profiles: [\"sims\"]\n\n",
            id = p.id,
            wb = opts.wb_port,
        ));
    }
    s
}

fn die<T>(e: std::io::Error) -> T {
    eprintln!("error: {e}");
    process::exit(1)
}
