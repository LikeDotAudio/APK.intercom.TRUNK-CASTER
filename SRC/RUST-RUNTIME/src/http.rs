//! A tiny HTTP/1.1 server on localhost so the HTML pages have live
//! controls and the SDK's `HttpClient` has something to talk to.
//! Plain `std::net`, one thread per connection, state behind a mutex.

use crate::html;
use crate::runtime::Runtime;
use serde::Serialize;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use trunk_caster_sdk::*;

pub type Shared = Arc<Mutex<Runtime>>;

pub fn serve(rt: Shared, addr: String) -> io::Result<()> {
    let listener = TcpListener::bind(&addr)?;
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let rt = rt.clone();
            thread::spawn(move || {
                let _ = handle(stream, rt);
            });
        }
    });
    Ok(())
}

struct Req {
    method: String,
    path: String,
    body: String,
    /// `Sec-WebSocket-Key` when the client asked to upgrade.
    ws_key: Option<String>,
}

fn read_request(stream: &mut TcpStream) -> io::Result<Req> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    let mut ws_key = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            } else if k.eq_ignore_ascii_case("sec-websocket-key") {
                ws_key = Some(v.trim().to_string());
            }
        }
    }
    let mut body = vec![0u8; content_length.min(4 << 20)];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok(Req { method, path, body: String::from_utf8_lossy(&body).into_owned(), ws_key })
}

fn respond(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8]) -> io::Result<()> {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn json<T: Serialize>(stream: &mut TcpStream, code: u16, v: &T) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(v).unwrap_or_default();
    respond(stream, code, "application/json; charset=utf-8", &body)
}

/// One query-string value, `%xx` and `+` decoded.
fn query(path: &str, key: &str) -> Option<String> {
    let q = path.split_once('?')?.1;
    let raw = q.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))?;
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()).is_some() => {
                out.push(raw.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()).unwrap_or(b'?'));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

fn html_page(stream: &mut TcpStream, page: String) -> io::Result<()> {
    respond(stream, 200, "text/html; charset=utf-8", page.as_bytes())
}

fn error(stream: &mut TcpStream, code: u16, msg: &str) -> io::Result<()> {
    json(stream, code, &serde_json::json!({ "error": msg }))
}

fn handle(mut stream: TcpStream, rt: Shared) -> io::Result<()> {
    let req = read_request(&mut stream)?;
    let path = req.path.split('?').next().unwrap_or("/").trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };

    // The telemetry stream: upgrade, register, then sit reading pings until
    // the browser goes away. The runtime broadcasts to every registered socket.
    if path == "/ws" {
        let Some(key) = req.ws_key.clone() else { return error(&mut stream, 400, "websocket upgrade expected") };
        crate::ws::accept(&mut stream, &key)?;
        let reader = stream.try_clone()?;
        {
            let mut rt = lock(&rt);
            rt.ws.add(stream);
            let n = rt.ws.count();
            rt.note(format!("telemetry stream: page connected ({n} open)"));
        }
        crate::ws::read_loop(reader);
        return Ok(());
    }

    match (req.method.as_str(), path) {
        ("GET", "/") | ("GET", "/globe") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::globe_page(&rt, true))
        }
        ("GET", "/home") | ("GET", "/about") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::index_page(&rt))
        }
        ("GET", "/api/globe") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &html::globe_data(&rt))
        }
        ("GET", "/usage") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::usage_page(&rt, true))
        }
        ("GET", "/users") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::users_page(&rt, true))
        }
        ("GET", "/crosspoints") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::crosspoints_page(&rt, true))
        }
        ("GET", "/simulator") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::simulator_page(&rt, true))
        }
        ("GET", "/space") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::space_page(&rt, true))
        }
        ("GET", "/overlord") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::overlord_page(&rt, true))
        }
        ("GET", "/racks") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::racks_page(&rt, true))
        }
        ("GET", "/relay") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::relay_page(&rt, true))
        }
        ("GET", "/api/sites") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.sites)
        }
        ("GET", "/api/globe/config") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.globe)
        }
        ("POST", "/api/globe/config") => match serde_json::from_str::<GlobeConfig>(&req.body) {
            Ok(g) => {
                let mut rt = lock(&rt);
                match rt.set_globe(g) {
                    Ok(g) => json(&mut stream, 200, &g),
                    Err(e) => error(&mut stream, 500, &e.to_string()),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad globe config: {e}")),
        },
        ("GET", "/api/preferences") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_prefs)
        }
        ("GET", "/api/regions") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.regions())
        }
        ("GET", "/analyzer") => {
            let id = req.path.split('?').nth(1).and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("id=").map(String::from)));
            let rt = lock(&rt);
            html_page(&mut stream, html::analyzer_page(&rt, true, id.as_deref()))
        }
        ("POST", "/api/capture/start") => {
            let v: serde_json::Value = serde_json::from_str(&req.body).unwrap_or_default();
            let note = v.get("note").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let mut rt = lock(&rt);
            let mut c = rt.start_capture(&note);
            c.samples.clear();
            json(&mut stream, 200, &c)
        }
        ("POST", "/api/capture/stop") => {
            let mut rt = lock(&rt);
            match rt.stop_capture() {
                Some(mut c) => {
                    c.samples.clear();
                    json(&mut stream, 200, &c)
                }
                None => error(&mut stream, 400, "no capture in progress"),
            }
        }
        ("GET", "/api/captures") => {
            let rt = lock(&rt);
            let mut cur = rt.capture.clone();
            if let Some(c) = &mut cur {
                c.samples.clear();
            }
            json(&mut stream, 200, &serde_json::json!({ "current": cur, "captures": crate::analyzer::list(&rt.layout) }))
        }
        ("GET", p) if p.starts_with("/api/analyze/") => {
            let id = p.trim_start_matches("/api/analyze/").to_string();
            let rt = lock(&rt);
            match crate::analyzer::load(&rt.layout, &id) {
                Some(mut c) => {
                    c.samples.clear();
                    json(&mut stream, 200, &c)
                }
                None => error(&mut stream, 404, &format!("no capture or run {id}")),
            }
        }
        ("GET", p) if p.starts_with("/api/capture/") => {
            let id = p.trim_start_matches("/api/capture/").to_string();
            let rt = lock(&rt);
            match crate::analyzer::load(&rt.layout, &id) {
                Some(c) => json(&mut stream, 200, &c),
                None => error(&mut stream, 404, &format!("no capture or run {id}")),
            }
        }
        ("GET", "/api/phonebook") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.phone_book())
        }
        ("GET", "/api/gpio/functions") => {
            let v: Vec<serde_json::Value> = GpioFunction::all().iter().map(|f| serde_json::json!({ "pin": f.pin(), "function": f, "label": f.label() })).collect();
            json(&mut stream, 200, &v)
        }
        ("GET", "/api/topics") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &html::topics(&rt))
        }
        ("GET", "/api/land") => respond(&mut stream, 200, "application/json; charset=utf-8", html::LAND_JSON.as_bytes()),
        ("GET", "/api/tree") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.tree())
        }
        ("GET", p) if p.starts_with("/api/device/") => {
            let id = p.trim_start_matches("/api/device/").to_string();
            let rt = lock(&rt);
            match rt.device(&id) {
                Some(d) => json(&mut stream, 200, &d),
                None => error(&mut stream, 404, &format!("no frame {id}")),
            }
        }
        ("GET", "/panels") | ("GET", "/lights") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::panels_page(&rt, true))
        }
        ("GET", "/panels/editor") | ("GET", "/editor") => {
            let frame = query(&req.path, "frame");
            let port = query(&req.path, "port").and_then(|p| p.trim_start_matches('U').parse().ok());
            let rt = lock(&rt);
            html_page(&mut stream, html::panel_editor_page(&rt, frame.as_deref(), port, true))
        }
        ("GET", "/api/bookings") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.bookings.list)
        }
        ("POST", "/api/bookings") => match serde_json::from_str::<crate::bookings::BookingAsk>(&req.body) {
            Ok(ask) => {
                let mut rt = lock(&rt);
                match rt.book(ask) {
                    Ok(b) => {
                        let _ = rt.persist();
                        json(&mut stream, 200, &b)
                    }
                    Err(e) => error(&mut stream, 400, &e),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad booking: {e}")),
        },
        ("POST", "/api/bookings/cancel") => {
            let id = serde_json::from_str::<serde_json::Value>(&req.body).ok().and_then(|v| v["id"].as_str().map(String::from)).unwrap_or_default();
            let mut rt = lock(&rt);
            match rt.cancel_booking(&id) {
                Ok(()) => {
                    let _ = rt.persist();
                    json(&mut stream, 200, &serde_json::json!({ "cancelled": id }))
                }
                Err(e) => error(&mut stream, 404, &e),
            }
        }
        ("GET", "/continents") | ("GET", "/discovery") => {
            let rt = lock(&rt);
            html_page(&mut stream, html::continents_page(&rt, true))
        }
        ("GET", "/api/continents") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.continent_totals())
        }
        ("GET", "/api/lines") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.lines())
        }
        ("GET", "/api/runs") => {
            let rt = lock(&rt);
            let mut cur = rt.recorder.current.clone();
            cur.samples.clear();
            json(&mut stream, 200, &serde_json::json!({ "current": cur, "previous": rt.recorder.index }))
        }
        ("GET", "/api/runs/current") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recorder.current)
        }
        ("GET", "/api/labels") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_labels)
        }
        ("GET", "/api/voices") => {
            let v = lock(&rt).voices.clone();
            let summary = v.lock().unwrap_or_else(|e| e.into_inner()).summary();
            json(&mut stream, 200, &summary)
        }
        ("GET", p) if p.starts_with("/api/voices/") => {
            let rt = lock(&rt);
            let v = rt.voices.clone();
            let fv = v.lock().unwrap_or_else(|e| e.into_inner()).frame_voice(&rt.state, &p["/api/voices/".len()..]);
            match fv {
                Some(fv) => json(&mut stream, 200, &fv),
                None => error(&mut stream, 404, "no frame"),
            }
        }
        ("GET", "/api/taps") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.taps())
        }
        ("GET", p) if p.starts_with("/api/taps/") => {
            let rt = lock(&rt);
            match rt.tap_strip(&p["/api/taps/".len()..]) {
                Some(s) => json(&mut stream, 200, &s),
                None => error(&mut stream, 404, "no frame"),
            }
        }
        ("GET", "/api/bandwidth") => {
            let rt = lock(&rt);
            let v = rt.voices.clone();
            let bw = v.lock().unwrap_or_else(|e| e.into_inner()).bandwidth(&rt.state);
            json(&mut stream, 200, &bw)
        }
        ("GET", "/api/airports") => {
            let rt = lock(&rt);
            let list: Vec<Airport> = rt
                .sites
                .sites
                .iter()
                .map(|s| Airport {
                    site: s.name.clone(),
                    country: s.country.clone(),
                    airport: trunk_caster_sdk::sites::airport_of(&s.name),
                    accent: trunk_caster_sdk::voice::accent_base(&s.country, &s.name).into(),
                })
                .collect();
            json(&mut stream, 200, &list)
        }
        ("GET", p) if p.starts_with("/voices/") => {
            let v = lock(&rt).voices.clone();
            let wav = v.lock().unwrap_or_else(|e| e.into_inner()).wav(&p["/voices/".len()..]);
            match wav {
                Some(b) => respond(&mut stream, 200, "audio/wav", &b),
                None => error(&mut stream, 404, "no such recording"),
            }
        }
        ("GET", "/api/gains") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_gains)
        }
        ("GET", "/api/relay/events") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_relay_events)
        }
        ("GET", "/api/presets") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &presets(&rt.fader))
        }
        ("GET", "/api/productions") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.production_samples())
        }
        ("GET", "/api/report") | ("GET", "/report.md") => {
            let rt = lock(&rt);
            let md = crate::report::markdown(&rt);
            respond(&mut stream, 200, "text/markdown; charset=utf-8", md.as_bytes())
        }
        ("POST", "/api/fader/preset") => {
            let v: serde_json::Value = serde_json::from_str(&req.body).unwrap_or_default();
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let mut rt = lock(&rt);
            match rt.apply_preset(&id) {
                Ok(f) => json(&mut stream, 200, &f),
                Err(e) => error(&mut stream, 400, &e),
            }
        }
        ("POST", "/api/fader/quick") => {
            let v: serde_json::Value = serde_json::from_str(&req.body).unwrap_or_default();
            let mut rt = lock(&rt);
            match rt.quick_fader(v.get("speed").and_then(|x| x.as_f64()), v.get("running").and_then(|x| x.as_bool())) {
                Ok(f) => json(&mut stream, 200, &f),
                Err(e) => error(&mut stream, 500, &e.to_string()),
            }
        }
        ("POST", "/api/clock") => {
            let v: serde_json::Value = serde_json::from_str(&req.body).unwrap_or_default();
            match v.get("hour").and_then(|x| x.as_f64()) {
                Some(h) => {
                    let mut rt = lock(&rt);
                    rt.set_clock_hour(h);
                    let st = rt.status();
                    json(&mut stream, 200, &st)
                }
                None => error(&mut stream, 400, "expected {\"hour\": 0..24}"),
            }
        }
        ("POST", "/api/taps/unity") => match serde_json::from_str::<TapsUnity>(if req.body.trim().is_empty() { "{}" } else { &req.body }) {
            Ok(u) => {
                let mut rt = lock(&rt);
                match rt.taps_unity(u) {
                    Ok(r) => json(&mut stream, 200, &r),
                    Err(e) => error(&mut stream, 400, &e),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad unity: {e}")),
        },
        ("POST", "/api/gain") => match serde_json::from_str::<GainSet>(&req.body) {
            Ok(g) => {
                let mut rt = lock(&rt);
                match rt.set_gain(g) {
                    Ok(ev) => json(&mut stream, 200, &ev),
                    Err(e) => error(&mut stream, 400, &e),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad gain: {e}")),
        },
        ("POST", "/api/relay/bind") => match serde_json::from_str::<RelayBinding>(&req.body) {
            Ok(b) => {
                let mut rt = lock(&rt);
                match rt.relay_bind(b) {
                    Ok(b) => json(&mut stream, 200, &b),
                    Err(e) => error(&mut stream, 400, &e),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad binding: {e}")),
        },
        ("POST", "/api/relay/unbind") => {
            let v: serde_json::Value = serde_json::from_str(&req.body).unwrap_or_default();
            let (m, p) = (v.get("matrix").and_then(|x| x.as_str()), v.get("port").and_then(|x| x.as_u64()));
            match (m, p) {
                (Some(m), Some(p)) => {
                    let mut rt = lock(&rt);
                    match rt.relay_unbind(m, p as usize) {
                        Ok(()) => json(&mut stream, 200, &serde_json::json!({"unbound": true})),
                        Err(e) => error(&mut stream, 400, &e),
                    }
                }
                _ => error(&mut stream, 400, "expected {matrix, port}"),
            }
        }
        ("POST", "/api/relay/event") => match serde_json::from_str::<RelayEvent>(&req.body) {
            Ok(ev) => {
                let mut rt = lock(&rt);
                let ev = rt.relay_event(ev);
                json(&mut stream, 200, &ev)
            }
            Err(e) => error(&mut stream, 400, &format!("bad event: {e}")),
        },
        ("GET", "/api/remotes") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.remote_list())
        }
        ("GET", "/api/relay") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &crate::relay::snapshot(&rt))
        }
        ("GET", "/api/gpio") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_gpio)
        }
        ("GET", "/api/renames") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_renames)
        }
        ("GET", "/api/policy") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.policy)
        }
        ("GET", "/api/wardbeck") => {
            let rt = lock(&rt);
            let lines: Vec<String> = rt.crosspoints.recent_wb.iter().cloned().collect();
            respond(&mut stream, 200, "text/plain; charset=utf-8", lines.join("\n").as_bytes())
        }
        ("GET", "/api/checkin") => {
            let rt = lock(&rt);
            let text = std::fs::read_to_string(rt.layout.checkin_file()).unwrap_or_default();
            respond(&mut stream, 200, "text/plain; charset=utf-8", text.as_bytes())
        }
        ("POST", "/api/gpio") => match serde_json::from_str::<GpioCommand>(&req.body) {
            Ok(g) => {
                let mut rt = lock(&rt);
                match rt.gpio(g) {
                    Ok(ev) => {
                        let _ = rt.persist();
                        json(&mut stream, 200, &ev)
                    }
                    Err(e) => error(&mut stream, 400, &e),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad gpio: {e}")),
        },
        ("POST", "/api/rename") => match serde_json::from_str::<Rename>(&req.body) {
            Ok(r) => {
                let mut rt = lock(&rt);
                match rt.rename(r) {
                    Ok(d) => {
                        let _ = rt.persist();
                        json(&mut stream, 200, &d)
                    }
                    Err(e) => error(&mut stream, 400, &e),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad rename: {e}")),
        },

        ("GET", "/api/status") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.status())
        }
        ("GET", "/api/advertisements") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.advertisements())
        }
        ("GET", "/api/protocols") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.repertoire.protocols)
        }
        ("GET", "/api/state") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.state)
        }
        ("GET", "/api/users") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.recent_records)
        }
        ("GET", "/api/fader") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.fader)
        }
        ("GET", "/api/timeline") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.timeline)
        }
        ("GET", "/api/seeks") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.offers)
        }
        ("GET", "/api/crosspoints") => {
            let rt = lock(&rt);
            let mut cps: Vec<&Crosspoint> = rt.crosspoints.current.iter().collect();
            cps.sort_by(|a, b| (&a.frame, &a.input, &a.output).cmp(&(&b.frame, &b.input, &b.output)));
            json(
                &mut stream,
                200,
                &serde_json::json!({
                    "settings": rt.crosspoints.settings,
                    "events_logged": rt.crosspoints.events_logged,
                    "log_ended": rt.crosspoints.ended,
                    "crosspoints": cps,
                    "recent_events": rt.crosspoints.recent,
                }),
            )
        }
        ("GET", "/api/crosscheck") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.last_crosscheck)
        }
        ("GET", "/api/log") => {
            let rt = lock(&rt);
            json(&mut stream, 200, &rt.log)
        }

        ("POST", "/api/request") => match serde_json::from_str::<Request>(&req.body) {
            Ok(r) => {
                let mut rt = lock(&rt);
                let reply = rt.handle_request(r, "http");
                let _ = rt.persist();
                json(&mut stream, 200, &reply)
            }
            Err(e) => error(&mut stream, 400, &format!("bad request: {e}")),
        },
        ("POST", "/api/release") => {
            let id = serde_json::from_str::<serde_json::Value>(&req.body)
                .ok()
                .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(String::from));
            match id {
                Some(id) => {
                    let mut rt = lock(&rt);
                    let reply = rt.release(&id);
                    let _ = rt.persist();
                    json(&mut stream, 200, &reply)
                }
                None => error(&mut stream, 400, "expected {\"id\": ...}"),
            }
        }
        ("POST", "/api/fader") => match serde_json::from_str::<Fader>(&req.body) {
            Ok(f) => {
                let mut rt = lock(&rt);
                match rt.set_fader(f) {
                    Ok(()) => {
                        let f = rt.fader.clone();
                        json(&mut stream, 200, &f)
                    }
                    Err(e) => error(&mut stream, 500, &e.to_string()),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad fader: {e}")),
        },
        ("POST", "/api/panel-seek") => match serde_json::from_str::<PanelSeek>(&req.body) {
            Ok(s) => {
                let mut rt = lock(&rt);
                let offer = rt.seek_http(s);
                let _ = rt.persist();
                json(&mut stream, 200, &offer)
            }
            Err(e) => error(&mut stream, 400, &format!("bad seek: {e}")),
        },
        ("POST", "/api/crosspoints/settings") => match serde_json::from_str::<CrosspointSettings>(&req.body) {
            Ok(s) => {
                let mut rt = lock(&rt);
                rt.pref("crosspoint-settings", None, serde_json::to_value(&s).unwrap_or_default());
                match rt.crosspoints.set_settings(s) {
                    Ok(()) => {
                        rt.mark_dirty();
                        let _ = rt.persist();
                        let s = rt.crosspoints.settings.clone();
                        json(&mut stream, 200, &s)
                    }
                    Err(e) => error(&mut stream, 500, &e.to_string()),
                }
            }
            Err(e) => error(&mut stream, 400, &format!("bad settings: {e}")),
        },
        ("POST", "/api/crosspoints/reset") => {
            let mut rt = lock(&rt);
            rt.pref("crosspoint-reset", None, serde_json::json!({}));
            match rt.crosspoints.reset() {
                Ok(()) => {
                    rt.mark_dirty();
                    let _ = rt.persist();
                    json(&mut stream, 200, &serde_json::json!({ "reset": true }))
                }
                Err(e) => error(&mut stream, 500, &e.to_string()),
            }
        }

        ("GET", _) => error(&mut stream, 404, "not found"),
        _ => error(&mut stream, 405, "method not allowed"),
    }
}

/// Lock the runtime, recovering from a poisoned mutex so one bad page
/// render never takes the whole server down.
fn lock(rt: &Shared) -> std::sync::MutexGuard<'_, Runtime> {
    rt.lock().unwrap_or_else(|e| e.into_inner())
}
