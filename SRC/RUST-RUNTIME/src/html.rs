//! HTML pages. Each page is written as a static file into its folder and
//! also served live at the runtime's HTTP port. Served pages have working
//! controls; static pages show the same data with a note.

use crate::crosspoints::user_port;
use crate::runtime::Runtime;
use crate::util::{self, esc};
use std::collections::BTreeMap;
use std::fmt::Write;
use trunk_caster_sdk::*;

const CSS: &str = r#"
:root{--bg:#f6f7f9;--panel:#ffffff;--ink:#1b1f24;--muted:#6b7280;--line:#e3e6ea;--accent:#1f6feb;--ok:#1a7f37;--warn:#b35900;--bad:#c62828;--free:#dbe7f6;--used:#1f6feb;--via:#8957e5;--space:#0b1020;--star:#ffffff;--ph-night:#3d4f9e;--ph-dawn:#c25e00;--ph-day:#9a7400;--ph-dusk:#b8336a}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1115;--panel:#171a21;--ink:#e6e8eb;--muted:#9aa3ad;--line:#2a2f38;--accent:#5a9bff;--ok:#3fb950;--warn:#e3a35a;--bad:#ff6b6b;--free:#273246;--used:#5a9bff;--via:#b48cff;--ph-night:#8a9be0;--ph-dawn:#ffa657;--ph-day:#f2cc60;--ph-dusk:#ff7eb6}}
:root[data-theme="dark"]{--bg:#0f1115;--panel:#171a21;--ink:#e6e8eb;--muted:#9aa3ad;--line:#2a2f38;--accent:#5a9bff;--ok:#3fb950;--warn:#e3a35a;--bad:#ff6b6b;--free:#273246;--used:#5a9bff;--via:#b48cff;--ph-night:#8a9be0;--ph-dawn:#ffa657;--ph-day:#f2cc60;--ph-dusk:#ff7eb6}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{flex:1 0 auto;width:100%}
footer{position:sticky;bottom:0;z-index:5;margin-top:auto;padding:3px 16px 3px;border-top:1px solid var(--line);background:var(--panel);color:var(--muted);font-size:12px}
footer .status{display:flex;flex-wrap:wrap;gap:1px 14px;align-items:baseline;margin-top:1px;font-family:ui-monospace,Consolas,monospace;font-size:11px;opacity:.8}
footer .strip{cursor:ew-resize}
#replay{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:3px 0;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink)}#replay label{display:inline-flex;gap:4px;align-items:center}#replay input[type=range]{width:min(26vw,220px)}#replay #rp-when{font-family:ui-monospace,Consolas,monospace;font-weight:600}
footer a{color:var(--accent);text-decoration:none}footer .right{margin-left:auto}footer .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:5px;vertical-align:middle}footer .dot.live{background:var(--ok)}
.day .scrub{fill:transparent;cursor:ew-resize}
header{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:6}
header h1{font-size:16px;margin:0;color:var(--muted);font-weight:600;letter-spacing:.02em}
header nav.views{display:flex;flex:1 1 auto;justify-content:space-between;gap:6px}header nav.views a{flex:1 1 0;text-align:center;color:var(--ink);text-decoration:none;white-space:nowrap;font-size:1.3em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:10px 12px;border-radius:999px;border:1px solid var(--line);background:var(--bg)}
@media (max-width:1100px){header nav.views{flex-wrap:wrap}header nav.views a{flex:1 1 140px;font-size:1.05em}}
header nav.views a:hover{border-color:var(--accent);color:var(--accent)}header nav.views a.on{background:var(--accent);color:#fff;border-color:var(--accent)}
header nav.views .dd{flex:1 1 0;position:relative;display:flex}header nav.views .dd>a{flex:1 1 auto}header nav.views .dd .menu{display:none;position:absolute;top:100%;left:0;min-width:100%;z-index:10;padding-top:4px;flex-direction:column;gap:4px}
header nav.views .dd:hover .menu,header nav.views .dd:focus-within .menu{display:flex}header nav.views .dd .menu a{font-size:.85em;padding:8px 12px;background:var(--panel);box-shadow:0 4px 12px rgba(0,0,0,.15)}
@media (max-width:1100px){header nav.views .dd{flex:1 1 140px}}
footer .stats{color:var(--ink)}footer .stats b{font-weight:600}
.day .rail{stroke:var(--line)}.day .zone circle{fill:var(--accent);stroke:var(--panel);stroke-width:1.5}.day .zone text{fill:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}.day .zone .clk{fill:var(--ink);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;text-transform:none;letter-spacing:0}.day .zone.anchor circle{fill:var(--bad)}.day .zone.anchor .clk{fill:var(--bad)}
.day .mark{fill:var(--ink);opacity:.35;font-size:11px;font-weight:700;letter-spacing:.08em}.day .whatis{fill:var(--ink);font-size:11px;font-weight:600}.day .nowlabel{fill:var(--bad);font-weight:600;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;white-space:pre}.day .zone .clk{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}.day .zone.ph-night text{fill:var(--ph-night)}.day .zone.ph-dawn text{fill:var(--ph-dawn)}.day .zone.ph-day text{fill:var(--ph-day)}.day .zone.ph-dusk text{fill:var(--ph-dusk)}
.sim{display:grid;grid-template-columns:420px minmax(0,1fr);gap:14px;align-items:start}.sim aside{position:sticky;top:12px;max-height:calc(100vh - 170px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}.sim aside h2{margin:0 0 8px}
.report h3{font-size:12px;margin:12px 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.report h4{font-size:12.5px;margin:10px 0 4px;color:var(--ink)}.report ul{margin:0;padding-left:16px;font-size:12.5px}.report li{margin:2px 0}.report p{margin:4px 0;font-size:12px;color:var(--muted)}.report code{font-size:11px}
.events{display:flex;flex-wrap:wrap;gap:8px}.event{flex:1 1 200px;text-align:left;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--bg);color:var(--ink);cursor:pointer}.event b{display:block;font-size:13px}.event span{display:block;font-size:11px;color:var(--muted);margin-top:2px;font-weight:400}.event.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}.event:hover{border-color:var(--accent)}
.prods{width:100%}.prods input{width:100%;padding:3px 6px;font-size:12px}.prods td{padding:3px 4px}.prods input[type=checkbox]{width:auto}
.swatch{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:4px;border:1px solid rgba(0,0,0,.15)}
.quick{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin-top:10px}.quick input[type=range]{width:220px;padding:0}.quick b{color:var(--ink)}
@media (max-width:1000px){.sim{grid-template-columns:1fr}.sim aside{position:static;max-height:none}}
main{padding:12px 16px;max-width:none;margin:0}section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 10px}h3{font-size:13px;margin:14px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}.tile{border:1px solid var(--line);border-radius:6px;padding:8px 10px}.tile b{display:block;font-size:20px}.tile span{color:var(--muted);font-size:12px}
.casters{display:inline-flex;gap:2px}.casters i{display:inline-block;width:12px;height:12px;border-radius:2px;background:var(--free)}.casters i.t{background:var(--used)}
.bar{height:8px;background:var(--free);border-radius:4px;overflow:hidden;min-width:80px}.bar i{display:block;height:100%;background:var(--used)}
.kind-direct{color:var(--ok)}.kind-via{color:var(--via)}.status-granted{color:var(--ok)}.status-denied{color:var(--bad)}.status-released{color:var(--muted)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}
form.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}form.row label{display:flex;flex-direction:column;font-size:12px;color:var(--muted)}
input,select,button{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);max-width:100%}button{background:var(--accent);color:#fff;border-color:var(--accent);cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button.small{padding:2px 8px;font-size:12px}button:disabled{opacity:.5;cursor:not-allowed}
.note{font-size:12px;color:var(--muted)}.result{margin-top:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap}
.scroll{max-height:420px;overflow:auto}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:12px}pre{margin:0;white-space:pre-wrap}
svg text{fill:var(--muted);font-size:11px}svg .grid{stroke:var(--line)}svg .axis{stroke:var(--muted)}
.rack{border:1px solid var(--line);border-radius:8px;margin-bottom:14px;background:var(--panel)}.rack>h2{padding:10px 14px;margin:0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}.rack>h2 .muted{font-size:12px;font-weight:400}
details.frame{border-top:1px solid var(--line)}details.frame:first-of-type{border-top:0}details.frame summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;padding:8px 14px}details.frame summary::-webkit-details-marker{display:none}details.frame summary::before{content:"▸";color:var(--muted);width:12px}details.frame[open] summary::before{content:"▾"}
details.frame .lid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding:0 14px 14px 40px;border-top:1px dashed var(--line);background:linear-gradient(var(--bg),var(--panel))}details.frame .lid>div{padding-top:8px}details.frame .lid h4{margin:0 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.ports{display:grid;grid-template-columns:repeat(auto-fill,minmax(52px,1fr));gap:4px}.port{border:1px solid var(--line);border-radius:4px;padding:2px 4px;font-size:11px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--bg)}.port.named{border-color:var(--accent)}.port.live{background:var(--used);color:#fff;border-color:var(--used)}
.io{display:flex;flex-direction:column;gap:3px;font-size:12px}.io .in::before{content:"⇢ ";color:var(--ok)}.io .out::before{content:"⇠ ";color:var(--via)}
.matrix{border-collapse:separate;border-spacing:3px;width:auto}.matrix td,.matrix th{border:0;padding:0;text-align:center}.matrix th{font-size:11px;color:var(--muted);font-weight:500;padding:2px}.matrix td i{display:block;width:26px;height:26px;border-radius:4px;background:var(--free)}.matrix td i.on{background:var(--used)}
.space{background:var(--space);border-radius:8px;display:block;width:100%}.space .star{fill:var(--star);opacity:.5;animation:tw 3s infinite alternate}.space .node{stroke:#fff;stroke-opacity:.35}.space .trunk{stroke:var(--used);stroke-opacity:.55}.space .lbl{fill:#cfd6e4;font-size:11px}.space .proto{fill:#8fa3c7;font-size:12px;font-weight:600}
@keyframes tw{from{opacity:.2}to{opacity:.8}}
.fam-analog-audio{fill:#f6c343}.fam-audio-over-ip{fill:#5a9bff}.fam-telephony{fill:#3fb950}.fam-control{fill:#e3a35a}.fam-wireless{fill:#b48cff}.fam-media-transport{fill:#ff6b6b}.fam-other{fill:#9aa3ad}
.overlord{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:14px;align-items:start}.overlord aside{position:sticky;top:12px;max-height:calc(100vh - 130px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.overlord aside h2{position:sticky;top:0;background:var(--panel);padding:4px 0;margin:0 0 6px}
.taskbar{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.5}.taskbar div{border-bottom:1px dashed var(--line);padding:3px 0;word-break:break-word}.taskbar .t{color:var(--muted)}.taskbar .g{color:var(--ok)}.taskbar .d{color:var(--bad)}.taskbar .w{color:var(--warn)}.taskbar .v{color:var(--via)}
.calls{background:var(--space);border-radius:8px;display:block;width:100%}.calls .chord{fill:none;stroke-opacity:.7}.calls .chord.direct{stroke:var(--used)}.calls .chord.via{stroke:var(--via)}.calls .tick{stroke:#8fa3c7}.calls .lbl{fill:#cfd6e4;font-size:10px}.calls .proto{fill:#8fa3c7;font-size:11px;font-weight:600}.calls .dot{fill:#fff}.calls .cont{fill:rgba(143,163,199,.06);stroke:#8fa3c7;stroke-opacity:.45;stroke-width:1}
.day{display:block;width:100%}.day .band{fill:var(--free)}.day .night{fill:var(--line)}.day .news{fill:var(--used);opacity:.35}.day .radio{fill:var(--warn);opacity:.35}.day .main{fill:var(--bad);opacity:.35}.day .oly{fill:var(--via);opacity:.45}.day .olyt{font-size:9.5px;font-weight:600;fill:var(--via)}.day .curve{fill:none;stroke:var(--ink);stroke-width:1.2;opacity:.8}.day .now{stroke:var(--bad);stroke-width:2}.day text{font-size:10px}
@media (max-width:900px){.overlord{grid-template-columns:1fr}.overlord aside{position:static;max-height:360px}}
@media (max-width:640px){main{padding:12px}header{padding:12px}footer{padding:6px 12px}td,th{padding:4px 6px}details.frame .lid{padding-left:14px}}
/* The data terminal: header and footer pinned, the space between split into
   columns (three at least) that scroll on their own, sashes between them.
   No gutters, no rounded corners. Below 900px the page flows as one column. */
@media (min-width:900px){
html,body{height:100%}body{height:100vh;overflow:hidden}
main{flex:1 1 0;min-height:0;padding:0;margin:0;max-width:none;overflow:hidden}
.cols{display:grid;height:100%;min-height:0}
.cols>.col{overflow:auto;min-width:0;min-height:0;height:100%;overscroll-behavior:contain}
.cols>.sash{cursor:col-resize;background:var(--line);touch-action:none}.cols>.sash:hover,.cols>.sash.drag{background:var(--accent)}
.cols section{margin:0;border-radius:0;border-width:0 0 1px 0;padding:6px 8px}
.cols aside,.cols .globeside{position:static;max-height:none;overflow:visible}
.quads{display:grid;height:100%;min-height:0}
.quads>.pane{overflow:auto;min-width:0;min-height:0;overscroll-behavior:contain;container-type:size;border-top:3px solid var(--qc,var(--line));position:relative}
.quads>.sash{background:var(--line);touch-action:none;z-index:2}.quads>.sash.v{cursor:col-resize}.quads>.sash.h{cursor:row-resize}.quads>.sash:hover,.quads>.sash.drag{background:var(--accent)}
.quads section{margin:0;border-radius:0;border-width:0 0 1px 0;padding:6px 8px}
.quads aside,.quads .globeside{position:static;max-height:none;overflow:visible}
.quads canvas.globe,.quads #cglobe{height:max(240px, calc(100cqh - 120px))!important}
.quads .trends{max-height:none}
footer{margin-top:0}
}
#daystrip{height:94px}#daystrip text,#daystrip circle{transform-box:fill-box;transform-origin:center;transform:scaleX(var(--ix,1))}#daystrip line,#daystrip path,#daystrip rect{vector-effect:non-scaling-stroke}

/* Header tabs in resistor-code colours; the open one ringed. */
header nav.views a{background:var(--tc,var(--bg));color:var(--tf,var(--ink));border-color:var(--tc,var(--line));box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}
header nav.views a:hover{color:var(--tf,var(--ink));border-color:var(--ink)}header nav.views a.on{background:var(--tc,var(--accent));color:var(--tf,#fff);outline:3px solid var(--ink);outline-offset:2px}
/* The band under the header: top and bottom of the last four tabs opened. */
#quadbtn{margin-left:8px;flex:0 0 auto;align-self:center}
#topics{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));border-bottom:1px solid var(--line);background:var(--panel);flex:0 0 auto}
#topics .tchart{position:relative;padding:3px 8px 5px;border-right:1px solid var(--line);border-top:3px solid var(--tc);font-size:11px;min-width:0}
#topics .th{position:absolute;z-index:2;left:0;right:0;top:0;padding:3px 8px;background:color-mix(in srgb,var(--panel) 88%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;transition:opacity 1.2s ease}
/* The titles are overlays: they melt away after a few seconds, leaving only
   the graphed data, and come back while the pointer is on the graph. */
#topics.melted .th{opacity:0}#topics .tchart:hover .th,#topics .aurora:hover .th{opacity:1;transition-duration:.2s}#topics .th b{padding:0 5px;border-radius:3px}
#topics .tr{display:grid;grid-template-columns:minmax(0,42%) 1fr auto;gap:6px;align-items:center;line-height:15px}
#topics .tr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#topics .tr i{height:8px;background:var(--free);display:block}
#topics .tr u{display:block;height:100%;background:var(--tc);box-shadow:inset 0 0 0 1px rgba(127,127,127,.45)}#topics .tr b{font-variant-numeric:tabular-nums}
#topics .aurora{position:relative;grid-column:span 2;padding:3px 8px 5px;border-right:1px solid var(--line);border-top:3px solid var(--tc);font-size:11px;min-width:0}
#topics .aurora canvas{display:block;width:100%;height:100%;min-height:80px;background:#050914;border-radius:4px}
#topics .aopts{display:inline-flex;gap:8px;align-items:center;margin-left:8px;font-size:10.5px}#topics .aopts label{display:inline-flex;gap:3px;align-items:center;white-space:nowrap}#topics .aopts input[type=range]{width:70px;height:12px}#topics .aopts select{font-size:10.5px;padding:0 2px}
section>h2+p.note{transition:opacity .6s,max-height .6s,margin .6s;max-height:30em;overflow:hidden}body.notes-folded section>h2+p.note{opacity:0;max-height:0;margin:0}body.notes-folded section>h2:hover+p.note{opacity:1;max-height:30em;margin:revert}body.notes-folded section>h2:has(+p.note)::after{content:" ⓘ";font-size:.75em;color:var(--muted);cursor:help}
/* Pop-out: every section opens alone in its own live window. */
section h2 .pop{float:right;font-size:12px;line-height:1;padding:2px 6px;margin-left:6px;background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:4px;cursor:pointer}section h2 .pop:hover{color:var(--accent);border-color:var(--accent)}
body.popped header,body.popped footer,body.popped #topics{display:none}body.popped main{overflow:auto;padding:0}body.popped section.popsel{min-height:100vh;margin:0;border:0;border-radius:0}
"#;

const JS: &str = r#"
const LIVE = location.protocol.startsWith('http');
async function api(path, body){
  const r = await fetch(path,{method: body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body: body===undefined?undefined:JSON.stringify(body)});
  const t = await r.text(); try{return JSON.parse(t)}catch{return t}
}
function show(id, v){ const el=document.getElementById(id); if(el) el.textContent = typeof v==='string'? v : JSON.stringify(v,null,2); }
function num(id){ const el=document.getElementById(id); if(!el||el.value==='') return undefined; return Number(el.value); }
function val(id){ const el=document.getElementById(id); return el? el.value : undefined; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function dur(s){ s=Math.max(0,Math.floor(s)); if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m '+String(s%60).padStart(2,'0')+'s'; return Math.floor(s/3600)+'h '+String(Math.floor(s%3600/60)).padStart(2,'0')+'m'; }
// A change made from a page: refresh the page in place shortly after.
function reload(ms){ setTimeout(()=>refreshMain(true), ms||600); }
function connect(from, fromPort, who){ const to=prompt('Connect '+from+':'+fromPort+' to which frame? (e.g. london-01)'); if(!to) return; api('/api/request',{who:who||'operator',from:from,to:to,from_port:fromPort}).then(r=>{alert(r.status+(r.reason?': '+r.reason:'')); reload();}); }
function rename(frame, port){ const name=prompt('New name for '+frame+':U'+String(port).padStart(2,'0')+' (emoji welcome; cut to 6, 8 and 16 characters)'); if(!name) return; api('/api/rename',{frame:frame,port:port,name:name}).then(()=>reload()); }
function cancelBooking(id){ if(!confirm('Cancel booking '+id+'?')) return; api('/api/bookings/cancel',{id:id}).then(()=>reload()); }
function gpio(conn){ const pin=prompt('GPIO key on '+conn+':\n1 blink panel · 2 check lights · 3 set latch · 4 set listen\n5 unset latch · 6 clear · 7 last caller · 8 ping','1'); if(!pin) return; api('/api/gpio',{connection:conn,pin:Number(pin),state:true,note:'from page'}).then(r=>{alert(typeof r==='string'?r:(r.error||('pin '+r.pin+' '+(r.function||'')+' via '+r.trunks.join(',')+(r.result?'\n'+JSON.stringify(r.result,null,1):'')))); reload();}); }

// ---- Telemetry: streamed over a WebSocket, cached locally, applied in place ----
const TC = { status:null, onStatus:[], onGlobe:[], onMain:[], ws:null, interacting:0 };
function cacheGet(k){ try{ return JSON.parse(localStorage.getItem('tc:'+k)); }catch(e){ return null; } }
function cacheSet(k,v){ try{ localStorage.setItem('tc:'+k, JSON.stringify(v)); }catch(e){} }
// A new version is serving: drop everything cached under tc: and remember the build.
function cacheFlush(){ try{ for(let i=localStorage.length-1;i>=0;i--){ const k=localStorage.key(i); if(k && k.startsWith('tc:')) localStorage.removeItem(k); } localStorage.setItem('tc:build', JSON.stringify(BUILD)); }catch(e){} }
if(LIVE && cacheGet('build')!==BUILD) cacheFlush();
function setText(id, t){ const el=document.getElementById(id); if(el && el.textContent!==t) el.textContent=t; }
// The broadcast day strip in the footer: "now", the world clocks riding on
// it, and which clock is at 6 am, noon and 6 pm. Painted every frame between
// telemetry updates, advancing the hour at the fader's speed, so it is smooth.
function predictedHour(){ if(typeof TC.hour!=='number') return null; const dt=(performance.now()-(TC.at||0))/1000; return ((TC.hour + dt*(TC.speed||0)/3600)%24+24)%24; }
const fmtH = h => { const t=Math.round(((h%24)+24)%24*3600)%86400; return String(Math.floor(t/3600)).padStart(2,'0')+':'+String(Math.floor(t%3600/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0'); };
function paintDay(){
  const strip=document.getElementById('daystrip'); const h=predictedHour(); if(!strip||h==null) return;
  const off=Number(strip.dataset.offset||0); const X=lh=>28+(((lh%24)+24)%24/24)*(960-28-12);
  const lh=((h+off)%24+24)%24; const x=X(lh);
  const n=strip.querySelector('.now'); if(n){ n.setAttribute('x1',x); n.setAttribute('x2',x); }
  const t=strip.querySelector('.nowlabel'); if(t){ t.textContent=fmtH(lh)+' '+(strip.dataset.anchor||'')+' · '+fmtH(h)+' UTC · ×'+Number(TC.load||1).toFixed(1); }
  const at={0:[],6:[],12:[],18:[]}; const lab=[];
  strip.querySelectorAll('.zone').forEach(z=>{ const zo=Number(z.dataset.offset||0); const zl=((h+zo)%24+24)%24; z.setAttribute('transform','translate('+X(zl).toFixed(1)+',0)'); const c=z.querySelector('.clk'); if(c) c.textContent=fmtH(zl).slice(0,5); lab.push({z,x:X(zl)}); const ph= zl<5||zl>=20.5?'night':zl<8?'dawn':zl<17?'day':'dusk'; if(z.dataset.ph!==ph){ z.classList.remove('ph-'+z.dataset.ph); z.classList.add('ph-'+ph); z.dataset.ph=ph; } for(const k of [0,6,12,18]){ let d=Math.abs(zl-k); d=Math.min(d,24-d); if(d<=1.5) at[k].push([d,z.dataset.name]); } });
  // Cities close together on the day would print over each other: keep each
  // dot where it is but push the labels apart, then back inside the strip.
  lab.sort((a,b)=>a.x-b.x); for(const l of lab){ let w=0; l.z.querySelectorAll('text').forEach(e=>{ try{ w=Math.max(w,e.getComputedTextLength()); }catch(_){} }); l.w=w+8; l.p=l.x; }
  for(let i=1;i<lab.length;i++) lab[i].p=Math.max(lab[i].p, lab[i-1].p+(lab[i-1].w+lab[i].w)/2);
  for(let i=lab.length-1;i>=0;i--){ const hi=i===lab.length-1? 960-lab[i].w/2 : lab[i+1].p-(lab[i].w+lab[i+1].w)/2; lab[i].p=Math.min(lab[i].p,hi); }
  for(const l of lab){ l.p=Math.max(l.p,l.w/2); l.z.querySelectorAll('text').forEach(e=>{ e.setAttribute('text-anchor','middle'); e.setAttribute('x',(l.p-l.x).toFixed(1)); }); }
  const word={0:'midnight',6:'6 am',12:'noon',18:'6 pm'}; const parts=[]; for(const k of [6,12,18,0]){ const v=at[k].sort((a,b)=>a[0]-b[0]).map(a=>a[1]); if(v.length) parts.push(word[k]+' in '+v.join(' and ')); }
  const w=strip.querySelector('.whatis'); if(w) w.textContent = parts.length? parts.join(' · ') : 'no clock within 90 minutes of 6 am, noon or 6 pm';
  document.querySelectorAll('.zoneclock').forEach(e=>{ e.textContent=fmtH(h+Number(e.dataset.offset||0)); });
}
(function dayLoop(){ try{ paintDay(); }catch(e){} requestAnimationFrame(dayLoop); })();
function applyStatus(m){
  TC.status = m; cacheSet('status', m);
  const s = m.status || {};
  setText('footclock', m.clock);
  setText('hdr-clock', m.clock);
  setText('hdr-stats', (s.frames||0)+' frames · '+(s.trunks||0)+' trunks · '+(s.connections||0)+' live'+(m.muted?(' · '+m.muted+' parked'):'')+' · load ×'+Number(m.load||1).toFixed(1));
  const fmt = h => { const t=Math.round(((h%24)+24)%24*3600)%86400; return String(Math.floor(t/3600)).padStart(2,'0')+':'+String(Math.floor(t%3600/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0'); };
  if(typeof m.hour==='number'){ TC.hour=m.hour; TC.at=performance.now(); TC.speed=(m.fader&&typeof m.fader.speed==='number')?m.fader.speed:0; TC.load=Number(m.load||1); paintDay(); }
  if(m.fader && typeof m.fader.preset==='string') document.querySelectorAll('.event').forEach(e=>e.classList.toggle('on', e.dataset.id===m.fader.preset));
  const sp=document.getElementById('qspeed'); if(sp && m.fader && document.activeElement!==sp){ sp.value=m.fader.speed; setText('qspeedv', Math.round(m.fader.speed)+'×'); }
  const run=document.getElementById('qrun'); if(run && m.fader){ run.dataset.running=String(m.fader.running); run.textContent = m.fader.running?'⏸ pause load':'▶ run load'; run.className='small '+(m.fader.running?'secondary':''); }
  const bb=document.getElementById('blackout-banner'); if(bb) bb.style.display = m.blackout?'block':'none';
  TC.onStatus.forEach(f=>{ try{ f(m); }catch(e){} });
}
function connectWs(){
  if(!LIVE || !('WebSocket' in window)) return;
  try{
    const ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
    ws.onmessage = e => { let m; try{ m=JSON.parse(e.data); }catch(err){ return; } if(m.build && m.build!==BUILD){ cacheFlush(); ws.onclose=null; location.reload(); return; } if(m.type==='status') applyStatus(m); else if(m.type==='globe-delta') TC.onGlobe.forEach(f=>{ try{ f(m); }catch(err){} }); };
    ws.onclose = () => { TC.ws=null; setTimeout(connectWs, 2000); };
    ws.onerror = () => { try{ ws.close(); }catch(e){} };
    TC.ws = ws;
  }catch(e){ setTimeout(connectWs, 5000); }
}
// ---- Replay: a published copy has no caster to stream from, so it plays a
// simulated year (replay/index.json, one file per day) through the same
// handlers the WebSocket feeds. The publisher sets window.TC_REPLAY.
const REPLAY = window.TC_REPLAY || null;
const RP = { ix:null, day:0, f:0, playing:true, rate:1, files:new Map(), timer:0 };
const RP_RATES = [0.5, 1, 2, 4, 8, 16];
function rpDate(d){ const t0 = Math.floor(Date.parse(RP.ix.generated)/86400000 - RP.ix.days)*86400000; return new Date(t0 + d*86400000).toISOString().slice(0,10); }
// Day files are gzipped JSON; a server that already unpacked one sends plain text.
async function rpFetch(url){
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if(buf[0]===0x1f && buf[1]===0x8b && 'DecompressionStream' in window) return JSON.parse(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  return JSON.parse(new TextDecoder().decode(buf));
}
// Recorded frames are slimmed (see simulate.rs): put back what the pages read.
function rpExpand(g){
  const F = RP.ix.fleet||[], id = i => typeof i==='number' ? F[i] : i;
  if(Array.isArray(g.trunkList)){ const n={}; g.trunkList = g.trunkList.map(t=>{ if(!Array.isArray(t)) return t; const a=id(t[0]), b=id(t[1]), k=a+'~'+b; n[k]=(n[k]||0)+1; return {a:a, b:b, used:t[2], uses:t[3], streak:t[4], cap:t[5]||RP.ix.cap||8, id:'trunk '+a+'–'+b+(n[k]>1?' #'+n[k]:''), gain:0}; }); }
  for(const c of g.callList||[]){
    if(c.bc!==undefined && !c.badge) c.badge = {color:c.bc};
    if(Array.isArray(c.hops) && typeof c.hops[0]==='number'){ const h=[]; for(let i=0;i+1<c.hops.length;i+=2) h.push([id(c.hops[i]), id(c.hops[i+1])]); c.hops=h; }
  }
  return g;
}
function rpLoad(d){
  if(RP.files.has(d)) return RP.files.get(d);
  const p = rpFetch(REPLAY+'day-'+String(d).padStart(3,'0')+'.json.gz').then(fs=>{ fs.forEach(f=>rpExpand(f.g)); return fs; }).catch(()=>[]);
  RP.files.set(d, p);
  for(const k of RP.files.keys()) if(Math.abs(k-d)>2) RP.files.delete(k);
  return p;
}
function rpSave(){ try{ sessionStorage.setItem('replay.at', JSON.stringify({day:RP.day, f:RP.f, rate:RP.rate, playing:RP.playing})); }catch(e){} }
async function rpShow(){
  const frames = await rpLoad(RP.day); if(!frames.length) return;
  RP.f = Math.min(RP.f, frames.length-1); const fr = frames[RP.f];
  // The footer clock runs at replay speed between frames.
  const s = Object.assign({}, fr.s, { fader: Object.assign({}, fr.s.fader||{}, { speed: RP.playing ? RP.ix.every*RP.rate : 0 }) });
  // A new day: its first frame carries the slow parts (trend history, clusters).
  if(RP.based!==RP.day && RP.f>0) TC.onGlobe.forEach(f=>{ try{ f(frames[0].g); }catch(e){} });
  RP.based = RP.day;
  applyStatus(s); TC.onGlobe.forEach(f=>{ try{ f(fr.g); }catch(e){} });
  const el = id => document.getElementById(id);
  if(el('rp-day') && document.activeElement!==el('rp-day')) el('rp-day').value = RP.day;
  if(el('rp-time') && document.activeElement!==el('rp-time')) el('rp-time').value = RP.f;
  setText('rp-when', rpDate(RP.day)+' · '+(fr.s.clock||'')+' UTC');
  if(RP.day+1 < RP.ix.days) rpLoad(RP.day+1);
}
function rpTick(){
  clearTimeout(RP.timer); if(!RP.playing) return;
  RP.timer = setTimeout(async ()=>{
    RP.f++; if(RP.f >= RP.ix.frames){ RP.f = 0; RP.day = (RP.day+1) % RP.ix.days; }
    await rpShow(); rpSave(); rpTick();
  }, 1000/RP.rate);
}
function rpPlay(on){ RP.playing = on; setText('rp-play', on?'⏸':'▶'); rpShow(); rpSave(); rpTick(); }
function startReplay(){
  fetch(REPLAY+'index.json').then(r=>r.json()).then(ix=>{
    RP.ix = ix; RP.day = ix.days-1; RP.f = 0;
    try{ const a = JSON.parse(sessionStorage.getItem('replay.at')); if(a && a.day < ix.days){ RP.day=a.day; RP.f=a.f; RP.rate=a.rate||1; RP.playing=a.playing!==false; } }catch(e){}
    const bar = document.createElement('div'); bar.id='replay';
    bar.innerHTML = '<b>Replay</b> <span class="muted">a simulated year, '+esc(rpDate(0))+' to '+esc(rpDate(ix.days-1))+'</span>'
      +'<button id="rp-play" class="small" title="play / pause">⏸</button>'
      +'<label>day <input id="rp-day" type="range" min="0" max="'+(ix.days-1)+'" step="1"></label>'
      +'<label>time <input id="rp-time" type="range" min="0" max="'+(ix.frames-1)+'" step="1"></label>'
      +'<label>speed <select id="rp-rate">'+RP_RATES.map(r=>'<option value="'+r+'"'+(r===RP.rate?' selected':'')+'>'+(r*ix.every/60)+' min/s</option>').join('')+'</select></label>'
      +'<b id="rp-when"></b>';
    document.querySelector('footer').prepend(bar);
    bar.querySelectorAll('button,input,select').forEach(e=>e.disabled=false);
    document.getElementById('rp-play').onclick = ()=>rpPlay(!RP.playing);
    document.getElementById('rp-day').oninput = e=>{ RP.day=Number(e.target.value); rpShow(); rpSave(); };
    document.getElementById('rp-time').oninput = e=>{ RP.f=Number(e.target.value); rpShow(); rpSave(); };
    document.getElementById('rp-rate').onchange = e=>{ RP.rate=Number(e.target.value); rpShow(); rpSave(); rpTick(); };
    rpPlay(RP.playing);
  }).catch(()=>{});
}
// Refresh <main> in place from the server: no reload, no flash, no scroll
// jump, and never while you are typing, selecting or pressing something.
let refreshing=false;
// The data terminal: every section of the page dealt into columns (three at
// least, one more per 560 px), each to the shortest so far, the same deal
// again on every refresh. Sashes resize; the widths are kept per page.
// Eight quadrants: on a wide screen the sections are dealt into a grid of
// four columns by two rows, eight panes that scroll on their own. The first
// eight sections get a pane each; any more go to the pane with the least in
// it. Sashes resize columns and rows (kept per page); double-click resets.
// Q, or the ▦ button in the header, flips between quadrants and columns.
function quadMode(){ let m=null; try{ m=localStorage.getItem('layout.mode'); }catch(e){} return window.innerWidth>=1200 && m!=='cols'; }
function toggleQuads(){ try{ localStorage.setItem('layout.mode', quadMode()?'cols':'quads'); }catch(e){} TC.colPlan=null; location.reload(); }
function layoutQuads(main, all){
  // Hidden sections (a device panel not open yet) take no cell of their own:
  // they ride in the pane of the section before them and show up there.
  const hidden = new Set(all.filter(it=>it.offsetParent===null));
  const items = all.filter(it=>!hidden.has(it)); if(!items.length) return;
  // Eight cells, four columns by two rows. With fewer than eight sections the
  // tallest (a map first) take a whole column each until the eight cells are
  // used: six sections make two full-height columns and four quadrants.
  const n = items.length, C = n>=4 ? 4 : n, T = n>=8 ? 0 : (n>=4 ? 8-n : C);
  const key = 'quads:'+location.pathname+':'+n;
  let st=null; try{ st=JSON.parse(localStorage.getItem(key)); }catch(e){}
  let fc = (st && Array.isArray(st.c) && st.c.length===C) ? st.c : Array(C).fill(1);
  let fr = (st && Array.isArray(st.r) && st.r.length===2) ? st.r : [1,1];
  const save = () => { try{ localStorage.setItem(key, JSON.stringify({c:fc, r:fr})); }catch(e){} };
  const tracks = a => a.map(f=>Math.max(0.05,f).toFixed(3)+'fr').join(' 5px ');
  const grid = document.createElement('div'); grid.className='quads';
  const apply = () => { grid.style.gridTemplateColumns=tracks(fc); grid.style.gridTemplateRows=tracks(fr); };
  apply();
  // Which sections stand tall: maps and canvases first, then the longest.
  const weight = it => (it.querySelector('canvas') ? 1e6 : 0) + (it.scrollHeight||it.offsetHeight||0);
  const tall = new Set(items.map((it,k)=>[weight(it),k]).sort((x,y)=>y[0]-x[0]).slice(0,T).map(x=>x[1]));
  const COLORS = ['#5a9bff','#3fb950','#f6c343','#ff6b6b','#b48cff','#e3a35a','#2bb3c0','#ff4fd8'];
  // Cells: tall columns on the left in page order, then quadrant pairs.
  const cells = []; let col = 0;
  items.forEach((it,k)=>{ if(tall.has(k) && col<C){ cells.push({col, row:0, span:true}); col++; } });
  const shortCols = []; for(let c=col;c<C;c++){ shortCols.push(c); cells.push({col:c,row:0}); cells.push({col:c,row:1}); }
  const panes = cells.map((c,k)=>{ const p=document.createElement('div'); p.className='pane'; p.dataset.q=k+1; p.style.setProperty('--qc', COLORS[k%8]); p.style.gridColumn=String(c.col*2+1); p.style.gridRow = c.span ? '1 / span 3' : String(c.row*2+1); grid.appendChild(p); return p; });
  for(let i=0;i<C-1;i++){ const sh=document.createElement('div'); sh.className='sash v'; sh.dataset.i=i; sh.style.gridColumn=String(i*2+2); sh.style.gridRow='1 / -1'; grid.appendChild(sh); }
  for(const c of shortCols){ const sh=document.createElement('div'); sh.className='sash h'; sh.dataset.c=c; sh.style.gridRow='2'; sh.style.gridColumn=String(c*2+1); grid.appendChild(sh); }
  const rest = Array.from(main.childNodes);
  main.appendChild(grid);
  // Deal: tall sections to the tall panes, the rest in order to the
  // quadrants; past eight, to the pane with the least in it.
  const plan = (TC.colPlan && TC.colPlan.key===key && TC.colPlan.ids.length===all.length) ? TC.colPlan.ids : null;
  const ids = [], load = Array(panes.length).fill(0); let nextTall = 0, nextShort = cells.findIndex(c=>!c.span), lastPane = 0, k = -1;
  all.forEach((it,a)=>{ let j;
    if(hidden.has(it)){ j = plan ? plan[a] : lastPane; panes[Math.min(j,panes.length-1)].appendChild(it); ids.push(j); return; }
    k++;
    if(plan) j=plan[a];
    else if(tall.has(k) && nextTall<panes.length && cells[nextTall] && cells[nextTall].span) j=nextTall++;
    else if(nextShort>=0 && nextShort<panes.length && !load[nextShort]) j=nextShort++;
    else { j=0; for(let i=1;i<panes.length;i++) if(load[i] < load[j]) j=i; }
    panes[j].appendChild(it); load[j] += it.offsetHeight||1; ids.push(j); lastPane = j; });
  TC.colPlan = {key, ids};
  for(const r of rest){ if(r.nodeType===1 && !all.includes(r) && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(r.tagName)) r.style.display='none'; }
  const paneAtCell = (c,r) => panes[cells.findIndex(x=>x.col===c && (x.span || x.row===r))];
  const drag = (sash, horizontal, i) => sash.addEventListener('pointerdown', e=>{ e.preventDefault(); sash.setPointerCapture(e.pointerId); sash.classList.add('drag');
    const arr = horizontal? fr : fc; const a = horizontal? paneAtCell(i,0) : paneAtCell(i,0), b = horizontal? paneAtCell(i,1) : paneAtCell(i+1,0);
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect(); const sa = horizontal? ra.height : ra.width, sb = horizontal? rb.height : rb.width; const x0 = horizontal? e.clientY : e.clientX; const j = horizontal? 0 : i; const sum = arr[j]+arr[j+1];
    const move = ev => { const d=(horizontal? ev.clientY : ev.clientX)-x0; const na=Math.max(120, Math.min(sa+sb-120, sa+d)); arr[j]=sum*na/(sa+sb); arr[j+1]=sum-arr[j]; apply(); window.dispatchEvent(new Event('resize')); };
    const up = () => { sash.classList.remove('drag'); sash.removeEventListener('pointermove',move); sash.removeEventListener('pointerup',up); save(); };
    sash.addEventListener('pointermove',move); sash.addEventListener('pointerup',up); });
  grid.querySelectorAll('.sash.v').forEach(sh=>drag(sh, false, Number(sh.dataset.i)));
  grid.querySelectorAll('.sash.h').forEach(sh=>drag(sh, true, Number(sh.dataset.c)));
  grid.querySelectorAll('.sash').forEach(sh=>sh.addEventListener('dblclick',()=>{ fc=Array(C).fill(1); fr=[1,1]; apply(); try{ localStorage.removeItem(key); }catch(e){} window.dispatchEvent(new Event('resize')); }));
  window.dispatchEvent(new Event('resize'));
}
// The layout switch in the header, and Q on the keyboard.
document.addEventListener('DOMContentLoaded',()=>{
  const nav=document.querySelector('header nav.views'); if(nav && !document.getElementById('quadbtn') && window.innerWidth>=1200){ const b=document.createElement('button'); b.id='quadbtn'; b.type='button'; b.className='small secondary'; b.title='Eight quadrants or columns (Q)'; b.textContent=quadMode()? '▦ 8' : '▥ cols'; b.addEventListener('click',toggleQuads); nav.parentNode.insertBefore(b, nav.nextSibling); }
  window.addEventListener('keydown', e=>{ if(e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return; if((e.key==='q'||e.key==='Q') && !e.ctrlKey && !e.metaKey && !e.altKey && window.innerWidth>=1200){ e.preventDefault(); toggleQuads(); } });
});
function layoutCols(){
  const main = document.querySelector('main'); if(!main) return;
  if(POP){ applyPop(); return; }
  addPops();
  if(window.innerWidth < 900){ return; }
  const items = [];
  const take = el => { for(const c of Array.from(el.children)){ if(/^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName) || c.classList.contains('cols')) continue; if(c.tagName==='SECTION' || !c.querySelector('section')){ if(c.offsetParent!==null || c.tagName==='SECTION') items.push(c); } else take(c); } };
  take(main);
  if(!items.length) return;
  if(quadMode() && items.length>=2){ layoutQuads(main, items); return; }
  const n = Math.max(3, Math.min(items.length, Math.floor(main.clientWidth/560)) || 3);
  const key = 'cols:'+location.pathname+':'+n;
  let fr = null; try{ fr = JSON.parse(localStorage.getItem(key)); }catch(e){}
  if(!Array.isArray(fr) || fr.length!==n) fr = Array(n).fill(1);
  const grid = document.createElement('div'); grid.className='cols';
  const cols = [];
  const tmpl = () => fr.map(f=>Math.max(0.05,f).toFixed(3)+'fr').join(' 5px ');
  grid.style.gridTemplateColumns = tmpl();
  for(let i=0;i<n;i++){ if(i){ const s=document.createElement('div'); s.className='sash'; s.dataset.i=i-1; grid.appendChild(s); } const c=document.createElement('div'); c.className='col'; grid.appendChild(c); cols.push(c); }
  // Keep what is left behind (scripts, templates) but out of the way.
  const rest = Array.from(main.childNodes);
  main.appendChild(grid);
  const plan = (TC.colPlan && TC.colPlan.key===key && TC.colPlan.ids.length===items.length) ? TC.colPlan.ids : null;
  const ids = [];
  items.forEach((it,k)=>{ let j; if(plan) j=plan[k]; else { j=0; for(let i=1;i<n;i++) if(cols[i].scrollHeight < cols[j].scrollHeight - 1) j=i; } cols[j].appendChild(it); ids.push(j); });
  TC.colPlan = {key, ids};
  // The emptied wrappers stay (their scripts may look them up) but hidden.
  for(const r of rest){ if(r.nodeType===1 && !items.includes(r) && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(r.tagName)) r.style.display='none'; }
  grid.querySelectorAll('.sash').forEach(sash=>{
    sash.addEventListener('pointerdown', e=>{ e.preventDefault(); sash.setPointerCapture(e.pointerId); sash.classList.add('drag'); const i=Number(sash.dataset.i); const a=cols[i], b=cols[i+1]; const wa=a.getBoundingClientRect().width, wb=b.getBoundingClientRect().width, x0=e.clientX, sum=fr[i]+fr[i+1];
      const move = ev => { const d=ev.clientX-x0; const na=Math.max(120, Math.min(wa+wb-120, wa+d)); fr[i]=sum*na/(wa+wb); fr[i+1]=sum-fr[i]; grid.style.gridTemplateColumns=tmpl(); window.dispatchEvent(new Event('resize')); };
      const up = () => { sash.classList.remove('drag'); sash.removeEventListener('pointermove',move); sash.removeEventListener('pointerup',up); try{ localStorage.setItem(key, JSON.stringify(fr)); }catch(e){} };
      sash.addEventListener('pointermove',move); sash.addEventListener('pointerup',up); });
    sash.addEventListener('dblclick',()=>{ fr=Array(n).fill(1); grid.style.gridTemplateColumns=tmpl(); try{ localStorage.removeItem(key); }catch(e){} window.dispatchEvent(new Event('resize')); });
  });
  window.dispatchEvent(new Event('resize'));
}
// The day strip stretches to the footer's width; its labels do not.
function fitStrip(){ const s=document.getElementById('daystrip'); if(!s) return; const w=s.getBoundingClientRect().width||960; s.style.setProperty('--ix', (960/w).toFixed(4)); }
window.addEventListener('resize', fitStrip);
async function refreshMain(force){
  if(!LIVE || refreshing || document.hidden) return;
  if(!force && (Date.now()-TC.interacting < 1500 || (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) || (window.getSelection && String(window.getSelection()).length>0))) return;
  refreshing=true;
  try{
    const r = await fetch(location.pathname+location.search,{cache:'no-store'}); const html = await r.text();
    const doc = new DOMParser().parseFromString(html,'text/html'); const nm = doc.querySelector('main'); const main=document.querySelector('main');
    if(nm && main){
      const open = new Set(Array.from(main.querySelectorAll('details[open]')).map(d=>d.dataset.id||d.id||d.querySelector('summary')?.textContent));
      const scrolls = Array.from(main.querySelectorAll('.scroll')).map(e=>e.scrollTop);
      const cs = Array.from(main.querySelectorAll(':scope>.cols>.col')).map(c=>c.scrollTop);
      // Live drawings (canvases and what draws on them) keep their element:
      // the script holding them never runs again, so a fresh one stays blank.
      const keep = Array.from(main.querySelectorAll('canvas[id],.tip[id],[data-keep][id]'));
      main.innerHTML = nm.innerHTML;
      keep.forEach(el=>{ const fresh=document.getElementById(el.id); if(fresh && fresh!==el) fresh.replaceWith(el); });
      layoutCols();
      main.querySelectorAll(':scope>.cols>.col').forEach((c,i)=>{ if(cs[i]!=null) c.scrollTop=cs[i]; });
      main.querySelectorAll('details').forEach(d=>{ const k=d.dataset.id||d.id||d.querySelector('summary')?.textContent; if(open.has(k)) d.open=true; });
      main.querySelectorAll('.scroll').forEach((e,i)=>{ if(scrolls[i]!=null) e.scrollTop=scrolls[i]; });
      cacheSet('main:'+location.pathname, nm.innerHTML);
      TC.onMain.forEach(f=>{ try{ f(); }catch(e){} });
    }
  }catch(e){}
  refreshing=false;
}
document.addEventListener('DOMContentLoaded',()=>{
  layoutCols(); fitStrip();
  document.querySelectorAll('details.frame').forEach(d=>{ try{ if(localStorage.getItem('open:'+d.dataset.id)==='1') d.open=true; d.addEventListener('toggle',()=>localStorage.setItem('open:'+d.dataset.id, d.open?'1':'0')); }catch(e){} });
  if(!LIVE){ document.querySelectorAll('button,input,select').forEach(e=>e.disabled=true); document.querySelectorAll('.live-only').forEach(e=>e.style.display='block'); return; }
  ['pointerdown','keydown','wheel'].forEach(ev=>document.addEventListener(ev,()=>TC.interacting=Date.now(),{passive:true}));
  // Section explanations fold away once the page has loaded; hover a heading's ⓘ to read one again.
  setTimeout(()=>document.body.classList.add('notes-folded'), 3000);
  const cached = cacheGet('status'); if(cached) applyStatus(cached);
  if(REPLAY) startReplay(); else connectWs();
  if(REFRESH_MS>0) setInterval(()=>refreshMain(false), REFRESH_MS);
  // The broadcast day in the footer: drag or click to scrub the clock.
  const strip = document.getElementById('daystrip');
  if(strip){
    let down=false, last=0;
    // The strip is in the anchor zone's local time; the clock is set in UTC.
    const hourAt = e => { const r=strip.getBoundingClientRect(); const pl=28/960, pr=12/960; const f=((e.clientX-r.left)/r.width - pl)/(1-pl-pr); return Math.min(24, Math.max(0, f*24)); };
    const send = e => { const lh=hourAt(e); const off=Number(strip.dataset.offset||0); TC.hour=((lh-off)%24+24)%24; TC.at=performance.now(); paintDay(); const now=Date.now(); if(now-last<120) return; last=now; api('/api/clock',{hour:((lh-off)%24+24)%24}).then(s=>{ if(s&&s.clock) setText('footclock', s.clock); }); };
    strip.addEventListener('pointerdown',e=>{down=true; send(e);});
    window.addEventListener('pointermove',e=>{ if(down) send(e); });
    window.addEventListener('pointerup',()=>{ down=false; });
  }
  // The fader, always ready to go.
  const sp = document.getElementById('qspeed'), run = document.getElementById('qrun');
  if(sp){ sp.addEventListener('input',()=>{ setText('qspeedv', sp.value+'×'); }); sp.addEventListener('change',()=>api('/api/fader/quick',{speed:Number(sp.value)})); }
  if(run){ run.addEventListener('click',()=>api('/api/fader/quick',{running: run.dataset.running!=='true'})); }
});

// Pop-out: ?pop=<section title> shows that one section alone, still live.
const POP = new URLSearchParams(location.search).get('pop');
function secKey(s){ const h=s.querySelector('h2'); if(!h) return ''; const t=h.firstChild; return ((t&&t.nodeType===3)?t.textContent:h.textContent).trim(); }
function addPops(){ if(POP) return; document.querySelectorAll('main section').forEach(s=>{ const h=s.querySelector('h2'); if(!h||h.querySelector('.pop')) return; const k=secKey(s); if(!k) return; const b=document.createElement('button'); b.type='button'; b.className='pop'; b.title='Pop out into its own window'; b.textContent='↗'; b.addEventListener('click',e=>{ e.preventDefault(); e.stopPropagation(); const u=new URL(location.href); u.search=''; u.searchParams.set('pop',k); window.open(u.toString(),'pop '+location.pathname+' '+k,'popup,width=960,height=720'); }); h.appendChild(b); }); }
function applyPop(){ document.body.classList.add('popped'); document.title=POP; const secs=Array.from(document.querySelectorAll('main section')); const hit=secs.find(s=>secKey(s)===POP); if(!hit) return; secs.forEach(s=>{ const show= s===hit || s.contains(hit) || hit.contains(s); s.style.display= show?'':'none'; }); hit.classList.add('popsel'); }
// The last four tabs opened, newest first, each with its top and bottom five.
const TOPN=5;
function topicPath(){ const p=location.pathname.replace(/\/$/,'')||'/'; const m={'/globe':'/','/discovery':'/continents','/lights':'/panels','/about':'/home'}; if(m[p]) return m[p]; if(p.startsWith('/panels')) return '/panels'; return p; }
function recentTopics(){ let r=[]; try{ r=JSON.parse(localStorage.getItem('tc:topics'))||[]; }catch(e){} return Array.isArray(r)?r:[]; }
function noteTopic(){ if(POP) return; const p=topicPath(); if(!document.querySelector('header nav.views a[href="'+p+'"]')) return; const r=recentTopics().filter(x=>x!==p); r.unshift(p); try{ localStorage.setItem('tc:topics', JSON.stringify(r.slice(0,4))); }catch(e){} }
function topicChart(t, items, kind){ const max=Math.max(1e-9,...items.map(i=>i[1])); const rows=items.length? items.map(([n,v])=>'<div class="tr"><span title="'+esc(n)+'">'+esc(n)+'</span><i><u style="width:'+(v/max*100).toFixed(1)+'%"></u></i><b>'+(Math.round(v*10)/10)+'</b></div>').join('') : '<div class="muted">nothing yet</div>'; return '<div class="tchart" style="--tc:'+t.colour+'"><div class="th"><b style="background:'+t.colour+';color:'+t.ink+'">'+esc(t.label)+'</b> '+kind+' '+TOPN+' <span class="muted">· '+esc(t.metric)+'</span></div>'+rows+'</div>'; }
// The Continents band: a heat aurora over the flat world. Each site is a
// curtain of light, taller and brighter the more calls it carries, green at
// the edge through cyan to violet at the core, shimmering as it breathes.
let AURORA=null, AURORA_LAND=null, AURORA_RAF=0;
// Viewer options, kept in this browser: intensity, colours and overlays.
const AURORA_PALETTES={ aurora:[[200,120,255],[70,220,255],[61,255,160]], fire:[[255,240,180],[255,140,40],[200,30,30]], ice:[[235,245,255],[120,180,255],[40,80,200]], mono:[[255,255,255],[190,200,215],[120,130,150]] };
const AURORA_DEFAULT={ intensity:0.5, palette:'aurora', land:true, grid:false, dots:false, labels:false };
function auroraOpts(){ let o={}; try{ o=JSON.parse(localStorage.getItem('aurora.opts'))||{}; }catch(e){} return Object.assign({}, AURORA_DEFAULT, o); }
function auroraSet(k,v){ const o=auroraOpts(); o[k]=v; try{ localStorage.setItem('aurora.opts', JSON.stringify(o)); }catch(e){} }
function auroraControls(){ const o=auroraOpts(); const ck=(k,l)=>'<label><input type="checkbox" '+(o[k]?'checked ':'')+'onchange="auroraSet(&quot;'+k+'&quot;,this.checked)">'+l+'</label>';
  return '<span class="aopts"><label>intensity <input type="range" min="0.1" max="1.5" step="0.05" value="'+o.intensity+'" oninput="auroraSet(&quot;intensity&quot;,Number(this.value))"></label><label>colours <select onchange="auroraSet(&quot;palette&quot;,this.value)">'+Object.keys(AURORA_PALETTES).map(p=>'<option'+(p===o.palette?' selected':'')+'>'+p+'</option>').join('')+'</select></label>'+ck('land','land')+ck('grid','grid')+ck('dots','sites')+ck('labels','labels')+'</span>'; }
function auroraChart(t){ const top=t.items.filter(i=>i[1]>0).slice(0,3).map(([n,v])=>esc(n)+' '+(Math.round(v*10)/10)).join(' · '); return '<div class="aurora" style="--tc:'+t.colour+'"><div class="th"><b style="background:'+t.colour+';color:'+t.ink+'">'+esc(t.label)+'</b> heat aurora <span class="muted">· live calls per site'+(top?' · '+top:'')+'</span>'+auroraControls()+'</div><canvas id="aurora-cv"></canvas></div>'; }
function auroraLoad(){ if(AURORA_LAND) return; AURORA_LAND=[]; fetch('/api/land').then(r=>r.json()).then(l=>{ AURORA_LAND=l; }).catch(()=>{}); }
function auroraFrame(ts){
  AURORA_RAF=0; const cv=document.getElementById('aurora-cv'); if(!cv||!AURORA) return;
  const dpr=window.devicePixelRatio||1, W=cv.clientWidth, H=cv.clientHeight; if(!W||!H){ AURORA_RAF=requestAnimationFrame(auroraFrame); return; }
  if(cv.width!==Math.round(W*dpr)||cv.height!==Math.round(H*dpr)){ cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr); }
  const g=cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.globalCompositeOperation='source-over'; g.fillStyle='#050914'; g.fillRect(0,0,W,H);
  const X=lon=>(lon+180)/360*W, Y=lat=>(84-lat)/(84+58)*H;
  const o=auroraOpts(), I=Math.max(0.05, Number(o.intensity)||0.5), P=AURORA_PALETTES[o.palette]||AURORA_PALETTES.aurora, rgba=(c,a)=>'rgba('+c[0]+','+c[1]+','+c[2]+','+Math.min(1,a*I).toFixed(3)+')';
  if(o.grid){ g.strokeStyle='rgba(143,163,199,0.18)'; g.lineWidth=0.5; g.beginPath(); for(let lon=-150;lon<180;lon+=30){ g.moveTo(X(lon),0); g.lineTo(X(lon),H); } for(let lat=-30;lat<84;lat+=30){ g.moveTo(0,Y(lat)); g.lineTo(W,Y(lat)); } g.stroke(); }
  g.fillStyle='#14213d'; g.strokeStyle='#26385f'; g.lineWidth=0.6;
  for(const ring of (o.land?AURORA_LAND:null)||[]){ g.beginPath(); let prev=null; for(let i=0;i<ring.length;i+=2){ const x=X(ring[i]), y=Y(ring[i+1]); if(prev!==null && Math.abs(x-prev)>W/2){ g.moveTo(x,y); } else if(i) g.lineTo(x,y); else g.moveTo(x,y); prev=x; } g.fill(); g.stroke(); }
  const max=Math.max(1e-9,...AURORA.map(h=>h[2])), s=ts/1000; g.globalCompositeOperation='lighter';
  for(const [lat,lon,v,name] of AURORA){
    const k=v/max, x=X(lon), y=Y(lat), ph=(lon*7.3+lat*3.1)%6.283, wob=0.75+0.25*Math.sin(s*1.7+ph);
    const r=4+k*Math.min(W,H)*0.55*wob*(0.6+0.4*Math.min(1,I)); if(v<=0){ g.fillStyle=rgba(P[2],0.25); g.fillRect(x-1,y-1,2,2); continue; }
    g.save(); g.translate(x+Math.sin(s*0.9+ph)*2, y); g.scale(0.55, 1.6);
    const gr=g.createRadialGradient(0,0,0,0,0,r);
    gr.addColorStop(0,rgba(P[0],0.55*k+0.25)); gr.addColorStop(0.3,rgba(P[1],0.45*k+0.15)); gr.addColorStop(0.65,rgba(P[2],0.3*k+0.08)); gr.addColorStop(1,rgba(P[2],0));
    g.fillStyle=gr; g.beginPath(); g.arc(0,0,r,0,6.283); g.fill(); g.restore();
  }
  g.globalCompositeOperation='source-over';
  if(o.dots){ g.fillStyle='rgba(255,255,255,0.75)'; for(const [lat,lon] of AURORA){ g.fillRect(X(lon)-1,Y(lat)-1,2,2); } }
  if(o.labels){ g.font='10px system-ui,sans-serif'; g.textAlign='center'; for(const [lat,lon,v,name] of AURORA.filter(h=>h[2]>0).sort((a,b)=>b[2]-a[2]).slice(0,6)){ const x=X(lon), y=Y(lat); g.fillStyle='rgba(5,9,20,0.7)'; const w=g.measureText(name).width+6; g.fillRect(x-w/2,y-17,w,13); g.fillStyle='#e6edf7'; g.fillText(name,x,y-7); } }
  if(!document.hidden) AURORA_RAF=requestAnimationFrame(auroraFrame);
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && AURORA && !AURORA_RAF) AURORA_RAF=requestAnimationFrame(auroraFrame); });
async function paintTopics(){ const box=document.getElementById('topics'); if(!box||POP) return; const recent=recentTopics(); let d=null; try{ d=await api('/api/topics'); }catch(e){} if(!d) return; let h=''; AURORA=null; for(const p of recent){ const t=d[p]; if(!t) continue; if(t.heat){ AURORA=t.heat; auroraLoad(); h+=auroraChart(t); continue; } const all=t.items; const nz=all.filter(i=>i[1]>0); const pool=nz.length>TOPN?nz:all; h+=topicChart(t, all.slice(0,TOPN), 'top')+topicChart(t, pool.slice(-TOPN).reverse(), 'bottom'); } box.innerHTML=h; box.style.display=h?'':'none'; if(h && !box.dataset.melt){ box.dataset.melt='1'; setTimeout(()=>box.classList.add('melted'), 4000); } if(AURORA && !AURORA_RAF) AURORA_RAF=requestAnimationFrame(auroraFrame); }
document.addEventListener('DOMContentLoaded',()=>{ noteTopic(); if(LIVE && !POP){ paintTopics(); setInterval(()=>{ if(!document.hidden) paintTopics(); }, Math.max(4000, REFRESH_MS||5000)); } });
"#;

/// Views with a drop-down: the tab opens the first, the menu lists them all.
const NAV_MENUS: &[(&str, &[(&str, &str)])] = &[("Panels", &[("/panels", "Panels"), ("/panels/editor", "Panel editor")])];

const NAV: &[(&str, &str)] = &[
    ("/", "Globe"),
    ("/continents", "Continents"),
    ("/overlord", "Overlord"),
    ("/panels", "Panels"),
    ("/usage", "Usage"),
    ("/racks", "Racks"),
    ("/relay", "Relay"),
    ("/users", "Users"),
    ("/crosspoints", "Cross points"),
    ("/simulator", "Simulator"),
    ("/analyzer", "Analyzer"),
    ("/home", "About"),
];

fn page(title: &str, rt: &Runtime, live: bool, refresh_ms: u32, body: &str) -> String {
    let mut nav = String::new();
    let href = |path: &str| if live { path.to_string() } else { format!("{}{}", rt.endpoint, path) };
    for (i, (path, label)) in NAV.iter().enumerate() {
        let (bg, ink) = topic_colour(i);
        let colour = format!(r#" style="--tc:{bg};--tf:{ink}""#);
        if let Some((_, items)) = NAV_MENUS.iter().find(|(l, _)| l == label) {
            let on = items.iter().any(|(_, l)| *l == title);
            let _ = write!(nav, r#"<div class="dd"{colour}><a href="{}"{}>{} ▾</a><div class="menu">"#, esc(&href(path)), if on { " class=\"on\"" } else { "" }, label);
            for (p, l) in items.iter() {
                let _ = write!(nav, r#"<a href="{}"{}>{}</a>"#, esc(&href(p)), if *l == title { " class=\"on\" aria-current=\"page\"" } else { "" }, l);
            }
            nav.push_str("</div></div>");
            continue;
        }
        let on = if *label == title { " class=\"on\" aria-current=\"page\"" } else { "" };
        let _ = write!(nav, r#"<a href="{}"{on}{colour}>{}</a>"#, esc(&href(path)), label);
    }
    let st = rt.status();
    let mode = if !live {
        "Static snapshot".to_string()
    } else if refresh_ms > 0 {
        format!("Live · refreshes every {}s", (refresh_ms as f64 / 1000.0).max(1.0).round() as u32)
    } else {
        "Live".to_string()
    };
    let uptime = format!("since {}", rt.started_at);
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{CSS}</style><script>const REFRESH_MS={refresh_ms};const BUILD="{build}";{JS}</script></head>
<body><header><h1>Trunk-Caster</h1><nav class="views" aria-label="Views">{nav}</nav></header><div id="topics" style="display:none" aria-label="Top and bottom of the last four tabs opened"></div>
<div id="blackout-banner" style="display:{bdisp};background:var(--bad);color:#fff;text-align:center;padding:6px;font-weight:600">Daily reset: everything is disconnected and every sender reset until {bend:02}:00 UTC. Traffic reconnects then.</div>
<main><p class="live-only note" style="display:none">Static snapshot. Open <a href="{ep}/">{ep}</a> while the runtime is serving for live controls.</p>
{body}</main>
<footer><div class="strip">{day}</div>
<div class="status"><span class="stats">site <b>{site}</b> · UTC <b id="hdr-clock">{clock}</b> · <span id="hdr-stats">{frames} frames · {trunks} trunks · {conns} live · load ×{mult:.1}</span></span><span><span class="dot{dot}"></span>{mode}</span><span><a href="{ep}/">{ep}</a> · wire v{wire} · {shape} · up {up}</span><span class="right" title="build {build}">Trunk-Caster {ver} · updated {when}</span></div></footer></body></html>"#,
        day = day_timeline(rt),
        bdisp = if rt.blackout_active { "block" } else { "none" },
        bend = rt.fader.day.blackout.end_hour as u32,
        title = esc(title),
        site = esc(&rt.site),
        clock = rt.clock(),
        mult = rt.load_multiplier(),
        frames = st.frames,
        trunks = st.trunks,
        conns = st.connections,
        when = esc(&st.updated_at),
        ep = esc(&rt.endpoint),
        dot = if live { " live" } else { "" },
        mode = mode,
        wire = st.wire_version,
        shape = format!("{} casters/frame · {} ch/trunk", st.shape.casters_per_frame, st.shape.channels_per_trunk),
        up = esc(&uptime),
        ver = env!("CARGO_PKG_VERSION"),
        build = env!("TC_BUILD"),
    )
}

fn tile(label: &str, value: impl std::fmt::Display) -> String {
    format!(r#"<div class="tile"><b>{value}</b><span>{}</span></div>"#, esc(label))
}

fn frame_options(rt: &Runtime) -> String {
    let mut s = String::new();
    for f in &rt.state.frames {
        let _ = write!(s, r#"<option value="{0}">{0} · {1} free</option>"#, esc(&f.id), rt.state.free_casters(&f.id));
    }
    s
}

/// 95s -> "1m 35s", 3700s -> "1h 1m".
pub fn dur(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else if secs < 86_400 {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}d {:02}h", secs / 86_400, (secs % 86_400) / 3600)
    }
}

fn dur_f(secs: f64) -> String {
    dur(secs.max(0.0) as u64)
}

fn ago(rt: &Runtime, frame: &str, now: u64) -> String {
    match rt.state.seconds_since_last(frame, now) {
        Some(0) => "<span class=\"ok\">live now</span>".into(),
        Some(s) => {
            let who = rt.state.last_activity.get(frame).map(|a| esc(&a.who)).unwrap_or_default();
            format!("{} ago <span class=\"muted\">({who})</span>", dur(s))
        }
        None => "<span class=\"muted\">never</span>".into(),
    }
}

fn kind_str(k: RouteKind) -> &'static str {
    match k {
        RouteKind::Direct => "direct",
        RouteKind::Via => "via",
    }
}

fn route_str(c: &Connection) -> String {
    std::iter::once(c.from_frame.clone())
        .chain(c.hops.iter().map(|h| h.to.clone()))
        .map(|f| esc(&f))
        .collect::<Vec<_>>()
        .join(" → ")
}

/// Shared connections table.
fn connections_table(rt: &Runtime, conns: &[&Connection], now: u64) -> String {
    let mut b = String::from(
        "<div class=\"scroll\"><table><tr><th>Who</th><th>For</th><th>From</th><th>To</th><th>Route</th><th>Connected for</th><th>GPIO</th><th>Origin</th><th></th></tr>",
    );
    for c in conns {
        let _ = write!(
            b,
            r#"<tr><td><b>{who}</b><br><code class="muted">{id}</code></td><td>{why}<br><span class="muted">{where_}</span></td><td>{from}:{fp}</td><td>{to}:{tp}</td><td class="kind-{kind}">{kind} · {route}</td><td>{wall}<br><span class="muted">sim {sim}</span></td><td>{gpio} <button class="small secondary" onclick="gpio('{id}')">send</button></td><td class="muted">{origin}</td><td><button class="small secondary" onclick="api('/api/release',{{id:'{id}'}}).then(()=>reload())">release</button></td></tr>"#,
            who = esc(&c.who),
            id = esc(&c.id),
            why = esc(c.why.as_deref().unwrap_or("")),
            where_ = esc(c.where_.as_deref().unwrap_or("")),
            from = esc(&c.from_frame),
            fp = user_port(c.from_port),
            to = esc(&c.to_frame),
            tp = user_port(c.to_port),
            kind = kind_str(c.kind),
            route = route_str(c),
            wall = dur(c.connected_for(now)),
            sim = dur_f(c.connected_for_sim(rt.sim_time)),
            gpio = c.gpio_sent,
            origin = esc(&c.origin),
        );
    }
    if conns.is_empty() {
        b.push_str("<tr><td colspan=\"9\" class=\"muted\">Nothing live.</td></tr>");
    }
    b.push_str("</table></div>");
    b
}

fn sorted_connections(rt: &Runtime) -> Vec<&Connection> {
    let mut conns: Vec<&Connection> = rt.state.connections.iter().collect();
    conns.sort_by(|a, b| b.granted_unix.cmp(&a.granted_unix).then(b.id.cmp(&a.id)));
    conns
}

/// Hours of a clock as "HH:MM" / "HH:MM:SS".
fn hm(hours: f64) -> String {
    let t = (hours.rem_euclid(24.0) * 3600.0).round() as u64;
    format!("{:02}:{:02}", t / 3600, (t % 3600) / 60)
}
fn hms(hours: f64) -> String {
    let t = (hours.rem_euclid(24.0) * 3600.0).round() as u64 % 86_400;
    format!("{:02}:{:02}:{:02}", t / 3600, (t % 3600) / 60, t % 60)
}

/// The broadcast day as a strip, labelled in the anchor zone's local time
/// (Saskatchewan: Central Standard, never changes): the world clocks riding
/// along the top (they slide with the day), overnight, hourly news rushes,
/// radio prep, the newscasts (06, 12, 18), the daily reset, the load curve,
/// "now", and which clock is at 6 am, noon and 6 pm. Lives in the footer of
/// every page and can be scrubbed.
fn day_timeline(rt: &Runtime) -> String {
    let d = &rt.fader.day;
    let anchor = rt.globe.anchor();
    let off = anchor.offset_hours;
    let (w, h) = (960.0_f64, 94.0_f64);
    let (pl, pr, top, bh) = (28.0, 12.0, 36.0, 28.0);
    // x is in anchor-local hours; UTC things are shifted by the offset.
    let x = |hour: f64| pl + hour.clamp(0.0, 24.0) / 24.0 * (w - pl - pr);
    let xu = |utc_hour: f64| x((utc_hour + off).rem_euclid(24.0));
    let utc_h = rt.time_of_day() / 3600.0;
    let mut s = String::new();
    let _ = write!(s, r#"<svg id="daystrip" class="day" data-offset="{off}" data-anchor="{}" viewBox="0 0 {w} {h}" preserveAspectRatio="none" role="img" aria-label="Broadcast day in {} time, world clocks along the top: drag to scrub the clock">"#, esc(&anchor.name), esc(&anchor.name));
    // The world clocks, riding on the day: each sits where its own local
    // time falls on the strip, so they slide along together.
    let _ = write!(s, r#"<line class="rail" x1="{pl}" x2="{}" y1="18" y2="18"/>"#, w - pr);
    for zone in &rt.globe.zones {
        let zl = (utc_h + zone.offset_hours).rem_euclid(24.0);
        let ta = if zl < 1.5 { "start" } else if zl > 22.5 { "end" } else { "middle" };
        let _ = write!(
            s,
            r#"<g class="zone{}" data-offset="{}" data-name="{}" transform="translate({:.1},0)"><circle cy="18" r="4"/><text y="9" text-anchor="{ta}">{}</text><text class="clk" y="31" text-anchor="{ta}">{}</text></g>"#,
            if zone.anchor { " anchor" } else { "" },
            zone.offset_hours,
            esc(&zone.name),
            x(zl),
            esc(&zone.name),
            hm(zl)
        );
    }
    let _ = write!(s, r#"<rect class="band" x="{pl}" y="{top}" width="{}" height="{bh}" rx="3"/>"#, w - pl - pr);
    if d.enabled {
        let _ = write!(s, r#"<rect class="night" x="{}" y="{top}" width="{}" height="{bh}"/>"#, x(0.0), x(5.0) - x(0.0));
        for i in 0..24 {
            let i = i as f64;
            let _ = write!(s, r#"<rect class="news" x="{:.1}" y="{top}" width="{:.1}" height="{bh}"><title>{:02}:00 television news rush</title></rect>"#, x(i - 5.0 / 60.0), x(i + 10.0 / 60.0) - x(i - 5.0 / 60.0), i as u32);
            let _ = write!(s, r#"<rect class="radio" x="{:.1}" y="{}" width="{:.1}" height="{}"><title>{:02}:30 radio prep</title></rect>"#, x(i + 25.0 / 60.0), top + bh * 0.5, x(i + 35.0 / 60.0) - x(i + 25.0 / 60.0), bh * 0.5, i as u32);
        }
        for n in &d.newscasts {
            let _ = write!(s, r#"<rect class="main" x="{:.1}" y="{top}" width="{:.1}" height="{bh}"><title>{:02}:00 television newscast ×{}: builds from {:02}:00, peaks {:02}:45 to {:02}:30</title></rect>"#, x(n.hour - 1.0), x(n.hour + 1.0) - x(n.hour - 1.0), n.hour as u32, n.peak, (n.hour - 1.0).max(0.0) as u32, (n.hour - 1.0).max(0.0) as u32, n.hour as u32);
        }
        // Load curve, sampled every 5 minutes, scaled to the band.
        let peak = d.biggest_peak();
        let mut path = String::new();
        for i in 0..=288 {
            let hour = i as f64 / 12.0;
            let m = d.multiplier(hour * 3600.0);
            let y = top + bh - (m / peak) * (bh - 2.0);
            let _ = write!(path, "{}{:.1},{:.1} ", if i == 0 { "M" } else { "L" }, x(hour), y);
        }
        let _ = write!(s, r#"<path class="curve" d="{path}"><title>load multiplier through a site's local day (peak ×{peak:.0})</title></path>"#);
    }
    // Productions on air, in the studio's local day, drawn as a thin bar
    // under the band.
    for (i, p) in rt.fader.productions.iter().enumerate().filter(|(_, p)| p.enabled && p.start_hour >= 0.0 && p.end_hour >= 0.0) {
        let y = top + bh + 1.0 + (i % 3) as f64 * 2.0;
        let title = format!("{}: on air {:02}:00 to {:02}:00 studio time at {}", p.name, p.start_hour as u32, p.end_hour as u32, p.studio);
        if p.start_hour <= p.end_hour {
            let _ = write!(s, r#"<rect x="{:.1}" y="{y:.1}" width="{:.1}" height="2" fill="var(--via)"><title>{}</title></rect>"#, x(p.start_hour), x(p.end_hour) - x(p.start_hour), esc(&title));
        } else {
            let _ = write!(s, r#"<rect x="{:.1}" y="{y:.1}" width="{:.1}" height="2" fill="var(--via)"><title>{}</title></rect><rect x="{:.1}" y="{y:.1}" width="{:.1}" height="2" fill="var(--via)"/>"#, x(p.start_hour), x(24.0) - x(p.start_hour), esc(&title), x(0.0), x(p.end_hour) - x(0.0));
        }
    }
    // The fixed marks of the day, inside the band.
    let ty = top + bh / 2.0 + 4.0;
    let _ = write!(s, r#"<text class="mark" x="{:.1}" y="{ty:.1}" text-anchor="start">MIDNIGHT</text><text class="mark" x="{:.1}" y="{ty:.1}" text-anchor="middle">6 AM</text><text class="mark" x="{:.1}" y="{ty:.1}" text-anchor="middle">NOON</text><text class="mark" x="{:.1}" y="{ty:.1}" text-anchor="middle">6 PM</text><text class="mark" x="{:.1}" y="{ty:.1}" text-anchor="end">MIDNIGHT</text>"#, x(0.0) + 3.0, x(6.0), x(12.0), x(18.0), x(24.0) - 3.0);
    for i in (0..=24).step_by(3) {
        let _ = write!(s, r#"<text x="{:.1}" y="{}" text-anchor="middle">{:02}:00</text>"#, x(i as f64), top + bh + 13.0, i % 24);
    }
    if d.enabled && d.olympics.enabled {
        // The Olympics are set in UTC, one moment for the globe; draw them
        // where they fall in anchor time (they may wrap).
        let o = &d.olympics;
        let (os, oe) = ((o.hour + off).rem_euclid(24.0), (o.hour + o.hours + off).rem_euclid(24.0));
        let title = format!("Olympics ×{} everywhere at once, {} to {} UTC ({} to {} {}); callers into {}", o.peak, hm(o.hour), hm((o.hour + o.hours).rem_euclid(24.0)), hm(os), hm(oe), anchor.name, if o.venue.is_empty() { "a capital" } else { o.venue.as_str() });
        if os <= oe {
            let _ = write!(s, r#"<rect class="oly" x="{:.1}" y="{top}" width="{:.1}" height="{bh}"><title>{}</title></rect>"#, x(os), x(oe) - x(os), esc(&title));
        } else {
            let _ = write!(s, r#"<rect class="oly" x="{:.1}" y="{top}" width="{:.1}" height="{bh}"><title>{}</title></rect><rect class="oly" x="{:.1}" y="{top}" width="{:.1}" height="{bh}"/>"#, x(os), x(24.0) - x(os), esc(&title), x(0.0), x(oe) - x(0.0));
        }
        let _ = write!(s, r#"<text class="olyt" x="{:.1}" y="{:.1}" text-anchor="start">OLYMPICS</text>"#, x(os) + 2.0, top + 10.0);
    }
    if d.blackout.enabled {
        // The reset is set in UTC; draw it where it falls in anchor time (it may wrap).
        let (bs, be) = ((d.blackout.start_hour + off).rem_euclid(24.0), (d.blackout.end_hour + off).rem_euclid(24.0));
        let title = format!("daily reset {:02}:00 to {:02}:00 UTC ({} to {} {}): everything disconnects, senders reset, reconnect after", d.blackout.start_hour as u32, d.blackout.end_hour as u32, hm(bs), hm(be), anchor.name);
        if bs <= be {
            let _ = write!(s, r#"<rect x="{:.1}" y="{top}" width="{:.1}" height="{bh}" fill="var(--bad)" opacity=".55"><title>{}</title></rect>"#, x(bs), x(be) - x(bs), esc(&title));
        } else {
            let _ = write!(s, r#"<rect x="{:.1}" y="{top}" width="{:.1}" height="{bh}" fill="var(--bad)" opacity=".55"><title>{}</title></rect><rect x="{:.1}" y="{top}" width="{:.1}" height="{bh}" fill="var(--bad)" opacity=".55"/>"#, x(bs), x(24.0) - x(bs), esc(&title), x(0.0), x(be) - x(0.0));
        }
    }
    // Which clock is at 6 am, noon, 6 pm (and midnight) right now.
    let mut at: Vec<(f64, &str, &str)> = Vec::new();
    for zone in &rt.globe.zones {
        let zl = (utc_h + zone.offset_hours).rem_euclid(24.0);
        for (k, word) in [(6.0, "6 am"), (12.0, "noon"), (18.0, "6 pm"), (0.0, "midnight")] {
            let dd = (zl - k).abs().min(24.0 - (zl - k).abs());
            if dd <= 1.5 {
                at.push((k, word, zone.name.as_str()));
            }
        }
    }
    let mut parts: Vec<String> = Vec::new();
    for (k, word) in [(6.0, "6 am"), (12.0, "noon"), (18.0, "6 pm"), (0.0, "midnight")] {
        let names: Vec<&str> = at.iter().filter(|(kk, _, _)| *kk == k).map(|(_, _, n)| *n).collect();
        if !names.is_empty() {
            parts.push(format!("{word} in {}", names.join(" and ")));
        }
    }
    let whatis = if parts.is_empty() { "no clock within 90 minutes of 6 am, noon or 6 pm".to_string() } else { parts.join(" · ") };
    let _ = write!(s, r#"<line class="now" x1="{:.1}" x2="{:.1}" y1="{}" y2="{}"/><text class="whatis" x="{pl}" y="{}" text-anchor="start">{}</text><text class="nowlabel" x="{:.1}" y="{}" text-anchor="end">{} {} · {} UTC · ×{:.1}</text>"#, xu(utc_h), xu(utc_h), top - 3.0, top + bh + 3.0, h - 4.0, esc(&whatis), w - pr, h - 4.0, hms(utc_h + off), esc(&anchor.name), rt.clock(), rt.load_multiplier());
    let _ = write!(s, r#"<rect class="scrub" x="{pl}" y="0" width="{}" height="{h}"><title>drag to scrub the clock</title></rect>"#, w - pl - pr);
    s.push_str("</svg>");
    s
}

fn last_connection_overall(rt: &Runtime, now: u64) -> String {
    match rt.state.last_activity.values().map(|a| a.unix).max() {
        Some(u) => format!("{} ago", dur(now.saturating_sub(u))),
        None => "never".into(),
    }
}

// ---------------------------------------------------------------------------

pub fn index_page(rt: &Runtime) -> String {
    let mut b = String::new();
    let st = rt.status();
    let _ = write!(
        b,
        r#"<section><h2>What is running</h2><div class="tiles">{}{}{}{}{}{}</div>
<p>Trunk-Caster speaks by protocol, not by brand. Every protocol found in the manuals is advertised as {fpp} frames of {up}+{cp} ports; a caster is a trunk port and a trunk between two casters carries {ch} channels. Any frame can reach any other frame directly, or <em>via</em> another frame when the direct capacity runs out. Every crosspoint is expressed in the Ward-Beck line <code>SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE</code>.</p>
<p class="note">Root: <code>{root}</code> · up since {since} · API: <code>{ep}/api/status</code> · plans and SDK in <code>TRUNK-CASTER-SDK</code></p></section>"#,
        tile("protocols", st.protocols),
        tile("frames", st.frames),
        tile("trunks", st.trunks),
        tile("live connections", st.connections),
        tile("manuals read", rt.repertoire.documents),
        tile("sim speed", format!("{}×", rt.fader.speed)),
        fpp = rt.shape.frames_per_protocol,
        up = rt.shape.user_ports,
        cp = rt.shape.casters_per_frame,
        ch = rt.shape.channels_per_trunk,
        root = esc(&rt.layout.root.display().to_string()),
        since = esc(&rt.started_at),
        ep = esc(&rt.endpoint),
    );

    b.push_str("<section><h2>Protocol repertoire</h2><table><tr><th>Protocol</th><th>Family</th><th>Implemented by</th><th>Type (from manuals)</th><th>Trunking notes</th></tr>");
    for p in &rt.repertoire.protocols {
        let vendors: Vec<String> = p
            .implementations
            .iter()
            .map(|i| match &i.flavor {
                Some(f) => format!("{} ({})", esc(&i.vendor), esc(f)),
                None => esc(&i.vendor),
            })
            .collect();
        let kind = p.kind().unwrap_or_default().to_string();
        let mut notes: Vec<String> = Vec::new();
        if let Some(n) = &p.digest.trunking_notes {
            notes.push(format!("<b>protocol</b>: {}", esc(n)));
        }
        notes.extend(
            p.implementations
                .iter()
                .filter_map(|i| i.digest.trunking_notes.as_ref().map(|n| format!("<b>{}</b>: {}", esc(&i.vendor), esc(n)))),
        );
        let _ = write!(
            b,
            "<tr><td><b>{}</b> <code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td class=\"note\">{}</td></tr>",
            esc(&p.name),
            esc(&p.id),
            p.family.label(),
            vendors.join(", "),
            esc(&kind),
            notes.join("<br>")
        );
    }
    let _ = write!(
        b,
        "<tr><td><b>{}</b> <code>relay</code></td><td>Other</td><td>{}</td><td>Relay hosted on this computer</td><td class=\"note\">{} matrices, see <a href=\"/relay\">Relay</a></td></tr>",
        esc(&rt.relay.protocol_name),
        esc(&rt.relay.host),
        rt.relay.matrices.len()
    );
    b.push_str("</table></section>");

    // Remote frames: the simulator containers (later real frames) speaking
    // Ward-Beck lines on the caster's TCP port.
    let remotes = rt.remote_list();
    let connected = remotes.iter().filter(|r| r.connected).count();
    let mq = rt.hub.mqtt_stats();
    let mqtt_tiles = match &mq {
        Some(m) => format!(
            "{}{}{}",
            tile(if m.connected { "MQTT ● up" } else { "MQTT ○ down" }, &m.broker),
            tile("double validated", remotes.iter().map(|r| r.mqtt_acks).sum::<u64>()),
            tile("rejected (one path)", remotes.iter().map(|r| r.rejects).sum::<u64>())
        ),
        None => tile("MQTT", "off"),
    };
    let _ = write!(
        b,
        r#"<section><h2>Intercom simulators and remote frames</h2><div class="tiles">{}{}{}{}{}</div><p class="note">Each intercom simulator is its own container hosting one protocol's frames. It connects to the Ward-Beck port <code>{}</code>, announces its frames, receives every CLOSE/OPEN line for them, echoes each one back as its acknowledgement, and checks in periodically. In parallel every line is published to the MQTT broker; the simulator applies a line only when the copy from the Ward-Beck port and the copy from MQTT agree, acks it over both, and rejects a copy whose twin never arrives. Start them with <code>docker compose --profile sims up -d</code>.</p>"#,
        tile("remote frames", remotes.len()),
        tile("connected", connected),
        tile("lines received", rt.remotes.lines_in),
        tile("bad lines", rt.hub.bad_lines()),
        mqtt_tiles,
        esc(rt.wb_endpoint.as_deref().unwrap_or("disabled"))
    );
    if !remotes.is_empty() {
        let mut by_proto: BTreeMap<String, Vec<&RemoteFrame>> = BTreeMap::new();
        for r in &remotes {
            let proto = rt.state.frame(&r.frame).map(|f| f.protocol_name.clone()).unwrap_or_else(|| "?".into());
            by_proto.entry(proto).or_default().push(r);
        }
        b.push_str("<div class=\"scroll\"><table><tr><th>Protocol</th><th>Frames hosted</th><th>Peer</th><th>Connected</th><th>Lines sent / acked</th><th>MQTT ✓✓ / rejected</th><th>Check-ins</th><th>Reported vs ours</th><th>Last seen</th></tr>");
        for (proto, list) in by_proto {
            let sent: u64 = list.iter().map(|r| r.lines_sent).sum();
            let acks: u64 = list.iter().map(|r| r.acks).sum();
            let mqtt_acks: u64 = list.iter().map(|r| r.mqtt_acks).sum();
            let rejects: u64 = list.iter().map(|r| r.rejects).sum();
            let checkins: u64 = list.iter().map(|r| r.checkins).sum();
            let reported: usize = list.iter().map(|r| r.reported_closed).sum();
            let ours: usize = list.iter().map(|r| rt.crosspoints.current.iter().filter(|c| c.frame == r.frame).count()).sum();
            let up = list.iter().filter(|r| r.connected).count();
            let last = list.iter().map(|r| r.last_seen.as_str()).max().unwrap_or("");
            let _ = write!(
                b,
                r#"<tr><td><b>{}</b></td><td>{}</td><td class="muted">{}</td><td class="{}">{}/{}</td><td>{} / {}</td><td class="{}">{} / {}</td><td>{}</td><td class="{}">{} vs {}</td><td class="muted">{}</td></tr>"#,
                esc(&proto),
                list.len(),
                esc(&list[0].peer),
                if up == list.len() { "ok" } else { "warn" },
                up,
                list.len(),
                sent,
                acks,
                if rejects == 0 { "ok" } else { "warn" },
                mqtt_acks,
                rejects,
                checkins,
                if reported == ours { "ok" } else { "warn" },
                reported,
                ours,
                esc(last)
            );
        }
        b.push_str("</table></div>");
    }
    b.push_str("</section>");

    b.push_str("<section><h2>Recent log</h2><div class=\"scroll\"><code>");
    for l in rt.log.iter().rev().take(40) {
        let _ = write!(b, "{}<br>", esc(l));
    }
    b.push_str("</code></div></section>");
    page("About", rt, true, 5000, &b)
}

// ---------------------------------------------------------------------------

pub fn usage_page(rt: &Runtime, live: bool) -> String {
    let st = &rt.state;
    let now = util::now_unix();
    let mut b = String::new();

    let _ = write!(
        b,
        r#"<section><h2>Any to any</h2>
<form class="row" onsubmit="event.preventDefault();api('/api/request',{{who:val('who')||'operator',from:val('from'),to:val('to'),why:val('why')||null,where:val('where')||null,gpio:(num('pin')?[{{pin:num('pin'),state:true,note:'call light'}}]:[])}}).then(r=>{{show('req-result',r);reload(900)}})">
<label>Who<input id="who" placeholder="operator"></label>
<label>From frame<select id="from">{opts}</select></label>
<label>To frame<select id="to">{opts}</select></label>
<label>Why<input id="why" placeholder="reason"></label>
<label>Where<input id="where" placeholder="location"></label>
<label>GPIO pin on connect<input id="pin" type="number" min="1" max="8" placeholder="none" style="width:90px"></label>
<button type="submit">Connect</button></form>
<p class="note">Direct trunk when there is one with room or both frames have a free caster; otherwise the router goes <span class="kind-via">via</span> another frame. The user ports take the caller's name. A request can also be dropped as JSON into <code>TRUNK-CASTER-INTERFACE</code>.</p>
<div id="req-result" class="result"></div></section>"#,
        opts = frame_options(rt)
    );

    let _ = write!(
        b,
        r#"<section><h2>Capacity</h2><div class="tiles">{}{}{}{}{}{}{}</div></section>"#,
        tile("frames", st.frames.len()),
        tile("trunks up", st.trunks.len()),
        tile("live connections", st.connections.len()),
        tile("via connections", st.connections.iter().filter(|c| c.kind == RouteKind::Via).count()),
        tile("channel utilisation", format!("{:.0}%", st.channel_utilization() * 100.0)),
        tile("caster utilisation", format!("{:.0}%", st.caster_utilization() * 100.0)),
        tile("last connection", last_connection_overall(rt, now)),
    );

    // Graphs: calls per protocol and how loaded the trunks are.
    {
        let mut per_proto: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        for c in &st.connections {
            if let Some(f) = st.frame(&c.from_frame) {
                let e = per_proto.entry(f.protocol_name.as_str()).or_default();
                e.0 += 1;
                if c.muted {
                    e.1 += 1;
                }
            }
        }
        let cats: Vec<&str> = per_proto.keys().copied().collect();
        let series: Vec<(&str, &str, Vec<f64>)> = vec![
            ("live calls (from)", "var(--used)", per_proto.values().map(|v| v.0 as f64).collect()),
            ("parked", "var(--muted)", per_proto.values().map(|v| v.1 as f64).collect()),
        ];
        let calls_chart = bar_chart("Calls by the caller's protocol", &cats, &series);
        let cap = rt.shape.channels_per_trunk.max(1);
        let mut hist = vec![0.0; cap + 1];
        for t in &st.trunks {
            hist[t.used().min(cap)] += 1.0;
        }
        let labels: Vec<String> = (0..=cap).map(|i| format!("{i} ch")).collect();
        let lref: Vec<&str> = labels.iter().map(String::as_str).collect();
        let hist_chart = bar_chart("Trunks by channels in use", &lref, &[("trunks", "var(--used)", hist)]);
        let _ = write!(b, "<section><h2>Graphs</h2>{calls_chart}{hist_chart}</section>");
    }

    // Usage per region: every site at its own local time.
    let regions = rt.regions();
    b.push_str("<section><h2>Usage per region</h2><p class=\"note\">Every site follows its own local clock (solar time from its longitude); the 06:00, 12:00 and 18:00 surges sweep around the globe. Capitals host 10 frames, provinces 1, smaller cities an 8×8 and a 2×2. Managed in <code>TRUNK-GLOBAL/sites.json</code>.</p><div class=\"scroll\" style=\"max-height:40vh\"><table><tr><th>Site</th><th>Country</th><th>Tier</th><th>Frames</th><th>Local clock</th><th>Load</th><th>Calls</th><th>Trunks</th><th>Panels live</th></tr>");
    let mut sorted: Vec<&serde_json::Value> = regions.iter().collect();
    sorted.sort_by(|a, b| b["load"].as_f64().partial_cmp(&a["load"].as_f64()).unwrap_or(std::cmp::Ordering::Equal).then(b["calls"].as_u64().cmp(&a["calls"].as_u64())));
    for r in sorted {
        let load = r["load"].as_f64().unwrap_or(1.0);
        let _ = write!(
            b,
            r#"<tr><td><b>{}</b></td><td class="muted">{}</td><td class="muted">{}</td><td>{}</td><td><b>{}</b></td><td class="{}">×{:.1}</td><td>{}</td><td>{}</td><td>{}</td></tr>"#,
            esc(r["site"].as_str().unwrap_or("")),
            esc(r["country"].as_str().unwrap_or("")),
            esc(r["tier"].as_str().unwrap_or("")),
            r["frames"],
            esc(r["local_clock"].as_str().unwrap_or("")),
            if load >= 3.0 { "bad" } else if load > 1.2 { "warn" } else { "muted" },
            load,
            r["calls"],
            r["trunks"],
            r["panels_live"]
        );
    }
    b.push_str("</table></div></section>");

    b.push_str("<section><h2>Live connections</h2>");
    b.push_str(&connections_table(rt, &sorted_connections(rt), now));
    b.push_str("</section>");

    // Frames grouped by protocol.
    b.push_str("<section><h2>All frames</h2>");
    let mut by_proto: BTreeMap<&str, Vec<&Frame>> = BTreeMap::new();
    for f in &st.frames {
        by_proto.entry(f.protocol.as_str()).or_default().push(f);
    }
    for (proto, frames) in by_proto {
        let name = &frames[0].protocol_name;
        let _ = write!(b, "<h3>{} <span class=\"muted\">{} · {}</span></h3><table><tr><th>Frame</th><th>Casters</th><th>Free</th><th>Trunks to</th><th>Panels busy</th><th>Named ports</th><th>Last connection</th></tr>", esc(name), esc(proto), frames[0].family.label());
        for f in frames {
            let ads = st.caster_ads(&f.id);
            let mut cs = String::from("<span class=\"casters\">");
            for a in &ads {
                let title = match (&a.trunk, &a.peer_frame) {
                    (Some(t), Some(p)) => format!("{} → {}", t, p),
                    _ => "free".into(),
                };
                let _ = write!(cs, r#"<i class="{}" title="C{} {}"></i>"#, if a.trunk.is_some() { "t" } else { "" }, a.index, esc(&title));
            }
            cs.push_str("</span>");
            let peers: Vec<String> = st
                .trunks
                .iter()
                .filter(|t| t.touches(&f.id))
                .map(|t| format!("{} <span class=\"muted\">({}/{})</span>", esc(t.peer_of(&f.id).unwrap_or("?")), t.used(), t.capacity))
                .collect();
            let _ = write!(
                b,
                "<tr><td><b>{}</b></td><td>{}</td><td>{}/{}</td><td>{}</td><td>{}/{}</td><td>{}</td><td>{}</td></tr>",
                esc(&f.id),
                cs,
                st.free_casters(&f.id),
                f.casters,
                peers.join(", "),
                st.used_user_ports(&f.id).len(),
                f.user_ports,
                st.port_names_of(&f.id).len(),
                ago(rt, &f.id, now)
            );
        }
        b.push_str("</table>");
    }
    b.push_str("</section>");

    // Trunks, with volume at both ends.
    b.push_str("<section><h2>All trunks</h2><p class=\"note\">Volume can be adjusted at multiple points: at the A caster, at the B caster, and per hop of each call (Overlord). Changes are logged to <code>TRUNK-USAGE/gains.jsonl</code>.</p><div class=\"scroll\"><table><tr><th>Trunk</th><th>A</th><th>Gain A</th><th>B</th><th>Gain B</th><th>Channels</th><th>Load</th><th>Up since</th><th>Connections</th></tr>");
    for t in &st.trunks {
        let pct = if t.capacity == 0 { 0.0 } else { t.used() as f64 / t.capacity as f64 * 100.0 };
        let gain = |end: &str, v: f64| {
            format!(
                r#"<input type="number" step="0.5" min="-60" max="20" value="{v:.1}" style="width:72px;padding:2px 4px" onchange="api('/api/gain',{{trunk:'{id}',end:'{end}',db:Number(this.value),who:'usage page'}})"> dB"#,
                id = esc(&t.id)
            )
        };
        let _ = write!(
            b,
            r#"<tr><td><code>{}</code></td><td>{} C{}</td><td>{}</td><td>{} C{}</td><td>{}</td><td>{}/{}</td><td><div class="bar"><i style="width:{:.0}%"></i></div></td><td class="muted">{}</td><td class="note">{}</td></tr>"#,
            esc(&t.id), esc(&t.a_frame), t.a_caster, gain("a", t.gain_a_db), esc(&t.b_frame), t.b_caster, gain("b", t.gain_b_db), t.used(), t.capacity, pct, esc(&t.created_at), esc(&t.connections.join(", "))
        );
    }
    if st.trunks.is_empty() {
        b.push_str("<tr><td colspan=\"9\" class=\"muted\">No trunks up. Connect two frames above or let the simulator run.</td></tr>");
    }
    b.push_str("</table></div></section>");

    page("Usage", rt, live, 3000, &b)
}

// ---------------------------------------------------------------------------
// The globe: page one. Frames on a rotating sphere, trunks arcing between
// them, every live call flying along its trunk.
// ---------------------------------------------------------------------------

/// Data the globe draws. Frames sit at their site's coordinates (capitals,
/// provinces, cities from TRUNK-GLOBAL/sites.json), in a tiny ring when a
/// site hosts several. Frames without a site (the relay, or a fleet without
/// sites) are laid out per protocol on a Fibonacci sphere.
pub fn globe_data(rt: &Runtime) -> serde_json::Value {
    let st = &rt.state;
    let now = util::now_unix();
    let utc = rt.time_of_day();

    // Fallback layout per protocol for frames with no coordinates.
    let mut protos: Vec<&str> = st.frames.iter().filter(|f| f.lat.is_none()).map(|f| f.protocol.as_str()).collect();
    protos.sort();
    protos.dedup();
    let n = protos.len().max(1) as f64;
    let golden = 137.50776_f64;
    let mut center: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    for (i, p) in protos.iter().enumerate() {
        if *p == crate::relay::PROTOCOL {
            center.insert(p, (8.0, 0.0));
            continue;
        }
        let lat = (1.0 - 2.0 * (i as f64 + 0.5) / n).asin().to_degrees() * 0.72;
        let lon = ((i as f64 * golden) % 360.0) - 180.0;
        center.insert(p, (lat, lon));
    }

    // Frames per site, to spread them in a small ring.
    let mut site_members: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for f in &st.frames {
        if f.lat.is_some() {
            site_members.entry(f.site.as_str()).or_default().push(f.id.as_str());
        }
    }

    let nodes: Vec<serde_json::Value> = st
        .frames
        .iter()
        .map(|f| {
            let (lat, lon) = match (f.lat, f.lon) {
                (Some(lat), Some(lon)) => {
                    let members = &site_members[f.site.as_str()];
                    let m = members.len().max(1) as f64;
                    let k = members.iter().position(|id| *id == f.id).unwrap_or(0) as f64;
                    let ring = if m > 1.0 { 0.9 + 0.08 * m } else { 0.0 };
                    let ang = std::f64::consts::TAU * k / m;
                    (lat + ring * ang.sin(), lon + ring * ang.cos() / lat.to_radians().cos().max(0.3))
                }
                _ => {
                    let (clat, clon) = center.get(f.protocol.as_str()).copied().unwrap_or((0.0, 0.0));
                    let siblings = st.frames.iter().filter(|g| g.protocol == f.protocol && g.lat.is_none()).count().max(1) as f64;
                    let k = st.frames.iter().filter(|g| g.protocol == f.protocol && g.lat.is_none()).position(|g| g.id == f.id).unwrap_or(0) as f64;
                    let ang = std::f64::consts::TAU * k / siblings;
                    let ring = if siblings > 1.0 { 5.5 } else { 0.0 };
                    (clat + ring * ang.sin(), clon + ring * ang.cos() / clat.to_radians().cos().max(0.3))
                }
            };
            let live = st.live_ports_of(&f.id);
            let who: Vec<String> = live.iter().map(|(p, w)| format!("{p} {w}")).collect();
            serde_json::json!({
                "id": f.id, "proto": f.protocol, "protoName": f.protocol_name, "site": f.site,
                "fam": serde_json::to_string(&f.family).unwrap_or_default().trim_matches('"'),
                "badge": f.badge, "lat": lat, "lon": lon, "live": live.len(), "cont": f.continent,
                "free": st.free_casters(&f.id), "cas": f.casters, "ports": f.user_ports,
                "since": st.seconds_since_last(&f.id, now),
                "sim": rt.remotes.frames.get(&f.id).map(|r| r.connected),
                "load": f.lon.map(|lon| rt.fader.day.multiplier_at(utc, lon)),
                "who": who,
            })
        })
        .collect();

    // Clusters to label: the sites (with tier), plus protocol centers for the fallback.
    let mut clusters: Vec<serde_json::Value> = rt
        .sites
        .sites
        .iter()
        .filter(|s| site_members.contains_key(s.name.as_str()))
        .map(|s| {
            let local = DaySchedule::local_tod(utc, s.lon) as u64;
            serde_json::json!({
                "name": s.name, "tier": s.tier, "country": s.country, "lat": s.lat, "lon": s.lon,
                "frames": site_members[s.name.as_str()].len(),
                "local": format!("{:02}:{:02}", local / 3600, (local % 3600) / 60),
                "load": rt.fader.day.multiplier_at(utc, s.lon),
            })
        })
        .collect();
    for p in &protos {
        let name = st.frames.iter().find(|f| f.protocol == *p).map(|f| f.protocol_name.clone()).unwrap_or_default();
        let (lat, lon) = center[p];
        clusters.push(serde_json::json!({ "name": name, "tier": "protocol", "lat": lat, "lon": lon, "frames": 0 }));
    }

    let badge_of = |frame: &str| st.frame(frame).and_then(|f| f.badge.clone());
    let today = rt.sim_day();
    // Every trunk that ever carried a call: its use count and day-by-day
    // trend, the habits (longest lock streak) first.
    let history: Vec<serde_json::Value> = rt
        .trends
        .summary(today)
        .into_iter()
        .map(|h| {
            serde_json::json!({
                "a": h.a, "b": h.b, "uses": h.uses, "streak": h.streak, "ld": h.locked_days, "lt": h.locked_today,
                "d": h.days, "l": h.locked.iter().map(|x| if *x { 1 } else { 0 }).collect::<Vec<u8>>(),
                "hh": h.held.iter().map(|x| (x * 10.0).round() / 10.0).collect::<Vec<f64>>(),
                "lh": h.lock_hours, "hours": h.hours, "longest": h.longest, "last": h.last_used,
            })
        })
        .collect();
    let trunks: Vec<serde_json::Value> = st
        .trunks
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id, "a": t.a_frame, "b": t.b_frame, "used": t.used(), "cap": t.capacity, "gain": t.gain_a_db + t.gain_b_db,
                "uses": rt.trends.uses_of(&t.a_frame, &t.b_frame), "streak": rt.trends.streak_of(&t.a_frame, &t.b_frame, today),
            })
        })
        .collect();
    let calls: Vec<serde_json::Value> = st
        .connections
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id, "who": c.who, "why": c.why, "kind": kind_str(c.kind), "muted": c.muted,
                "badge": badge_of(&c.from_frame), "toBadge": badge_of(&c.to_frame),
                "proto": st.frame(&c.from_frame).map(|f| f.protocol_name.clone()),
                "from_site": st.frame(&c.from_frame).map(|f| f.site.clone()), "to_site": st.frame(&c.to_frame).map(|f| f.site.clone()),
                "hops": c.hops.iter().map(|h| serde_json::json!([h.from, h.to])).collect::<Vec<_>>(),
                "gpio": c.gpio_sent, "for": dur(c.connected_for(now)), "gain": st.path_gain_db(c),
            })
        })
        .collect();
    serde_json::json!({
        "site": rt.site, "clock": rt.clock(), "load": rt.load_multiplier(), "sim_time": rt.sim_time,
        "frames": st.frames.len(), "sites": rt.sites.sites.len(), "trunks": st.trunks.len(), "calls": st.connections.len(),
        "sims": rt.remotes.frames.values().filter(|r| r.connected).count(),
        "config": rt.globe,
        "nodes": nodes, "clusters": clusters, "trunkList": trunks, "callList": calls,
        "history": history, "today": today, "lockHours": crate::trends::LOCK_SECONDS / 3600.0, "daysShown": crate::trends::DAYS_SHOWN,
    })
}

/// The land: Natural Earth 110 m (public domain), one flat
/// `[lon, lat, lon, lat, …]` array per ring, a tenth of a degree.
pub const LAND_JSON: &str = include_str!("land.json");

const MAP_CSS: &str = r#".mapbar{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-bottom:6px;font-size:12px;color:var(--muted)}.mapbar select{padding:3px 6px;font-size:12px}.mapbar .chips{display:flex;flex-wrap:wrap;gap:4px}.mapbar .chip{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px}.mapbar .chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.mfilter{position:relative}.mfilter summary{cursor:pointer;border:1px solid var(--line);border-radius:999px;padding:2px 10px;list-style:none}.mfilter summary::-webkit-details-marker{display:none}.mfilter[open] summary{border-color:var(--accent);color:var(--accent)}.mfilter .mf{position:absolute;z-index:15;top:calc(100% + 4px);left:0;display:grid;grid-template-columns:repeat(2,minmax(170px,1fr));gap:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:50vh;overflow:auto;box-shadow:0 6px 18px rgba(0,0,0,.25)}.mfilter .mf label{display:block;color:var(--ink);white-space:nowrap;font-size:12px}.mfilter .mf a{color:var(--accent);cursor:pointer;font-size:11px}
.globe{display:block;width:100%;background:#0b1020;border-radius:8px;cursor:grab;touch-action:none}.tip{display:none;position:fixed;z-index:20;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;pointer-events:none;max-width:380px}"#;

/// The one map. Every page that shows the world uses this block: the same
/// engine, the same data feed (`globe_data`, then the telemetry stream), the
/// same toolbar (round or flat, layers, protocol and vendor filter). A page
/// only picks its defaults: the view, the layers on, and an aggregator.
fn map_block(data: &serde_json::Value, height: &str, mode: &str, layers: Option<&[&str]>, hub: Option<&serde_json::Value>) -> String {
    format!(
        r#"<div id="mapbar" class="mapbar" data-keep></div><div class="note" id="globe-hud"></div><canvas id="globe" class="globe"{style} aria-label="Map of every frame, trunk and call"></canvas><div id="globe-tip" class="tip"></div><style>{MAP_CSS}</style>
<script>window.GLOBE_DEFAULT_MODE='{mode}';window.GLOBE_LAYERS={layers};window.GLOBE_HUB={hub};window.GLOBE_FILTER=window.GLOBE_FILTER||new Set();window.GLOBE_DATA={data};window.TC_LAND={LAND_JSON};</script><script>{GLOBE_JS}</script>"#,
        style = if height.is_empty() { String::new() } else { format!(r#" style="height:{height}""#) },
        layers = layers.map(|l| serde_json::to_string(l).unwrap_or_else(|_| "null".into())).unwrap_or_else(|| "null".into()),
        hub = hub.map(|h| h.to_string()).unwrap_or_else(|| "null".into()),
    )
}

const GLOBE_JS: &str = r#"
(function(){
  const canvas = document.getElementById('globe'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const tip = document.getElementById('globe-tip');
  let data = window.GLOBE_DATA;
  const cfg = () => data.config || {rotate_deg_per_s:2.5, tilt_deg:-18, show_capitals:true, show_provinces:true, show_cities:true, graticule_deg:30, projection:'both', zoom:1};
  const sget=(k,d)=>{ const v=sessionStorage.getItem('globe.'+k); return v===null? d : Number(v); };
  let dragOff = sget('drag', 0), tilt = sget('tilt', cfg().tilt_deg), zoom = sget('zoom', cfg().zoom||1), panY = sget('pany', 0), panX = sget('panx', 0);
  // The view: 'both' puts the round globe on the left and the flat map across
  // the rest of the width; 'globe' or 'map' fills the canvas with one.
  // Each page remembers its own view, layers and filter.
  const PAGE = location.pathname.replace(/\/$/,'') || '/';
  let mode = sessionStorage.getItem('globe.mode'+PAGE) || window.GLOBE_DEFAULT_MODE || window.GLOBE_FORCE_PROJECTION || cfg().projection || 'both';
  let projection = mode==='map' ? 'map' : 'globe';
  let pane = {p:projection, x:0, w:1400};
  const panes = () => { if(mode!=='both') return [{p:mode, x:0, w:W}]; const gw=Math.round(Math.min(W*0.45, H*1.08)); return [{p:'globe', x:0, w:gw}, {p:'map', x:gw, w:W-gw}]; };
  function paneAt(mx){ const l=panes(); let q=l[l.length-1]; for(const c of l){ if(mx>=c.x && mx<c.x+c.w){ q=c; break; } } pane=q; projection=q.p; return q; }
  // Pan moves the map; in 'both' the globe stays centred in its pane.
  const pans = () => mode!=='both' || projection==='map';
  // Layers: what is drawn. The filter: which protocols and vendors.
  const ALL_LAYERS = [['sun','Sunlight'],['trunks','Trunks'],['calls','Calls'],['frames','Frames'],['ports','Data ports'],['continents','Continents'],['labels','Labels'],['grid','Graticule']];
  const lget = (k, d) => { try{ const v = JSON.parse(sessionStorage.getItem('globe.'+k+PAGE)); return Array.isArray(v) ? v : d; }catch(e){ return d; } };
  const layers = new Set(lget('layers', window.GLOBE_LAYERS || ['sun','trunks','calls','frames','ports','labels','grid']));
  const on = k => layers.has(k);
  const hidProto = new Set(lget('hideproto', [])), hidVendor = new Set(lget('hidevendor', []));
  const vendorOf = n => (n.badge && n.badge.vendor) || 'other';
  const hiddenByUser = n => hidProto.has(n.protoName) || hidVendor.has(vendorOf(n));
  const shown = n => !(window.GLOBE_FILTER && window.GLOBE_FILTER.size && !window.GLOBE_FILTER.has(n.proto)) && !hiddenByUser(n);
  let SPEED = cfg().rotate_deg_per_s, hover = null, dragging = null, frozenRot = null, W=1400, H=820, dpr=1;
  function resize(){ dpr = window.devicePixelRatio||1; const r = canvas.getBoundingClientRect(); W = Math.max(200, r.width); H = Math.max(200, r.height); canvas.width = W*dpr; canvas.height = H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
  window.addEventListener('resize', resize); resize();
  const R = () => (projection==='map' ? Math.min(pane.w/3.8, H/1.9*0.96) : Math.min(pane.w, H)*0.44) * zoom;
  // The map repeats sideways: the world is drawn once per copy, shiftX apart.
  let shiftX = 0;
  const CX = () => pane.x + pane.w/2 + (pans()?panX:0) + shiftX, CY = () => H/2 + (pans()?panY:0);
  const mapW = () => R()*3.8;
  // On the map, the copy of q nearest p, so a line across the date line goes the short way.
  const near = (p, q) => { if(projection!=='map') return q; const w=mapW(); let x=q.x; while(x-p.x>w/2) x-=w; while(p.x-x>w/2) x+=w; return x===q.x? q : {x:x, y:q.y, z:q.z}; };
  function rot(){ if(frozenRot!==null) return frozenRot; return ((Date.now()/1000)*SPEED + dragOff) % 360; }
  function proj(lat, lon){
    if(projection==='map'){
      let lo = ((lon + rot() + 540) % 360) - 180;
      return {x: CX() + lo/180 * R()*1.9, y: CY() - lat/90 * R()*0.95, z: 1};
    }
    const la = lat*Math.PI/180, lo = (lon + rot())*Math.PI/180, ti = tilt*Math.PI/180;
    const x = Math.cos(la)*Math.sin(lo), y = Math.sin(la), z = Math.cos(la)*Math.cos(lo);
    const y2 = y*Math.cos(ti) - z*Math.sin(ti), z2 = y*Math.sin(ti) + z*Math.cos(ti);
    return {x: CX() + R()*x, y: CY() - R()*y2, z: z2};
  }
  function lift(p, q, amount){
    const mx=(p.x+q.x)/2, my=(p.y+q.y)/2;
    if(projection==='map'){ const d=Math.hypot(q.x-p.x,q.y-p.y); return {x:mx, y:my - Math.min(0.35*d, R()*0.5)}; }
    const dx=mx-CX(), dy=my-CY(), d=Math.hypot(dx,dy)||1; const k = Math.max(amount*R(), d*1.08);
    return {x: CX() + dx/d*k, y: CY() + dy/d*k};
  }
  const famColor = f => ({'analog-audio':'#f6c343','audio-over-ip':'#5a9bff','telephony':'#3fb950','control':'#e3a35a','wireless':'#b48cff','media-transport':'#ff6b6b'})[f] || '#9aa3ad';
  const nodeColor = n => (n.badge && n.badge.color) || famColor(n.fam);
  const tierShown = t => t==='protocol' || (t==='capital'&&cfg().show_capitals) || (t==='province'&&cfg().show_provinces) || (t==='city'&&cfg().show_cities);
  let seed = 7; const rnd=()=>{seed=(seed*16807)%2147483647; return seed/2147483647;};
  const stars = Array.from({length:160},()=>({x:rnd(),y:rnd(),r:0.4+rnd()*1.3,p:rnd()*6}));
  let byId = {}; function index(){ byId={}; data.nodes.forEach(n=>byId[n.id]=n); }
  index();
  // The toolbar every map carries: view, colour, layers, filter.
  function buildBar(){
    const bar = document.getElementById('mapbar'); if(!bar || bar.dataset.built) return; bar.dataset.built = '1';
    const protos = [...new Set(data.nodes.map(n=>n.protoName))].sort(), vendors = [...new Set(data.nodes.map(vendorOf))].sort();
    const chip = (k,l) => '<button type="button" class="chip'+(on(k)?' on':'')+'" data-layer="'+k+'">'+l+'</button>';
    const box = (set,kind,v) => '<label><input type="checkbox" data-'+kind+'="'+esc(v)+'"'+(set.has(v)?'':' checked')+'> '+esc(v)+'</label>';
    bar.innerHTML = '<label>View <select id="g_proj"><option value="both">globe and flat map</option><option value="globe">round</option><option value="map">flat</option></select></label>'
      + '<label>Colour <select id="g_view"><option value="uses">times used</option><option value="trend">trend: days locked</option><option value="live">live only</option></select></label>'
      + '<span class="chips">'+ALL_LAYERS.filter(([k])=>k!=='ports'||window.GLOBE_HUB).map(([k,l])=>chip(k,l)).join('')+'</span>'
      + '<details class="mfilter"><summary>Filter <span id="mfilter-n"></span></summary><div class="mf">'
      + '<div><b>Protocols</b> <a data-all="proto">all</a> · <a data-none="proto">none</a>'+protos.map(v=>box(hidProto,'proto',v)).join('')+'</div>'
      + '<div><b>Vendors</b> <a data-all="vendor">all</a> · <a data-none="vendor">none</a>'+vendors.map(v=>box(hidVendor,'vendor',v)).join('')+'</div></div></details>';
    const save = () => { sessionStorage.setItem('globe.layers'+PAGE, JSON.stringify([...layers])); sessionStorage.setItem('globe.hideproto'+PAGE, JSON.stringify([...hidProto])); sessionStorage.setItem('globe.hidevendor'+PAGE, JSON.stringify([...hidVendor])); const n = hidProto.size + hidVendor.size; setText('mfilter-n', n ? '· '+n+' hidden' : ''); };
    bar.querySelectorAll('[data-layer]').forEach(el=>el.addEventListener('click',()=>{ const k=el.dataset.layer; if(layers.has(k)) layers.delete(k); else layers.add(k); el.classList.toggle('on', layers.has(k)); save(); }));
    for(const [kind, set] of [['proto', hidProto], ['vendor', hidVendor]]){
      bar.querySelectorAll('input[data-'+kind+']').forEach(c=>c.addEventListener('change',()=>{ const v=c.dataset[kind]; if(c.checked) set.delete(v); else set.add(v); save(); }));
      bar.querySelectorAll('[data-all="'+kind+'"],[data-none="'+kind+'"]').forEach(el=>el.addEventListener('click',()=>{ const none = !!el.dataset.none; bar.querySelectorAll('input[data-'+kind+']').forEach(c=>{ c.checked=!none; if(none) set.add(c.dataset[kind]); else set.delete(c.dataset[kind]); }); save(); }));
    }
    save();
  }
  buildBar();
  // Use counts and trends.
  const tkey = (a,b) => a<=b? a+'|'+b : b+'|'+a;
  let histByKey = {}; function indexHist(){ histByKey={}; for(const h of data.history||[]) histByKey[tkey(h.a,h.b)]=h; } indexHist();
  let view = new URLSearchParams(location.search).get('view') || sessionStorage.getItem('globe.view') || 'uses', focus = sessionStorage.getItem('globe.focus') || null;
  const arcs = []; let arcTip = false;
  const USE_STOPS = [[0,'#2a4a8a'],[1,'#5a9bff'],[2,'#2bb3c0'],[3,'#3fb950'],[4,'#f6c343'],[5,'#ff6b6b']];
  const hex = h => [1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
  const mix = (a,b,f) => { const x=hex(a), y=hex(b); return 'rgb('+x.map((v,i)=>Math.round(v+(y[i]-v)*f)).join(',')+')'; };
  function useColor(n){ const v=Math.max(0,Math.min(5,Math.log10(Math.max(1,n||0)))); for(let i=1;i<USE_STOPS.length;i++){ if(v<=USE_STOPS[i][0]){ const [a0,c0]=USE_STOPS[i-1], [a1,c1]=USE_STOPS[i]; return mix(c0,c1,(v-a0)/(a1-a0)); } } return USE_STOPS[USE_STOPS.length-1][1]; }
  const STREAK_STOPS = [[1,'#f6c343'],[2,'#e3a35a'],[3,'#ff8a3d'],[5,'#ff6b6b'],[7,'#ff4fd8']];
  function streakColor(s){ if(!s||s<1) return '#9aa3ad'; let c=STREAK_STOPS[0][1]; for(const [k,v] of STREAK_STOPS) if(s>=k) c=v; return c; }
  const fmtN = n => n>=1e6? (n/1e6).toFixed(1)+'M' : n>=1e4? Math.round(n/1e3)+'k' : n>=1e3? (n/1e3).toFixed(1)+'k' : String(n);
  const siteOf = id => (byId[id] && byId[id].site) || id;
  function drawLegend(){
    const x0=14, y0=H-58, w=Math.min(300, W*0.3);
    ctx.globalAlpha=0.85; ctx.fillStyle='#0b1020'; ctx.fillRect(x0-8,y0-20,w+16,62); ctx.globalAlpha=1;
    ctx.font='600 11px system-ui'; ctx.textAlign='left'; ctx.fillStyle='#cfd8e6';
    if(view==='trend'){
      ctx.fillText('Days in a row a trunk was locked ('+(data.lockHours||1)+' h or more)', x0, y0-6);
      const steps=[1,2,3,5,7]; const sw=w/steps.length;
      steps.forEach((s,i)=>{ ctx.fillStyle=streakColor(s); ctx.fillRect(x0+i*sw, y0, sw-2, 10); ctx.fillStyle='#9fb0cc'; ctx.font='10px system-ui'; ctx.fillText(s+(i===steps.length-1?'+ days':(s===1?' day':'')), x0+i*sw, y0+24); });
      ctx.fillText('pulsing: locked today · label: days running', x0, y0+36);
    } else if(view==='uses'){
      ctx.fillText('Times each trunk was used', x0, y0-6);
      const g=ctx.createLinearGradient(x0,0,x0+w,0); for(let i=0;i<=20;i++){ g.addColorStop(i/20, useColor(Math.pow(10,i/4))); } ctx.fillStyle=g; ctx.fillRect(x0,y0,w,10);
      ctx.fillStyle='#9fb0cc'; ctx.font='10px system-ui'; ['1','10','100','1k','10k','100k'].forEach((l,i)=>{ ctx.textAlign=i===0?'left':i===5?'right':'center'; ctx.fillText(l, x0+w*i/5, y0+24); });
      ctx.textAlign='left'; ctx.fillText('bright: up now · faint: used before · ring: locked days running', x0, y0+36);
    } else { ctx.fillText('Trunks up now, width by channels in use', x0, y0-6); }
  }
  // The trend list beside the globe: the habits first.
  function renderTrends(){
    const el=document.getElementById('side-trends'); if(!el) return;
    const all=data.history||[]; const rows=(view==='trend'? all.filter(h=>h.ld>0) : all.slice().sort((a,b)=>b.uses-a.uses)).slice(0,30);
    setText('trend-count', all.filter(h=>h.ld>0).length+' locked · '+all.length+' trunks used');
    if(!rows.length){ el.innerHTML='<p class="muted">'+(view==='trend'?'No trunk locked yet. ':'No trunk history yet. ')+'Every call that rides a trunk is counted; a call held '+(data.lockHours||1)+' h or more locks it for the day.</p>'; return; }
    el.innerHTML = rows.map(h=>{ const k=tkey(h.a,h.b); const mx=Math.max(1,...h.d); const bw=100/h.d.length;
      const spark='<svg viewBox="0 0 100 22" preserveAspectRatio="none" class="spark">'+h.d.map((v,i)=>{ const hgt=Math.max(v?2:0.6,v/mx*20); return '<rect x="'+(i*bw+0.4).toFixed(1)+'" y="'+(22-hgt).toFixed(1)+'" width="'+(bw-0.8).toFixed(1)+'" height="'+hgt.toFixed(1)+'" fill="'+(h.l[i]?streakColor(Math.max(1,h.streak)):'#5a9bff')+'" opacity="'+(h.l[i]?1:0.55)+'"><title>'+(h.d.length-1-i===0?'today':(h.d.length-1-i)+' days ago')+': '+v+' uses'+(h.hh&&h.hh[i]?' · '+h.hh[i]+' h held':'')+(h.l[i]?' · locked':'')+'</title></rect>'; }).join('')+'</svg>';
      const clock='<div class="lockclock" title="Hours of the day it was locked, over the last '+h.d.length+' days">'+h.lh.map((c,i)=>'<i style="opacity:'+(c?0.25+0.75*c/h.d.length:0.08)+';background:'+(c?streakColor(Math.max(1,h.streak)):'var(--muted)')+'" title="'+String(i).padStart(2,'0')+':00 · locked '+c+' of '+h.d.length+' days"></i>').join('')+'</div>';
      return '<div class="trend'+(focus===k?' on':'')+'" data-k="'+esc(k)+'"><div class="tt"><b>'+esc(siteOf(h.a))+'</b> ↔ <b>'+esc(siteOf(h.b))+'</b> <span class="muted">'+esc(h.a)+' · '+esc(h.b)+'</span></div><div class="tn"><span class="uses" style="background:'+useColor(h.uses)+'">'+fmtN(h.uses)+'×</span>'+(h.streak? '<span class="streak" style="background:'+streakColor(h.streak)+'">'+(h.lt?'🔒 ':'')+h.streak+' day'+(h.streak>1?'s':'')+' locked</span>' : h.ld? '<span class="muted">'+h.ld+' of '+h.d.length+' days locked</span>':'')+'</div>'+spark+clock+'</div>'; }).join('');
    el.querySelectorAll('.trend').forEach(d=>d.addEventListener('click',()=>focusTrunk(d.dataset.k)));
  }
  function focusTrunk(k){
    focus = focus===k? null : k; if(focus) sessionStorage.setItem('globe.focus',focus); else sessionStorage.removeItem('globe.focus');
    const h = histByKey[k]; if(focus && h && byId[h.a] && byId[h.b]){ const a=byId[h.a], b=byId[h.b]; let dl=b.lon-a.lon; if(dl>180) dl-=360; if(dl<-180) dl+=360; const lon=a.lon+dl/2, lat=(a.lat+b.lat)/2; dragOff = -lon - (Date.now()/1000)*SPEED; frozenRot=null; hover=null; if(mode!=='map') tilt=Math.max(-85,Math.min(85,lat)); sessionStorage.setItem('globe.drag',dragOff); sessionStorage.setItem('globe.tilt',tilt); }
    renderTrends();
  }
  function trunkTip(r){ const h=r.hist||{}, lv=r.live; const a=lv?lv.a:h.a, b=lv?lv.b:h.b; const uses=(lv&&lv.uses)||h.uses||0;
    let s='<b>'+esc(siteOf(a))+' ↔ '+esc(siteOf(b))+'</b><br><span class="muted">'+esc(a)+' ↔ '+esc(b)+'</span><br>used <b>'+uses.toLocaleString()+'</b> time'+(uses===1?'':'s');
    if(lv) s+='<br>up now · '+lv.used+'/'+lv.cap+' channels';
    if(h.streak) s+='<br>locked <b>'+h.streak+' day'+(h.streak>1?'s':'')+' running</b>'+(h.lt?' (today too)':'');
    else if(h.ld) s+='<br>locked '+h.ld+' of the last '+h.d.length+' days';
    if(h.longest) s+='<br>longest hold '+dur(h.longest);
    if(h.lh){ const hrs=h.lh.map((c,i)=>[c,i]).filter(x=>x[0]>0).sort((x,y)=>y[0]-x[0]).slice(0,3).map(x=>String(x[1]).padStart(2,'0')+':00'); if(hrs.length) s+='<br>usually locked at '+hrs.join(', '); }
    return s+'<br><span class="muted">click to follow it</span>'; }
  // The land. On the globe, points round the back are pushed out to the
  // horizon so a coast that turns away closes along the rim. On the map a
  // coast that crosses the date line is unwrapped and drawn again a
  // world-width over.
  const LAND = window.TC_LAND || [];
  function drawLand(){
    ctx.save();
    ctx.fillStyle = '#29446f'; ctx.strokeStyle = '#6a8cc4'; ctx.lineWidth = 0.8; ctx.lineJoin = 'round';
    const cx = CX(), cy = CY(), r = R();
    if(projection==='map'){
      const w = r*3.8, x0 = cx - r*1.9;
      ctx.beginPath(); ctx.rect(x0, cy - r*0.95, w, r*1.9); ctx.clip();
      for(const ring of LAND){
        const xs = [], ys = []; let prev = null, lo = Infinity, hi = -Infinity;
        for(let i=0; i<ring.length; i+=2){ const p = proj(ring[i+1], ring[i]); let x = p.x; if(prev!==null){ while(x - prev > w/2) x -= w; while(prev - x > w/2) x += w; } xs.push(x); ys.push(p.y); prev = x; lo = Math.min(lo, x); hi = Math.max(hi, x); }
        for(const shift of [0, w, -w]){
          if(shift && !(lo + shift < x0 + w && hi + shift > x0)) continue;
          ctx.beginPath(); for(let i=0;i<xs.length;i++){ if(i) ctx.lineTo(xs[i]+shift, ys[i]); else ctx.moveTo(xs[i]+shift, ys[i]); } ctx.closePath(); ctx.fill(); ctx.stroke();
        }
      }
    } else {
      for(const ring of LAND){
        let seen = false; ctx.beginPath();
        for(let i=0; i<ring.length; i+=2){
          const p = proj(ring[i+1], ring[i]); let x = p.x, y = p.y;
          if(p.z > 0) seen = true;
          else { const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1; x = cx + dx/d*r; y = cy + dy/d*r; }
          if(i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        if(!seen) continue;
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Sunlight on the map: the sun's position from the simulated UTC clock
  // and today's declination; the night side shaded with a twilight edge
  // (civil to astronomical), the point under the sun glowing.
  const night = document.createElement('canvas'); night.width = 180; night.height = 90;
  const nctx = night.getContext('2d'), nimg = nctx.createImageData(180, 90);
  function utcHour(){
    const h = (typeof predictedHour==='function') ? predictedHour() : null; if(h!=null) return h;
    const m = /(\d+):(\d+)(?::(\d+))?/.exec(data.clock||''); if(m) return (+m[1]) + (+m[2])/60 + (+(m[3]||0))/3600;
    const d = new Date(); return d.getUTCHours() + d.getUTCMinutes()/60;
  }
  function sunAt(){
    const now = new Date(), doy = Math.floor((now - Date.UTC(now.getUTCFullYear(),0,0))/864e5);
    return { lat: -23.44*Math.cos(2*Math.PI/365*(doy+10)), lon: ((-(utcHour()-12)*15) % 360 + 540) % 360 - 180 };
  }
  // One pixel per 2° of the map as it sits on screen (already turned by rot()).
  function paintNight(s){
    const d = s.lat*Math.PI/180, sd = Math.sin(d), cd = Math.cos(d), ro = rot(), D = nimg.data;
    for(let j=0;j<90;j++){ const la=(89-j*2)*Math.PI/180, a=Math.sin(la)*sd, b=Math.cos(la)*cd;
      for(let i=0;i<180;i++){ const H=(-179+i*2-ro-s.lon)*Math.PI/180; const alt=Math.asin(Math.max(-1,Math.min(1,a+b*Math.cos(H))))*180/Math.PI; let f=Math.max(0,Math.min(1,(1-alt)/13)); f=f*f*(3-2*f); const k=(j*180+i)*4;
        // Day: a warm wash of light. Night: deep blue-black. Twilight between.
        D[k]=Math.round(255-255*f); D[k+1]=Math.round(232-228*f); D[k+2]=Math.round(170-150*f); D[k+3]=Math.round(255*(0.13+0.55*f)); } }
    nctx.putImageData(nimg, 0, 0);
  }
  function drawSun(s){
    const r = R(), w = mapW(), h = r*1.9, x0 = CX()-w/2, y0 = CY()-h/2;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.drawImage(night, x0, y0, w, h);
    const p = proj(s.lat, s.lon), gr = r*0.3;
    for(const q of [p, {x:p.x-w, y:p.y}, {x:p.x+w, y:p.y}]){
      const g = ctx.createRadialGradient(q.x,q.y,0,q.x,q.y,gr); g.addColorStop(0,'rgba(255,214,102,0.30)'); g.addColorStop(1,'rgba(255,214,102,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x,q.y,gr,0,6.283); ctx.fill();
    }
    ctx.fillStyle = '#ffd666'; ctx.strokeStyle = 'rgba(255,214,102,.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x,p.y,5,0,6.283); ctx.fill(); ctx.beginPath(); ctx.arc(p.x,p.y,9,0,6.283); ctx.stroke();
    ctx.restore();
  }
  // Night on the round globe: the dark cap around the point opposite the
  // sun, in three steps (sunset, civil, nautical twilight).
  function capRing(lat0, lon0, rho){ const p1=lat0*Math.PI/180, l1=lon0*Math.PI/180, r=rho*Math.PI/180, pts=[]; for(let i=0;i<=96;i++){ const th=i/96*2*Math.PI; const la=Math.asin(Math.sin(p1)*Math.cos(r)+Math.cos(p1)*Math.sin(r)*Math.cos(th)); const lo=l1+Math.atan2(Math.sin(th)*Math.sin(r)*Math.cos(p1), Math.cos(r)-Math.sin(p1)*Math.sin(la)); pts.push([la*180/Math.PI, lo*180/Math.PI]); } return pts; }
  function drawNightGlobe(s){
    const cx=CX(), cy=CY(), r=R(), alat=-s.lat, alon=s.lon+180;
    ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,r,0,6.283); ctx.clip();
    for(const [rho, al] of [[90,0.22],[84,0.2],[78,0.24]]){
      let seen=false; ctx.beginPath();
      capRing(alat, alon, rho).forEach(([la,lo],i)=>{ const p=proj(la,lo); let x=p.x, y=p.y; if(p.z>0) seen=true; else { const dx=x-cx, dy=y-cy, d=Math.hypot(dx,dy)||1; x=cx+dx/d*r; y=cy+dy/d*r; } if(i) ctx.lineTo(x,y); else ctx.moveTo(x,y); });
      if(!seen) continue;
      ctx.closePath(); ctx.fillStyle='rgba(2,5,20,'+al+')'; ctx.fill();
    }
    const p=proj(s.lat,s.lon); if(p.z>0){ const gr=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*0.35); gr.addColorStop(0,'rgba(255,214,102,0.28)'); gr.addColorStop(1,'rgba(255,214,102,0)'); ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(p.x,p.y,r*0.35,0,6.283); ctx.fill(); ctx.fillStyle='#ffd666'; ctx.beginPath(); ctx.arc(p.x,p.y,5,0,6.283); ctx.fill(); }
    ctx.restore();
  }
  // Continents: one bubble per continent at its centre, sized by its frames,
  // and an arc to every continent it trunks with (width: trunks up now,
  // colour: times trunks between them were used; dashed when none is up).
  // Worked out from the same frames, trunks and calls as every other layer.
  const CONT_AT = {'Europe':[50,15],'North America':[45,-100],'South America':[-15,-60],'Africa':[5,20],'Middle East':[29,45],'Asia':[40,90],'Oceania':[-25,135],'Antarctica':[-80,0]};
  let contCache = null, contKey = '';
  const contHits = [];
  function contAgg(){
    const key = data.nodes.length+'|'+data.trunkList.length+'|'+data.callList.length+'|'+(data.history||[]).length+'|'+data.clock+'|'+hidProto.size+'|'+hidVendor.size+'|'+((window.GLOBE_FILTER&&window.GLOBE_FILTER.size)||0);
    if(contCache && key===contKey) return contCache; contKey = key;
    const cs = {}, links = {}, cOf = id => byId[id] && shown(byId[id]) ? byId[id].cont : null;
    for(const n of data.nodes){ if(!n.cont || !shown(n)) continue; const c = cs[n.cont] || (cs[n.cont] = {name:n.cont, frames:0, live:0, la:0, sx:0, sy:0, n:0, homeTrunks:0, homeCalls:0, sites:new Set()}); c.frames++; c.live += n.live||0; c.sites.add(n.site); c.la += n.lat; c.sx += Math.cos(n.lon*Math.PI/180); c.sy += Math.sin(n.lon*Math.PI/180); c.n++; }
    for(const c of Object.values(cs)){ const at = CONT_AT[c.name]; if(at){ c.lat=at[0]; c.lon=at[1]; } else { c.lat=c.la/c.n; c.lon=Math.atan2(c.sy,c.sx)*180/Math.PI; } }
    const L = (x, y) => { const [a, b] = x < y ? [x, y] : [y, x]; return links[a+'|'+b] || (links[a+'|'+b] = {a, b, trunks:0, used:0, cap:0, calls:0, uses:0}); };
    for(const t of data.trunkList){ const a=cOf(t.a), b=cOf(t.b); if(!a||!b) continue; if(a===b){ cs[a].homeTrunks++; continue; } const l=L(a,b); l.trunks++; l.used+=t.used||0; l.cap+=t.cap||0; }
    for(const c of data.callList){ const a=cOf(c.hops[0][0]), b=cOf(c.hops[c.hops.length-1][1]); if(!a||!b) continue; if(a===b){ cs[a].homeCalls++; continue; } L(a,b).calls++; }
    for(const h of data.history||[]){ const a=cOf(h.a), b=cOf(h.b); if(!a||!b||a===b) continue; L(a,b).uses += h.uses||0; }
    return contCache = {nodes:Object.values(cs), links:Object.values(links)};
  }
  function drawContinents(t){
    const gg = contAgg(), maxT = Math.max(1, ...gg.links.map(l=>l.trunks)), maxF = Math.max(1, ...gg.nodes.map(n=>n.frames)), P = {};
    for(const c of gg.nodes) P[c.name] = proj(c.lat, c.lon);
    ctx.lineCap = 'round';
    for(const l of gg.links.slice().sort((x,y)=>x.trunks-y.trunks)){
      const p = P[l.a]; let q = P[l.b]; if(!p||!q) continue; q = near(p,q); if(!(p.z>-0.05||q.z>-0.05)) continue;
      const c = lift(p, q, 1.25), w = l.trunks ? 1.5+7*Math.sqrt(l.trunks/maxT) : 1, front = p.z>0 && q.z>0;
      ctx.globalAlpha = front ? 0.9 : 0.3; ctx.strokeStyle = l.trunks ? useColor(l.uses||l.trunks) : '#5a6b8f'; ctx.lineWidth = w; if(!l.trunks) ctx.setLineDash([4,5]);
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.quadraticCurveTo(c.x,c.y,q.x,q.y); ctx.stroke(); ctx.setLineDash([]);
      const n = Math.min(12, l.calls); for(let k=0;k<n;k++){ let u=((t*0.18+k/n)%1); if(k%2) u=1-u; const v=1-u; ctx.globalAlpha=0.95; ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(v*v*p.x+2*v*u*c.x+u*u*q.x, v*v*p.y+2*v*u*c.y+u*u*q.y, 2.4, 0, 6.283); ctx.fill(); }
      const mx = 0.25*p.x+0.5*c.x+0.25*q.x, my = 0.25*p.y+0.5*c.y+0.25*q.y;
      if(front){ const lab=(l.trunks? l.trunks+' trunk'+(l.trunks>1?'s':'') : 'idle')+(l.calls? ' · '+l.calls+' call'+(l.calls>1?'s':'') : ''); ctx.globalAlpha=1; ctx.font='600 12px system-ui'; ctx.textAlign='center'; ctx.lineWidth=4; ctx.strokeStyle='#0b1020'; ctx.strokeText(lab,mx,my-6); ctx.fillStyle=l.trunks?'#e6edf7':'#7f8ba3'; ctx.fillText(lab,mx,my-6); }
      contHits.push({l, x:mx, y:my, r:14});
    }
    for(const c of gg.nodes){
      const p = P[c.name]; if(p.z<=-0.05) continue; const r = 8+18*Math.sqrt(c.frames/maxF);
      ctx.globalAlpha = p.z>0 ? 1 : 0.3;
      const gr = ctx.createRadialGradient(p.x,p.y,1,p.x,p.y,r*1.8); gr.addColorStop(0,'rgba(90,155,255,.55)'); gr.addColorStop(1,'rgba(90,155,255,0)'); ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(p.x,p.y,r*1.8,0,6.283); ctx.fill();
      ctx.fillStyle='#5a9bff'; ctx.beginPath(); ctx.arc(p.x,p.y,r*0.55,0,6.283); ctx.fill(); ctx.strokeStyle='#cfe0ff'; ctx.lineWidth=1.5; ctx.stroke();
      ctx.font='700 14px system-ui'; ctx.textAlign='center'; ctx.lineWidth=4; ctx.strokeStyle='#0b1020'; ctx.strokeText(c.name,p.x,p.y-r-6); ctx.fillStyle='#fff'; ctx.fillText(c.name,p.x,p.y-r-6);
      ctx.font='11px system-ui'; const sub=c.frames+' frames · '+c.homeTrunks+' home trunks · '+c.homeCalls+' home calls'; ctx.strokeText(sub,p.x,p.y+r+14); ctx.fillStyle='#9fb0cc'; ctx.fillText(sub,p.x,p.y+r+14);
      if(p.z>0) contHits.push({c, links:gg.links, x:p.x, y:p.y, r:Math.max(14, r)});
    }
    ctx.globalAlpha = 1;
  }
  function frame(){
    const t = Date.now()/1000;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#0b1020'; ctx.fillRect(0,0,W,H);
    for(const s of stars){ ctx.globalAlpha = 0.25 + 0.45*Math.abs(Math.sin(t*0.7+s.p)); ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(s.x*W, s.y*H, s.r, 0, 6.283); ctx.fill(); }
    ctx.globalAlpha = 1;
    arcs.length = 0; contHits.length = 0;
    for(const pn of panes()){
      pane = pn; projection = pn.p;
      ctx.save(); ctx.beginPath(); ctx.rect(pn.x, 0, pn.w, H); ctx.clip();
      if(projection==='map'){
        // Keep the pan inside one world-width, then draw every copy across the pane.
        const w = mapW(); panX = ((panX + w/2) % w + w) % w - w/2;
        const sun = on('sun') ? sunAt() : null; if(sun) paintNight(sun);
        const c0 = pn.x + pn.w/2 + panX, k0 = Math.floor((pn.x - c0 - w/2)/w), k1 = Math.ceil((pn.x + pn.w - c0 + w/2)/w);
        for(let k=k0; k<=k1; k++){ const c = c0 + k*w; if(c + w/2 < pn.x || c - w/2 > pn.x + pn.w) continue; shiftX = k*w; scene(t, sun); }
        shiftX = 0;
      } else scene(t, on('sun') ? sunAt() : null);
      ctx.restore();
      if(pn.x>0){ ctx.strokeStyle='#2a3a60'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(pn.x+0.5, 10); ctx.lineTo(pn.x+0.5, H-10); ctx.stroke(); }
    }
    if(on('trunks') || on('continents')) drawLegend();
    const hud = document.getElementById('globe-hud'); if(hud) hud.textContent = data.site+' · '+data.clock+' UTC · '+data.sites+' sites · '+data.frames+' frames · '+data.trunks+' trunks · '+data.calls+' calls · '+data.sims+' simulators · '+(mode==='both'?'globe and flat map':mode==='map'?'flat map':'globe')+' · zoom '+zoom.toFixed(1)+'×';
    requestAnimationFrame(frame);
  }
  function scene(t, sun){
    // Sea and graticule.
    ctx.fillStyle = '#0e1a33'; ctx.strokeStyle = '#2a3a60'; ctx.lineWidth = 1.5;
    if(projection==='map'){ ctx.beginPath(); ctx.rect(CX()-R()*1.9, CY()-R()*0.95, R()*3.8, R()*1.9); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(CX(), CY(), R(), 0, 6.283); ctx.fill(); ctx.stroke(); }
    drawLand();
    if(sun){ if(projection==='map') drawSun(sun); else drawNightGlobe(sun); }
    if(on('grid')){
    const step = Math.max(10, cfg().graticule_deg||30);
    ctx.lineWidth = 0.6;
    for(let lo=-180; lo<180; lo+=step){ ctx.beginPath(); let pen=false; for(let s=0;s<=72;s++){ const p=proj(-90+180*s/72, lo); if(p.z>0.02){ if(pen) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y); pen=true; } else pen=false; } ctx.stroke(); }
    for(let la=-90+step; la<90; la+=step){ ctx.beginPath(); ctx.strokeStyle = la===0?'#3b4f80':'#2a3a60'; ctx.lineWidth = la===0?1:0.6; let pen=false, last=null; for(let s=0;s<=144;s++){ const p=proj(la, -180+360*s/144); if(p.z>0.02 && !(projection==='map' && last && Math.abs(p.x-last.x)>R())){ if(pen) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y); pen=true; } else pen=false; last=p; } ctx.stroke(); }
    }
    // Positions.
    const pos = {}; for(const n of data.nodes) pos[n.id] = proj(n.lat, n.lon);
    // Trunks.
    // Trunks: every trunk that ever carried a call, coloured by how many
    // times it was used (or, in the trend view, by how many days running it
    // was locked for an hour or more). Live trunks are bright.
    const liveKey = {}; for(const tr of data.trunkList) liveKey[tkey(tr.a,tr.b)] = tr;
    const drawArc = (a, b, color, alpha, width, rec) => { const p=pos[a]; let q=pos[b]; if(!p||!q) return null; if(byId[a]&&byId[b]&&!shown(byId[a])&&!shown(byId[b])) return null; q=near(p,q); if(!(p.z>-0.05||q.z>-0.05)) return null; const c=lift(p,q,1.12); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.quadraticCurveTo(c.x,c.y,q.x,q.y); ctx.strokeStyle=color; ctx.globalAlpha=alpha*((p.z>0&&q.z>0)?1:0.35); ctx.lineWidth=width; ctx.stroke(); const pts=[]; for(let k=1;k<10;k++){ const u=k/10, v=1-u; pts.push([v*v*p.x+2*v*u*c.x+u*u*q.x, v*v*p.y+2*v*u*c.y+u*u*q.y]); } const m={x:0.25*p.x+0.5*c.x+0.25*q.x, y:0.25*p.y+0.5*c.y+0.25*q.y, front:p.z>0&&q.z>0}; if(rec) arcs.push({pts, rec, m}); return m; };
    const pulse = 0.55 + 0.45*Math.sin(t*3);
    if(!on('trunks')){ }
    else if(view==='live'){
      for(const tr of data.trunkList) drawArc(tr.a, tr.b, '#5a9bff', 0.6, 0.7+tr.used*0.45, {live:tr, hist:histByKey[tkey(tr.a,tr.b)]});
    } else if(view==='trend'){
      let labels=0; for(const h of data.history||[]){ if(!h.ld) continue; const k=tkey(h.a,h.b), lv=liveKey[k], foc=focus===k; const m=drawArc(h.a, h.b, foc?'#ffffff':streakColor(h.streak||0.5), h.lt? (0.55+0.45*pulse) : (h.streak?0.75:0.35), (foc?2:0)+1+Math.min(8,(h.streak||0)*0.9)+(lv?1:0), {live:lv, hist:h}); if(m && m.front && (foc || (h.streak>=3 && labels<24))){ labels++; ctx.globalAlpha=1; ctx.font='600 11px system-ui'; ctx.textAlign='center'; const lab=h.streak+' days'; ctx.lineWidth=3; ctx.strokeStyle='#0b1020'; ctx.strokeText(lab,m.x,m.y-4); ctx.fillStyle=streakColor(h.streak); ctx.fillText(lab,m.x,m.y-4); } }
      for(const tr of data.trunkList){ const k=tkey(tr.a,tr.b); const h=histByKey[k]; if(h&&h.ld) continue; drawArc(tr.a, tr.b, '#5a9bff', 0.18, 0.7, {live:tr, hist:h}); }
    } else {
      for(const h of data.history||[]){ const k=tkey(h.a,h.b); if(liveKey[k]) continue; drawArc(h.a, h.b, focus===k?'#ffffff':useColor(h.uses), focus===k?1:0.22, focus===k?2.5:0.7, {hist:h}); }
      for(const tr of data.trunkList){ const k=tkey(tr.a,tr.b); const h=histByKey[k]; const m=drawArc(tr.a, tr.b, focus===k?'#ffffff':useColor(tr.uses||(h&&h.uses)||1), 0.9, 1+tr.used*0.5+(focus===k?2:0), {live:tr, hist:h}); if(m && m.front && (tr.streak||0)>=2){ ctx.globalAlpha=0.5+0.5*pulse; ctx.beginPath(); ctx.arc(m.x,m.y,4+Math.min(6,tr.streak),0,6.283); ctx.strokeStyle=streakColor(tr.streak); ctx.lineWidth=2; ctx.stroke(); } }
    }
    ctx.globalAlpha=1;
    // Data ports: each frame to the central aggregator, when a page names one.
    const hub = window.GLOBE_HUB; let hp = null;
    if(hub && on('ports')){ hp = proj(hub.lat, hub.lon); const filt = window.GLOBE_FILTER && window.GLOBE_FILTER.size;
      for(const n of data.nodes){ const p=pos[n.id]; if(!p) continue; if(p.z<=0 && hp.z<=0) continue; if(!shown(n)) continue;
        const hq=near(p,hp); const c=lift(p,hq,1.04); ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.quadraticCurveTo(c.x,c.y,hq.x,hq.y);
        if(n.sim===true){ ctx.setLineDash([]); ctx.strokeStyle='#3fb950'; ctx.globalAlpha=filt?0.8:0.45; }
        else if(n.sim===false){ ctx.setLineDash([3,4]); ctx.strokeStyle='#e3a35a'; ctx.globalAlpha=filt?0.9:0.6; }
        else { ctx.setLineDash([]); ctx.strokeStyle='#5a9bff'; ctx.globalAlpha=filt?0.45:0.12; }
        ctx.lineWidth=0.8; ctx.stroke(); ctx.setLineDash([]);
        if(n.sim===true){ const k=((t*0.4 + (n.lat+n.lon)*0.013)%1+1)%1, u=1-k; const x=u*u*p.x+2*u*k*c.x+k*k*hq.x, y=u*u*p.y+2*u*k*c.y+k*k*hq.y; ctx.globalAlpha=0.9; ctx.fillStyle='#7ee787'; ctx.beginPath(); ctx.arc(x,y,1.6,0,6.283); ctx.fill(); }
      }
      ctx.globalAlpha=1;
    }
    // Frames.
    if(on('frames')) for(const n of data.nodes){ const p=pos[n.id]; if(p.z<=0 || hiddenByUser(n)) continue; const r=3.2+Math.sqrt(n.live||0)*2.2; ctx.beginPath(); ctx.arc(p.x,p.y,r,0,6.283); ctx.fillStyle=nodeColor(n); ctx.globalAlpha=!shown(n)?0.1:(n.live>0?1:0.55); ctx.fill(); ctx.globalAlpha=1; if(n.live>0||hover===n.id){ ctx.strokeStyle='rgba(255,255,255,.5)'; ctx.lineWidth=1; ctx.stroke(); } }
    // Calls in flight, coloured by the caller's vendor; parked lines dimmer.
    if(on('calls')) for(let i=0;i<data.callList.length;i++){ const c=data.callList[i]; const hop=c.hops[Math.floor((t*0.25+i*0.37)%c.hops.length)]; const p=pos[hop[0]]; let q=pos[hop[1]]; if(!p||!q) continue; q=near(p,q); if(byId[c.hops[0][0]] && !shown(byId[c.hops[0][0]]) && byId[c.hops[c.hops.length-1][1]] && !shown(byId[c.hops[c.hops.length-1][1]])) continue; if(!(p.z>-0.05||q.z>-0.05)) continue; const u=((t*0.25+i*0.37)%1); const k=lift(p,q,1.12); const x=(1-u)*(1-u)*p.x+2*(1-u)*u*k.x+u*u*q.x, y=(1-u)*(1-u)*p.y+2*(1-u)*u*k.y+u*u*q.y; ctx.beginPath(); ctx.arc(x,y,c.muted?2:2.8,0,6.283); ctx.fillStyle=(c.badge&&c.badge.color)||(c.kind==='via'?'#b48cff':'#fff'); ctx.globalAlpha=c.muted?0.35:((p.z>0&&q.z>0)?1:0.35); ctx.fill(); }
    ctx.globalAlpha=1;
    if(hub && hp && hp.z>0){ const s=7; ctx.beginPath(); ctx.moveTo(hp.x,hp.y-s); ctx.lineTo(hp.x+s,hp.y); ctx.lineTo(hp.x,hp.y+s); ctx.lineTo(hp.x-s,hp.y); ctx.closePath(); ctx.fillStyle='#ffffff'; ctx.fill(); ctx.strokeStyle='#5a9bff'; ctx.lineWidth=2; ctx.stroke(); ctx.font='600 12px system-ui'; ctx.textAlign='left'; ctx.fillStyle='#e6edf7'; ctx.fillText('◆ '+hub.name+' aggregator', hp.x+10, hp.y+4); ctx.textAlign='center'; }
    // Labels: capitals always, provinces and cities when zoomed in or asked.
    ctx.textAlign='center';
    if(on('continents')) drawContinents(t);
    if(on('labels')) for(const k of data.clusters){ if(!tierShown(k.tier)) continue; const big = k.tier==='capital'||k.tier==='protocol'; if(!big && zoom<1.4 && k.tier!=='province') continue; const p=proj(k.lat,k.lon); if(p.z<=0.15) continue; ctx.globalAlpha=Math.min(big?1:(k.tier==='city'?0.6:0.75),(p.z-0.15)*3); ctx.fillStyle = big?'#8fa3c7':'#9fb0cc'; ctx.font = big?'600 12px system-ui':'10px system-ui'; ctx.fillText(k.name+(k.local?' '+k.local:''), p.x, p.y-(big?14:9)); }
    ctx.globalAlpha=1;
  }
  // Hover: nearest frame within 9px.
  canvas.addEventListener('pointermove', e=>{ if(dragging) return; const r=canvas.getBoundingClientRect(); let mx=e.clientX-r.left; const my=e.clientY-r.top; paneAt(mx); if(projection==='map'){ const w=mapW(); mx -= w*Math.round((mx-(pane.x+pane.w/2+panX))/w); } let best=null, bd=81; if(on('frames')) for(const n of data.nodes){ const p=proj(n.lat,n.lon); if(p.z<=0 || hiddenByUser(n)) continue; const d=(p.x-mx)**2+(p.y-my)**2; if(d<bd){ bd=d; best=n; } } if(best){ if(hover!==best.id){ hover=best.id; frozenRot=rot(); } tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; const b=best.badge?best.badge.emoji+' '+best.badge.vendor+' · ':''; tip.innerHTML='<b>'+esc(b+best.id)+'</b><br>'+esc(best.protoName+(best.site?' · '+best.site:''))+'<br>'+esc(best.ports+'+'+best.cas+' ports · '+best.free+' casters free · '+best.live+' panels live')+(best.load?'<br>load ×'+best.load.toFixed(1):'')+(best.sim===true?'<br>simulator ●':best.sim===false?'<br>simulator ○':'')+(best.who&&best.who.length?'<br>'+best.who.map(esc).join('<br>'):''); } else if(hover){ hover=null; dragOff = frozenRot - (Date.now()/1000)*SPEED; sessionStorage.setItem('globe.drag',dragOff); frozenRot=null; tip.style.display='none'; } });
  let contTip = false;
  canvas.addEventListener('pointermove', e=>{
    if(dragging || hover || !on('continents')){ if(contTip && !hover){ contTip=false; tip.style.display='none'; } return; }
    const r=canvas.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top; let best=null, bd=Infinity;
    for(const h of contHits){ const d=Math.hypot(h.x-mx, h.y-my); if(d<h.r && d<bd){ bd=d; best=h; } }
    if(!best){ if(contTip){ contTip=false; tip.style.display='none'; } return; }
    contTip=true; tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px';
    if(best.c){ const c=best.c, out=best.links.filter(l=>l.a===c.name||l.b===c.name).sort((x,y)=>y.trunks-x.trunks); tip.innerHTML='<b>'+esc(c.name)+'</b><br>'+c.sites.size+' sites · '+c.frames+' frames · '+c.live+' panels live<br>at home: '+c.homeTrunks+' trunks · '+c.homeCalls+' calls'+(out.length? '<br><br>trunks out:<br>'+out.map(l=>esc(l.a===c.name?l.b:l.a)+': <b>'+l.trunks+'</b> up · '+l.calls+' calls · used '+Number(l.uses).toLocaleString()+'×').join('<br>') : '<br>no trunks to other continents'); }
    else { const l=best.l; tip.innerHTML='<b>'+esc(l.a)+' ↔ '+esc(l.b)+'</b><br>'+l.trunks+' trunks up · '+l.used+'/'+l.cap+' channels<br>'+l.calls+' calls<br>used <b>'+Number(l.uses).toLocaleString()+'</b> times'; }
  });
  canvas.addEventListener('pointerleave', ()=>{ if(hover){ dragOff = frozenRot - (Date.now()/1000)*SPEED; frozenRot=null; hover=null; } tip.style.display='none'; });
  // Drag: sideways turns, up/down tilts (globe) or pans (map). Wheel zooms.
  canvas.addEventListener('pointerdown', e=>{ const rr=canvas.getBoundingClientRect(); paneAt(e.clientX-rr.left); dragging={proj:projection, x:e.clientX,y:e.clientY,off: hover? frozenRot - (Date.now()/1000)*SPEED : dragOff, tilt:tilt, pan:panY, panx:panX}; if(hover){ hover=null; frozenRot=null; tip.style.display='none'; } e.preventDefault(); });
  window.addEventListener('pointermove', e=>{ if(!dragging) return; if(e.shiftKey || e.buttons===4){ panX = (dragging.panx||0) + (e.clientX-dragging.x); panY = dragging.pan + (e.clientY-dragging.y); sessionStorage.setItem('globe.panx',panX); sessionStorage.setItem('globe.pany',panY); return; } dragOff = dragging.off + (e.clientX-dragging.x)*0.35/zoom; sessionStorage.setItem('globe.drag',dragOff); if(dragging.proj==='map'){ panY = dragging.pan + (e.clientY-dragging.y); sessionStorage.setItem('globe.pany',panY); } else { tilt = Math.max(-85, Math.min(85, dragging.tilt - (e.clientY-dragging.y)*0.3/zoom)); sessionStorage.setItem('globe.tilt',tilt); const i=document.getElementById('g_tilt'); if(i) i.value=Math.round(tilt); } });
  window.addEventListener('pointerup', ()=>dragging=null);
  // The wheel takes you into the globe at the cursor: zoom about that point.
  canvas.addEventListener('wheel', e=>{ e.preventDefault(); const r=canvas.getBoundingClientRect(); const mx=e.clientX-r.left, my=e.clientY-r.top; const k=Math.pow(1.12, -e.deltaY/100); const nz=Math.max(0.6, Math.min(12, zoom*k)); const f=nz/zoom; paneAt(mx); if(pans()){ panX = mx - (mx - CX())*f - (pane.x+pane.w/2); panY = my - (my - CY())*f - H/2; } zoom=nz; if(zoom<=1.02){ panX=0; panY=0; } sessionStorage.setItem('globe.zoom',zoom); sessionStorage.setItem('globe.panx',panX); sessionStorage.setItem('globe.pany',panY); const z=document.getElementById('g_zoom'); if(z) z.value=zoom.toFixed(1); }, {passive:false});
  window.addEventListener('keydown', e=>{ if(e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return; if(e.key==='ArrowUp') tilt=Math.min(85,tilt+5); else if(e.key==='ArrowDown') tilt=Math.max(-85,tilt-5); else if(e.key==='ArrowLeft') dragOff-=10; else if(e.key==='ArrowRight') dragOff+=10; else if(e.key==='+'||e.key==='=') zoom=Math.min(8,zoom*1.2); else if(e.key==='-') zoom=Math.max(0.6,zoom/1.2); else if(e.key==='Home'){ tilt=cfg().tilt_deg; zoom=cfg().zoom||1; panY=0; panX=0; sessionStorage.setItem('globe.panx',0); sessionStorage.setItem('globe.pany',0); } else if(e.key==='m'||e.key==='M'){ mode = mode==='both'?'globe':mode==='globe'?'map':'both'; projection = mode==='map'?'map':'globe'; sessionStorage.setItem('globe.mode'+PAGE,mode); const sel=document.getElementById('g_proj'); if(sel) sel.value=mode; } else return; sessionStorage.setItem('globe.tilt',tilt); sessionStorage.setItem('globe.zoom',zoom); e.preventDefault(); });
  const pb=document.getElementById('g_proj'); if(pb){ pb.value=mode; pb.addEventListener('change',()=>{ mode=pb.value; projection=mode==='map'?'map':'globe'; sessionStorage.setItem('globe.mode'+PAGE,mode); }); }
  const gf = document.getElementById('globe-form');
  if(gf){ gf.addEventListener('submit', e=>{ e.preventDefault(); api('/api/globe/config',{rotate_deg_per_s:num('g_rot'),tilt_deg:Math.round(tilt),show_capitals:document.getElementById('g_cap').checked,show_provinces:document.getElementById('g_prov').checked,show_cities:document.getElementById('g_city').checked,graticule_deg:num('g_grat'),projection:mode,zoom:Number(zoom.toFixed(2))}).then(()=>{ setText('globe-saved','saved'); }); }); }
  // Deltas from the stream: trunks, calls, live counts. Nodes stay; a
  // changed fleet triggers one full fetch.
  TC.onGlobe.push(m=>{ if(m.frames!==data.nodes.length){ api('/api/globe').then(d=>{ if(d&&d.nodes){ data=d; index(); } }); return; } data.trunkList=m.trunkList; data.callList=m.callList; data.clusters=m.clusters||data.clusters; data.clock=m.clock; data.sites=m.sites; data.trunks=m.trunks; data.calls=m.calls; data.sims=m.sims; for(const n of data.nodes) n.live = (m.live&&m.live[n.id])||0; });
  TC.onStatus.push(m=>{ SPEED = (data.config&&data.config.rotate_deg_per_s!=null)? data.config.rotate_deg_per_s : SPEED; renderSide(m); });
  // Totals beside the globe: continent to continent, and every line's lease.
  function renderSide(m){
    const ct=document.getElementById('side-continents'); if(ct && m.continents){ const cross=m.continents.filter(c=>c.crossing), home=m.continents.filter(c=>!c.crossing); ct.innerHTML = '<tr><th>From</th><th>To</th><th>Ocean</th><th>Calls</th></tr>' + cross.map(c=>'<tr><td>'+esc(c.from)+'</td><td>'+esc(c.to)+'</td><td class="muted">'+esc(c.ocean||'')+'</td><td><b>'+c.calls+'</b>'+(c.muted?' <span class="muted">('+c.muted+' parked)</span>':'')+'</td></tr>').join('') + (home.length?'<tr><th colspan=4 style="padding-top:8px">Within a continent</th></tr>'+home.map(c=>'<tr><td colspan=3>'+esc(c.from)+'</td><td><b>'+c.calls+'</b></td></tr>').join(''):''); }
    const ln=document.getElementById('side-lines'); if(ln && m.lines){ ln.innerHTML = m.lines.slice(0,40).map(l=>{ const pct=Math.max(0,Math.min(100,l.left/l.lease*100)); const cls=l.state==='red'?'red':l.state==='parked'?'parked':'green'; return '<div class="line '+cls+'" title="'+esc(l.id)+'"><div class="lbar"><i style="width:'+pct+'%"></i></div><span>'+(l.badge?l.badge.emoji+' ':'')+esc(l.who)+'</span><span class="muted">'+esc((l.from_site||l.from)+' → '+(l.to_site||l.to))+'</span><b>'+(l.state==='parked'?'parked':l.state==='red'?'may be dead':dur(l.left))+'</b></div>'; }).join(''); setText('side-count', m.lines.length+(m.status&&m.status.connections>m.lines.length?' of '+m.status.connections:'')+' lines'); }
    if(m.run){ setText('side-run', m.run.id+' · '+m.run.summary.granted+' granted · '+m.run.summary.denied+' denied · peak '+m.run.summary.peak_live); }
  }
  // Hover a trunk: how many times it was used and its trend.
  const nearestArc = e => { const r=canvas.getBoundingClientRect(); const mx=e.clientX-r.left, my=e.clientY-r.top; let best=null, bd=64; for(const a of arcs){ for(const [x,y] of a.pts){ const d=(x-mx)**2+(y-my)**2; if(d<bd){ bd=d; best=a; } } } return best; };
  canvas.addEventListener('pointermove', e=>{ if(dragging || hover){ arcTip=false; return; } const best=nearestArc(e); if(best){ arcTip=true; tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; tip.innerHTML=trunkTip(best.rec); } else if(arcTip){ arcTip=false; tip.style.display='none'; } });
  let downAt=null; canvas.addEventListener('pointerdown', e=>{ downAt=[e.clientX,e.clientY]; });
  canvas.addEventListener('click', e=>{ if(downAt && Math.hypot(e.clientX-downAt[0], e.clientY-downAt[1])>4) return; const best=nearestArc(e); if(best){ const rr=best.rec; const a=rr.live?rr.live.a:rr.hist.a, b=rr.live?rr.live.b:rr.hist.b; focusTrunk(tkey(a,b)); } });
  const vs=document.getElementById('g_view'); if(vs){ vs.value=view; vs.addEventListener('change',()=>{ view=vs.value; sessionStorage.setItem('globe.view',view); renderTrends(); }); }
  window.addEventListener('keydown', e=>{ if(e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return; if(e.key==='t'||e.key==='T'){ view = view==='trend'?'uses':'trend'; sessionStorage.setItem('globe.view',view); if(vs) vs.value=view; renderTrends(); } });
  TC.onGlobe.push(m=>{ if(m.history){ data.history=m.history; data.today=m.today; indexHist(); renderTrends(); } });
  renderTrends();
  // The list sits after the map on the page: draw it once the page is in.
  document.addEventListener('DOMContentLoaded', renderTrends);
  const cached = cacheGet('status'); if(cached) renderSide(cached);
  requestAnimationFrame(frame);
})();
"#;

pub fn globe_page(rt: &Runtime, live: bool) -> String {
    let data = globe_data(rt);
    let g = &rt.globe;
    let mut b = String::new();
    let _ = write!(
        b,
        r#"<div class="globewrap">
<section style="padding:10px 12px">{map}
<form id="globe-form" class="row" style="margin-top:8px">
<label>Rotation °/s<input id="g_rot" type="number" step="0.5" min="0" max="60" value="{rot}" style="width:70px"></label>
<label>Tilt °<input id="g_tilt" type="number" step="1" min="-85" max="85" value="{tilt}" style="width:70px"></label>
<label>Zoom<input id="g_zoom" type="number" step="0.1" min="0.6" max="8" value="{zoom}" style="width:70px" readonly></label>
<label>Graticule °<input id="g_grat" type="number" step="5" min="10" max="90" value="{grat}" style="width:70px"></label>
<label><input id="g_cap" type="checkbox" {cap}> capitals</label><label><input id="g_prov" type="checkbox" {prov}> provinces</label><label><input id="g_city" type="checkbox" {city}> cities</label>
<button type="submit" class="small">Save globe preferences</button><span class="note" id="globe-saved">drag to turn and tilt · wheel zooms in at the cursor · shift-drag pans the map · M cycles both / globe / map · Home resets · saved to <code>TRUNK-GLOBAL/globe.json</code></span></form>
<p class="note" style="margin:8px 0 0">Every frame sits at its site: capitals host 10 frames, states and provinces 1, smaller cities an 8×8 and a 2×2. Lines are trunks; the moving dots are calls in flight, coloured by the caller's vendor: 🔵 Clear-Com, 🔴 Riedel, 🟣 RTS, 🟡 Telos, 🟢 Intracom, 🟠 Ward-Beck, ⚪ relay; parked lines are dim. Site labels carry their local clock; the news surges follow the sun. Scrub the day in the footer.</p>
</section>
<aside class="globeside">
<section><h2>Trunk trends <span class="muted" id="trend-count"></span></h2><p class="note">Each trunk with the number of times it was used and its last {days} days: bars are uses per day, coloured on the days it was locked (held {lockh} h or more). The strip under it is the hours of the day it was locked. A trunk locked day after day at the same hours is a habit. Click one to find it on the globe; <b>T</b> flips to the trend view.</p><div id="side-trends" class="trends"><span class="muted">loading…</span></div></section>
<section><h2>Discovery</h2><p class="note">Global → continent → country → site → device. Click a device for its own data and timeline.</p><div id="tree" class="tree"><span class="muted">loading…</span></div></section>
<section id="device-panel" style="display:none"><h2 id="device-title">Device</h2><div id="device-body"></div></section>
<section><h2>Continent to continent</h2><table id="side-continents"><tr><td class="muted">waiting for the stream…</td></tr></table></section>
<section><h2>Lines <span class="muted" id="side-count"></span></h2><p class="note">Green: lease left (15 min, reset when the line is used). Red: may be dead, bandwidth on hold, first to be reclaimed. Parked: connected but muted until the next sweep.</p><div id="side-lines" class="lines"></div><p class="note" id="side-run"></p></section>
</aside></div>
<style>.globewrap{{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}}.globeside{{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;align-items:start}}.globeside section{{margin-bottom:0}}
.trends{{max-height:46vh;overflow:auto}}.trends .trend{{padding:5px 4px;border-bottom:1px dashed var(--line);cursor:pointer;font-size:12px}}.trends .trend:hover,.trends .trend.on{{background:var(--free)}}.trends .tt .muted{{font-size:10.5px}}.trends .tn{{display:flex;gap:6px;align-items:center;margin:2px 0}}.trends .uses,.trends .streak{{color:#0b1020;font-weight:700;border-radius:9px;padding:0 7px;font-size:11px}}.trends .spark{{display:block;width:100%;height:22px}}.trends .lockclock{{display:grid;grid-template-columns:repeat(24,1fr);gap:1px;height:6px;margin-top:2px}}.trends .lockclock i{{display:block;border-radius:1px}}
.globe{{display:block;width:100%;height:min(80vh,900px);background:#0b1020;border-radius:8px;cursor:grab;touch-action:none}}.tip{{display:none;position:fixed;z-index:20;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;pointer-events:none;max-width:320px}}
.lines .line{{display:grid;grid-template-columns:70px 1fr 1fr auto;gap:6px;align-items:center;font-size:12px;padding:2px 0;border-bottom:1px dashed var(--line)}}.lines .lbar{{height:8px;background:var(--free);border-radius:4px;overflow:hidden}}.lines .lbar i{{display:block;height:100%;background:var(--ok)}}.lines .red .lbar i{{background:var(--bad);width:100%!important}}.lines .red b{{color:var(--bad)}}.lines .parked .lbar i{{background:var(--muted)}}.lines .parked b{{color:var(--muted)}}
.tree details{{margin-left:10px}}.tree summary{{cursor:pointer;font-size:12.5px;padding:2px 0}}.tree summary .st{{color:var(--muted);font-size:11px;margin-left:6px}}.tree .dev{{display:block;margin-left:26px;font-size:12px;padding:1px 0;cursor:pointer;color:var(--accent)}}.tree .dev:hover{{text-decoration:underline}}.tree .dev .st{{color:var(--muted);font-size:11px;margin-left:6px}}
</style>
<script>{disc}</script>"#,
        map = map_block(&data, "", if g.projection.is_empty() { "both" } else { &g.projection }, None, None),
        disc = DISCOVERY_JS,
        days = crate::trends::DAYS_SHOWN,
        lockh = crate::trends::LOCK_SECONDS / 3600.0,
        rot = g.rotate_deg_per_s,
        tilt = g.tilt_deg,
        zoom = g.zoom,
        grat = g.graticule_deg,
        cap = if g.show_capitals { "checked" } else { "" },
        prov = if g.show_provinces { "checked" } else { "" },
        city = if g.show_cities { "checked" } else { "" },
    );
    page("Globe", rt, live, 0, &b)
}

/// The fold-out discovery: Global → continent → country → site → device,
/// with stats at every level; a device click shows that device's own data
/// and timeline, not the fleet's.
const DISCOVERY_JS: &str = r#"
(function(){
  const root = document.getElementById('tree'); if(!root) return;
  const st = (o, keys) => '<span class="st">'+keys.map(k=>o[k]!=null? (k==='load'? '×'+Number(o[k]).toFixed(1) : o[k]+' '+k.replace('_',' ')) : '').filter(Boolean).join(' · ')+'</span>';
  const openSet = new Set(JSON.parse(sessionStorage.getItem('tree.open')||'[]'));
  const remember = () => sessionStorage.setItem('tree.open', JSON.stringify(Array.from(root.querySelectorAll('details[open]')).map(d=>d.dataset.k)));
  const det = (k, title, stats, inner, open) => '<details data-k="'+esc(k)+'"'+(open?' open':'')+'><summary><b>'+esc(title)+'</b>'+stats+'</summary>'+inner+'</details>';
  function render(t){
    let h = '<div class="note">Global · '+t.global.sites+' sites · '+t.global.frames+' frames · '+t.global.calls+' calls ('+t.global.parked+' parked) · '+t.global.trunks+' trunks · '+t.global.clock+' UTC</div>';
    for(const c of t.continents){
      const kc='c:'+c.continent;
      let inner='';
      for(const k of c.children){
        const kk=kc+'/'+k.country;
        let sinner='';
        for(const s of k.children){
          const ks=kk+'/'+s.site;
          const devs = s.devices.map(d=>'<a class="dev" data-id="'+esc(d.id)+'">'+(d.badge?d.badge.emoji+' ':'')+esc(d.id)+' <span class="muted">'+esc(d.protocol)+'</span>'+st(d,['calls','parked','panels_live'])+(d.sim===true?' <span class="ok">●</span>':d.sim===false?' <span class="warn">○</span>':'')+'</a>').join('');
          sinner += det(ks, s.site+(s.tier?' ('+s.tier+')':''), st(s,['local_clock','load','frames','calls','parked']), devs, openSet.has(ks));
        }
        inner += det(kk, k.country, st(k,['sites','frames','calls','parked']), sinner, openSet.has(kk));
      }
      h += det(kc, c.continent, st(c,['countries','frames','calls','parked','panels_live']), inner, openSet.has(kc));
    }
    root.innerHTML = h;
    root.querySelectorAll('details').forEach(d=>d.addEventListener('toggle', remember));
    root.querySelectorAll('a.dev').forEach(a=>a.addEventListener('click', ()=>showDevice(a.dataset.id)));
  }
  let selected = sessionStorage.getItem('tree.device');
  async function showDevice(id){
    selected = id; sessionStorage.setItem('tree.device', id);
    const d = await api('/api/device/'+encodeURIComponent(id)); if(!d || d.error) return;
    const p = document.getElementById('device-panel'), body = document.getElementById('device-body');
    p.style.display='block'; document.getElementById('device-title').textContent = (d.frame.badge?d.frame.badge.emoji+' ':'')+d.frame.id+' · '+d.frame.protocol_name;
    const f=d.frame;
    let h = '<div class="tiles">'+[['site',f.site||'—'],['local clock',d.local_clock||'—'],['load',d.load?'×'+d.load.toFixed(1):'—'],['casters free',f.free_casters+'/'+f.casters],['panels live',Object.keys(f.live_ports||{}).length+'/'+f.user_ports],['since last',f.seconds_since_last_connection!=null?dur(f.seconds_since_last_connection)+' ago':'never']].map(([k,v])=>'<div class="tile"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></div>').join('')+'</div>';
    if(d.remote) h += '<p class="note">simulator '+(d.remote.connected?'● connected':'○ gone')+' · '+d.remote.acks+' acks · reports '+d.remote.reported_closed+' crosspoints</p>';
    h += '<h3>Its lines</h3>'+(d.lines.length? '<table>'+d.lines.map(l=>'<tr><td class="'+(l.state==='red'?'bad':l.state==='parked'?'muted':'ok')+'">'+l.state+'</td><td>'+esc(l.who)+'</td><td class="muted">'+l.role+'</td><td>'+esc(l.from)+' → '+esc(l.to)+'</td><td>'+dur(l.connected_for)+'</td><td>'+(l.state==='green'?dur(l.left)+' left':'')+'</td></tr>').join('')+'</table>' : '<p class="muted">no lines</p>');
    h += '<h3>Its trunks</h3>'+(d.trunks.length? '<table>'+d.trunks.map(t=>'<tr><td>C'+t.caster+'</td><td>→ '+esc(t.peer)+'</td><td>'+t.used+'/'+t.capacity+' ch</td><td>'+(t.gain?t.gain.toFixed(1)+' dB':'')+'</td></tr>').join('')+'</table>' : '<p class="muted">no trunks up</p>');
    const labels = Object.entries(d.labels||{}); if(labels.length) h += '<h3>Panel names</h3><table>'+labels.map(([p,l])=>'<tr><td>'+p+'</td><td><code>'+esc(l.l6)+'</code></td><td><code>'+esc(l.l8)+'</code></td><td><code>'+esc(l.l16)+'</code></td></tr>').join('')+'</table>';
    h += '<h3>Its timeline</h3>'+(d.events.length? '<div class="scroll" style="max-height:220px"><table>'+d.events.map(e=>'<tr><td class="muted">'+esc(e.when.slice(11,19))+'</td><td>'+esc(e.who)+'</td><td>'+esc(e.from)+' → '+esc(e.whom)+'</td><td class="status-'+e.status+'">'+e.status+'</td><td>'+(e.lasted!=null?dur(e.lasted):'')+'</td></tr>').join('')+'</table></div>' : '<p class="muted">nothing recorded yet</p>');
    body.innerHTML = h;
  }
  async function load(){ try{ const t = await api('/api/tree'); if(t && t.continents){ cacheSet('tree', t); render(t); } }catch(e){} if(selected && document.getElementById('device-panel').style.display!=='none') showDevice(selected); }
  const cached = cacheGet('tree'); if(cached) render(cached);
  load(); setInterval(load, 6000);
  if(selected) showDevice(selected);
})();
"#;

// ---------------------------------------------------------------------------
// Panels: every panel and the trunk-caster keys on it, under a board of
// blinking lights, one per intercom frame.
// ---------------------------------------------------------------------------

pub fn panels_page(rt: &Runtime, live: bool) -> String {
    let st = &rt.state;
    let now = util::now_unix();
    let lease = rt.fader.lease_seconds;
    let mut b = String::new();

    // The light board: one light per frame, no names. Under each light the
    // destination it is connected to (frame to frame), how long that
    // connection has been up, its lease counting down and the caster keys.
    let mut frames: Vec<&Frame> = st.frames.iter().collect();
    frames.sort_by(|a, b| (a.continent.as_deref().unwrap_or(""), &a.site, &a.id).cmp(&(b.continent.as_deref().unwrap_or(""), &b.site, &b.id)));
    let _ = write!(
        b,
        r#"<section><h2>Light board <span class="muted" id="lights-summary"></span></h2><p class="note">One light per intercom frame, a column per continent. Under each light: the frame, the destination it is connected to, how long that connection has been up, its lease counting down and its caster keys. <a href="/panels?pop=Light%20board" target="_blank" rel="noopener">Open the board in its own window ↗</a> and stretch it across your monitors; the continents spread to fill it.</p>
<div class="lkey"><span><i class="k on"></i>green · good to go</span><span><i class="k idle"></i>ready, nothing connected</span><span><i class="k red"></i>red · high capacity ({hot}% or more of its panels or casters in use)</span><span><i class="k stale"></i>amber · lease ran out, may be dead</span><span><i class="k parked"></i>grey · every line parked</span><span><i class="k off"></i>dashed · simulator not connected</span><span><i class="k blink"></i>blinking · a call just came or went</span><span><span class="ck"><u class="on"></u><u></u><u class="on"></u><u></u></span>caster keys, lit when a trunk rides them</span><span><span class="cd" style="width:44px"><b style="width:60%"></b></span>lease left</span></div>
<div class="lights" id="lights">"#,
        hot = (HOT_SHARE * 100.0) as u32
    );
    let mut last_cont: Option<String> = None;
    for f in &frames {
        let cont = f.continent.clone().unwrap_or_else(|| if f.protocol == crate::relay::PROTOCOL { "This computer".into() } else { "Other".into() });
        if last_cont.as_deref() != Some(cont.as_str()) {
            if last_cont.is_some() {
                b.push_str("</div></div>");
            }
            let _ = write!(b, r#"<div class="lcont"><span class="lgroup">{}</span><div class="lset">"#, esc(&cont));
            last_cont = Some(cont);
        }
        let l = light_of(rt, f, now, lease);
        let off = matches!(rt.remotes.frames.get(&f.id), Some(r) if !r.connected);
        let badge = f.badge.as_ref().map(|b| b.color.as_str()).unwrap_or("#9aa3ad");
        let keys: String = l.casters.iter().map(|on| if *on { r#"<u class="on"></u>"# } else { "<u></u>" }).collect();
        let (dest, len, left, pct) = match &l.conn {
            Some(c) => (
                format!("→ {}{}", esc(&c.to), if c.more > 0 { format!(" +{}", c.more) } else { String::new() }),
                dur(c.since_secs),
                if c.left <= 0.0 { "ran out".to_string() } else { dur(c.left as u64) },
                (c.left / lease.max(1.0) * 100.0).clamp(0.0, 100.0),
            ),
            None => ("ready".to_string(), String::new(), String::new(), 0.0),
        };
        let _ = write!(
            b,
            r#"<span class="light {state}{off}" data-id="{id}" data-live="{n}" style="--c:{badge}" title="{id} · {proto} · {site}{dest_t}"><i></i><small class="me">{id}</small><small class="dest">{dest}</small><small class="len">{len}</small><span class="cd"><b style="width:{pct:.0}%"></b><em>{left}</em></span><span class="ck">{keys}</span></span>"#,
            state = l.state,
            off = if off { " off" } else { "" },
            id = esc(&f.id),
            n = l.live,
            proto = esc(&f.protocol_name),
            site = esc(&f.site),
            dest_t = l.conn.as_ref().map(|c| format!(" · to {} · up {} · lease {}", esc(&c.to), dur(c.since_secs), if c.left <= 0.0 { "ran out".to_string() } else { dur(c.left as u64) + " left" })).unwrap_or_default(),
        );
    }
    if last_cont.is_some() {
        b.push_str("</div></div>");
    }
    b.push_str("</div></section>");
    let _ = write!(b, "<script>window.LIGHTS0={};</script>", lights_json(rt));

    // The phone book.
    let book = rt.phone_book();
    let _ = write!(
        b,
        r#"<section><h2>Phone book <span class="muted">{} people</span></h2><p class="note">Everyone who has called: the panels that carry their name right now, where those are, how often they call and when they were last seen. Names as 6-, 8- and 16-character panels show them.</p><div class="scroll" style="max-height:50vh"><table><tr><th>Who</th><th>6</th><th>8</th><th>16</th><th>On panels</th><th>Sites</th><th>Calls</th><th>Live now</th><th>Last seen</th><th>Last called</th></tr>"#,
        book.len()
    );
    for p in book.iter().take(400) {
        let _ = write!(
            b,
            r#"<tr><td>{} <b>{}</b></td><td><code>{}</code></td><td><code>{}</code></td><td><code>{}</code></td><td class="muted">{}</td><td class="muted">{}</td><td>{}</td><td>{}</td><td class="muted">{}</td><td class="muted">{}</td></tr>"#,
            p.badge.as_ref().map(|b| b.emoji.as_str()).unwrap_or(""),
            esc(&p.who),
            esc(&p.label.l6),
            esc(&p.label.l8),
            esc(&p.label.l16),
            esc(&p.panels.iter().take(6).cloned().collect::<Vec<_>>().join(", ")) + if p.panels.len() > 6 { " …" } else { "" },
            esc(&p.sites.iter().take(4).cloned().collect::<Vec<_>>().join(", ")),
            p.calls,
            p.live_now,
            esc(p.last_seen.as_deref().unwrap_or("")),
            esc(p.last_called.as_deref().unwrap_or(""))
        );
    }
    if book.is_empty() {
        b.push_str("<tr><td colspan=\"10\" class=\"muted\">Nobody has called yet.</td></tr>");
    }
    b.push_str("</table></div></section>");

    // Every panel with its keys.
    #[allow(clippy::type_complexity)]
    let mut rows: Vec<(bool, String, usize, String)> = Vec::new(); // (live, frame, port, html)
    for f in &st.frames {
        let labels = st.labels_of(&f.id);
        let live_ports = st.live_ports_of(&f.id);
        let mut ports: std::collections::BTreeSet<usize> = labels.keys().filter_map(|p| p.trim_start_matches('U').parse().ok()).collect();
        ports.extend(live_ports.keys().filter_map(|p| p.trim_start_matches('U').parse::<usize>().ok()));
        for port in ports {
            let pl = user_port(port);
            let conn = st.connections.iter().find(|c| (c.from_frame == f.id && c.from_port == port) || (c.to_frame == f.id && c.to_port == port));
            // The trunk-caster keys on this panel: the casters its calls ride.
            let mut keys: Vec<String> = rt
                .crosspoints
                .current
                .iter()
                .filter(|cp| cp.frame == f.id && (cp.input == pl || cp.output == pl))
                .map(|cp| if cp.input == pl { cp.output.clone() } else { cp.input.clone() })
                .filter(|k| k.starts_with('C'))
                .collect();
            keys.sort();
            keys.dedup();
            let key_html: String = (0..f.casters)
                .map(|k| {
                    let kl = format!("C{k}");
                    let on = keys.contains(&kl);
                    let peer = st.trunks.iter().find(|t| t.caster_on(&f.id) == Some(k)).and_then(|t| t.peer_of(&f.id)).unwrap_or("");
                    format!(r#"<span class="key{}" title="{} {}">{}</span>"#, if on { " on" } else { "" }, kl, esc(peer), k)
                })
                .collect();
            let label = labels.get(&pl).cloned().unwrap_or_else(|| Label::new(live_ports.get(&pl).map(String::as_str).unwrap_or(&pl)));
            let (state, far, gpio, since) = match conn {
                Some(c) => {
                    let left = c.lease_left(rt.sim_time, lease);
                    let far = if c.from_frame == f.id { format!("{}:{}", c.to_frame, user_port(c.to_port)) } else { format!("{}:{}", c.from_frame, user_port(c.from_port)) };
                    let state = if c.muted { "<span class=\"muted\">parked</span>".to_string() } else if left <= 0.0 { "<span class=\"bad\">red · may be dead</span>".to_string() } else { format!("<span class=\"ok\">green · {} left</span>", dur(left.max(0.0) as u64)) };
                    (state, far, c.gpio_sent, dur(c.connected_for(now)))
                }
                None => ("<span class=\"muted\">idle</span>".to_string(), String::new(), 0, String::new()),
            };
            let badge = f.badge.as_ref().map(|b| b.emoji.as_str()).unwrap_or("");
            let html = format!(
                r#"<tr><td>{badge} <b>{}</b>:{}</td><td class="muted">{}</td><td><code>{}</code></td><td><code>{}</code></td><td><code>{}</code></td><td>{}</td><td>{}</td><td class="keys">{}</td><td>{}</td><td>{}</td><td class="muted">{}</td><td><button class="small secondary" onclick="rename('{}',{})">rename</button></td></tr>"#,
                esc(&f.id), pl, esc(&f.site), esc(&label.l6), esc(&label.l8), esc(&label.l16),
                esc(live_ports.get(&pl).map(String::as_str).unwrap_or("")), esc(&far), key_html, gpio, state, since, esc(&f.id), port
            );
            rows.push((conn.is_some(), f.id.clone(), port, html));
        }
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let total = rows.len();
    let _ = write!(
        b,
        r#"<section><h2>Panels <span class="muted">{} named or live, {} live</span></h2><p class="note">Every panel (a user port with a name or a call) and the trunk-caster keys on it: the casters its call rides are lit. Names as a 6-, 8- and 16-character panel shows them.</p><div class="scroll" style="max-height:70vh"><table><tr><th>Panel</th><th>Site</th><th>6</th><th>8</th><th>16</th><th>Who</th><th>Far end</th><th>Keys (casters)</th><th>GPIO</th><th>Lease</th><th>Connected</th><th></th></tr>"#,
        total,
        rows.iter().filter(|r| r.0).count()
    );
    for (_, _, _, html) in rows.iter().take(500) {
        b.push_str(html);
    }
    if total == 0 {
        b.push_str("<tr><td colspan=\"12\" class=\"muted\">No panels named or live yet.</td></tr>");
    }
    b.push_str("</table></div></section>");

    let _ = write!(
        b,
        r#"<style>.lights{{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px 14px;align-items:start}}.lights .lcont{{min-width:0}}.lights .lgroup{{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:2px 0 4px;border-bottom:1px solid var(--line)}}.lights .lset{{display:flex;flex-wrap:wrap;gap:4px 3px;align-items:flex-start}}
.light{{display:inline-flex;flex-direction:column;align-items:center;width:92px;font-size:9px;color:var(--muted);text-align:center;overflow:hidden;padding:2px 0}}.light small{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px;display:block;line-height:1.25}}.light small.dest{{color:var(--ink);font-size:9px;min-height:11px}}.light small.len{{color:var(--ink);font-weight:600;min-height:11px;font-variant-numeric:tabular-nums}}.light.gpio i{{animation:blink .25s steps(2,start) 16}}
.light i,.lkey i.k{{display:block;width:14px;height:14px;border-radius:50%;background:var(--free);border:2px solid var(--line);margin-bottom:1px;transition:background .3s,box-shadow .3s;box-sizing:border-box}}
.light.idle i,.lkey i.idle{{border-color:#3fb950}}.light.on i,.lkey i.on{{background:#3fb950;border-color:#3fb950;box-shadow:0 0 8px #3fb950}}.light.parked i,.lkey i.parked{{background:var(--muted);border-color:var(--muted)}}.light.red i,.lkey i.red{{background:var(--bad);border-color:var(--bad);box-shadow:0 0 8px var(--bad)}}.light.stale i,.lkey i.stale{{background:#e3a35a;border-color:#e3a35a;box-shadow:0 0 6px #e3a35a}}.light.off i,.lkey i.off{{background:transparent;border-style:dashed;border-color:var(--muted)}}
.light .cd,.lkey .cd{{position:relative;display:block;width:80px;height:9px;background:var(--free);border-radius:3px;overflow:hidden;margin:1px 0}}.light .cd b,.lkey .cd b{{display:block;height:100%;background:#3fb950;opacity:.55}}.light.stale .cd b{{background:#e3a35a}}.light.red .cd b{{background:var(--bad)}}.light .cd em{{position:absolute;inset:0;font-style:normal;font-size:8px;line-height:9px;color:var(--ink);font-variant-numeric:tabular-nums}}.light.idle .cd,.light:not(.on):not(.red):not(.stale):not(.parked) .cd{{visibility:hidden}}
.light .ck,.lkey .ck{{display:flex;gap:1px;margin-top:1px}}.light .ck u,.lkey .ck u{{display:block;width:8px;height:5px;background:var(--free);border-radius:1px}}.light .ck u.on,.lkey .ck u.on{{background:var(--used)}}
.lkey{{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:11.5px;color:var(--muted);margin:6px 0 10px}}.lkey>span{{display:inline-flex;align-items:center;gap:5px}}.lkey i.k{{margin:0}}.lkey i.blink{{background:#3fb950;border-color:#3fb950;animation:blink .7s steps(2,start) infinite}}
.light.blink i{{animation:blink .35s steps(2,start) 6}}@keyframes blink{{to{{visibility:hidden}}}}
.keys .key{{display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;font-size:10px;border-radius:3px;background:var(--free);color:var(--muted);margin-right:2px}}.keys .key.on{{background:var(--used);color:#fff;font-weight:600}}</style>
<script>
(function(){{
  if(!document.getElementById('lights')) return;
  // The page refresh swaps the board, so look it up each time.
  const board={{querySelectorAll:q=>(document.getElementById('lights')||document.createElement('div')).querySelectorAll(q)}};
  const L0=window.LIGHTS0||{{}};
  let prev={{}}, conns=L0.conn||{{}}, got=Date.now()/1000, lease=L0.lease||900, skew=L0.now? L0.now-Date.now()/1000 : 0;
  const fmt=s=>{{ s=Math.max(0,Math.floor(s)); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60; return h? h+'h '+String(m).padStart(2,'0')+'m' : m? m+'m '+String(x).padStart(2,'0')+'s' : x+'s'; }};
  // Every second: lengths count up, leases count down, between stream updates.
  function tick(){{ const now=Date.now()/1000, el0=now-got;
    board.querySelectorAll('.light').forEach(el=>{{ const c=conns[el.dataset.id]; const len=el.querySelector('.len'), cd=el.querySelector('.cd'), dest=el.querySelector('.dest'); if(!len) return;
      if(!c){{ len.textContent=''; if(dest) dest.textContent='ready'; return; }}
      len.textContent=fmt(now+skew-c.since); if(dest) dest.textContent='→ '+c.to+(c.more?' +'+c.more:'');
      const left=c.left-el0; if(cd){{ cd.querySelector('em').textContent= left<=0? 'ran out' : fmt(left); cd.querySelector('b').style.width=Math.max(0,Math.min(100,left/lease*100)).toFixed(0)+'%'; }} }}); }}
  setInterval(tick, 1000);
  TC.onGlobe.push(m=>{{ if(!m.lights) return; const L=m.lights; const gp=new Set(m.blink||[]); conns=L.conn||{{}}; got=Date.now()/1000; lease=L.lease||lease; if(L.now) skew=L.now-got;
    const hot=new Set(L.hot||[]), stale=new Set(L.stale||[]), parked=new Set(L.parked||[]), live=L.live||{{}}, cas=L.casters||{{}}; let on=0, blink=0, reds=0, ambers=0;
    board.querySelectorAll('.light').forEach(el=>{{ const id=el.dataset.id; const n=live[id]||0; const was=prev[id]||0;
      const st= hot.has(id)? 'red' : stale.has(id)? 'stale' : parked.has(id)? 'parked' : n>0? 'on' : 'idle';
      ['on','idle','red','stale','parked'].forEach(k=>el.classList.toggle(k, k===st)); el.classList.toggle('gpio', gp.has(id));
      if(n!==was){{ el.classList.remove('blink'); void el.offsetWidth; el.classList.add('blink'); blink++; }}
      if(n>0) on++; if(st==='red') reds++; if(st==='stale') ambers++;
      const ck=el.querySelector('.ck'); const bits=cas[id]; if(ck && bits){{ const us=ck.children; for(let i=0;i<us.length;i++) us[i].classList.toggle('on', bits.charAt(i)==='1'); }}
      el.dataset.live=n; prev[id]=n; }});
    tick();
    setText('lights-summary', on+' connected · '+reds+' high capacity · '+ambers+' lease ran out · '+blink+' changed · '+gp.size+' blinking by GPIO');
  }});
}})();
</script>"#
    );
    page("Panels", rt, live, 6000, &b)
}

/// Share of a frame's panel ports or casters in use at which its light goes red.
pub const HOT_SHARE: f64 = 0.75;

pub struct LightConn {
    pub to: String,
    pub since_unix: u64,
    pub since_secs: u64,
    pub left: f64,
    pub more: usize,
}

pub struct Light {
    pub state: &'static str,
    pub live: usize,
    pub conn: Option<LightConn>,
    pub casters: Vec<bool>,
}

/// One frame's light: green when it carries calls with room to spare, red at
/// high capacity, amber when a lease ran out, grey when every line is parked.
/// Its connection is the longest-running one, shown frame to frame.
pub fn light_of(rt: &Runtime, f: &Frame, now: u64, lease: f64) -> Light {
    let st = &rt.state;
    let mine: Vec<&Connection> = st.connections.iter().filter(|c| c.from_frame == f.id || c.to_frame == f.id).collect();
    let live_ports = st.live_ports_of(&f.id).len();
    let used = st.used_casters(&f.id);
    let share = (live_ports as f64 / f.user_ports.max(1) as f64).max(used as f64 / f.casters.max(1) as f64);
    let stale = mine.iter().any(|c| c.lease_left(rt.sim_time, lease) <= 0.0);
    let parked = !mine.is_empty() && mine.iter().all(|c| c.muted);
    let state = if share >= HOT_SHARE {
        "red"
    } else if stale {
        "stale"
    } else if parked {
        "parked"
    } else if !mine.is_empty() {
        "on"
    } else {
        "idle"
    };
    let conn = mine.iter().min_by_key(|c| c.granted_unix).map(|c| LightConn {
        to: if c.from_frame == f.id { c.to_frame.clone() } else { c.from_frame.clone() },
        since_unix: c.granted_unix,
        since_secs: c.connected_for(now),
        left: c.lease_left(rt.sim_time, lease),
        more: mine.len() - 1,
    });
    let mut casters = vec![false; f.casters];
    for a in st.caster_ads(&f.id) {
        if a.trunk.is_some() && a.index < casters.len() {
            casters[a.index] = true;
        }
    }
    Light { state, live: mine.len(), conn, casters }
}

/// The light board's part of the stream: states, connections and caster keys.
pub fn lights_json(rt: &Runtime) -> serde_json::Value {
    let now = util::now_unix();
    let lease = rt.fader.lease_seconds;
    let (mut hot, mut stale, mut parked) = (Vec::new(), Vec::new(), Vec::new());
    let mut live = serde_json::Map::new();
    let mut conn = serde_json::Map::new();
    let mut cas = serde_json::Map::new();
    for f in &rt.state.frames {
        let l = light_of(rt, f, now, lease);
        match l.state {
            "red" => hot.push(f.id.clone()),
            "stale" => stale.push(f.id.clone()),
            "parked" => parked.push(f.id.clone()),
            _ => {}
        }
        if l.live > 0 {
            live.insert(f.id.clone(), serde_json::json!(l.live));
        }
        if let Some(c) = &l.conn {
            conn.insert(f.id.clone(), serde_json::json!({ "to": c.to, "since": c.since_unix, "left": c.left, "more": c.more }));
        }
        if l.casters.iter().any(|x| *x) {
            cas.insert(f.id.clone(), serde_json::Value::String(l.casters.iter().map(|x| if *x { '1' } else { '0' }).collect()));
        }
    }
    serde_json::json!({ "now": now, "lease": lease, "hot": hot, "stale": stale, "parked": parked, "live": live, "conn": conn, "casters": cas })
}

// ---------------------------------------------------------------------------
// Panel editor: pick a region from the tree, then a frame, then one of its
// panels or inputs; rename it, or book it for a program on the timeline.
// ---------------------------------------------------------------------------

const EDITOR_JS: &str = r#"
function bookPort(frame, port){
  const t=(val('bk-start')||'00:00').split(':').map(Number);
  api('/api/bookings',{frame:frame,port:port,kind:val('bk-kind'),program:val('bk-program')||'',who:val('bk-who')||null,to:val('bk-to')||null,start_hour:(t[0]||0)+(t[1]||0)/60,minutes:num('bk-min')||60,daily:!!(document.getElementById('bk-daily')||{}).checked})
    .then(r=>{ show('bk-result', r&&r.error? r.error : 'booked '+r.id+' · '+r.program); if(r&&!r.error) reload(); });
}
function renamePort(frame, port){ const n=val('rn-name'); if(!n) return; api('/api/rename',{frame:frame,port:port,name:n}).then(r=>{ show('rn-result', r&&r.error? r.error : 'renamed'); reload(); }); }
function findInTree(q){
  q=(q||'').trim().toLowerCase(); const tree=document.getElementById('ptree'); if(!tree) return;
  tree.querySelectorAll('a.tdev').forEach(a=>{ a.style.display = !q || a.textContent.toLowerCase().includes(q) || (a.dataset.where||'').toLowerCase().includes(q) ? '' : 'none'; });
  tree.querySelectorAll('details').forEach(d=>{ if(q){ d.open = !!Array.from(d.querySelectorAll('a.tdev')).find(a=>a.style.display!=='none'); } });
}
"#;

/// Where a booking falls on a frame's own clock, "HH:MM".
fn booking_local(rt: &Runtime, b: &crate::bookings::Booking, t: f64) -> String {
    hm((rt.tod_at(t) + rt.frame_offset_secs(&b.frame)) / 3600.0)
}

/// The booking timeline: one row per booked port, a bar from start to end
/// on the simulated clock, two hours back and a day ahead (UTC along the
/// top). Bars from the panel editor are blue, from the simulated traffic
/// violet, on air green, refused or missed red, finished grey.
fn booking_gantt(rt: &Runtime, list: &[&crate::bookings::Booking], max_rows: usize, live: bool) -> String {
    let now = rt.clock_abs();
    let (t0, t1) = (now - 2.0 * 3600.0, now + 22.0 * 3600.0);
    let mut rows: Vec<(String, usize)> = Vec::new();
    for b in list.iter().filter(|b| b.overlaps(t0, t1)) {
        let k = (b.frame.clone(), b.port);
        if !rows.contains(&k) {
            rows.push(k);
        }
    }
    if rows.is_empty() {
        return "<p class=\"muted\">Nothing booked in the next day.</p>".into();
    }
    let more = rows.len().saturating_sub(max_rows);
    rows.truncate(max_rows);
    let (w, lw, rh, top) = (960.0_f64, 170.0_f64, 15.0_f64, 18.0_f64);
    let h = top + rows.len() as f64 * rh + 4.0;
    let x = |t: f64| lw + ((t - t0) / (t1 - t0)).clamp(0.0, 1.0) * (w - lw - 8.0);
    let base = if live { String::new() } else { rt.endpoint.clone() };
    let mut s = String::new();
    let _ = write!(s, r#"<svg class="gantt" viewBox="0 0 {w} {h}" role="img" aria-label="Booking timeline">"#);
    // Hour lines, labelled every three hours on the UTC clock.
    let first = t0 + (3600.0 - rt.tod_at(t0).rem_euclid(3600.0));
    let mut t = first;
    while t < t1 {
        let hour = (rt.tod_at(t) / 3600.0).round() as u32 % 24;
        let _ = write!(s, r#"<line class="grid" x1="{0:.1}" x2="{0:.1}" y1="{1}" y2="{h}"/>"#, x(t), top - 4.0);
        if hour % 3 == 0 {
            let _ = write!(s, r#"<text x="{:.1}" y="11" text-anchor="middle">{hour:02}:00</text>"#, x(t));
        }
        t += 3600.0;
    }
    for (i, (frame, port)) in rows.iter().enumerate() {
        let y = top + i as f64 * rh;
        let _ = write!(
            s,
            r#"<a href="{}/panels/editor?frame={}&amp;port={}"><text class="row" x="{:.1}" y="{:.1}" text-anchor="end">{}:{}</text></a>"#,
            esc(&base), esc(frame), port, lw - 6.0, y + rh - 4.0, esc(frame), user_port(*port)
        );
        for b in list.iter().filter(|b| &b.frame == frame && b.port == *port && b.overlaps(t0, t1)) {
            let (xa, xb) = (x(b.start), x(b.end));
            let class = format!("bk {} {}", b.source, b.status.label().replace(' ', "-"));
            let _ = write!(
                s,
                r#"<rect class="{class}" x="{xa:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx="2"><title>{} · {} {} · {}:{} → {} · {}–{} local · {} min · {}{}{}</title></rect>"#,
                y + 2.0,
                (xb - xa).max(2.0),
                rh - 4.0,
                esc(&b.program),
                b.kind.label(),
                esc(&b.id),
                esc(&b.frame),
                user_port(b.port),
                esc(b.to.as_deref().unwrap_or("held locally")),
                booking_local(rt, b, b.start),
                booking_local(rt, b, b.end),
                ((b.end - b.start) / 60.0).round(),
                b.status.label(),
                if b.daily { " · daily" } else { "" },
                b.reason.as_deref().map(|r| format!(" · {}", esc(r))).unwrap_or_default(),
            );
            if xb - xa > 60.0 {
                let _ = write!(s, r#"<text class="bklbl" x="{:.1}" y="{:.1}">{}</text>"#, xa + 3.0, y + rh - 5.0, esc(&b.program));
            }
        }
    }
    let _ = write!(s, r#"<line class="nowline" x1="{0:.1}" x2="{0:.1}" y1="{1}" y2="{h}"/><text class="nowlabel" x="{0:.1}" y="{1}" text-anchor="middle">now</text>"#, x(now), top - 5.0);
    s.push_str("</svg>");
    if more > 0 {
        let _ = write!(s, r#"<p class="note">and {more} more booked ports</p>"#);
    }
    s
}

const GANTT_CSS: &str = r#"<style>.gantt{display:block;width:100%}.gantt .row{fill:var(--ink);font-size:10.5px}.gantt a:hover .row{fill:var(--accent)}.gantt .bklbl{fill:#fff;font-size:9.5px;pointer-events:none}
.gantt .bk{fill:var(--accent)}.gantt .bk.simulator{fill:var(--via);opacity:.8}.gantt .bk.on-air{fill:var(--ok);opacity:1}.gantt .bk.failed,.gantt .bk.missed{fill:var(--bad);opacity:.55}.gantt .bk.done{fill:var(--muted);opacity:.5}
.gantt .nowline{stroke:var(--bad);stroke-width:1.5}.gantt .nowlabel{fill:var(--bad);font-size:10px;font-weight:600}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted);margin:4px 0 8px}.legend i{display:inline-block;width:12px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}</style>"#;

fn gantt_legend() -> &'static str {
    r#"<div class="legend"><span><i style="background:var(--accent)"></i>booked in the panel editor</span><span><i style="background:var(--via)"></i>booked by the simulated traffic</span><span><i style="background:var(--ok)"></i>on air</span><span><i style="background:var(--bad);opacity:.55"></i>refused or missed</span><span><i style="background:var(--muted);opacity:.5"></i>done</span></div>"#
}

/// Upcoming and on-air bookings as a table, soonest first.
fn bookings_table(rt: &Runtime, list: &[&crate::bookings::Booking], cap: usize, live: bool) -> String {
    let now = rt.clock_abs();
    let base = if live { String::new() } else { rt.endpoint.clone() };
    let mut b = String::from("<div class=\"scroll\" style=\"max-height:40vh\"><table><tr><th>Booking</th><th>Port</th><th>Program</th><th>To</th><th>Local</th><th>Starts</th><th>Status</th><th>Booked by</th><th></th></tr>");
    let mut n = 0;
    for bk in list.iter().filter(|b| !b.status.finished()).take(cap) {
        n += 1;
        let starts = if bk.start > now { format!("in {}", dur((bk.start - now) as u64)) } else { format!("{} left", dur((bk.end - now).max(0.0) as u64)) };
        let _ = write!(
            b,
            r#"<tr><td><code>{}</code>{}</td><td><a href="{}/panels/editor?frame={}&amp;port={}">{}:{}</a> <span class="muted">{}</span></td><td><b>{}</b></td><td>{}</td><td>{}–{}</td><td>{}</td><td class="{}">{}</td><td class="muted">{} · {}</td><td><button class="small secondary" onclick="cancelBooking('{}')">cancel</button></td></tr>"#,
            esc(&bk.id),
            if bk.daily { " <span class=\"muted\">daily</span>" } else { "" },
            esc(&base), esc(&bk.frame), bk.port, esc(&bk.frame), user_port(bk.port), bk.kind.label(),
            esc(&bk.program),
            esc(bk.to.as_deref().unwrap_or("held locally")),
            booking_local(rt, bk, bk.start), booking_local(rt, bk, bk.end),
            starts,
            if bk.status == crate::bookings::BookingStatus::OnAir { "ok" } else { "" },
            bk.status.label(),
            esc(&bk.who), esc(&bk.source),
            esc(&bk.id),
        );
    }
    if n == 0 {
        b.push_str("<tr><td colspan=\"9\" class=\"muted\">Nothing booked.</td></tr>");
    }
    b.push_str("</table></div>");
    b
}

/// The Overlord's TIMELINE drop-down: every booking, two hours back and a
/// day ahead.
fn timeline_dropdown(rt: &Runtime, live: bool) -> String {
    use crate::bookings::BookingStatus as S;
    let list: Vec<&crate::bookings::Booking> = rt.bookings.list.iter().collect();
    let booked = list.iter().filter(|b| b.status == S::Booked).count();
    let on = list.iter().filter(|b| b.status == S::OnAir).count();
    let sim = list.iter().filter(|b| b.source == "simulator" && !b.status.finished()).count();
    let ed = list.iter().filter(|b| b.source != "simulator" && !b.status.finished()).count();
    let refused = list.iter().filter(|b| matches!(b.status, S::Failed | S::Missed)).count();
    format!(
        r#"<section><details class="timeline" data-id="overlord-timeline"><summary><b>TIMELINE</b> <span class="muted">{booked} booked · {on} on air · {sim} from the simulated traffic · {ed} from the panel editor · {refused} refused or missed</span></summary>
<p class="note">The bookings: a panel or an input held for a program from a start to an end. The simulated traffic books ahead as a booking desk would ({bph:.0} an hour); book your own in the <a href="{base}/panels/editor">panel editor</a>. When a booking starts the call is made and held until its end. Times along the top are UTC on the simulated clock; hover a bar for the frame's own local time.</p>{legend}{gantt}<h3>Next up</h3>{table}</details></section>{css}"#,
        bph = rt.fader.bookings_per_hour,
        base = if live { String::new() } else { esc(&rt.endpoint) },
        legend = gantt_legend(),
        gantt = booking_gantt(rt, &list, 80, live),
        table = bookings_table(rt, &list, 40, live),
        css = GANTT_CSS,
    )
}

/// The Overlord's TAPS and Mixes drop-down: a mixer of every connected
/// frame, one little fader per closed crosspoint, each the gain of the thing
/// coming in (the input) onto the output it is crossed to.
fn taps_dropdown(rt: &Runtime) -> String {
    let st = &rt.state;
    let voices = rt.voices.lock().unwrap_or_else(|e| e.into_inner());
    let mut by_frame: BTreeMap<&str, Vec<&trunk_caster_sdk::Crosspoint>> = BTreeMap::new();
    for x in &rt.crosspoints.current {
        by_frame.entry(x.frame.as_str()).or_default().push(x);
    }
    let points: usize = by_frame.values().map(Vec::len).sum();
    let trimmed = st.xp_gains.len();
    let mut strips = String::new();
    for (frame, xs) in by_frame.iter_mut() {
        xs.sort_by(|a, b| (&a.input, &a.output).cmp(&(&b.input, &b.output)));
        let f = st.frame(frame);
        let badge = f.and_then(|f| f.badge.as_ref());
        let _ = write!(
            strips,
            r#"<div class="mix" style="--c:{}" data-f="{}"><h4 title="{} · {} · speaks in {}">{} <b>{}</b> <span class="muted">{} · {}</span>{}{}</h4><div class="faders">"#,
            badge.map(|b| b.color.as_str()).unwrap_or("var(--line)"),
            esc(frame),
            esc(badge.map(|b| b.vendor.as_str()).unwrap_or("")),
            esc(f.map(|f| f.protocol.as_str()).unwrap_or("")),
            esc(&f.map(|f| trunk_caster_sdk::voice::accent_of(f.country.as_deref().unwrap_or(""), &f.site, frame)).unwrap_or_default()),
            badge.map(|b| b.emoji.as_str()).unwrap_or(""),
            esc(frame),
            esc(f.map(|f| f.site.as_str()).unwrap_or("")),
            xs.len(),
            match voices.frame_kbps(frame) {
                k if k > 0.0 => format!(r#" <span class="talk" title="talking now, both cuts on the wire">🔊 {k:.0} kbit/s</span>"#),
                _ => String::new(),
            },
            ["ident", "call"]
                .iter()
                .filter_map(|k| voices.of(frame, k).map(|a| (k, a)))
                .map(|(k, a)| format!(
                    r#" <button type="button" class="say" title="{k}: {} · {}s · {} from the 1 s cut, {} corrected from the 5 s cut, {} lost · sent in {:.1}s" onclick="sayVoice('{}')">▶{}</button>"#,
                    esc(&a.text), a.seconds, a.from_1s, a.corrected_from_5s, a.lost, a.transmit_s,
                    esc(&crate::voices::file_name(frame, k)),
                    if *k == "ident" { "id" } else { "call" },
                ))
                .collect::<String>(),
        );
        for x in xs.iter() {
            let db = st.xp_gain_db(frame, &x.input, &x.output);
            // Kept small: 2000-odd of these on one page. The one script below
            // handles every fader; the title is filled in on hover.
            let _ = write!(
                strips,
                r#"<label class="fd{off}" data-c="{cid}"><small>{i}</small><input type="range" min="-60" max="20" step="0.5" value="{db:.1}"><small class="db">{db:+.1}</small><small class="out">{o}</small></label>"#,
                off = if db != 0.0 { " trim" } else { "" },
                i = esc(&x.input),
                o = esc(&x.output),
                cid = esc(&x.connection),
            );
        }
        strips.push_str("</div></div>");
    }
    if by_frame.is_empty() {
        strips.push_str(r#"<p class="muted">No crosspoints closed: no frame is connected right now.</p>"#);
    }
    format!(
        r#"<section><details class="taps" data-id="overlord-taps"><summary><b>TAPS and Mixes</b> <span class="muted">{n} frames connected · {points} crosspoints · {trimmed} trimmed off unity</span></summary>
<p class="note">A mixer of every connected frame. Each little fader is one crosspoint: the thing coming in on the top port, crossed to the port at the bottom, from -60 to +20 dB. Double-click a fader for unity. Each change lands in <code>TRUNK-USAGE/gains.jsonl</code> and the call's path gain.</p><p class="note">Each frame's voice: every frame talks at once, in the accent of its country. <b>▶id</b> says the country, site, frame and airport; <b>▶call</b> says its connection, from and to, which it repeats the whole time it is connected (🔊 is what it puts on the wire right now). The simulators send each saying twice at the same time, cut into 1-second and 5-second chunks; here it is re-assembled, a damaged or missing second corrected from the other cut. {voices}</p><div class="mixer">{strips}</div></details></section>
<script>function sayVoice(f){{ try{{ (window._say&&window._say.pause()); window._say=new Audio('/voices/'+f+'?t='+Date.now()); window._say.play(); }}catch(e){{}} }}
if(!window._tapsWired){{ window._tapsWired=1;
  const at=e=>{{ const l=e.target.closest&&e.target.closest('.fd'); if(!l) return null; const s=l.querySelectorAll('small'); return {{l, r:l.querySelector('input'), frame:l.closest('.mix').dataset.f, input:s[0].textContent, output:s[2].textContent}}; }};
  const show=x=>{{ const v=+x.r.value; x.l.querySelector('.db').textContent=(v>0?'+':'')+v.toFixed(1); x.l.classList.toggle('trim', v!==0); }};
  const send=x=>api('/api/gain',{{frame:x.frame,input:x.input,output:x.output,db:Number(x.r.value),who:'taps and mixes'}});
  document.addEventListener('input',e=>{{ const x=at(e); if(x&&e.target===x.r) show(x); }});
  document.addEventListener('change',e=>{{ const x=at(e); if(x&&e.target===x.r) send(x); }});
  document.addEventListener('dblclick',e=>{{ const x=at(e); if(x){{ x.r.value=0; show(x); send(x); }} }});
  document.addEventListener('mouseover',e=>{{ const x=at(e); if(x&&!x.l.title) x.l.title=x.frame+': '+x.input+' → '+x.output+' · '+x.l.dataset.c; }});
}}</script>
<style>.mixer{{display:flex;flex-wrap:wrap;gap:6px}}.mix{{border:1px solid var(--line);border-top:3px solid var(--c);border-radius:6px;padding:3px 5px;background:var(--bg)}}.mix h4{{margin:0 0 2px;font-size:10.5px;font-weight:400;white-space:nowrap}}.mix .faders{{display:flex;gap:1px}}.mix .say{{font-size:9px;padding:0 4px;margin-left:3px;line-height:14px;border-radius:7px}}.mix .talk{{font-size:9px;margin-left:3px;color:var(--c)}}.fd{{display:flex;flex-direction:column;align-items:center;width:26px;font-size:8.5px;line-height:1.1;cursor:ns-resize}}.fd small{{max-width:26px;overflow:hidden;text-overflow:clip;white-space:nowrap;color:var(--text)}}.fd .out,.fd .db{{color:var(--muted)}}.fd.trim .db{{color:var(--c);font-weight:600}}.fd input[type=range]{{writing-mode:vertical-lr;direction:rtl;width:12px;height:54px;margin:1px 0;padding:0;accent-color:var(--c)}}</style>"#,
        n = by_frame.len(),
        voices = {
            let v = &voices;
            format!(
                "{} sayings heard from {} chunks · {} seconds corrected from the 5 s cut · {} lost on both · {} unreadable chunks.",
                v.recordings, v.chunks_in, v.corrected_s, v.lost_s, v.bad_chunks
            )
        },
    )
}

/// The Overlord's bandwidth simulation: the voice every connected frame
/// talks, metered as it arrives, by protocol, and spread over the trunks its
/// calls cross. The same numbers as `GET /api/bandwidth`.
fn bandwidth_section(rt: &Runtime) -> String {
    let bw = rt.voices.lock().unwrap_or_else(|e| e.into_inner()).bandwidth(&rt.state);
    let mut b = String::new();
    let _ = write!(
        b,
        r#"<section><h2>Bandwidth</h2><p class="note">The bandwidth simulation: every connected frame talks the whole time it is connected, and what it puts on the wire (both cuts of the wave sender, base64 on MQTT) is metered here over the last {} s. Each frame's rate is shared between its calls and carried by every trunk those calls cross, so a trunk's load is the voice actually riding it. API: <code>GET /api/bandwidth</code>.</p><div class="tiles">{}{}{}{}{}</div><div class="cols2"><div><h3>By protocol</h3><table><tr><th>Protocol</th><th>Talking</th><th>kbit/s</th><th>Total</th></tr>"#,
        bw.window_s,
        tile("voice on the wire", format!("{:.1} Mbit/s", bw.kbps / 1000.0)),
        tile("frames talking", bw.talking),
        tile("carried on trunks", format!("{:.1} Mbit/s", bw.carried_kbps / 1000.0)),
        tile("trunks carrying voice", bw.trunks.iter().filter(|t| t.kbps > 0.0).count()),
        tile("heard since start", format!("{:.1} GB", bw.bytes as f64 / 1e9)),
    );
    for p in &bw.by_protocol {
        let _ = write!(b, "<tr><td>{}</td><td>{}</td><td>{:.0}</td><td class=\"muted\">{:.1} MB</td></tr>", esc(&p.protocol), p.talking, p.kbps, p.bytes as f64 / 1e6);
    }
    b.push_str("</table></div><div><h3>Busiest trunks</h3><table><tr><th>Trunk</th><th>A</th><th>B</th><th>Calls</th><th>kbit/s</th><th>kbit/s per channel</th></tr>");
    for t in bw.trunks.iter().take(25) {
        let _ = write!(
            b,
            "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td>{} of {}</td><td><b>{:.0}</b></td><td class=\"muted\">{:.0}</td></tr>",
            esc(&t.trunk),
            esc(&t.a_frame),
            esc(&t.b_frame),
            t.calls,
            t.capacity,
            t.kbps,
            t.kbps_per_channel,
        );
    }
    if bw.trunks.is_empty() {
        b.push_str("<tr><td colspan=\"6\" class=\"muted\">No calls on trunks right now.</td></tr>");
    }
    b.push_str("</table></div></div></section><style>.cols2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}</style>");
    b
}

pub fn panel_editor_page(rt: &Runtime, frame: Option<&str>, port: Option<usize>, live: bool) -> String {
    let st = &rt.state;
    let now = util::now_unix();
    let base = if live { String::new() } else { rt.endpoint.clone() };
    let sel = frame.and_then(|id| st.frame(id));

    // The tree: continent → country → site → frame.
    let tree = rt.tree();
    let mut t = String::from(r#"<input id="tfind" placeholder="find a frame, site or country" oninput="findInTree(this.value)" style="width:100%;margin-bottom:8px"><div id="ptree" class="ptree">"#);
    let in_sel = |key: &str, v: &str| sel.is_some_and(|f| match key {
        "continent" => f.continent.as_deref().unwrap_or(if f.protocol == crate::relay::PROTOCOL { "This computer" } else { "Other" }) == v,
        "country" => f.country.as_deref().unwrap_or(&rt.site) == v,
        _ => (if f.site.is_empty() { &rt.site } else { &f.site }) == v,
    });
    for c in tree["continents"].as_array().into_iter().flatten() {
        let cn = c["continent"].as_str().unwrap_or("");
        let _ = write!(t, r#"<details data-id="pt:{0}"{1}><summary>{0} <span class="muted">{2}</span></summary>"#, esc(cn), if in_sel("continent", cn) { " open" } else { "" }, c["frames"]);
        for k in c["children"].as_array().into_iter().flatten() {
            let kn = k["country"].as_str().unwrap_or("");
            let _ = write!(t, r#"<details data-id="pt:{cn}/{0}"{1}><summary>{0} <span class="muted">{2}</span></summary>"#, esc(kn), if in_sel("continent", cn) && in_sel("country", kn) { " open" } else { "" }, k["frames"], cn = esc(cn));
            for s in k["children"].as_array().into_iter().flatten() {
                let sn = s["site"].as_str().unwrap_or("");
                let _ = write!(
                    t,
                    r#"<details data-id="pt:{cn}/{kn}/{0}"{1}><summary>{0} <span class="muted">{2}</span></summary>"#,
                    esc(sn),
                    if in_sel("country", kn) && in_sel("site", sn) { " open" } else { "" },
                    s["local_clock"].as_str().unwrap_or(""),
                    cn = esc(cn),
                    kn = esc(kn)
                );
                for d in s["devices"].as_array().into_iter().flatten() {
                    let id = d["id"].as_str().unwrap_or("");
                    let _ = write!(
                        t,
                        r#"<a class="tdev{}" data-where="{} {} {}" href="{}/panels/editor?frame={}">{} {} <span class="muted">{} · {}/{} live</span></a>"#,
                        if Some(id) == frame { " on" } else { "" },
                        esc(cn), esc(kn), esc(sn),
                        esc(&base), esc(id),
                        d["badge"]["emoji"].as_str().unwrap_or(""),
                        esc(id),
                        esc(d["protocol"].as_str().unwrap_or("")),
                        d["panels_live"], d["ports"],
                    );
                }
                t.push_str("</details>");
            }
            t.push_str("</details>");
        }
        t.push_str("</details>");
    }
    t.push_str("</div>");

    let mut m = String::new();
    match sel {
        None => {
            let _ = write!(
                m,
                r#"<section><h2>Pick a frame</h2><p class="note">Open a region in the tree on the left (continent, country, site) and pick a frame. Its {} panels and inputs come up here: pick one to rename it or book it for a program at a set time. Every booking lands on the <a href="{}/overlord">Overlord</a>'s TIMELINE.</p></section>"#,
                st.shape.user_ports,
                esc(&base)
            );
            let list: Vec<&crate::bookings::Booking> = rt.bookings.list.iter().filter(|b| b.source != "simulator").collect();
            let _ = write!(m, "<section><h2>Booked in the editor</h2>{}</section>", bookings_table(rt, &list, 60, live));
        }
        Some(f) => {
            let off = rt.frame_offset_secs(&f.id);
            let local = hm((rt.time_of_day() + off) / 3600.0);
            let labels = st.labels_of(&f.id);
            let live_ports = st.live_ports_of(&f.id);
            let fb: Vec<&crate::bookings::Booking> = rt.bookings.list.iter().filter(|b| b.frame == f.id).collect();
            let _ = write!(
                m,
                r#"<section><h2>{} {} <span class="muted">{} · {} · {}{}</span></h2><div class="tiles">{}{}{}{}{}</div>"#,
                f.badge.as_ref().map(|b| b.emoji.as_str()).unwrap_or(""),
                esc(&f.id),
                esc(&f.protocol_name),
                esc(&f.site),
                esc(f.country.as_deref().unwrap_or("")),
                f.continent.as_deref().map(|c| format!(" · {}", esc(c))).unwrap_or_default(),
                tile("local clock", &local),
                tile("panels and inputs", f.user_ports),
                tile("live now", live_ports.len()),
                tile("casters free", format!("{}/{}", st.free_casters(&f.id), f.casters)),
                tile("bookings", fb.iter().filter(|b| !b.status.finished()).count()),
            );
            // The ports: one chip each, named, live and booked marked.
            m.push_str(r#"<h3>Panels and inputs</h3><div class="pgrid">"#);
            for i in 0..f.user_ports {
                let pl = user_port(i);
                let who = live_ports.get(&pl);
                let name = labels.get(&pl).map(|l| l.l8.clone());
                let pb: Vec<&&crate::bookings::Booking> = fb.iter().filter(|b| b.port == i && !b.status.finished()).collect();
                let input = fb.iter().any(|b| b.port == i && b.kind == crate::bookings::PortKind::Input);
                let mut class = String::from("pchip");
                if who.is_some() {
                    class.push_str(" live");
                } else if name.is_some() {
                    class.push_str(" named");
                }
                if !pb.is_empty() {
                    class.push_str(" booked");
                }
                if port == Some(i) {
                    class.push_str(" sel");
                }
                let _ = write!(
                    m,
                    r#"<a class="{class}" href="{}/panels/editor?frame={}&amp;port={i}" title="{}"><b>{pl}</b>{}<small>{}</small>{}</a>"#,
                    esc(&base),
                    esc(&f.id),
                    esc(&who.cloned().or(name.clone()).unwrap_or_else(|| "free".into())),
                    if input { " <span class=\"tag\">in</span>" } else { "" },
                    esc(&who.cloned().or(name).unwrap_or_default()),
                    if pb.is_empty() { String::new() } else { format!("<small class=\"bkn\">{} booked</small>", pb.len()) },
                );
            }
            m.push_str("</div></section>");

            // The chosen port.
            if let Some(i) = port.filter(|i| *i < f.user_ports) {
                let pl = user_port(i);
                let label = labels.get(&pl).cloned().unwrap_or_else(|| Label::new(live_ports.get(&pl).map(String::as_str).unwrap_or(&pl)));
                let conn = st.connections.iter().find(|c| (c.from_frame == f.id && c.from_port == i) || (c.to_frame == f.id && c.to_port == i));
                let now_on = match conn {
                    Some(c) => {
                        let far = if c.from_frame == f.id { format!("{}:{}", c.to_frame, user_port(c.to_port)) } else { format!("{}:{}", c.from_frame, user_port(c.from_port)) };
                        format!(r#"<span class="ok">live</span> · <b>{}</b> to {} · {} · {}"#, esc(&c.who), esc(&far), esc(c.why.as_deref().unwrap_or("")), dur(c.connected_for(now)))
                    }
                    None => "<span class=\"muted\">idle</span>".into(),
                };
                let mut programs: Vec<String> = rt.fader.productions.iter().map(|p| p.name.clone()).collect();
                for b in rt.bookings.list.iter().rev().take(200) {
                    if !programs.contains(&b.program) {
                        programs.push(b.program.clone());
                    }
                }
                let next_hour = ((rt.time_of_day() + off) / 3600.0).floor() as u32 % 24 + 1;
                let _ = write!(
                    m,
                    r#"<section><h2>{pl} <span class="muted">on {id}</span></h2><p>{now_on}</p><p class="muted">Panel names: <code>{l6}</code> · <code>{l8}</code> · <code>{l16}</code></p>
<form class="row" onsubmit="event.preventDefault();renamePort('{id}',{i})"><label>Name<input id="rn-name" placeholder="{l16}"></label><button type="submit">Rename</button></form><div id="rn-result" class="result"></div>
<h3>Book it for a program</h3>
<form class="row" onsubmit="event.preventDefault();bookPort('{id}',{i})">
<label>As<select id="bk-kind"><option value="panel">panel</option><option value="input">input</option></select></label>
<label>Program<input id="bk-program" list="bk-programs" placeholder="Morning news" required></label><datalist id="bk-programs">{progs}</datalist>
<label>Call to<select id="bk-to"><option value="">hold the port locally</option>{opts}</select></label>
<label>Starts ({id} time)<input id="bk-start" type="time" value="{next:02}:00"></label>
<label>Minutes<input id="bk-min" type="number" min="1" max="1440" value="60" style="width:90px"></label>
<label>Daily<input id="bk-daily" type="checkbox"></label>
<label>Who<input id="bk-who" placeholder="operator"></label>
<button type="submit">Book</button></form><div id="bk-result" class="result"></div>
<h3>Bookings on {pl}</h3>{table}</section>"#,
                    id = esc(&f.id),
                    l6 = esc(&label.l6),
                    l8 = esc(&label.l8),
                    l16 = esc(&label.l16),
                    progs = programs.iter().take(40).map(|p| format!("<option value=\"{}\">", esc(p))).collect::<String>(),
                    opts = frame_options(rt),
                    next = next_hour % 24,
                    table = bookings_table(rt, &rt.bookings.of_port(&f.id, i).collect::<Vec<_>>(), 30, live),
                );
            } else {
                m.push_str(r#"<section><p class="note">Pick a panel or input above to rename it or book it.</p></section>"#);
            }
            let _ = write!(m, "<section><h2>Timeline on {}</h2>{}{}</section>", esc(&f.id), gantt_legend(), booking_gantt(rt, &fb, 60, live));
        }
    }

    let b = format!(
        r#"<div class="editor"><aside><h2>Regions</h2>{t}</aside><div>{m}</div></div>{GANTT_CSS}
<style>.editor{{display:grid;grid-template-columns:320px minmax(0,1fr);gap:14px;align-items:start}}.editor aside{{position:sticky;top:76px;max-height:calc(100vh - 190px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}}
.ptree details{{margin-left:10px}}.ptree>details{{margin-left:0}}.ptree summary{{cursor:pointer;padding:2px 0;font-size:13px}}.ptree summary .muted{{font-size:11px}}.ptree a.tdev{{display:block;margin-left:22px;padding:2px 6px;border-radius:4px;font-size:12.5px;color:var(--ink);text-decoration:none}}.ptree a.tdev:hover{{background:var(--bg);color:var(--accent)}}.ptree a.tdev.on{{background:var(--accent);color:#fff}}.ptree a.tdev.on .muted{{color:#e6edf7}}
.pgrid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:5px}}.pchip{{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-size:12px;color:var(--ink);text-decoration:none;background:var(--bg);min-height:46px;overflow:hidden}}.pchip small{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}}.pchip:hover{{border-color:var(--accent)}}
.pchip.named{{border-color:var(--accent)}}.pchip.live{{background:var(--used);border-color:var(--used);color:#fff}}.pchip.live small{{color:#e6edf7}}.pchip.booked{{box-shadow:inset 0 3px 0 var(--via)}}.pchip.sel{{outline:2px solid var(--accent);outline-offset:1px}}.pchip .tag{{font-size:9.5px;color:var(--via);font-weight:600;text-transform:uppercase}}.pchip .bkn{{color:var(--via)}}
@media (max-width:1000px){{.editor{{grid-template-columns:1fr}}.editor aside{{position:static;max-height:50vh}}}}</style>
<script>{EDITOR_JS}</script>"#
    );
    page("Panel editor", rt, live, 6000, &b)
}

// ---------------------------------------------------------------------------
// Analyzer: capture START/STOP and offline analysis of any capture or run,
// summarized to hourly, half-hour and quarter-hour check-ins.
// ---------------------------------------------------------------------------

pub fn analyzer_page(rt: &Runtime, live: bool, id: Option<&str>) -> String {
    let mut b = String::new();
    let cur = rt.capture.as_ref();
    let _ = write!(
        b,
        r#"<section><h2>Capture</h2><p class="note">START records every telemetry sample into a capture file; STOP closes it with a summary and check-ins at one hour, half an hour and a quarter hour of the simulated day. Captures live in <code>TRUNK-SIMULATOR/captures/</code> and can be analyzed offline, as can every recorded run.</p>
<form class="row" onsubmit="event.preventDefault();api('/api/capture/start',{{note:val('cap-note')||''}}).then(()=>reload(400))"><label>Note<input id="cap-note" placeholder="what this capture is for" style="width:280px"></label><button type="submit" {sdis}>▶ START capture</button><button type="button" class="secondary" {tdis} onclick="api('/api/capture/stop',{{}}).then(c=>{{ if(c&&c.id) location.href='/analyzer?id='+encodeURIComponent(c.id); else reload(300); }})">■ STOP capture</button>
<span class="note">{status}</span></form></section>"#,
        sdis = if cur.is_some() { "disabled" } else { "" },
        tdis = if cur.is_some() { "" } else { "disabled" },
        status = match cur {
            Some(c) => format!("capturing <b>{}</b> since {} ({} UTC on the simulated day), {} samples so far{}", esc(&c.id), esc(&c.started_at), esc(&c.started_clock), c.samples.len(), if c.note.is_empty() { String::new() } else { format!(" · {}", esc(&c.note)) }),
            None => "no capture in progress".into(),
        },
    );

    // What can be analyzed.
    let captures = crate::analyzer::list(&rt.layout);
    b.push_str("<section><h2>Captures and runs</h2><div class=\"scroll\" style=\"max-height:40vh\"><table><tr><th>Id</th><th>Kind</th><th>Started</th><th>Sim clock</th><th>Duration</th><th>Samples</th><th>Granted</th><th>Denied</th><th>Peak live</th><th></th></tr>");
    for c in &captures {
        let _ = write!(
            b,
            r#"<tr><td><code>{id}</code><br><span class="muted">{}</span></td><td>capture</td><td class="muted">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td><a href="/analyzer?id={id}">analyze</a></td></tr>"#,
            esc(&c.note), esc(&c.started_at), esc(&c.started_clock), dur(c.summary.duration_sim_seconds as u64), c.summary.samples, c.summary.granted, c.summary.denied, c.summary.peak_live,
            id = esc(&c.id)
        );
    }
    let mut runs: Vec<&SimRun> = rt.recorder.index.iter().collect();
    runs.insert(0, &rt.recorder.current);
    for r in runs.iter().take(40) {
        let _ = write!(
            b,
            r#"<tr><td><code>{id}</code></td><td class="muted">run · {}</td><td class="muted">{}</td><td></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td><a href="/analyzer?id={id}">analyze</a></td></tr>"#,
            esc(&r.reason), esc(&r.started_at), dur(r.summary.duration_sim_seconds as u64), r.summary.samples, r.summary.granted, r.summary.denied, r.summary.peak_live,
            id = esc(&r.id)
        );
    }
    b.push_str("</table></div></section>");

    // The analysis of one capture or run.
    if let Some(id) = id {
        match crate::analyzer::load(&rt.layout, id) {
            None => {
                let _ = write!(b, "<section><h2>Analysis</h2><p class=\"bad\">No capture or run named {}.</p></section>", esc(id));
            }
            Some(c) => {
                let s = &c.summary;
                let _ = write!(
                    b,
                    r#"<section><h2>Analysis of {} <span class="muted">{}</span></h2><div class="tiles">{}{}{}{}{}{}{}{}</div><p class="note">Parameters: speed {}×, {} requests/min baseline, {}s mean hold, lease {}s, round robin {}s, news cycle {}; {} frames across {} sites.</p>"#,
                    esc(&c.id),
                    esc(&c.note),
                    tile("samples", s.samples),
                    tile("simulated time", dur(s.duration_sim_seconds as u64)),
                    tile("granted", s.granted),
                    tile("denied", s.denied),
                    tile("peak live", s.peak_live),
                    tile("avg live", format!("{:.1}", s.avg_live)),
                    tile("avg channel util", format!("{:.0}%", s.avg_channel_utilization * 100.0)),
                    tile("cross-check fails", s.crosschecks_failed),
                    c.fader.speed,
                    c.fader.requests_per_minute,
                    c.fader.mean_hold_seconds,
                    c.fader.lease_seconds,
                    c.fader.round_robin_seconds,
                    if c.fader.day.enabled { "on" } else { "off" },
                    c.frames,
                    c.sites
                );
                let xs: Vec<f64> = c.samples.iter().map(|x| x.sim_time).collect();
                let series: Vec<(&str, &str, Vec<f64>)> = vec![
                    ("live", "var(--used)", c.samples.iter().map(|x| x.active as f64).collect()),
                    ("parked", "var(--muted)", c.samples.iter().map(|x| x.muted as f64).collect()),
                    ("trunks", "var(--ok)", c.samples.iter().map(|x| x.trunks as f64).collect()),
                ];
                let _ = write!(b, "{}", line_chart("Live lines, parked lines and trunks over the capture", &xs, &series, None));
                let util_series: Vec<(&str, &str, Vec<f64>)> = vec![
                    ("channel utilisation %", "var(--used)", c.samples.iter().map(|x| x.channel_utilization * 100.0).collect()),
                    ("load ×10", "var(--bad)", c.samples.iter().map(|x| x.load_multiplier * 10.0).collect()),
                ];
                let _ = write!(b, "{}", line_chart("Utilisation and news-cycle load over the capture", &xs, &util_series, Some(100.0)));
                for (title, buckets) in [("Hourly check-ins", &c.buckets.hour), ("Half-hour check-ins", &c.buckets.half_hour), ("Quarter-hour check-ins", &c.buckets.quarter_hour)] {
                    let cats: Vec<&str> = buckets.iter().map(|x| x.clock.as_str()).collect();
                    let bars: Vec<(&str, &str, Vec<f64>)> = vec![
                        ("avg live", "var(--used)", buckets.iter().map(|x| x.avg_live).collect()),
                        ("granted", "var(--ok)", buckets.iter().map(|x| x.granted as f64).collect()),
                        ("denied", "var(--bad)", buckets.iter().map(|x| x.denied as f64).collect()),
                    ];
                    let _ = write!(b, "<h3>{}</h3>{}", title, bar_chart(title, &cats, &bars));
                    if buckets.len() <= 48 {
                        b.push_str("<div class=\"scroll\" style=\"max-height:40vh\"><table><tr><th>Check-in</th><th>Samples</th><th>Avg live</th><th>Peak</th><th>Avg parked</th><th>Granted</th><th>Denied</th><th>Released</th><th>Avg util</th><th>Max util</th><th>Load</th><th>Reset</th><th>CC fails</th></tr>");
                        for x in buckets.iter() {
                            let _ = write!(
                                b,
                                "<tr><td><b>{}</b></td><td>{}</td><td>{:.1}</td><td>{}</td><td>{:.1}</td><td>{}</td><td>{}</td><td>{}</td><td>{:.0}%</td><td>{:.0}%</td><td>×{:.1}</td><td class=\"{}\">{}</td><td>{}</td></tr>",
                                esc(&x.clock), x.samples, x.avg_live, x.peak_live, x.avg_muted, x.granted, x.denied, x.released, x.avg_channel_utilization * 100.0, x.max_channel_utilization * 100.0, x.avg_load,
                                if x.blackout { "bad" } else { "muted" }, if x.blackout { "reset" } else { "" }, x.crosschecks_failed
                            );
                        }
                        b.push_str("</table></div>");
                    }
                }
                let _ = write!(b, r#"<p class="note">Raw file: <a href="/api/capture/{id}">/api/capture/{id}</a> (all samples) · <a href="/api/analyze/{id}">/api/analyze/{id}</a> (summary and check-ins only)</p></section>"#, id = esc(&c.id));
            }
        }
    }
    page("Analyzer", rt, live, 0, &b)
}

// ---------------------------------------------------------------------------
// Continents: the overview by continent, with the discovery tree
// ---------------------------------------------------------------------------

/// The geographic middle of each continent, where the continent globe
/// draws it; anything else sits at the average of its frames.
pub fn continents_page(rt: &Runtime, live: bool) -> String {
    let st = &rt.state;
    let utc = rt.time_of_day();
    let mut b = String::new();
    // Per continent: sites, frames, calls, parked, panels, average load now.
    let mut per: BTreeMap<String, (std::collections::BTreeSet<String>, usize, usize, usize, usize, Vec<f64>)> = BTreeMap::new();
    for f in &st.frames {
        let cont = f.continent.clone().unwrap_or_else(|| if f.protocol == crate::relay::PROTOCOL { "This computer".into() } else { "Other".into() });
        let e = per.entry(cont).or_default();
        e.0.insert(f.site.clone());
        e.1 += 1;
        e.4 += st.live_ports_of(&f.id).len();
        if let Some(lon) = f.lon {
            e.5.push(rt.fader.day.multiplier_at(utc, lon));
        }
    }
    for c in &st.connections {
        for fid in [&c.from_frame, &c.to_frame] {
            if let Some(f) = st.frame(fid) {
                let cont = f.continent.clone().unwrap_or_else(|| "Other".into());
                if let Some(e) = per.get_mut(&cont) {
                    e.2 += 1;
                    if c.muted {
                        e.3 += 1;
                    }
                }
            }
        }
    }
    b.push_str("<section><h2>Continents</h2><p class=\"note\">Each continent with its sites, frames, live calls (parked in brackets), panels live and the average news-cycle load across its sites right now. The Overlord draws only the calls that leave their continent.</p><div class=\"tiles\">");
    for (cont, (sites, frames, calls, parked, panels, loads)) in &per {
        let avg = if loads.is_empty() { 1.0 } else { loads.iter().sum::<f64>() / loads.len() as f64 };
        let _ = write!(
            b,
            r#"<div class="tile"><b>{}</b><span>{} sites · {} frames · {} calls ({} parked) · {} panels · load ×{:.1}</span></div>"#,
            esc(cont),
            sites.len(),
            frames,
            calls,
            parked,
            panels,
            avg
        );
    }
    b.push_str("</div></section>");

    // The continents on the one map: the continents layer on, frames,
    // trunks and calls off until asked for from its toolbar.
    let _ = write!(
        b,
        r#"<section style="padding:10px 12px"><h2>Continent globe</h2><p class="note">Each continent sits at its centre, sized by its frames. An arc joins two continents that trunk with each other: width is the trunks up now, colour is how many times trunks between them were ever used, dashed when none is up right now. White dots are calls crossing. The same map as the Globe and Racks pages: turn it flat or round, switch on frames, trunks or calls, or filter by protocol and vendor from its toolbar. Hover a continent or an arc for the numbers; drag to turn.</p>{}</section>"#,
        map_block(&globe_data(rt), "min(72vh,820px)", "globe", Some(&["sun", "continents", "grid"]), None)
    );

    // --- Graphs -----------------------------------------------------------
    let palette = ["#5a9bff", "#3fb950", "#f6c343", "#ff6b6b", "#b48cff", "#e3a35a", "#9aa3ad", "#2bb3c0"];
    let conts: Vec<String> = per.keys().cloned().collect();
    let color = |i: usize| palette[i % palette.len()];

    // 1. Calls per continent over simulated time (from the timeline samples).
    let samples: Vec<&Sample> = rt.timeline.samples.iter().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
    let xs: Vec<f64> = samples.iter().map(|s| s.sim_time).collect();
    let series: Vec<(&str, &str, Vec<f64>)> = conts
        .iter()
        .enumerate()
        .map(|(i, c)| (c.as_str(), color(i), samples.iter().map(|s| *s.continents.get(c).unwrap_or(&0) as f64).collect::<Vec<f64>>()))
        .collect();
    let chart_time = line_chart("Live calls per continent over simulated time", &xs, &series, None);

    // 2. Now, by continent: calls, parked, panels live, frames.
    let cats: Vec<&str> = conts.iter().map(String::as_str).collect();
    let now_series: Vec<(&str, &str, Vec<f64>)> = vec![
        ("live calls", "var(--used)", conts.iter().map(|c| per[c].2 as f64).collect()),
        ("parked", "var(--muted)", conts.iter().map(|c| per[c].3 as f64).collect()),
        ("panels live", "var(--ok)", conts.iter().map(|c| per[c].4 as f64).collect()),
        ("frames", "var(--line)", conts.iter().map(|c| per[c].1 as f64).collect()),
    ];
    let chart_now = bar_chart("Right now, by continent", &cats, &now_series);

    // 3. The news-cycle load through the UTC day per continent (average over
    //    its sites' local clocks), with "now" marked.
    let hours: Vec<f64> = (0..=96).map(|i| i as f64 / 4.0).collect();
    let mut cont_lons: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for f in &st.frames {
        if let (Some(c), Some(lon)) = (&f.continent, f.lon) {
            cont_lons.entry(c.clone()).or_default().push(lon);
        }
    }
    let load_series: Vec<(&str, &str, Vec<f64>)> = conts
        .iter()
        .enumerate()
        .filter(|(_, c)| cont_lons.contains_key(*c))
        .map(|(i, c)| {
            let lons = &cont_lons[c];
            let vals: Vec<f64> = hours.iter().map(|h| lons.iter().map(|lon| rt.fader.day.multiplier_at(h * 3600.0, *lon)).sum::<f64>() / lons.len() as f64).collect();
            (c.as_str(), color(i), vals)
        })
        .collect();
    let mut chart_load = line_chart("News-cycle load through the UTC day, by continent (×)", &hours, &load_series, Some(rt.fader.day.biggest_peak()));
    // Mark now.
    let now_h = utc / 3600.0;
    let (w, pl, pr, pt, pb, h) = (960.0, 48.0, 16.0, 28.0, 28.0, 240.0);
    let nx = pl + now_h / 24.0 * (w - pl - pr);
    chart_load = chart_load.replace("</svg>", &format!(r#"<line x1="{nx:.1}" x2="{nx:.1}" y1="{pt}" y2="{}" stroke="var(--bad)" stroke-width="1.5"/><text x="{nx:.1}" y="{}" text-anchor="middle" style="fill:var(--bad);font-weight:600">now {}</text></svg>"#, h - pb, pt - 4.0, rt.clock()));

    // 4. Continent to continent heat matrix.
    let totals = rt.continent_totals();
    let mut grid: BTreeMap<(String, String), u64> = BTreeMap::new();
    for t in &totals {
        let (a, b, n) = (t["from"].as_str().unwrap_or("").to_string(), t["to"].as_str().unwrap_or("").to_string(), t["calls"].as_u64().unwrap_or(0));
        grid.insert((a.clone(), b.clone()), n);
        grid.insert((b, a), n);
    }
    let matrix = heat_matrix("Calls between continents", &cats, &|a, b| *grid.get(&(a.to_string(), b.to_string())).unwrap_or(&0) as f64);

    let _ = write!(
        b,
        r#"<section><h2>Graphs</h2>{chart_time}{chart_now}{chart_load}<div style="display:grid;grid-template-columns:minmax(280px,520px) 1fr;gap:16px;align-items:start">{matrix}<p class="note">The heat matrix is symmetric: a cell is the number of live calls between the row's continent and the column's. The diagonal is calls that stay home. Hover a cell for the ocean they cross.</p></div></section>"#
    );

    b.push_str("<section><h2>Continent to continent</h2><table><tr><th>From</th><th>To</th><th>Ocean</th><th>Calls</th><th>Parked</th></tr>");
    for t in totals.iter().filter(|t| t["crossing"].as_bool().unwrap_or(false)) {
        let _ = write!(b, "<tr><td><b>{}</b></td><td><b>{}</b></td><td class=\"muted\">{}</td><td>{}</td><td class=\"muted\">{}</td></tr>", esc(t["from"].as_str().unwrap_or("")), esc(t["to"].as_str().unwrap_or("")), esc(t["ocean"].as_str().unwrap_or("")), t["calls"], t["muted"]);
    }
    for t in totals.iter().filter(|t| !t["crossing"].as_bool().unwrap_or(false)) {
        let _ = write!(b, "<tr><td colspan=\"3\" class=\"muted\">within {}</td><td>{}</td><td class=\"muted\">{}</td></tr>", esc(t["from"].as_str().unwrap_or("")), t["calls"], t["muted"]);
    }
    b.push_str("</table></section>");

    let _ = write!(
        b,
        r#"<div class="globewrap"><section><h2>Discovery</h2><p class="note">Global → continent → country → site (province, state, city, capital) → device. Fold out any level for its stats; click a device for its own data and timeline rather than fleet totals.</p><div id="tree" class="tree"><span class="muted">loading…</span></div></section>
<aside class="globeside"><section id="device-panel" style="display:none"><h2 id="device-title">Device</h2><div id="device-body"></div></section>
<section><h2>Lines <span class="muted" id="side-count"></span></h2><div id="side-lines" class="lines"></div></section>
<section><h2>Continent to continent (live)</h2><table id="side-continents"></table></section></aside></div>
<style>.globewrap{{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:14px;align-items:start}}.globeside{{position:sticky;top:12px;max-height:calc(100vh - 150px);overflow:auto}}@media (max-width:1000px){{.globewrap{{grid-template-columns:1fr}}.globeside{{position:static}}}}
.lines .line{{display:grid;grid-template-columns:70px 1fr 1fr auto;gap:6px;align-items:center;font-size:12px;padding:2px 0;border-bottom:1px dashed var(--line)}}.lines .lbar{{height:8px;background:var(--free);border-radius:4px;overflow:hidden}}.lines .lbar i{{display:block;height:100%;background:var(--ok)}}.lines .red .lbar i{{background:var(--bad);width:100%!important}}.lines .red b{{color:var(--bad)}}.lines .parked .lbar i{{background:var(--muted)}}.lines .parked b{{color:var(--muted)}}
.tree details{{margin-left:10px}}.tree summary{{cursor:pointer;font-size:12.5px;padding:2px 0}}.tree summary .st{{color:var(--muted);font-size:11px;margin-left:6px}}.tree .dev{{display:block;margin-left:26px;font-size:12px;padding:1px 0;cursor:pointer;color:var(--accent)}}.tree .dev .st{{color:var(--muted);font-size:11px;margin-left:6px}}</style>
<script>{disc}</script>
<script>TC.onStatus.push(m=>{{ const ct=document.getElementById('side-continents'); if(ct&&m.continents) ct.innerHTML='<tr><th>From</th><th>To</th><th>Ocean</th><th>Calls</th></tr>'+m.continents.filter(c=>c.crossing).map(c=>'<tr><td>'+esc(c.from)+'</td><td>'+esc(c.to)+'</td><td class="muted">'+esc(c.ocean||'')+'</td><td><b>'+c.calls+'</b></td></tr>').join(''); const ln=document.getElementById('side-lines'); if(ln&&m.lines){{ ln.innerHTML=m.lines.slice(0,40).map(l=>{{const pct=Math.max(0,Math.min(100,l.left/l.lease*100)); const cls=l.state==='red'?'red':l.state==='parked'?'parked':'green'; return '<div class="line '+cls+'"><div class="lbar"><i style="width:'+pct+'%"></i></div><span>'+(l.badge?l.badge.emoji+' ':'')+esc(l.who)+'</span><span class="muted">'+esc((l.from_site||l.from)+' → '+(l.to_site||l.to))+'</span><b>'+(l.state==='parked'?'parked':l.state==='red'?'may be dead':dur(l.left))+'</b></div>';}}).join(''); setText('side-count', m.lines.length+' lines'); }} }});</script>"#,
        disc = DISCOVERY_JS
    );
    page("Continents", rt, live, 8000, &b)
}

// ---------------------------------------------------------------------------
// Space: the constellation view (kept at /space)
// ---------------------------------------------------------------------------

pub fn space_page(rt: &Runtime, live: bool) -> String {
    let st = &rt.state;
    let now = util::now_unix();
    let (w, h) = (1400.0_f64, 900.0_f64);
    let (cx, cy) = (w / 2.0, h / 2.0);

    let mut by_proto: BTreeMap<&str, Vec<&Frame>> = BTreeMap::new();
    for f in &st.frames {
        by_proto.entry(f.protocol.as_str()).or_default().push(f);
    }
    let n = by_proto.len().max(1);
    let big_r = (h / 2.0 - 90.0).min(w / 2.0 - 120.0);
    let mut pos: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    let mut clusters: Vec<(String, f64, f64, &Frame)> = Vec::new();
    for (i, (_proto, frames)) in by_proto.iter().enumerate() {
        let a = std::f64::consts::TAU * i as f64 / n as f64 - std::f64::consts::FRAC_PI_2;
        let (px, py) = (cx + big_r * a.cos(), cy + big_r * a.sin());
        let m = frames.len().max(1);
        let small_r = if m == 1 { 0.0 } else { 34.0 + 2.2 * m as f64 };
        for (j, f) in frames.iter().enumerate() {
            let b = std::f64::consts::TAU * j as f64 / m as f64;
            pos.insert(f.id.as_str(), (px + small_r * b.cos(), py + small_r * b.sin()));
        }
        clusters.push((frames[0].protocol_name.clone(), px, py, frames[0]));
    }

    let mut svg = String::new();
    let _ = write!(svg, r#"<svg class="space" viewBox="0 0 {w} {h}" role="img" aria-label="Frames in space">"#);
    // Stars.
    let mut rng = util::Rng::new(42);
    for _ in 0..140 {
        let (x, y, r) = (rng.f64() * w, rng.f64() * h, 0.5 + rng.f64() * 1.3);
        let _ = write!(svg, r#"<circle class="star" cx="{x:.0}" cy="{y:.0}" r="{r:.1}" style="animation-delay:{:.1}s"/>"#, rng.f64() * 3.0);
    }
    // Trunks.
    for t in &st.trunks {
        if let (Some(a), Some(b)) = (pos.get(t.a_frame.as_str()), pos.get(t.b_frame.as_str())) {
            let _ = write!(
                svg,
                r#"<line class="trunk" x1="{:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}" stroke-width="{:.1}"><title>{} · {} C{} ↔ {} C{} · {}/{} channels</title></line>"#,
                a.0, a.1, b.0, b.1, 0.8 + t.used() as f64 * 0.6, esc(&t.id), esc(&t.a_frame), t.a_caster, esc(&t.b_frame), t.b_caster, t.used(), t.capacity
            );
        }
    }
    // Cluster labels.
    for (name, px, py, f) in &clusters {
        let m = by_proto.get(f.protocol.as_str()).map(Vec::len).unwrap_or(1);
        let r = if m == 1 { 0.0 } else { 34.0 + 2.2 * m as f64 };
        let _ = write!(svg, r#"<text class="proto" x="{:.0}" y="{:.0}" text-anchor="middle">{}</text>"#, px, py - r - 14.0, esc(name));
    }
    // Frames.
    for f in &st.frames {
        let Some(&(x, y)) = pos.get(f.id.as_str()) else { continue };
        let live = st.live_ports_of(&f.id).len();
        let r = 5.0 + (live as f64).sqrt() * 2.2;
        let fam = serde_json::to_string(&f.family).unwrap_or_default().trim_matches('"').to_string();
        let since = match st.seconds_since_last(&f.id, now) {
            Some(0) => "live now".to_string(),
            Some(s) => format!("last connection {} ago", dur(s)),
            None => "no connection yet".to_string(),
        };
        let names: Vec<String> = st.live_ports_of(&f.id).into_iter().map(|(p, w)| format!("{p} {w}")).collect();
        let _ = write!(
            svg,
            r#"<circle class="node fam-{fam}" cx="{x:.1}" cy="{y:.1}" r="{r:.1}" fill-opacity="{op:.2}"><title>{id} · {proto} · {free}/{cas} casters free · {live} panels live · {since}{names}</title></circle>"#,
            id = esc(&f.id),
            proto = esc(&f.protocol_name),
            free = st.free_casters(&f.id),
            cas = f.casters,
            op = if live > 0 { 1.0 } else { 0.55 },
            names = if names.is_empty() { String::new() } else { format!("\n{}", esc(&names.join("\n"))) }
        );
        if live > 0 || f.protocol == crate::relay::PROTOCOL {
            let _ = write!(svg, r#"<text class="lbl" x="{:.1}" y="{:.1}" text-anchor="middle">{}</text>"#, x, y + r + 11.0, esc(&f.id));
        }
    }
    // Legend.
    let mut lx = 20.0;
    for (fam, label) in [
        ("analog-audio", "Analog audio"),
        ("audio-over-ip", "Audio over IP"),
        ("telephony", "Telephony"),
        ("control", "Control"),
        ("wireless", "Wireless"),
        ("media-transport", "Media transport"),
        ("other", "Other / relay"),
    ] {
        let _ = write!(svg, r#"<circle class="fam-{fam}" cx="{:.0}" cy="{:.0}" r="5"/><text class="lbl" x="{:.0}" y="{:.0}">{label}</text>"#, lx, h - 20.0, lx + 10.0, h - 16.0);
        lx += 26.0 + label.len() as f64 * 6.3;
    }
    svg.push_str("</svg>");

    let mut b = String::new();
    let _ = write!(
        b,
        r#"<section><h2>Frames in space</h2><p class="note">The constellation view: each constellation is a protocol; each star a frame. Lines are trunks between casters, thicker as they carry more channels. Bright stars have panels live right now; hover for who is on them and when the frame last carried a connection. The <a href="/">Globe</a> places the same frames at their real sites.</p>{svg}</section>"#
    );
    page("Space", rt, live, 4000, &b)
}

// ---------------------------------------------------------------------------
// Overlord: every panel, every call to and from, the log in the task bar
// ---------------------------------------------------------------------------

pub fn overlord_page(rt: &Runtime, live: bool) -> String {
    let st = &rt.state;
    let now = util::now_unix();
    let conns = sorted_connections(rt);

    // Frames that take part in a call that leaves its continent, placed on a
    // ring grouped by continent. Calls that stay home are not drawn.
    let cont_of = |id: &str| st.frame(id).and_then(|f| f.continent.clone()).unwrap_or_else(|| "Other".into());
    let crossing: Vec<&Connection> = conns.iter().copied().filter(|c| cont_of(&c.from_frame) != cont_of(&c.to_frame)).collect();
    // Every frame a call walks through, caller first, so each trunk hop is drawn.
    let route_of = |c: &Connection| -> Vec<String> { std::iter::once(c.from_frame.clone()).chain(c.hops.iter().map(|h| h.to.clone())).collect() };
    let mut active: Vec<&Frame> = st
        .frames
        .iter()
        .filter(|f| crossing.iter().any(|c| route_of(c).iter().any(|r| *r == f.id)))
        .collect();
    // Sorted continent, then vendor, then site, so each vendor's colour sits
    // together on its continent's circle.
    let vendor_of = |f: &Frame| f.badge.as_ref().map(|b| b.vendor.clone()).unwrap_or_default();
    active.sort_by(|a, b| {
        (a.continent.as_deref().unwrap_or(""), vendor_of(a), &a.site, &a.id).cmp(&(b.continent.as_deref().unwrap_or(""), vendor_of(b), &b.site, &b.id))
    });
    // One circle per continent, the circles themselves on a ring.
    let mut groups: Vec<(String, Vec<&Frame>)> = Vec::new();
    for f in &active {
        let cont = f.continent.clone().unwrap_or_else(|| "Other".into());
        match groups.last_mut() {
            Some((c, fs)) if *c == cont => fs.push(f),
            _ => groups.push((cont, vec![f])),
        }
    }
    let k = groups.len().max(1);
    let (w, h) = (1100.0_f64, 760.0_f64);
    let (cx, cy) = (w / 2.0, h / 2.0);
    let ring = if k == 1 { 0.0 } else { (h / 2.0 - 125.0).min(w / 2.0 - 240.0) };
    let rc = if k == 1 { h / 2.0 - 90.0 } else { (ring * (std::f64::consts::PI / k as f64).sin() - 15.0).clamp(55.0, 140.0) };
    let mut pos: BTreeMap<&str, (f64, f64, f64)> = BTreeMap::new();
    let mut centres: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for (j, (cont, fs)) in groups.iter().enumerate() {
        let ca = std::f64::consts::TAU * j as f64 / k as f64 - std::f64::consts::FRAC_PI_2;
        let (gx, gy) = (cx + ring * ca.cos(), cy + ring * ca.sin());
        centres.insert(cont.clone(), (gx, gy));
        for (i, f) in fs.iter().enumerate() {
            let a = std::f64::consts::TAU * i as f64 / fs.len() as f64 - std::f64::consts::FRAC_PI_2;
            pos.insert(f.id.as_str(), (gx + rc * a.cos(), gy + rc * a.sin(), a));
        }
    }

    let mut svg = String::new();
    let _ = write!(svg, r#"<svg class="calls" viewBox="0 0 {w} {h}" role="img" aria-label="Calls between continents">"#);
    if active.is_empty() {
        let _ = write!(svg, r#"<text class="proto" x="{}" y="{}" text-anchor="middle">no calls leave their continent right now</text>"#, cx, cy);
    }
    for (cont, (gx, gy)) in &centres {
        let _ = write!(
            svg,
            r#"<circle class="cont" cx="{gx:.1}" cy="{gy:.1}" r="{rc:.1}"/><text class="proto" x="{gx:.1}" y="{:.1}" text-anchor="middle">{}</text>"#,
            gy + 4.0,
            esc(cont)
        );
    }
    // Chords, one per trunk hop, each coloured by the vendor whose iron that
    // hop leaves from, so a call reads red → purple → blue → yellow along its
    // route. Inline style: the .chord.direct/.via CSS would beat a stroke
    // attribute. Only calls that cross an ocean are drawn, like cables.
    let colour_of = |id: &str| st.frame(id).and_then(|f| f.badge.as_ref()).map(|b| b.color.clone());
    for c in &crossing {
        let kind = kind_str(c.kind);
        let width = 1.2 + c.gpio_sent as f64 * 0.4;
        let emoji = st.frame(&c.from_frame).and_then(|f| f.badge.as_ref()).map(|b| format!("{} ", b.emoji)).unwrap_or_default();
        let title = format!(
            "{emoji}{} → {} · {}:{} → {}:{} · {} · {} · {} · {:+.1} dB · GPIO {}",
            esc(&c.who), esc(c.why.as_deref().unwrap_or("")), esc(&c.from_frame), user_port(c.from_port), esc(&c.to_frame), user_port(c.to_port),
            kind, route_str(c).replace("&rarr;", "→"), dur(c.connected_for(now)), st.path_gain_db(c), c.gpio_sent,
        );
        let dash = if c.kind == RouteKind::Via { r#" stroke-dasharray="6 4""# } else { "" };
        let route = route_of(c);
        for (i, leg) in route.windows(2).enumerate() {
            let (Some(a), Some(b)) = (pos.get(leg[0].as_str()), pos.get(leg[1].as_str())) else { continue };
            // Hops that stay home bow through their continent's circle; hops
            // that cross an ocean bow through the middle of the ring.
            let (ox, oy) = if cont_of(&leg[0]) == cont_of(&leg[1]) { centres.get(&cont_of(&leg[0])).copied().unwrap_or((cx, cy)) } else { (cx, cy) };
            let (qx, qy) = (ox + ((a.0 + b.0) / 2.0 - ox) * 0.25, oy + ((a.1 + b.1) / 2.0 - oy) * 0.25);
            let style = colour_of(&leg[0]).map(|col| format!(r#" style="stroke:{col}""#)).unwrap_or_default();
            let _ = write!(
                svg,
                r#"<path class="chord {kind}"{style} d="M{:.1},{:.1} Q{qx:.1},{qy:.1} {:.1},{:.1}" stroke-width="{width:.1}"{dash}><title>hop {} of {}: {} → {} · {title}</title></path>"#,
                a.0, a.1, b.0, b.1, i + 1, route.len() - 1, esc(&leg[0]), esc(&leg[1])
            );
        }
        if let Some(a) = pos.get(c.from_frame.as_str()) {
            let _ = write!(svg, r#"<circle class="dot" cx="{:.1}" cy="{:.1}" r="2.2"/>"#, a.0, a.1);
        }
    }
    // Each frame's dot in its vendor's colour, so the hops can be read off.
    for f in &active {
        let (x, y, _) = pos[f.id.as_str()];
        let col = colour_of(&f.id).unwrap_or_else(|| "#fff".into());
        let _ = write!(svg, r#"<circle cx="{x:.1}" cy="{y:.1}" r="4.5" style="fill:{col};stroke:#0b1020;stroke-width:1"/>"#);
    }
    // Ticks and labels, outward from each frame's continent circle.
    for f in &active {
        let (x, y, a) = pos[f.id.as_str()];
        let (ox, oy) = (a.cos(), a.sin());
        let _ = write!(svg, r#"<line class="tick" x1="{:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}"/>"#, x, y, x + ox * 8.0, y + oy * 8.0);
        let anchor = if ox > 0.1 { "start" } else if ox < -0.1 { "end" } else { "middle" };
        let live = st.live_ports_of(&f.id).len();
        let badge = f.badge.as_ref().map(|b| b.emoji.as_str()).unwrap_or("");
        let _ = write!(svg, r#"<text class="lbl" x="{:.1}" y="{:.1}" text-anchor="{anchor}">{badge} {} · {} · {live}</text>"#, x + ox * 12.0, y + oy * 12.0 + 3.0, esc(&f.site), esc(&f.id));
    }
    let _ = write!(
        svg,
        r#"<text class="proto" x="{cx:.0}" y="18" text-anchor="middle">{} of {} calls cross an ocean · {} UTC</text>"#,
        crossing.len(),
        conns.len(),
        rt.clock()
    );
    svg.push_str("</svg>");

    // The cables: continent to continent totals with the water they cross.
    let totals = rt.continent_totals();
    let mut cables = String::from("<table><tr><th>From</th><th>To</th><th>Ocean</th><th>Calls</th><th>Parked</th></tr>");
    for t in totals.iter().filter(|t| t["crossing"].as_bool().unwrap_or(false)) {
        let _ = write!(cables, "<tr><td><b>{}</b></td><td><b>{}</b></td><td class=\"muted\">{}</td><td>{}</td><td class=\"muted\">{}</td></tr>", esc(t["from"].as_str().unwrap_or("")), esc(t["to"].as_str().unwrap_or("")), esc(t["ocean"].as_str().unwrap_or("")), t["calls"], t["muted"]);
    }
    let home: usize = totals.iter().filter(|t| !t["crossing"].as_bool().unwrap_or(false)).map(|t| t["calls"].as_u64().unwrap_or(0) as usize).sum();
    let _ = write!(cables, "<tr><td colspan=\"3\" class=\"muted\">stay within their continent (not drawn)</td><td>{home}</td><td></td></tr></table>");

    // Panels board: every live panel across every frame, with the name as a
    // 6-, 8- and 16-character panel shows it and the vendor's badge.
    let mut panels = String::from("<div class=\"scroll\" style=\"max-height:48vh\"><table><tr><th>Panel</th><th>Site</th><th>6</th><th>8</th><th>16</th><th>Who</th><th></th><th>Far end</th><th>For</th><th>Connected</th><th>Gain</th><th>GPIO</th><th></th></tr>");
    let mut rows: Vec<(String, usize, &Connection, bool)> = Vec::new();
    for c in &conns {
        rows.push((c.from_frame.clone(), c.from_port, c, true));
        rows.push((c.to_frame.clone(), c.to_port, c, false));
    }
    rows.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
    for (frame, port, c, is_from) in &rows {
        let (far, farp) = if *is_from { (&c.to_frame, c.to_port) } else { (&c.from_frame, c.from_port) };
        let f = st.frame(frame);
        let badge = f.and_then(|f| f.badge.as_ref()).map(|b| format!(r#"<span title="{}">{}</span> "#, esc(&b.vendor), b.emoji)).unwrap_or_default();
        let far_badge = st.frame(far).and_then(|f| f.badge.as_ref()).map(|b| b.emoji.clone()).unwrap_or_default();
        let label = st.label_of(frame, *port).cloned().unwrap_or_else(|| Label::new(&c.who));
        let flag = |over: bool| if over { r#" class="warn" title="longer than this panel shows""# } else { "" };
        let _ = write!(
            panels,
            r#"<tr><td>{badge}<b>{}</b>:{}</td><td class="muted">{}</td><td{}><code>{}</code></td><td{}><code>{}</code></td><td><code>{}</code></td><td>{}</td><td class="{}">{}</td><td>{} {}:{}</td><td class="muted">{}</td><td>{}</td><td>{:+.1} dB</td><td>{} <button class="small secondary" onclick="gpio('{id}')">send</button></td><td><button class="small secondary" onclick="api('/api/release',{{id:'{id}'}}).then(()=>reload())">release</button> <button class="small secondary" onclick="rename('{}',{})">rename</button></td></tr>"#,
            esc(frame),
            user_port(*port),
            esc(f.map(|f| f.site.as_str()).unwrap_or("")),
            flag(label.over6),
            esc(&label.l6),
            flag(label.over8),
            esc(&label.l8),
            esc(&label.l16),
            esc(&c.who),
            if *is_from { "kind-direct" } else { "kind-via" },
            if *is_from { "→ to" } else { "← from" },
            far_badge,
            esc(far),
            user_port(farp),
            esc(c.why.as_deref().unwrap_or("")),
            dur(c.connected_for(now)),
            st.path_gain_db(c),
            c.gpio_sent,
            esc(frame),
            port,
            id = esc(&c.id)
        );
    }
    if rows.is_empty() {
        panels.push_str("<tr><td colspan=\"13\" class=\"muted\">No panels live.</td></tr>");
    }
    panels.push_str("</table></div>");

    // The task bar: the log, newest first, then recent Ward-Beck lines.
    let mut bar = String::from("<h2>Log</h2><div class=\"taskbar\">");
    for l in rt.log.iter().rev().take(80) {
        let (t, msg) = l.split_once(' ').unwrap_or(("", l));
        let class = if msg.starts_with("granted") {
            "g"
        } else if msg.starts_with("denied") || msg.contains("FAILED") {
            "d"
        } else if msg.starts_with("released") || msg.starts_with("check-in") {
            "t"
        } else if msg.starts_with("gpio") || msg.starts_with("renamed") {
            "v"
        } else {
            "w"
        };
        let _ = write!(bar, r#"<div><span class="t">{}</span> <span class="{class}">{}</span></div>"#, esc(t.get(11..19).unwrap_or(t)), esc(msg));
    }
    bar.push_str("</div><h2>Ward-Beck</h2><div class=\"taskbar\">");
    for l in rt.crosspoints.recent_wb.iter().rev().take(40) {
        let _ = write!(bar, "<div>{}</div>", esc(l));
    }
    bar.push_str("</div>");

    let remotes_up = rt.remotes.frames.values().filter(|r| r.connected).count();
    let mut b = String::new();
    let _ = write!(
        b,
        r#"<div class="overlord"><div>
<section><div class="tiles">{}{}{}{}{}{}</div>{}
<form class="row" onsubmit="event.preventDefault();api('/api/request',{{who:val('who')||'overlord',from:val('from'),to:val('to'),why:val('why')||null,gpio:(num('pin')?[{{pin:num('pin'),state:true,note:'call light'}}]:[])}}).then(r=>{{show('req-result',r);reload(900)}})">
<label>Who<input id="who" placeholder="overlord"></label><label>From<select id="from">{opts}</select></label><label>To<select id="to">{opts}</select></label><label>Why<input id="why" placeholder="reason"></label><label>GPIO pin<input id="pin" type="number" min="1" max="8" placeholder="none" style="width:80px"></label><button type="submit">Connect</button></form><div id="req-result" class="result"></div></section>
{timeline}
{taps}
{bandwidth}
<section><h2>Graphs</h2>{vendor_chart}</section>
<section><h2>Messages</h2><p class="note">Every call that routes flies in from the left and lands in the bucket, where it is assigned to its protocol after travelling city to city.</p><div id="lane" class="lane"></div><div id="bucket" class="bucket"></div></section>
<section><h2>Calls between continents</h2><p class="note">One circle per continent, its frames sorted by vendor. Each call is drawn hop by hop through every frame it trunks through; each leg is coloured by the vendor of the frame it leaves, so a call reads red → purple → blue → yellow. Legs are dashed when <span class="kind-via">via</span>, thicker as GPIO rides it. Calls that stay on their continent are counted but not drawn.</p>{svg}<h3>Cables</h3>{cables}</section>
<section><h2>All panels</h2>{panels}</section>
</div><aside>{bar}</aside></div>
<style>.lane{{position:relative;height:34px;overflow:hidden;border:1px dashed var(--line);border-radius:6px;margin-bottom:6px}}.lane .msg{{position:absolute;left:0;top:5px;transform:translateX(-100vw);transition:transform 1.4s cubic-bezier(.2,.8,.2,1);white-space:nowrap;font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:2px 10px}}.lane .msg.go{{transform:translateX(0)}}
.bucket{{width:75%;min-height:120px;border:2px solid var(--line);border-radius:10px;padding:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;background:var(--bg)}}.bucket .col{{border:1px solid var(--line);border-radius:6px;padding:4px 6px;background:var(--panel)}}.bucket .col h4{{margin:0 0 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}}.bucket .chip{{font-size:11.5px;padding:1px 0;border-bottom:1px dashed var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:1;transition:opacity 1s}}.bucket .chip.old{{opacity:.45}}</style>
<script>
(function(){{
  const lane=document.getElementById('lane'), bucket=document.getElementById('bucket'); if(!lane) return;
  const seen=new Set(); let first=true;
  function col(proto){{ let c=bucket.querySelector('[data-proto="'+proto+'"]'); if(!c){{ c=document.createElement('div'); c.className='col'; c.dataset.proto=proto; c.innerHTML='<h4>'+esc(proto)+' <span class="n"></span></h4>'; bucket.appendChild(c); }} return c; }}
  function land(call){{ const c=col(call.proto||'?'); const chip=document.createElement('div'); chip.className='chip'; chip.title=(call.why||'')+' · '+call.kind; chip.innerHTML=(call.badge?call.badge.emoji+' ':'')+esc(call.who)+' <span class="muted">'+esc((call.from_site||call.hops[0][0])+' → '+(call.to_site||call.hops[call.hops.length-1][1]))+'</span>'; c.insertBefore(chip, c.children[1]||null); while(c.children.length>9) c.removeChild(c.lastChild); setTimeout(()=>chip.classList.add('old'), 20000); c.querySelector('.n').textContent=(c.children.length-1); }}
  function fly(call){{ const m=document.createElement('div'); m.className='msg'; m.innerHTML=(call.badge?call.badge.emoji+' ':'')+esc(call.who)+' · '+esc((call.from_site||call.hops[0][0])+' → '+(call.to_site||call.hops[call.hops.length-1][1]))+' · <b>'+esc(call.proto||'')+'</b>'; lane.appendChild(m); requestAnimationFrame(()=>requestAnimationFrame(()=>m.classList.add('go'))); setTimeout(()=>{{ m.remove(); land(call); }}, 1500); }}
  TC.onGlobe.push(m=>{{ let q=0; for(const c of m.callList||[]){{ if(seen.has(c.id)) continue; seen.add(c.id); if(first) {{ land(c); continue; }} if(q<6) {{ setTimeout(()=>fly(c), q*220); q++; }} else land(c); }} first=false; if(seen.size>5000) seen.clear(); }});
}})();
</script>"#,
        tile("UTC clock", rt.clock()),
        tile("sites", rt.sites.sites.len()),
        tile("calls live", conns.len()),
        tile("panels live", rows.len()),
        tile("trunks", st.trunks.len()),
        tile("simulators up", remotes_up),
        "",
        opts = frame_options(rt),
        cables = cables,
        timeline = timeline_dropdown(rt, live),
        taps = taps_dropdown(rt),
        bandwidth = bandwidth_section(rt),
        vendor_chart = {
            let mut by_vendor: BTreeMap<String, (usize, usize)> = BTreeMap::new();
            for c in &conns {
                let v = st.frame(&c.from_frame).and_then(|f| f.badge.as_ref()).map(|b| format!("{} {}", b.emoji, b.vendor)).unwrap_or_else(|| "⚫ unknown".into());
                let e = by_vendor.entry(v).or_default();
                if c.kind == RouteKind::Via {
                    e.1 += 1;
                } else {
                    e.0 += 1;
                }
            }
            let cats: Vec<&str> = by_vendor.keys().map(String::as_str).collect();
            let series: Vec<(&str, &str, Vec<f64>)> = vec![
                ("direct", "var(--used)", by_vendor.values().map(|v| v.0 as f64).collect()),
                ("via", "var(--via)", by_vendor.values().map(|v| v.1 as f64).collect()),
            ];
            bar_chart("Live calls by the caller's vendor, direct and via", &cats, &series)
        },
    );
    page("Overlord", rt, live, 3000, &b)
}

// ---------------------------------------------------------------------------
// Racks: the physical manager, one rack per protocol, frames fold out
// ---------------------------------------------------------------------------

pub fn racks_page(rt: &Runtime, live: bool) -> String {
    let st = &rt.state;
    let now = util::now_unix();
    let mut b = String::new();
    let _ = write!(
        b,
        r#"<section><h2>Physical manager</h2><div class="tiles">{}{}{}{}</div><p class="note">One rack per protocol. Click a frame to fold it open: trunks going in and out on its casters, the panels connected, and every local input and output. Click a port to connect it or rename it.</p></section>"#,
        tile("racks", st.frames.iter().map(|f| f.protocol.as_str()).collect::<std::collections::BTreeSet<_>>().len()),
        tile("frames", st.frames.len()),
        tile("panels live", st.connections.len() * 2),
        tile("last connection", last_connection_overall(rt, now)),
    );

    let mut by_proto: BTreeMap<&str, Vec<&Frame>> = BTreeMap::new();
    for f in &st.frames {
        by_proto.entry(f.protocol.as_str()).or_default().push(f);
    }
    // Graph: per protocol, frames, casters in use and panels live.
    let cats: Vec<&str> = by_proto.values().map(|v| v[0].protocol_name.as_str()).collect();
    let rack_series: Vec<(&str, &str, Vec<f64>)> = vec![
        ("frames", "var(--line)", by_proto.values().map(|v| v.len() as f64).collect()),
        ("casters in use", "var(--used)", by_proto.values().map(|v| v.iter().map(|f| st.used_casters(&f.id)).sum::<usize>() as f64).collect()),
        ("panels live", "var(--ok)", by_proto.values().map(|v| v.iter().map(|f| st.live_ports_of(&f.id).len()).sum::<usize>() as f64).collect()),
    ];
    let _ = write!(b, "<section>{}</section>", bar_chart("Racks: frames, casters in use and panels live per protocol", &cats, &rack_series));
    // The central aggregator: this runtime, where every frame's data port
    // lands (remote frames over the Ward-Beck TCP port, the rest in process).
    let agg = match &rt.wb_endpoint {
        Some(ep) => format!("{} · {}", rt.site, ep),
        None => rt.site.clone(),
    };
    let ports_up = st.frames.iter().filter(|f| matches!(rt.remotes.frames.get(&f.id), Some(r) if r.connected)).count();
    let ports_down = st.frames.iter().filter(|f| matches!(rt.remotes.frames.get(&f.id), Some(r) if !r.connected)).count();
    let ports_local = st.frames.len() - ports_up - ports_down;
    let globe = globe_data(rt);
    // The aggregator sits on the globe where this computer's frames sit.
    let (mut hlat, mut hlon, mut hn) = (0.0f64, 0.0f64, 0usize);
    if let Some(nodes) = globe["nodes"].as_array() {
        for n in nodes.iter().filter(|n| n["proto"].as_str() == Some(crate::relay::PROTOCOL)) {
            hlat += n["lat"].as_f64().unwrap_or(0.0);
            hlon += n["lon"].as_f64().unwrap_or(0.0);
            hn += 1;
        }
    }
    let (hlat, hlon) = if hn > 0 { (hlat / hn as f64, hlon / hn as f64) } else { (20.0, 0.0) };
    let hub = serde_json::json!({ "name": rt.site, "endpoint": rt.wb_endpoint, "lat": hlat, "lon": hlon });
    // Two columns under the racks graph: the racks on the left, the globe
    // with every frame's data port to the aggregator on the right.
    b.push_str(r#"<div class="rackwrap"><div class="racklist">"#);
    for (proto, frames) in by_proto {
        let f0 = frames[0];
        let live_in_rack: usize = frames.iter().map(|f| st.live_ports_of(&f.id).len()).sum();
        let trunks_in_rack = st.trunks.iter().filter(|t| frames.iter().any(|f| t.touches(&f.id))).count();
        let _ = write!(
            b,
            r#"<div class="rack" data-proto="{proto}"><h2>{} <span class="muted">{} · {} · {} frames · {} trunks · {} panels live · {}</span></h2>"#,
            esc(&f0.protocol_name),
            esc(proto),
            f0.family.label(),
            frames.len(),
            trunks_in_rack,
            live_in_rack,
            esc(&f0.implemented_by.join(", "))
        );
        for f in frames {
            let live_ports = st.live_ports_of(&f.id);
            let names = st.port_names_of(&f.id);
            let _ = write!(
                b,
                r#"<details class="frame" data-id="{id}"><summary><b>{id}</b><span class="casters">"#,
                id = esc(&f.id)
            );
            for a in st.caster_ads(&f.id) {
                let _ = write!(b, r#"<i class="{}" title="C{} {}"></i>"#, if a.trunk.is_some() { "t" } else { "" }, a.index, a.peer_frame.as_deref().map(esc).unwrap_or_else(|| "free".into()));
            }
            let sim = match rt.remotes.frames.get(&f.id) {
                Some(r) if r.connected => format!(r#"<span class="ok" title="simulator {} · {} acks · {} double validated over MQTT · {} rejected · reports {} crosspoints">● sim</span>"#, esc(&r.peer), r.acks, r.mqtt_acks, r.rejects, r.reported_closed),
                Some(_) => r#"<span class="warn" title="simulator disconnected">○ sim</span>"#.to_string(),
                None => String::new(),
            };
            let _ = write!(
                b,
                r#"</span><span>{} / {} casters free</span><span>{} panels live</span>{}<span class="muted">{}</span></summary><div class="lid">"#,
                st.free_casters(&f.id),
                f.casters,
                live_ports.len(),
                sim,
                ago(rt, &f.id, now)
            );

            // Data port: the frame's control link to the central aggregator.
            b.push_str("<div><h4>Data port</h4><div class=\"io\">");
            match rt.remotes.frames.get(&f.id) {
                Some(r) if r.connected => {
                    let _ = write!(b, r#"<span class="in"><span class="ok">● up</span> <b>{}</b> → aggregator {} <span class="muted">{} acks · reports {} crosspoints</span></span>"#, esc(&r.peer), esc(&agg), r.acks, r.reported_closed);
                }
                Some(r) => {
                    let _ = write!(b, r#"<span class="in"><span class="warn">○ down</span> last seen from <b>{}</b> → aggregator {}</span>"#, esc(&r.peer), esc(&agg));
                }
                None => {
                    let _ = write!(b, r#"<span class="in"><span class="muted">◆ in process</span> hosted inside the aggregator {}</span>"#, esc(&agg));
                }
            }
            b.push_str("</div></div>");

            // Trunks in and out.
            b.push_str("<div><h4>Trunks in / out</h4><div class=\"io\">");
            let mut any = false;
            for t in st.trunks.iter().filter(|t| t.touches(&f.id)) {
                any = true;
                let c = t.caster_on(&f.id).unwrap_or(0);
                let peer = t.peer_of(&f.id).unwrap_or("?");
                let _ = write!(
                    b,
                    r#"<span class="out">C{c} → <b>{}</b> <span class="muted">{} · {}/{} ch</span></span><span class="in">C{c} ← <b>{}</b></span>"#,
                    esc(peer),
                    esc(&t.id),
                    t.used(),
                    t.capacity,
                    esc(peer)
                );
            }
            if !any {
                b.push_str("<span class=\"muted\">no trunks up</span>");
            }
            b.push_str("</div></div>");

            // Panels connected.
            b.push_str("<div><h4>Panels connected</h4><div class=\"io\">");
            let mut conns: Vec<&Connection> = st.connections.iter().filter(|c| c.from_frame == f.id || c.to_frame == f.id).collect();
            conns.sort_by_key(|c| if c.from_frame == f.id { c.from_port } else { c.to_port });
            for c in &conns {
                let (port, far, farp) = if c.from_frame == f.id {
                    (c.from_port, &c.to_frame, c.to_port)
                } else {
                    (c.to_port, &c.from_frame, c.from_port)
                };
                let _ = write!(
                    b,
                    r#"<span class="{}"><b>{}</b> {} <span class="muted">→ {}:{} · {} · {} · {}</span> <button class="small secondary" onclick="api('/api/release',{{id:'{}'}}).then(()=>reload())">release</button></span>"#,
                    if c.from_frame == f.id { "out" } else { "in" },
                    user_port(port),
                    esc(&c.who),
                    esc(far),
                    user_port(farp),
                    esc(c.why.as_deref().unwrap_or("")),
                    kind_str(c.kind),
                    dur(c.connected_for(now)),
                    esc(&c.id)
                );
            }
            if conns.is_empty() {
                b.push_str("<span class=\"muted\">no panels connected</span>");
            }
            b.push_str("</div></div>");

            // Local inputs and outputs: live and named ports as chips, the
            // free ones folded into one chip so 213 frames stay light.
            let _ = write!(b, "<div><h4>Local inputs &amp; outputs ({} ports)</h4><div class=\"ports\">", f.user_ports);
            let mut free = 0usize;
            let mut first_free: Option<usize> = None;
            for i in 0..f.user_ports {
                let p = user_port(i);
                let live_who = live_ports.get(&p);
                let name = names.get(&p);
                if live_who.is_none() && name.is_none() {
                    free += 1;
                    first_free.get_or_insert(i);
                    continue;
                }
                let class = if live_who.is_some() { "port live" } else { "port named" };
                let label = live_who.or(name).map(|s| esc(s)).unwrap_or_else(|| p.clone());
                let _ = write!(
                    b,
                    r#"<span class="{class}" title="{p} · {title}" onclick="{onclick}">{p} {label}</span>"#,
                    title = esc(live_who.map(|w| format!("live: {w}")).or_else(|| name.map(|n| format!("named {n}"))).unwrap_or_default().as_str()),
                    onclick = if live_who.is_some() {
                        format!("rename('{}',{})", esc(&f.id), i)
                    } else {
                        format!("connect('{}',{},'{}')", esc(&f.id), i, esc(name.map(String::as_str).unwrap_or("operator")))
                    }
                );
            }
            if let Some(i) = first_free {
                let _ = write!(
                    b,
                    r#"<span class="port" style="grid-column:span 2" title="click to connect {p}" onclick="connect('{id}',{i},'operator')">{free} free · connect</span>"#,
                    p = user_port(i),
                    id = esc(&f.id)
                );
            }
            b.push_str("</div></div></div></details>");
        }
        b.push_str("</div>");
    }
    // The map half: the same frames drawn on a flat map; open or hover a
    // rack and only its frames stay bright.
    let _ = write!(
        b,
        r#"</div><aside class="rackmap"><section style="padding:8px">{map}<p class="note">The globe of every frame. Thin lines are data ports running from each frame to the central aggregator ◆: green when a remote frame is connected, amber dashed when it dropped, faint blue when the frame runs inside the aggregator. Fold a rack open, or rest on it, to light only its frames, their data ports and the trunks and calls that touch them. Drag turns and tilts, wheel zooms.</p></section>
<section><h2>Data ports <span class="muted">to the central aggregator</span></h2><div class="tiles">{t_agg}{t_up}{t_down}{t_local}</div><p class="note">Every frame reports its crosspoints and checks in over its data port. Remote frames and simulators connect over TCP as Ward-Beck lines. Frames without a remote are hosted inside the aggregator itself.</p></section></aside></div>
<style>.rackwrap{{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}}.rackmap{{position:sticky;top:76px}}@media (max-width:760px){{.rackwrap{{grid-template-columns:1fr}}.rackmap{{position:static}}}}
.globe{{display:block;width:100%;background:#0b1020;border-radius:8px;cursor:grab;touch-action:none}}.tip{{display:none;position:fixed;z-index:20;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;pointer-events:none;max-width:320px}}</style>
<script>
(function(){{
  const racks=document.querySelectorAll('.rack'); const open=()=>{{ const s=new Set(); document.querySelectorAll('.rack details[open]').forEach(d=>{{ const r=d.closest('.rack'); if(r) s.add(r.dataset.proto); }}); return s; }};
  const apply=hover=>{{ const s=open(); if(hover) s.add(hover); window.GLOBE_FILTER=s; }};
  racks.forEach(r=>{{ r.addEventListener('mouseenter',()=>apply(r.dataset.proto)); r.addEventListener('mouseleave',()=>apply(null)); r.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',()=>apply(null))); }});
  TC.onMain.push(()=>apply(null));
}})();
</script>"#,
        map = map_block(&globe, "min(62vh,600px)", "globe", None, Some(&hub)),
        t_agg = tile("aggregator", esc(&agg)),
        t_up = tile("remote ports up", ports_up),
        t_down = tile("remote ports down", ports_down),
        t_local = tile("in process", ports_local),
    );
    page("Racks", rt, live, 5000, &b)
}

// ---------------------------------------------------------------------------
// Relay: the matrices hosted on this computer
// ---------------------------------------------------------------------------

/// The local sound card relay: the browser enumerates this computer's
/// audio devices and meters every input live (Web Audio), binds devices to
/// relay ports, and reports peaks over the threshold as events.
const RELAY_JS: &str = r#"
(function(){
  if(!LIVE) return;
  const list = document.getElementById('devices'); if(!list) return;
  const THRESH = window.RELAY_THRESHOLD, MATRICES = window.RELAY_MATRICES, BOUND = window.RELAY_BOUND;
  const meters = {}; let ctx;
  const dbfs = v => v<=0 ? -90 : Math.max(-90, 20*Math.log10(v));
  function row(d){
    const bound = Object.entries(BOUND).find(([k,b])=>b.device_id===d.deviceId || b.device_label===d.label);
    const sel = MATRICES.map(m=>Array.from({length:m.io},(_,i)=>`<option value="${m.id}:${i}" ${bound&&bound[0]===m.id+':'+i?'selected':''}>${m.label} U${String(i).padStart(2,'0')}</option>`).join('')).join('');
    return `<tr id="dev-${cssId(d.deviceId)}"><td>${d.kind==='audioinput'?'🎙️ in':'🔈 out'}</td><td><b>${esc(d.label||d.deviceId.slice(0,8))}</b></td>
      <td class="vu"><div class="vubar"><i class="rms"></i><i class="peak"></i><span class="hold"></span></div><div class="vunum"><span class="db">—</span></div></td>
      <td><select class="bind"><option value="">— not bound —</option>${sel}</select></td><td class="muted ev"></td></tr>`;
  }
  const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const cssId = s => s.replace(/[^a-zA-Z0-9]/g,'_');
  async function start(){
    try{ await navigator.mediaDevices.getUserMedia({audio:true}); }catch(e){ document.getElementById('relay-note').textContent='Microphone permission is needed to meter the local devices: '+e.message; }
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput'||d.kind==='audiooutput');
    list.innerHTML = devs.map(row).join('') || '<tr><td colspan=5 class="muted">no audio devices found</td></tr>';
    devs.forEach(d=>{ api('/api/relay/event',{kind:'device',device_label:d.label||d.deviceId.slice(0,8),note:d.kind}); });
    document.querySelectorAll('select.bind').forEach((s,i)=>{ s.addEventListener('change',()=>{ const d=devs[i]; const v=s.value; if(!v){ const b=Object.entries(BOUND).find(([k,b])=>b.device_id===d.deviceId); if(b){ const [m,p]=b[0].split(':'); api('/api/relay/unbind',{matrix:m,port:Number(p)}).then(()=>reload()); } return; } const [m,p]=v.split(':'); api('/api/relay/bind',{matrix:m,port:Number(p),device_id:d.deviceId,device_label:d.label||d.deviceId.slice(0,8),kind:d.kind==='audioinput'?'input':'output'}).then(()=>reload()); }); });
    // Offer to connect microphone + speaker pairs: the first pair lands on
    // the 2x2 that carries your user name, the rest overflow onto the 8x8s.
    const mics = devs.filter(d=>d.kind==='audioinput' && !/communications|default/i.test(d.deviceId)), outs = devs.filter(d=>d.kind==='audiooutput' && !/communications|default/i.test(d.deviceId));
    const pairs = []; for(let i=0;i<Math.max(mics.length,outs.length);i++) pairs.push({mic:mics[i]||mics[0], spk:outs[i]||outs[0]});
    const order = MATRICES.slice().sort((a,b)=>(a.io===2?-1:0)-(b.io===2?-1:0)); // the 2x2 first
    const slots = []; for(const m of order) for(let p=0;p+1<m.io;p+=2) slots.push({matrix:m.id,label:m.label,mic:p,spk:p+1});
    const offer = document.getElementById('pair-offer');
    if(offer && pairs.length){
      offer.innerHTML = '<h3>Connect your microphone and speakers</h3><p class="note">'+pairs.length+' pair'+(pairs.length>1?'s':'')+' found. Each pair takes two ports: microphone in, speakers out.'+(pairs.length>1?' Connect them all at once or one by one.':'')+'</p>' + pairs.map((p,i)=>'<div class="row" style="margin:4px 0"><span>🎙️ '+esc(p.mic?p.mic.label:'—')+' + 🔈 '+esc(p.spk?p.spk.label:'—')+' → <b>'+esc(slots[i]?slots[i].label+' U'+String(slots[i].mic).padStart(2,'0')+'/U'+String(slots[i].spk).padStart(2,'0'):'no free pair')+'</b></span> <button class="small" data-pair="'+i+'" '+(slots[i]?'':'disabled')+'>Connect</button></div>').join('') + (pairs.length>1?'<button id="pair-all" style="margin-top:6px">Connect all '+Math.min(pairs.length,slots.length)+' pairs</button>':'');
      const bind = async (i) => { const p=pairs[i], s=slots[i]; if(!p||!s) return; if(p.mic) await api('/api/relay/bind',{matrix:s.matrix,port:s.mic,device_id:p.mic.deviceId,device_label:p.mic.label||'microphone',kind:'input'}); if(p.spk) await api('/api/relay/bind',{matrix:s.matrix,port:s.spk,device_id:p.spk.deviceId,device_label:p.spk.label||'speakers',kind:'output'}); };
      offer.querySelectorAll('button[data-pair]').forEach(b=>b.addEventListener('click', async()=>{ await bind(Number(b.dataset.pair)); reload(); }));
      const all=document.getElementById('pair-all'); if(all) all.addEventListener('click', async()=>{ for(let i=0;i<Math.min(pairs.length,slots.length);i++) await bind(i); reload(); });
    }
    ctx = new (window.AudioContext||window.webkitAudioContext)();
    for(const d of devs.filter(d=>d.kind==='audioinput')){
      try{
        const stream = await navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:d.deviceId}, echoCancellation:false, noiseSuppression:false, autoGainControl:false}});
        const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize=2048; src.connect(an);
        meters[d.deviceId] = {an, buf:new Float32Array(an.fftSize), peakHold:-90, over:false, lastOver:0, row:document.getElementById('dev-'+cssId(d.deviceId)), label:d.label||d.deviceId.slice(0,8)};
      }catch(e){ const r=document.getElementById('dev-'+cssId(d.deviceId)); if(r) r.querySelector('.ev').textContent='cannot open: '+e.message; }
    }
    tick();
  }
  function tick(){
    for(const id in meters){ const m=meters[id]; m.an.getFloatTimeDomainData(m.buf); let sum=0, pk=0; for(let i=0;i<m.buf.length;i++){ const v=Math.abs(m.buf[i]); sum+=v*v; if(v>pk) pk=v; }
      const rms=dbfs(Math.sqrt(sum/m.buf.length)), peak=dbfs(pk); m.peakHold = Math.max(peak, m.peakHold-0.4);
      const pct = db => Math.max(0, Math.min(100, (db+60)/60*100));
      const r=m.row; if(r){ r.querySelector('.rms').style.width=pct(rms)+'%'; r.querySelector('.peak').style.width=pct(peak)+'%'; r.querySelector('.hold').style.left=pct(m.peakHold)+'%'; r.querySelector('.db').textContent=(peak>-89?peak.toFixed(1):'-∞')+' dBFS'; r.querySelector('.vubar').classList.toggle('hot', peak>THRESH); }
      const now=Date.now();
      if(peak>THRESH && !m.over && now-m.lastOver>2000){ m.over=true; m.lastOver=now; const b=Object.entries(BOUND).find(([k,b])=>b.device_id===id); const [mx,pt]= b? b[0].split(':') : [null,null]; api('/api/relay/event',{kind:'over',device_label:m.label,matrix:mx,port:pt!==null?Number(pt):null,peak_dbfs:Math.round(peak*10)/10,threshold_dbfs:THRESH}); if(r) r.querySelector('.ev').textContent='over '+THRESH+' dBFS at '+new Date().toLocaleTimeString(); }
      if(peak<THRESH-3) m.over=false;
    }
    requestAnimationFrame(tick);
  }
  document.getElementById('relay-start').addEventListener('click', start);
})();
"#;

pub fn relay_page(rt: &Runtime, live: bool) -> String {
    let snap = crate::relay::snapshot(rt);
    let mut b = String::new();
    let bound: BTreeMap<String, &RelayBinding> = rt
        .relay
        .matrices
        .iter()
        .flat_map(|m| m.bindings.iter().map(move |(p, b)| (format!("{}:{}", m.id, p.trim_start_matches('U').parse::<usize>().unwrap_or(0)), b)))
        .collect();
    let matrices_json = serde_json::to_string(&rt.relay.matrices.iter().map(|m| serde_json::json!({"id": m.id, "label": m.label, "io": m.io})).collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
    let _ = write!(
        b,
        r#"<section><h2>Local sound card relay on {host}</h2><p class="note" id="relay-note">This computer's sound devices, metered live in your browser (peak and RMS in dBFS, peak hold). Bind a device to a relay port and it becomes that port's name; anything peaking over <b>{thr:+.0} dBFS</b> is logged as an event in <code>TRUNK-RELAY/events.jsonl</code> (threshold in <code>relay.json</code>). Outputs are listed but browsers cannot meter them.</p>
<button id="relay-start">🎚️ Start VU meters and find my microphone and speakers (asks for permission once)</button>
<div id="pair-offer"></div>
<style>.vu{{min-width:260px}}.vubar{{position:relative;height:14px;background:var(--free);border-radius:3px;overflow:hidden}}.vubar i{{position:absolute;left:0;top:0;height:100%;display:block}}.vubar .rms{{background:var(--ok);opacity:.9}}.vubar .peak{{background:var(--used);opacity:.45}}.vubar .hold{{position:absolute;top:0;width:2px;height:100%;background:var(--ink)}}.vubar.hot .peak{{background:var(--bad);opacity:.8}}.vunum{{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--muted)}}</style>
<div class="scroll"><table><tr><th>Kind</th><th>Device</th><th>VU</th><th>Bound to relay port</th><th>Events</th></tr><tbody id="devices"><tr><td colspan="5" class="muted">press Start</td></tr></tbody></table></div>
<script>window.RELAY_THRESHOLD={thr};window.RELAY_MATRICES={matrices};window.RELAY_BOUND={bound};</script><script>{js}</script></section>
<section><h2>Recent relay events</h2><div class="scroll" style="max-height:30vh"><table><tr><th>#</th><th>At</th><th>Kind</th><th>Device</th><th>Port</th><th>Peak</th><th>Note</th></tr>"#,
        host = esc(&snap.host),
        thr = rt.relay.over_threshold_dbfs,
        matrices = matrices_json,
        bound = serde_json::to_string(&bound).unwrap_or_else(|_| "{}".into()),
        js = RELAY_JS,
    );
    for e in rt.recent_relay_events.iter().rev().take(60) {
        let _ = write!(
            b,
            r#"<tr><td class="muted">{}</td><td class="muted">{}</td><td class="{}">{}</td><td>{}</td><td>{}</td><td>{}</td><td class="muted">{}</td></tr>"#,
            e.seq,
            esc(&e.at),
            if e.kind == "over" { "bad" } else { "muted" },
            esc(&e.kind),
            esc(&e.device_label),
            e.matrix.as_ref().map(|m| format!("{m}:{}", user_port(e.port.unwrap_or(0)))).unwrap_or_default(),
            e.peak_dbfs.map(|p| format!("{p:+.1} dBFS")).unwrap_or_default(),
            esc(e.note.as_deref().unwrap_or(""))
        );
    }
    if rt.recent_relay_events.is_empty() {
        b.push_str("<tr><td colspan=\"7\" class=\"muted\">No events yet.</td></tr>");
    }
    b.push_str("</table></div></section>");
    {
        let cats: Vec<&str> = snap.matrices.iter().map(|m| m.label.as_str()).collect();
        let series: Vec<(&str, &str, Vec<f64>)> = vec![
            ("ports", "var(--line)", snap.matrices.iter().map(|m| m.io as f64).collect()),
            ("ports live", "var(--ok)", snap.matrices.iter().map(|m| m.ports.iter().filter(|p| p.connection.is_some()).count() as f64).collect()),
            ("bound to a device", "var(--used)", snap.matrices.iter().map(|m| m.ports.iter().filter(|p| p.binding.is_some()).count() as f64).collect()),
            ("casters trunked", "var(--via)", snap.matrices.iter().map(|m| m.caster_status.iter().filter(|c| c.trunk.is_some()).count() as f64).collect()),
        ];
        let _ = write!(b, "<section><h2>Graphs</h2>{}</section>", bar_chart("Relay matrices: ports, live, bound and trunked", &cats, &series));
    }
    let _ = write!(
        b,
        r#"<section><h2>Matrices</h2><p class="note">Two 8×8 matrices and one 2×2, each a frame of protocol <code>relay</code> at site {site}. Rows are local inputs/outputs, columns the casters into Trunk-Caster; a filled cell is a closed crosspoint. Route a local port to any frame here, or any frame to a local port from <a href="/usage">Usage</a>.</p></section>"#,
        site = esc(&rt.site)
    );
    for m in &snap.matrices {
        let _ = write!(b, r#"<section><h2>{} <span class="muted">{} · {}×{}</span></h2><div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start">"#, esc(&m.label), esc(&m.id), m.io, m.casters);
        // Matrix grid.
        b.push_str("<table class=\"matrix\"><tr><th></th>");
        for c in &m.caster_status {
            let title = c.peer_frame.as_deref().map(|p| format!("C{} → {}", c.index, p)).unwrap_or_else(|| format!("C{} free", c.index));
            let _ = write!(b, r#"<th title="{}">C{}</th>"#, esc(&title), c.index);
        }
        b.push_str("</tr>");
        for p in &m.ports {
            let _ = write!(b, r#"<tr><th title="{}">{}</th>"#, esc(p.name.as_deref().unwrap_or(&p.port)), esc(&p.port));
            for c in &m.caster_status {
                let on = m.crosspoints.iter().any(|x| x.input == p.port && x.output == format!("C{}", c.index));
                let title = if on { format!("{} → C{} ({})", p.port, c.index, p.connected_to.clone().unwrap_or_default()) } else { String::new() };
                let _ = write!(b, r#"<td><i class="{}" title="{}"></i></td>"#, if on { "on" } else { "" }, esc(&title));
            }
            b.push_str("</tr>");
        }
        b.push_str("</table>");
        // Port list with controls.
        b.push_str("<table style=\"max-width:820px\"><tr><th>Port</th><th>Name</th><th>Sound device</th><th>Live</th><th>Connected to</th><th>For</th><th></th></tr>");
        for p in &m.ports {
            let idx: usize = p.port.trim_start_matches('U').parse().unwrap_or(0);
            let _ = write!(
                b,
                r#"<tr><td><b>{port}</b></td><td>{name} <button class="small secondary" onclick="rename('{id}',{idx})">rename</button></td><td class="muted">{dev}</td><td>{who}</td><td>{to}</td><td class="muted">{for_}</td><td>{action}</td></tr>"#,
                port = esc(&p.port),
                name = esc(p.name.as_deref().unwrap_or("")),
                dev = p.binding.as_ref().map(|b| format!("{} {}", if b.kind == "input" { "🎙️" } else { "🔈" }, esc(&b.device_label))).unwrap_or_default(),
                id = esc(&m.id),
                who = esc(p.live_who.as_deref().unwrap_or("")),
                to = esc(p.connected_to.as_deref().unwrap_or("")),
                for_ = p.connected_seconds.map(dur).unwrap_or_default(),
                action = match &p.connection {
                    Some(c) => format!(r#"<button class="small secondary" onclick="api('/api/release',{{id:'{}'}}).then(()=>reload())">release</button>"#, esc(c)),
                    None => format!(r#"<button class="small" onclick="connect('{}',{},'{}')">route to…</button>"#, esc(&m.id), idx, esc(p.name.as_deref().unwrap_or("relay"))),
                }
            );
        }
        b.push_str("</table></div></section>");
    }
    page("Relay", rt, live, 4000, &b)
}

// ---------------------------------------------------------------------------

pub fn users_page(rt: &Runtime, live: bool) -> String {
    let mut b = String::new();
    let now = util::now_unix();
    let recs = &rt.recent_records;
    let granted = recs.iter().filter(|r| r.status == ReplyStatus::Granted).count();
    let denied = recs.iter().filter(|r| r.status == ReplyStatus::Denied).count();
    let released = recs.iter().filter(|r| r.status == ReplyStatus::Released).count();
    let _ = write!(
        b,
        r#"<section><h2>Who asked whom</h2><div class="tiles">{}{}{}{}{}</div>
<p class="note">One JSON per request lives in <code>TRUNK-USERS</code>: who, whom, when, why, where and how (direct or via which frames), plus how long it lasted. Showing the most recent {} records.</p></section>"#,
        tile("records shown", recs.len()),
        tile("live (granted)", granted),
        tile("denied", denied),
        tile("released", released),
        tile("last connection", last_connection_overall(rt, now)),
        recs.len()
    );

    // Graphs: outcomes and the busiest callers among the recent records.
    {
        let outcomes: Vec<f64> = vec![granted as f64, denied as f64, released as f64];
        let outcome_chart = bar_chart("Recent requests by outcome", &["granted (live)", "denied", "released"], &[("requests", "var(--used)", outcomes)]);
        let mut by_who: BTreeMap<&str, usize> = BTreeMap::new();
        for r in recs.iter() {
            *by_who.entry(r.who.as_str()).or_default() += 1;
        }
        let mut top: Vec<(&str, usize)> = by_who.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        top.truncate(12);
        let cats: Vec<&str> = top.iter().map(|t| t.0).collect();
        let vals: Vec<f64> = top.iter().map(|t| t.1 as f64).collect();
        let who_chart = bar_chart("Busiest callers (recent records)", &cats, &[("requests", "var(--ok)", vals)]);
        let _ = write!(b, "<section><h2>Graphs</h2>{outcome_chart}{who_chart}</section>");
    }

    // People.
    #[derive(Default)]
    struct Person {
        asked: usize,
        live: usize,
        last: String,
        total: u64,
    }
    let mut people: BTreeMap<&str, Person> = BTreeMap::new();
    for r in recs.iter() {
        let p = people.entry(r.who.as_str()).or_default();
        p.asked += 1;
        if r.status == ReplyStatus::Granted {
            p.live += 1;
        }
        if r.when > p.last {
            p.last = r.when.clone();
        }
        p.total += r.connected_seconds.unwrap_or(0);
    }
    for c in &rt.state.connections {
        if let Some(p) = people.get_mut(c.who.as_str()) {
            p.total += c.connected_for(now);
        }
    }
    b.push_str("<section><h2>People</h2><div class=\"scroll\"><table><tr><th>Who</th><th>Requests</th><th>Live now</th><th>Connected in total</th><th>Last asked</th></tr>");
    let mut rows: Vec<(&str, Person)> = people.into_iter().collect();
    rows.sort_by(|a, b| b.1.last.cmp(&a.1.last));
    for (who, p) in rows.iter().take(100) {
        let _ = write!(b, "<tr><td><b>{}</b></td><td>{}</td><td>{}</td><td>{}</td><td class=\"muted\">{}</td></tr>", esc(who), p.asked, p.live, dur(p.total), esc(&p.last));
    }
    b.push_str("</table></div></section>");

    b.push_str("<section><h2>Requests</h2><div class=\"scroll\" style=\"max-height:70vh\"><table><tr><th>When</th><th>Who</th><th>From</th><th>Whom</th><th>Why</th><th>Where</th><th>How</th><th>Lasted</th><th>GPIO</th><th>Status</th><th>Origin</th></tr>");
    for r in recs.iter() {
        let how = match &r.how {
            Some(h) if h.kind == RouteKind::Via => format!("<span class=\"kind-via\">via {}</span>", esc(&h.via.join(" → "))),
            Some(_) => "<span class=\"kind-direct\">direct</span>".to_string(),
            None => format!("<span class=\"bad\">{}</span>", esc(r.reason.as_deref().unwrap_or("denied"))),
        };
        let status = match r.status {
            ReplyStatus::Granted => "granted",
            ReplyStatus::Denied => "denied",
            ReplyStatus::Released => "released",
        };
        let lasted = match (r.status, r.connected_seconds) {
            (ReplyStatus::Released, Some(s)) => dur(s),
            (ReplyStatus::Granted, _) => rt
                .state
                .connection(&r.id)
                .map(|c| format!("{} so far", dur(c.connected_for(now))))
                .unwrap_or_default(),
            _ => String::new(),
        };
        let _ = write!(
            b,
            r#"<tr><td class="muted">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td class="status-{status}">{status}</td><td class="muted">{}</td></tr>"#,
            esc(&r.when),
            esc(&r.who),
            esc(&r.from),
            esc(&r.whom),
            esc(r.why.as_deref().unwrap_or("")),
            esc(r.where_.as_deref().unwrap_or("")),
            how,
            lasted,
            r.gpio_sent,
            esc(&r.origin)
        );
    }
    if recs.is_empty() {
        b.push_str("<tr><td colspan=\"11\" class=\"muted\">No requests yet.</td></tr>");
    }
    b.push_str("</table></div></section>");
    page("Users", rt, live, 4000, &b)
}

// ---------------------------------------------------------------------------

/// The global crosspoint: a tiny matrix of every site against every
/// site, grouped by continent. A lit cell is a call from the row's site to
/// the column's, coloured by the caller's vendor (dim when parked); hover
/// it for who is on it. Beside it, every call as "who: from → to".
fn global_crosspoint(rt: &Runtime) -> String {
    let st = &rt.state;
    let site_of = |id: &str| st.frame(id).map(|f| f.site.clone());
    let mut sites: Vec<(String, String)> = st
        .frames
        .iter()
        .map(|f| (f.continent.clone().unwrap_or_else(|| if f.protocol == crate::relay::PROTOCOL { "This computer".into() } else { "Other".into() }), f.site.clone()))
        .collect();
    sites.sort();
    sites.dedup();
    let n = sites.len();
    if n == 0 {
        return String::new();
    }
    let index: BTreeMap<&str, usize> = sites.iter().enumerate().map(|(i, (_, s))| (s.as_str(), i)).collect();
    let mut cells: BTreeMap<(usize, usize), Vec<&Connection>> = BTreeMap::new();
    for c in &st.connections {
        let (Some(a), Some(b)) = (site_of(&c.from_frame), site_of(&c.to_frame)) else { continue };
        if let (Some(&i), Some(&j)) = (index.get(a.as_str()), index.get(b.as_str())) {
            cells.entry((i, j)).or_default().push(c);
        }
    }
    let cell = 4.0_f64;
    let (ml, mt) = (92.0_f64, 30.0_f64);
    let side = cell * n as f64;
    let (w, h) = (ml + side + 4.0, mt + side + 4.0);
    let mut svg = String::new();
    let _ = write!(
        svg,
        r#"<svg class="gxp" viewBox="0 0 {w:.0} {h:.0}" role="img" aria-label="Global crosspoint: every site against every site"><rect x="{ml}" y="{mt}" width="{side}" height="{side}" fill="var(--free)" opacity=".45"/><line x1="{ml}" y1="{mt}" x2="{x2}" y2="{y2}" stroke="var(--line)" stroke-width=".6"/>"#,
        x2 = ml + side,
        y2 = mt + side
    );
    // Continent bands: separators and labels.
    let mut groups: Vec<(String, usize, usize)> = Vec::new();
    for (i, (c, _)) in sites.iter().enumerate() {
        match groups.last_mut() {
            Some(g) if g.0 == *c => g.2 += 1,
            _ => groups.push((c.clone(), i, 1)),
        }
    }
    for (k, (c, start, count)) in groups.iter().enumerate() {
        let o = *start as f64 * cell;
        let len = *count as f64 * cell;
        if k % 2 == 1 {
            let _ = write!(svg, r#"<rect x="{ml}" y="{:.1}" width="{side}" height="{len:.1}" fill="var(--line)" opacity=".35"/><rect x="{:.1}" y="{mt}" width="{len:.1}" height="{side}" fill="var(--line)" opacity=".35"/>"#, mt + o, ml + o);
        }
        if *start > 0 {
            let _ = write!(svg, r#"<line x1="{ml}" x2="{:.1}" y1="{:.1}" y2="{:.1}" stroke="var(--muted)" stroke-width=".5"/><line y1="{mt}" y2="{:.1}" x1="{:.1}" x2="{:.1}" stroke="var(--muted)" stroke-width=".5"/>"#, ml + side, mt + o, mt + o, mt + side, ml + o, ml + o);
        }
        let short: String = c.split_whitespace().map(|w| w.chars().next().unwrap_or(' ')).collect::<String>();
        let short = if short.len() < 2 { c.chars().take(3).collect() } else { short };
        let _ = write!(svg, r#"<text x="{:.1}" y="{:.1}" text-anchor="end" font-size="9" fill="var(--muted)" dominant-baseline="middle">{} <tspan fill="var(--ink)">{}</tspan></text>"#, ml - 4.0, mt + o + len / 2.0, esc(c), count);
        let _ = write!(svg, r#"<text x="{:.1}" y="{:.1}" text-anchor="middle" font-size="9" fill="var(--muted)"><title>{}</title>{}</text>"#, ml + o + len / 2.0, mt - 6.0, esc(c), esc(&short));
    }
    let _ = write!(svg, r#"<text x="{:.1}" y="10" text-anchor="middle" font-size="8.5" fill="var(--muted)">to site →</text><text x="4" y="10" font-size="8.5" fill="var(--muted)">from site ↓</text>"#, ml + side / 2.0);
    // Lit crosspoints.
    for ((i, j), list) in &cells {
        let first = list[0];
        let color = st.frame(&first.from_frame).and_then(|f| f.badge.as_ref().map(|b| b.color.clone())).unwrap_or_else(|| "var(--accent)".into());
        let all_parked = list.iter().all(|c| c.muted);
        let mut title = format!("{} → {} · {} call{}", sites[*i].1, sites[*j].1, list.len(), if list.len() == 1 { "" } else { "s" });
        for c in list.iter().take(10) {
            let _ = write!(title, "\n{}: {}:{} → {}:{}{}", c.who, c.from_frame, user_port(c.from_port), c.to_frame, user_port(c.to_port), if c.muted { " (parked)" } else { "" });
        }
        if list.len() > 10 {
            let _ = write!(title, "\n… {} more", list.len() - 10);
        }
        let grow = if list.len() > 1 { 0.6 } else { 0.0 };
        let _ = write!(
            svg,
            r#"<rect class="xp" x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" rx=".6" fill="{}" opacity="{}"><title>{}</title></rect>"#,
            ml + *j as f64 * cell + 0.3 - grow,
            mt + *i as f64 * cell + 0.3 - grow,
            cell - 0.6 + 2.0 * grow,
            cell - 0.6 + 2.0 * grow,
            esc(&color),
            if all_parked { "0.4" } else { "1" },
            esc(&title)
        );
    }
    svg.push_str("</svg>");

    // Who is connected to who.
    let mut conns: Vec<&Connection> = st.connections.iter().collect();
    conns.sort_by(|a, b| a.who.cmp(&b.who).then(a.from_frame.cmp(&b.from_frame)));
    let mut list = String::new();
    for c in conns.iter().take(600) {
        let badge = st.frame(&c.from_frame).and_then(|f| f.badge.as_ref().map(|b| b.emoji.clone())).unwrap_or_default();
        let (fs, ts) = (site_of(&c.from_frame).unwrap_or_default(), site_of(&c.to_frame).unwrap_or_default());
        let _ = write!(
            list,
            r#"<div class="w{}" title="{}:{} → {}:{}{}">{} <b>{}</b> <span class="muted">{}</span> → <span>{}</span></div>"#,
            if c.muted { " parked" } else { "" },
            esc(&c.from_frame), user_port(c.from_port), esc(&c.to_frame), user_port(c.to_port),
            if c.kind == RouteKind::Via { format!(" via {}", c.via_frames().join(", ")) } else { String::new() },
            badge, esc(&c.who), esc(&fs), esc(&ts)
        );
    }
    if conns.is_empty() {
        list.push_str("<p class=\"muted\">Nobody is connected right now.</p>");
    } else if conns.len() > 600 {
        let _ = write!(list, "<p class=\"muted\">… and {} more</p>", conns.len() - 600);
    }
    let lit = cells.len();
    format!(
        r#"<section><h2>Global crosspoint <span class="muted">{n} sites × {n} sites · {lit} lit · {calls} calls</span></h2><p class="note">Every site against every site, grouped by continent. A lit cell is a call from the row's site to the column's, coloured by the caller's vendor; dim cells are parked, bigger cells carry more than one call. The diagonal is calls that stay home. Hover a cell for who is on it.</p>
<div class="gxpwrap"><div>{svg}</div><div class="who">{list}</div></div>
<style>.gxpwrap{{display:grid;grid-template-columns:minmax(320px,640px) 1fr;gap:16px;align-items:start}}.gxp{{display:block;width:100%;height:auto}}.gxp .xp:hover{{stroke:var(--ink);stroke-width:1}}.gxpwrap .who{{columns:240px;column-gap:18px;font-size:11.5px;max-height:640px;overflow:auto}}.gxpwrap .who div{{break-inside:avoid;padding:1px 0;border-bottom:1px dotted var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}.gxpwrap .who .parked{{opacity:.5}}@media (max-width:900px){{.gxpwrap{{grid-template-columns:1fr}}}}</style></section>"#,
        calls = st.connections.len()
    )
}

pub fn crosspoints_page(rt: &Runtime, live: bool) -> String {
    let cp = &rt.crosspoints;
    let mut b = String::new();

    b.push_str(&global_crosspoint(rt));

    let ended = if cp.ended {
        format!(r#"<span class="warn">log ended at {} events</span>"#, cp.events_logged)
    } else {
        format!(r#"<span class="ok">logging · {} of {} events</span>"#, cp.events_logged, cp.settings.max_events)
    };
    let _ = write!(
        b,
        r#"<section><h2>Delta log and check-in</h2><div class="tiles">{}{}{}{}{}</div>
<form class="row" onsubmit="event.preventDefault();api('/api/crosspoints/settings',{{max_events:num('max_events'),checkin_every_seconds:num('checkin')}}).then(()=>reload())">
<label>Log ends after (events)<input id="max_events" type="number" min="1" value="{max}"></label>
<label>Check-in every (s)<input id="checkin" type="number" min="1" step="1" value="{ci}"></label>
<button type="submit">Apply</button>
<button type="button" class="secondary" onclick="api('/api/crosspoints/reset',{{}}).then(()=>reload())">Reset log</button>
<span class="note">{ended}. Deltas: <code>deltas.jsonl</code> and <code>wardbeck.log</code>; snapshot: <code>crosspoints.json</code>; latest check-in: <code>checkin.wb</code>.</span></form></section>"#,
        tile("closed crosspoints", cp.current.len()),
        tile("end-to-end lines", cp.current_e2e.len()),
        tile("events logged", cp.events_logged),
        tile("check-ins", cp.checkins),
        tile("last check-in", cp.last_checkin_at.as_deref().map(|s| esc(s)).unwrap_or_else(|| "pending".into())),
        max = cp.settings.max_events,
        ci = cp.settings.checkin_every_seconds,
    );

    // The full map: every frame, inside its country, inside its continent.
    // A cell is one frame, shaded by how many crosspoints it has closed.
    {
        let mut per_frame: BTreeMap<&str, Vec<&Crosspoint>> = BTreeMap::new();
        for c in &cp.current {
            per_frame.entry(c.frame.as_str()).or_default().push(c);
        }
        let peak = per_frame.values().map(Vec::len).max().unwrap_or(0).max(1);
        let mut map: BTreeMap<String, BTreeMap<String, Vec<&Frame>>> = BTreeMap::new();
        for f in &rt.state.frames {
            let cont = f.continent.clone().unwrap_or_else(|| if f.protocol == crate::relay::PROTOCOL { "This computer".into() } else { "Other".into() });
            let country = f.country.clone().unwrap_or_else(|| rt.site.clone());
            map.entry(cont).or_default().entry(country).or_default().push(f);
        }
        let count = |fs: &[&Frame]| fs.iter().map(|f| per_frame.get(f.id.as_str()).map_or(0, Vec::len)).sum::<usize>();
        b.push_str(
            r#"<style>.xmap{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start}.xcont{flex:1 1 320px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--panel)}.xcont>h3{margin:0 0 6px;font-size:13px;display:flex;justify-content:space-between}.xcountries{display:flex;flex-wrap:wrap;gap:6px}.xcountry{border:1px solid var(--line);border-radius:6px;padding:4px 6px;flex:0 1 auto}.xcountry>div:first-child{font-size:11px;color:var(--muted);display:flex;gap:8px;justify-content:space-between;margin-bottom:3px}.xframes{display:flex;flex-wrap:wrap;gap:2px;max-width:220px}.xframes span{display:block;width:14px;height:14px;border-radius:3px;background:var(--free);border:1px solid var(--line);position:relative}.xframes span.on{background:color-mix(in srgb,var(--used) calc(var(--k)*100%),var(--free));border-color:var(--used)}.xframes span i{position:absolute;inset:auto 0 0 auto;width:4px;height:4px;border-radius:50%;background:var(--b)}</style>"#,
        );
        let _ = write!(
            b,
            r#"<section><h2>Map <span class="muted">· {} frames · {} closed</span></h2><p class="note">Every frame, in its country, in its continent. A cell is a frame, darker the more crosspoints it has closed (busiest: {peak}); the corner dot is its vendor. Hover a cell for its frame, site and crosspoints.</p><div class="xmap">"#,
            rt.state.frames.len(),
            cp.current.len()
        );
        for (cont, countries) in &map {
            let all: Vec<&Frame> = countries.values().flatten().copied().collect();
            let _ = write!(
                b,
                r#"<div class="xcont"><h3><span>{}</span><span class="muted">{} countries · {} frames · <b>{}</b> closed</span></h3><div class="xcountries">"#,
                esc(cont),
                countries.len(),
                all.len(),
                count(&all)
            );
            for (country, frames) in countries {
                let _ = write!(b, r#"<div class="xcountry"><div><span>{}</span><b>{}</b></div><div class="xframes">"#, esc(country), count(frames));
                for f in frames {
                    let list = per_frame.get(f.id.as_str());
                    let n = list.map_or(0, Vec::len);
                    let mut tip = format!("{} · {} · {} closed", f.id, f.site, n);
                    for c in list.into_iter().flatten().take(24) {
                        let _ = write!(tip, "\n{}→{}", c.input, c.output);
                    }
                    if n > 24 {
                        let _ = write!(tip, "\n… {} more", n - 24);
                    }
                    let _ = write!(
                        b,
                        r#"<span class="{}" style="--k:{:.2};--b:{}" title="{}">{}</span>"#,
                        if n > 0 { "on" } else { "" },
                        0.25 + 0.75 * n as f64 / peak as f64,
                        esc(f.badge.as_ref().map_or("transparent", |x| x.color.as_str())),
                        esc(&tip),
                        if f.badge.is_some() { "<i></i>" } else { "" }
                    );
                }
                b.push_str("</div></div>");
            }
            b.push_str("</div></div>");
        }
        if map.is_empty() {
            b.push_str("<p class=\"muted\">No frames yet.</p>");
        }
        b.push_str("</div></section>");
    }

    // Graphs: the frames with the most crosspoints closed, and recent deltas per minute.
    {
        let mut per_frame: BTreeMap<&str, usize> = BTreeMap::new();
        for c in &cp.current {
            *per_frame.entry(c.frame.as_str()).or_default() += 1;
        }
        let mut top: Vec<(&str, usize)> = per_frame.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        top.truncate(14);
        let cats: Vec<&str> = top.iter().map(|t| t.0).collect();
        let vals: Vec<f64> = top.iter().map(|t| t.1 as f64).collect();
        let top_chart = bar_chart("Frames with the most crosspoints closed", &cats, &[("crosspoints", "var(--used)", vals)]);
        let mut per_min: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for e in &cp.recent {
            let k = e.at.get(11..16).unwrap_or("").to_string();
            let v = per_min.entry(k).or_default();
            if e.op == DeltaOp::Set {
                v.0 += 1;
            } else {
                v.1 += 1;
            }
        }
        let keys: Vec<&str> = per_min.keys().map(String::as_str).collect();
        let sets: Vec<f64> = per_min.values().map(|v| v.0 as f64).collect();
        let clears: Vec<f64> = per_min.values().map(|v| v.1 as f64).collect();
        let delta_chart = bar_chart("Recent deltas per minute (UTC wall clock)", &keys, &[("set", "var(--ok)", sets), ("clear", "var(--muted)", clears)]);
        let _ = write!(b, "<section><h2>Graphs</h2>{top_chart}{delta_chart}</section>");
    }

    // Ward-Beck lines.
    b.push_str("<section><h2>Ward-Beck lines</h2><p class=\"note\"><code>SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE</code>. The unifying words: every delta, every end-to-end connection, every check-in. OPEN expresses what is no longer there.</p><div class=\"scroll\"><pre>");
    for l in cp.recent_wb.iter().rev().take(120) {
        let _ = writeln!(b, "{}", esc(l));
    }
    if cp.recent_wb.is_empty() {
        b.push_str("nothing yet");
    }
    b.push_str("</pre></div></section>");

    // Panel seeks.
    let _ = write!(
        b,
        r#"<section><h2>Looking for a panel</h2>
<form class="row" onsubmit="event.preventDefault();api('/api/panel-seek',{{who:val('swho')||'seeker',from:val('sfrom'),panel_frame:val('spanel'),panel_port:num('sport')||null}}).then(r=>show('seek-result',r))">
<label>Who<input id="swho" placeholder="seeker"></label>
<label>On frame<select id="sfrom">{opts}</select></label>
<label>Wants panel on<select id="spanel">{opts}</select></label>
<label>Port<input id="sport" type="number" min="0" placeholder="any"></label>
<button type="submit">Advertise seek</button></form>
<p class="note">A seek is advertised here and in <code>seeking.json</code>; the runtime answers with every trunk the seeker is allowed to take. File form: drop <code>seeks/&lt;id&gt;.json</code>, read <code>seeks/&lt;id&gt;.offer.json</code>.</p>
<div id="seek-result" class="result"></div>"#,
        opts = frame_options(rt),
    );
    if rt.offers.is_empty() {
        b.push_str("<p class=\"muted\">Nobody is seeking a panel right now.</p>");
    }
    for o in rt.offers.iter().rev().take(20) {
        let panel = match o.seek.panel_port {
            Some(p) => format!("{}:{}", esc(&o.seek.panel_frame), user_port(p)),
            None => esc(&o.seek.panel_frame),
        };
        let _ = write!(
            b,
            "<h3>{} on {} seeks {} <span class=\"muted\">· {} · {}</span></h3><table><tr><th>Kind</th><th>Path</th><th>Trunks</th><th>New trunks</th><th>Free channels</th></tr>",
            esc(&o.seek.who), esc(&o.seek.from), panel, esc(&o.seek_id), esc(&o.offered_at)
        );
        for t in &o.allowed_trunks {
            let trunks: Vec<String> = t.trunks.iter().map(|x| x.clone().unwrap_or_else(|| "new".into())).collect();
            let _ = write!(
                b,
                r#"<tr><td class="kind-{k}">{k}</td><td>{}</td><td><code>{}</code></td><td>{}</td><td>{}</td></tr>"#,
                esc(&t.path.join(" → ")),
                esc(&trunks.join(", ")),
                t.new_trunks_needed,
                t.free_channels,
                k = kind_str(t.kind)
            );
        }
        if o.allowed_trunks.is_empty() {
            b.push_str("<tr><td colspan=\"5\" class=\"bad\">No allowed trunk: no capacity anywhere between these frames.</td></tr>");
        }
        b.push_str("</table>");
    }
    b.push_str("</section>");

    // GPIO through the caster.
    b.push_str("<section><h2>GPIO through the trunk caster</h2><p class=\"note\">A GPIO command rides the same trunks as the call it belongs to. Send one from any live connection on the Usage page, or POST <code>/api/gpio</code>. Log: <code>gpio.jsonl</code>.</p><div class=\"scroll\"><table><tr><th>#</th><th>At</th><th>Who</th><th>Pin</th><th>State</th><th>Path</th><th>Trunks</th><th>Note</th></tr>");
    for e in rt.recent_gpio.iter().rev().take(60) {
        let _ = write!(
            b,
            r#"<tr><td class="muted">{}</td><td class="muted">{}</td><td>{}</td><td>{}</td><td class="{}">{}</td><td>{}</td><td><code>{}</code></td><td class="muted">{}</td></tr>"#,
            e.seq,
            esc(&e.at),
            esc(&e.who),
            e.pin,
            if e.state { "ok" } else { "muted" },
            if e.state { "CLOSE" } else { "OPEN" },
            esc(&e.path.join(" → ")),
            esc(&e.trunks.join(", ")),
            esc(e.note.as_deref().unwrap_or(""))
        );
    }
    if rt.recent_gpio.is_empty() {
        b.push_str("<tr><td colspan=\"8\" class=\"muted\">No GPIO sent yet.</td></tr>");
    }
    b.push_str("</table></div></section>");

    // Renames.
    b.push_str("<section><h2>Port renames</h2><p class=\"note\">A user port takes the name of the person who called through it. Each vendor implementing the frame's protocol is told in its own transport from <code>TRUNK-CASTER-SDK/vendor-policy.json</code>: RTS over SNMP SET, others kept in the SDK. Log: <code>renames.jsonl</code>.</p><div class=\"scroll\"><table><tr><th>#</th><th>At</th><th>Port</th><th>Was</th><th>Now</th><th>Vendor</th><th>Transport</th><th>Detail</th></tr>");
    for r in rt.recent_renames.iter().rev().take(80) {
        let _ = write!(
            b,
            r#"<tr><td class="muted">{}</td><td class="muted">{}</td><td>{}:{}</td><td class="muted">{}</td><td><b>{}</b></td><td>{}</td><td class="{}">{}</td><td class="note">{}{}</td></tr>"#,
            r.seq,
            esc(&r.at),
            esc(&r.frame),
            esc(&r.port),
            esc(r.old_name.as_deref().unwrap_or("")),
            esc(&r.new_name),
            esc(&r.vendor),
            if r.sent { "ok" } else { "warn" },
            esc(&r.transport),
            esc(&r.detail),
            r.payload_hex.as_deref().map(|h| format!("<br><code>{}</code>", esc(h))).unwrap_or_default()
        );
    }
    if rt.recent_renames.is_empty() {
        b.push_str("<tr><td colspan=\"8\" class=\"muted\">No renames yet.</td></tr>");
    }
    b.push_str("</table></div></section>");

    // Recent events.
    b.push_str("<section><h2>Recent deltas</h2><div class=\"scroll\"><table><tr><th>#</th><th>At</th><th>Sim t</th><th>Op</th><th>Frame</th><th>Input</th><th>Output</th><th>Connection</th></tr>");
    for e in cp.recent.iter().rev().take(100) {
        let _ = write!(
            b,
            r#"<tr><td class="muted">{}</td><td class="muted">{}</td><td class="muted">{}</td><td class="{}">{}</td><td>{}</td><td>{}</td><td>{}</td><td><code>{}</code></td></tr>"#,
            e.seq,
            esc(&e.at),
            e.sim_time.map(|t| format!("{t:.1}")).unwrap_or_default(),
            if e.op == DeltaOp::Set { "ok" } else { "muted" },
            if e.op == DeltaOp::Set { "set" } else { "clear" },
            esc(&e.crosspoint.frame),
            esc(&e.crosspoint.input),
            esc(&e.crosspoint.output),
            esc(&e.crosspoint.connection)
        );
    }
    b.push_str("</table></div></section>");

    // Current crosspoints by frame.
    b.push_str("<section><h2>Closed crosspoints by frame</h2><div class=\"scroll\" style=\"max-height:60vh\"><table><tr><th>Frame</th><th>Crosspoints (input → output)</th></tr>");
    let mut by_frame: BTreeMap<&str, Vec<&Crosspoint>> = BTreeMap::new();
    for c in &cp.current {
        by_frame.entry(c.frame.as_str()).or_default().push(c);
    }
    for (f, mut list) in by_frame {
        list.sort_by(|a, b| (&a.input, &a.output).cmp(&(&b.input, &b.output)));
        let items: Vec<String> = list
            .iter()
            .map(|c| format!("<code title=\"{}\">{}→{}</code>", esc(&c.connection), esc(&c.input), esc(&c.output)))
            .collect();
        let _ = write!(b, "<tr><td><b>{}</b></td><td>{}</td></tr>", esc(f), items.join(" "));
    }
    if cp.current.is_empty() {
        b.push_str("<tr><td colspan=\"2\" class=\"muted\">No crosspoints closed.</td></tr>");
    }
    b.push_str("</table></div></section>");

    page("Cross points", rt, live, 4000, &b)
}

// ---------------------------------------------------------------------------

pub fn simulator_page(rt: &Runtime, live: bool) -> String {
    let f = &rt.fader;
    let now = util::now_unix();
    let mut b = String::new();

    // Left: the report, generated from the run the graphs are drawn from.
    let report = md_html(&crate::report::markdown(rt));
    let _ = write!(
        b,
        r#"<div class="sim"><aside class="report" id="report"><h2>Report <span class="muted" style="font-weight:400;font-size:12px">· <a href="/api/report">markdown</a> · <a href="/api/runs/current">run json</a> · <a href="/api/report" onclick="event.preventDefault();if(navigator.clipboard)navigator.clipboard.writeText(document.getElementById('report').innerText)">copy</a></span></h2>{report}</aside><div class="simmain">"#
    );

    // Events: presets worth watching, one click each.
    let presets = presets(f);
    b.push_str(r#"<section><h2>Events</h2><div class="events">"#);
    for p in &presets {
        let _ = write!(
            b,
            r#"<button type="button" class="event{}" data-id="{}" title="{}" onclick="api('/api/fader/preset',{{id:'{}'}}).then(()=>reload())"><b>{}</b><span>{}</span></button>"#,
            if p.id == f.preset { " on" } else { "" },
            esc(&p.id),
            esc(&p.blurb),
            esc(&p.id),
            esc(&p.name),
            esc(&p.blurb)
        );
    }
    let _ = write!(
        b,
        r#"</div><div class="quick"><span>event <b>{}</b></span><span>UTC <b id="footclock">{}</b></span><label>speed <input id="qspeed" type="range" min="0" max="240" step="1" value="{speed:.0}" oninput="setText('qspeedv',this.value+'×')" onchange="api('/api/fader/quick',{{speed:Number(this.value)}})"> <b id="qspeedv">{speed:.0}×</b></label><button type="button" id="qrun" class="small {runclass}" data-running="{running}" onclick="api('/api/fader/quick',{{running:this.dataset.running!=='true'}}).then(()=>reload())">{runlabel}</button><span class="muted">a change starts a new run; the report on the left follows the current run</span></div></section>"#,
        esc(&crate::report::event_name(f)),
        rt.clock(),
        speed = f.speed,
        running = f.running,
        runclass = if f.running { "secondary" } else { "" },
        runlabel = if f.running { "⏸ pause load" } else { "▶ run load" },
    );

    // Productions on air right now.
    let prods = rt.production_samples();
    if !prods.is_empty() {
        b.push_str("<section><h2>Productions</h2><div class=\"tiles\">");
        for (name, p) in &prods {
            let busy_pct = if p.offered > 0 { p.busy as f64 / p.offered as f64 * 100.0 } else { 0.0 };
            let _ = write!(
                b,
                r#"<div class="tile" style="border-color:{}"><b>{} <span class="{}" style="font-size:12px">{}</span></b><span>{} · studio <code>{}</code></span><div style="margin-top:6px;font-size:12px">on the line <b>{}</b> · trunks <b>{}</b> of {} · offered <b>{}</b> · answered <b>{}</b> · busy <b class="{}">{}</b> ({:.0}%)</div><div class="bar" style="margin-top:6px"><i style="width:{:.0}%;background:var(--bad)"></i></div></div>"#,
                if p.on_air { "var(--accent)" } else { "var(--line)" },
                esc(name),
                if p.on_air { "ok" } else { "muted" },
                if p.on_air { "on air" } else { "off air" },
                if p.on_air { "live" } else { "waiting for the window" },
                esc(&p.studio),
                p.live,
                p.trunks_used,
                p.trunks,
                p.offered,
                p.answered,
                if p.busy > 0 { "bad" } else { "" },
                p.busy,
                busy_pct,
                busy_pct
            );
        }
        b.push_str("</div></section>");
    }

    // The fader, productions included.
    let _ = write!(
        b,
        r#"<section><h2>Fader</h2>
<form class="row" onsubmit="event.preventDefault();api('/api/fader',{{speed:num('speed'),requests_per_minute:num('rpm'),mean_hold_seconds:num('hold'),crosscheck_every_seconds:num('cc'),sample_every_seconds:num('smp'),running:val('running')==='true',seed:{seed},round_robin_seconds:{rr},lease_seconds:{lease},day:{{enabled:val('day_on')==='true',start_hour:num('day_start'),hourly_news:num('d_news'),radio_prep:num('d_radio'),overnight:num('d_night'),blackout:{{enabled:val('bo_on')==='true',start_hour:{bos},end_hour:{boe}}},olympics:{{enabled:val('oly_on')==='true',hour:num('oly_h'),hours:num('oly_len'),peak:num('oly_peak'),venue:val('oly_venue'),trunks:num('oly_trunks')||8,calls_per_minute:num('oly_cpm'),mean_hold_seconds:num('oly_hold')||120}},newscasts:(val('d_casts')||'').split(',').map(s=>s.trim()).filter(Boolean).map(s=>{{const [h,p]=s.split(':');return {{hour:Number(h),peak:Number(p||4)}}}})}},productions:Array.from(document.querySelectorAll('tr.prow')).map(r=>({{enabled:r.querySelector('.pen').checked,name:r.querySelector('.pname').value,studio:r.querySelector('.pstudio').value,trunks:Number(r.querySelector('.ptrunks').value)||8,calls_per_minute:Number(r.querySelector('.pcpm').value)||0,mean_hold_seconds:Number(r.querySelector('.phold').value)||90,start_hour:Number(r.querySelector('.pstart').value),end_hour:Number(r.querySelector('.pend').value)}})).filter(p=>p.name.trim()),in_building_calls_per_hour:num('bldg')}}).then(()=>reload())">
<label>Speed (sim s per real s)<input id="speed" type="number" step="0.5" min="0" value="{speed}"></label>
<label>Baseline requests / sim minute<input id="rpm" type="number" step="1" min="0" value="{rpm}"></label>
<label>Mean hold (sim s)<input id="hold" type="number" step="5" min="1" value="{hold}"></label>
<label>Cross-check every (sim s)<input id="cc" type="number" step="1" min="0.1" value="{cc}"></label>
<label>Sample every (sim s)<input id="smp" type="number" step="1" min="0.1" value="{smp}"></label>
<label>Synthetic load<select id="running"><option value="true" {ron}>running</option><option value="false" {roff}>paused</option></select></label>
<label>News cycle<select id="day_on"><option value="true" {don}>on</option><option value="false" {doff}>off (flat)</option></select></label>
<label>UTC clock at start (h, -1 = wall)<input id="day_start" type="number" step="0.5" min="-1" max="24" value="{dstart}" style="width:90px"></label>
<label>Television: hourly news ×<input id="d_news" type="number" step="0.5" min="1" value="{dnews}" style="width:70px"></label>
<label>Radio: prep ×<input id="d_radio" type="number" step="0.5" min="1" value="{dradio}" style="width:70px"></label>
<label>Television newscasts (local hour:peak, …)<input id="d_casts" value="{dcasts}" style="width:200px" placeholder="6:4, 12:4, 18:6"></label>
<label>Overnight ×<input id="d_night" type="number" step="0.1" min="0" max="1" value="{dnight}" style="width:70px"></label>
<label>Daily reset {bos:02}–{boe:02} UTC<select id="bo_on"><option value="true" {boon}>on</option><option value="false" {booff}>off</option></select></label>
<label>Calls inside each building / sim hour<input id="bldg" type="number" step="10" min="0" value="{bldg}" style="width:90px"></label>
<div style="flex-basis:100%"></div>
<label>Olympics, once a day<select id="oly_on"><option value="true" {olyon}>on</option><option value="false" {olyoff}>off</option></select></label>
<label>On air at (UTC h)<input id="oly_h" type="number" step="0.25" min="0" max="23.99" value="{olyh}" style="width:80px"></label>
<label>For (h)<input id="oly_len" type="number" step="0.25" min="0.25" max="12" value="{olylen}" style="width:70px"></label>
<label>Global surge ×<input id="oly_peak" type="number" step="0.5" min="1" value="{olypeak}" style="width:70px"></label>
<label>Venue (frame id)<input id="oly_venue" value="{olyvenue}" style="width:140px"></label>
<label>Venue trunks<input id="oly_trunks" type="number" min="1" max="{casters}" value="{olytrunks}" style="width:70px"></label>
<label>Callers / min<input id="oly_cpm" type="number" min="0" value="{olycpm}" style="width:90px"></label>
<label>Hold (s)<input id="oly_hold" type="number" min="1" value="{olyhold}" style="width:80px"></label>
<div style="flex-basis:100%"></div>
<table class="prods"><tr><th></th><th>Production</th><th>Studio (frame id, blank = a capital)</th><th>Trunks</th><th>Callers / min</th><th>Hold (s)</th><th>On air from (local h)</th><th>to</th><th></th></tr><tbody id="prows">{prows}</tbody></table>
<template id="prow-tmpl"><tr class="prow"><td><input class="pen" type="checkbox" checked></td><td><input class="pname" placeholder="Phone-in"></td><td><input class="pstudio" placeholder="london-01"></td><td><input class="ptrunks" type="number" min="1" max="{casters}" value="8"></td><td><input class="pcpm" type="number" min="0" value="2000"></td><td><input class="phold" type="number" min="1" value="90"></td><td><input class="pstart" type="number" min="-1" max="24" step="0.5" value="9"></td><td><input class="pend" type="number" min="-1" max="24" step="0.5" value="12"></td><td><button type="button" class="small secondary" onclick="this.closest('tr').remove()">✕</button></td></tr></template>
<button type="button" class="small secondary" onclick="const t=document.getElementById('prow-tmpl');const r=t.content.firstElementChild.cloneNode(true);document.getElementById('prows').appendChild(r);r.querySelector('.pname').focus()">+ production</button>
<button type="submit">Apply</button></form>
<p class="note">A production makes one studio available with that many trunks and aims that many callers a minute at it from everywhere else while it is on air (studio local time, from its longitude; -1 = all day). When every trunk made available (or every user port) at the studio is taken the caller hears busy: a denial that never reaches the router. The fader lives in <code>TRUNK-SIMULATOR/fader.json</code>, is re-read every tick (editing the file works too) and is always within sane bounds. Speed 0 freezes the simulated clock; real requests are always served. Every site follows its own local time, so the television and radio surges sweep around the globe; the Olympics happen once a day at one UTC moment, so every site surges together and callers from everywhere aim at the venue. Every building with two or more frames also makes its own intercom calls between them at a flat rate. Scrub the day in the footer of any page.</p></section>"#,
        speed = f.speed,
        rpm = f.requests_per_minute,
        hold = f.mean_hold_seconds,
        cc = f.crosscheck_every_seconds,
        smp = f.sample_every_seconds,
        seed = f.seed,
        rr = f.round_robin_seconds,
        lease = f.lease_seconds,
        ron = if f.running { "selected" } else { "" },
        roff = if f.running { "" } else { "selected" },
        don = if f.day.enabled { "selected" } else { "" },
        doff = if f.day.enabled { "" } else { "selected" },
        dstart = f.day.start_hour,
        dnews = f.day.hourly_news,
        dradio = f.day.radio_prep,
        dcasts = f.day.newscasts.iter().map(|n| format!("{}:{}", n.hour, n.peak)).collect::<Vec<_>>().join(", "),
        dnight = f.day.overnight,
        bos = f.day.blackout.start_hour as u32,
        boe = f.day.blackout.end_hour as u32,
        boon = if f.day.blackout.enabled { "selected" } else { "" },
        booff = if f.day.blackout.enabled { "" } else { "selected" },
        bldg = f.in_building_calls_per_hour,
        olyon = if f.day.olympics.enabled { "selected" } else { "" },
        olyoff = if f.day.olympics.enabled { "" } else { "selected" },
        olyh = f.day.olympics.hour,
        olylen = f.day.olympics.hours,
        olypeak = f.day.olympics.peak,
        olyvenue = esc(&f.day.olympics.venue),
        olytrunks = f.day.olympics.trunks,
        olycpm = f.day.olympics.calls_per_minute,
        olyhold = f.day.olympics.mean_hold_seconds,
        casters = rt.shape.casters_per_frame,
        prows = {
            let mut r = String::new();
            for p in &f.productions {
                let _ = write!(
                    r,
                    r#"<tr class="prow"><td><input class="pen" type="checkbox"{}></td><td><input class="pname" value="{}"></td><td><input class="pstudio" value="{}"></td><td><input class="ptrunks" type="number" min="1" max="{}" value="{}"></td><td><input class="pcpm" type="number" min="0" value="{}"></td><td><input class="phold" type="number" min="1" value="{}"></td><td><input class="pstart" type="number" min="-1" max="24" step="0.5" value="{}"></td><td><input class="pend" type="number" min="-1" max="24" step="0.5" value="{}"></td><td><button type="button" class="small secondary" onclick="this.closest('tr').remove()">✕</button></td></tr>"#,
                    if p.enabled { " checked" } else { "" },
                    esc(&p.name),
                    esc(&p.studio),
                    rt.shape.casters_per_frame,
                    p.trunks,
                    p.calls_per_minute,
                    p.mean_hold_seconds,
                    p.start_hour,
                    p.end_hour
                );
            }
            r
        },
    );

    // Every intercom simulator: its container, its protocol, the brands
    // (with their colours) and whether it is connected.
    {
        let remotes = rt.remote_list();
        b.push_str(r#"<section><h2>Intercom simulators</h2><p class="note">One container per protocol (<code>docker compose --profile sims up -d</code>); each hosts that protocol's frames and speaks Ward-Beck lines to the caster. The colour is the brand of the iron: 🟣 RTS, 🔴 Riedel, 🔵 Clear-Com, 🟡 Telos, 🟢 Intracom, 🟠 Ward-Beck, ⚪ relay.</p><div class="scroll"><table><tr><th>Container</th><th>Protocol</th><th>Family</th><th>Brands</th><th>Frames</th><th>Connected</th><th>Lines sent / acked</th><th>Check-ins</th><th>Last seen</th></tr>"#);
        for p in &rt.repertoire.protocols {
            let frames: Vec<&Frame> = rt.state.frames.iter().filter(|fr| fr.protocol == p.id).collect();
            let rem: Vec<&RemoteFrame> = remotes.iter().filter(|r| frames.iter().any(|fr| fr.id == r.frame)).collect();
            let up = rem.iter().filter(|r| r.connected).count();
            let host = rem.iter().find_map(|r| r.host.clone()).unwrap_or_else(|| format!("sim-{}", p.id));
            let peer = rem.first().map(|r| r.peer.clone()).unwrap_or_default();
            let mut brands: Vec<String> = Vec::new();
            for i in &p.implementations {
                let bd = vendor_badge(&i.vendor);
                let label = match &i.flavor {
                    Some(fl) => format!("{} ({})", i.vendor, fl),
                    None => i.vendor.clone(),
                };
                brands.push(format!(r#"<span style="white-space:nowrap"><i class="swatch" style="background:{}"></i>{} {}</span>"#, esc(&bd.color), bd.emoji, esc(&label)));
            }
            if brands.is_empty() {
                let bd = vendor_badge("");
                brands.push(format!(r#"<span><i class="swatch" style="background:{}"></i>{} unbranded</span>"#, bd.color, bd.emoji));
            }
            let sent: u64 = rem.iter().map(|r| r.lines_sent).sum();
            let acks: u64 = rem.iter().map(|r| r.acks).sum();
            let checkins: u64 = rem.iter().map(|r| r.checkins).sum();
            let last = rem.iter().map(|r| r.last_seen.as_str()).max().unwrap_or("");
            let _ = write!(
                b,
                r#"<tr><td><code>{}</code>{}</td><td><b>{}</b> <code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td class="{}">{}</td><td>{} / {}</td><td>{}</td><td class="muted">{}</td></tr>"#,
                esc(&host),
                if peer.is_empty() { String::new() } else { format!(r#" <span class="muted">{}</span>"#, esc(&peer)) },
                esc(&p.name),
                esc(&p.id),
                p.family.label(),
                brands.join(", "),
                frames.len(),
                if rem.is_empty() { "muted" } else if up == rem.len() { "ok" } else { "warn" },
                if rem.is_empty() { "not running".to_string() } else { format!("{up} / {} frames", rem.len()) },
                sent,
                acks,
                checkins,
                esc(last)
            );
        }
        let _ = write!(
            b,
            r#"<tr><td><code>trunk-caster</code></td><td><b>{}</b> <code>relay</code></td><td>Other</td><td><span><i class="swatch" style="background:{}"></i>{} {}</span></td><td>{}</td><td class="ok">in this process</td><td></td><td></td><td></td></tr></table></div></section>"#,
            esc(&rt.relay.protocol_name),
            vendor_badge("relay").color,
            vendor_badge("relay").emoji,
            esc(&rt.relay.host),
            rt.relay.matrices.len()
        );
    }

    let cc = &rt.last_crosscheck;
    let _ = write!(
        b,
        r#"<section><h2>Cross-check</h2><div class="tiles">{}{}{}{}{}</div>{}</section>"#,
        tile("checked last pass", cc.checked),
        tile("ok last pass", cc.ok),
        tile("ok total", rt.crosschecks_ok),
        tile("failed total", rt.crosschecks_failed),
        tile("last connection", last_connection_overall(rt, now)),
        if cc.failures.is_empty() {
            "<p class=\"ok\">Every live connection agrees with the trunks it rides on.</p>".to_string()
        } else {
            let mut s = String::from("<ul class=\"bad\">");
            for f in cc.failures.iter().take(20) {
                let _ = write!(s, "<li>{}</li>", esc(f));
            }
            s.push_str("</ul>");
            s
        }
    );

    let conns = sorted_connections(rt);
    let _ = write!(b, "<section><h2>Live now ({})</h2>", conns.len());
    b.push_str(&connections_table(rt, &conns[..conns.len().min(60)], now));
    b.push_str("</section>");

    // Graph: the recorded runs side by side.
    {
        let mut runs: Vec<&SimRun> = rt.recorder.index.iter().take(7).collect();
        runs.reverse();
        let cur = &rt.recorder.current;
        let mut labels: Vec<String> = runs.iter().map(|r| format!("{} {}", r.reason, r.started_at.get(11..16).unwrap_or(""))).collect();
        labels.push(format!("current {}", cur.reason));
        let lref: Vec<&str> = labels.iter().map(String::as_str).collect();
        let mut g: Vec<f64> = runs.iter().map(|r| r.summary.granted as f64).collect();
        g.push(cur.summary.granted as f64);
        let mut d: Vec<f64> = runs.iter().map(|r| r.summary.denied as f64).collect();
        d.push(cur.summary.denied as f64);
        let mut p: Vec<f64> = runs.iter().map(|r| r.summary.peak_live as f64).collect();
        p.push(cur.summary.peak_live as f64);
        let runs_chart = bar_chart("Runs: granted, denied and peak live (a run is one set of parameters)", &lref, &[("granted", "var(--ok)", g), ("denied", "var(--bad)", d), ("peak live", "var(--used)", p)]);
        let _ = write!(b, "<section><h2>Recorder</h2><p class=\"note\">Every fader change, clock scrub or reset end closes the run and starts a new one, so the metrics belong to the parameters that produced them. Files in <code>TRUNK-SIMULATOR/runs/</code>.</p>{runs_chart}</section>");
    }

    let samples = &rt.timeline.samples;
    let xs: Vec<f64> = samples.iter().map(|s| s.sim_time).collect();
    let chart1 = line_chart(
        "Connections and trunks",
        &xs,
        &[
            ("live connections", "var(--used)", samples.iter().map(|s| s.active as f64).collect()),
            ("via connections", "var(--via)", samples.iter().map(|s| s.active_via as f64).collect()),
            ("trunks up", "var(--ok)", samples.iter().map(|s| s.trunks as f64).collect()),
        ],
        None,
    );
    let chart2 = line_chart(
        "Utilisation (%) and news-cycle load (×10)",
        &xs,
        &[
            ("channel utilisation", "var(--used)", samples.iter().map(|s| s.channel_utilization * 100.0).collect()),
            ("caster utilisation", "var(--warn)", samples.iter().map(|s| s.caster_utilization * 100.0).collect()),
            ("load multiplier ×10", "var(--bad)", samples.iter().map(|s| s.load_multiplier * 10.0).collect()),
        ],
        Some(100.0),
    );
    let mut denied_rate = Vec::with_capacity(samples.len());
    let mut granted_rate = Vec::with_capacity(samples.len());
    for w in samples.windows(2) {
        let dt = (w[1].sim_time - w[0].sim_time).max(1e-9);
        // Counters restart at zero when state is reset; never underflow.
        denied_rate.push(w[1].denied_total.saturating_sub(w[0].denied_total) as f64 / dt * 60.0);
        granted_rate.push(w[1].granted_total.saturating_sub(w[0].granted_total) as f64 / dt * 60.0);
    }
    let xs2: Vec<f64> = xs.iter().skip(1).copied().collect();
    let chart3 = line_chart(
        "Grants and denials per simulated minute",
        &xs2,
        &[("granted / min", "var(--ok)", granted_rate), ("denied / min", "var(--bad)", denied_rate)],
        None,
    );
    // Productions: answered and busy per minute, and callers on the line
    // against the trunks made available.
    let mut prod_charts = String::new();
    {
        let names: Vec<&String> = f.productions.iter().map(|p| &p.name).collect();
        if !names.is_empty() {
            let palette = ["var(--ok)", "var(--used)", "var(--via)", "var(--warn)"];
            let mut rate_series: Vec<(String, &str, Vec<f64>)> = Vec::new();
            let mut live_series: Vec<(String, &str, Vec<f64>)> = Vec::new();
            for (i, name) in names.iter().enumerate() {
                let mut ans = Vec::with_capacity(samples.len());
                let mut busy = Vec::with_capacity(samples.len());
                for w in samples.windows(2) {
                    let dt = (w[1].sim_time - w[0].sim_time).max(1e-9);
                    let (a0, a1) = (w[0].productions.get(*name).cloned().unwrap_or_default(), w[1].productions.get(*name).cloned().unwrap_or_default());
                    ans.push(a1.answered.saturating_sub(a0.answered) as f64 / dt * 60.0);
                    busy.push(a1.busy.saturating_sub(a0.busy) as f64 / dt * 60.0);
                }
                rate_series.push((format!("{name}: answered / min"), palette[i % palette.len()], ans));
                rate_series.push((format!("{name}: busy / min"), "var(--bad)", busy));
                live_series.push((format!("{name}: on the line"), palette[i % palette.len()], samples.iter().map(|s| s.productions.get(*name).map(|p| p.live as f64).unwrap_or(0.0)).collect()));
                live_series.push((format!("{name}: trunks in use"), "var(--muted)", samples.iter().map(|s| s.productions.get(*name).map(|p| p.trunks_used as f64).unwrap_or(0.0)).collect()));
            }
            let rs: Vec<(&str, &str, Vec<f64>)> = rate_series.iter().map(|(n, c, v)| (n.as_str(), *c, v.clone())).collect();
            let ls: Vec<(&str, &str, Vec<f64>)> = live_series.iter().map(|(n, c, v)| (n.as_str(), *c, v.clone())).collect();
            prod_charts.push_str(&line_chart("Productions: answered and busy per simulated minute", &xs2, &rs, None));
            prod_charts.push_str(&line_chart("Productions: callers on the line and trunks in use", &xs, &ls, None));
        }
    }
    let _ = write!(
        b,
        r#"<section><h2>Usage over simulated time</h2><p class="note">{} samples, every {} sim s, in <code>timeline.json</code>. The report on the left is generated from the current run's samples.</p>{prod_charts}{chart1}{chart2}{chart3}</section>"#,
        samples.len(),
        f.sample_every_seconds
    );

    b.push_str("<section><h2>Latest samples</h2><div class=\"scroll\"><table><tr><th>Sim t</th><th>Clock</th><th>Live</th><th>Via</th><th>Trunks</th><th>Granted</th><th>Denied</th><th>Released</th><th>Chan %</th><th>Caster %</th><th>CC ok</th><th>CC fail</th></tr>");
    for s in samples.iter().rev().take(40) {
        let _ = write!(
            b,
            "<tr><td>{:.0}</td><td class=\"muted\">{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{:.0}</td><td>{:.0}</td><td>{}</td><td class=\"{}\">{}</td></tr>",
            s.sim_time, hms(s.time_of_day / 3600.0), s.active, s.active_via, s.trunks, s.granted_total, s.denied_total, s.released_total,
            s.channel_utilization * 100.0, s.caster_utilization * 100.0, s.crosschecks_ok,
            if s.crosschecks_failed > 0 { "bad" } else { "" }, s.crosschecks_failed
        );
    }
    b.push_str("</table></div></section></div></div>");

    page("Simulator", rt, live, 3000, &b)
}

/// The report's Markdown as HTML: headings, bullets, bold, code. Enough for
/// what `report::markdown` writes; everything is escaped first.
fn md_html(md: &str) -> String {
    fn inline(t: &str) -> String {
        let e = esc(t);
        let mut out = String::new();
        let mut bold = false;
        let mut code = false;
        let mut rest = e.as_str();
        while !rest.is_empty() {
            if let Some(r) = rest.strip_prefix("**") {
                out.push_str(if bold { "</b>" } else { "<b>" });
                bold = !bold;
                rest = r;
            } else if let Some(r) = rest.strip_prefix('`') {
                out.push_str(if code { "</code>" } else { "<code>" });
                code = !code;
                rest = r;
            } else {
                let mut it = rest.chars();
                let c = it.next().unwrap();
                out.push(c);
                rest = it.as_str();
            }
        }
        if bold {
            out.push_str("</b>");
        }
        if code {
            out.push_str("</code>");
        }
        out
    }
    let mut h = String::new();
    let mut in_list = false;
    for line in md.lines() {
        let l = line.trim_end();
        if let Some(t) = l.strip_prefix("- ") {
            if !in_list {
                h.push_str("<ul>");
                in_list = true;
            }
            let _ = write!(h, "<li>{}</li>", inline(t));
            continue;
        }
        if in_list {
            h.push_str("</ul>");
            in_list = false;
        }
        if let Some(t) = l.strip_prefix("### ") {
            let _ = write!(h, "<h4>{}</h4>", inline(t));
        } else if let Some(t) = l.strip_prefix("## ") {
            let _ = write!(h, "<h3>{}</h3>", inline(t));
        } else if let Some(_t) = l.strip_prefix("# ") {
            // The page already has the heading.
        } else if !l.is_empty() {
            let _ = write!(h, "<p>{}</p>", inline(l));
        }
    }
    if in_list {
        h.push_str("</ul>");
    }
    h
}

/// Inline SVG line chart. `series`: (label, css color, values aligned with xs).
fn line_chart(title: &str, xs: &[f64], series: &[(&str, &str, Vec<f64>)], y_max_fixed: Option<f64>) -> String {
    let (w, h, pl, pr, pt, pb) = (960.0, 240.0, 48.0, 16.0, 28.0, 28.0);
    let mut out = String::new();
    let _ = write!(out, r#"<svg viewBox="0 0 {w} {h}" width="100%" style="max-width:{w}px;display:block;margin:8px 0" role="img" aria-label="{}">"#, esc(title));
    let _ = write!(out, r#"<text x="{pl}" y="16" style="font-weight:600">{}</text>"#, esc(title));
    if xs.len() < 2 {
        let _ = write!(out, r#"<text x="{}" y="{}" text-anchor="middle">waiting for samples…</text></svg>"#, w / 2.0, h / 2.0);
        return out;
    }
    let x0 = xs[0];
    let x1 = xs[xs.len() - 1].max(x0 + 1e-9);
    let mut y1 = y_max_fixed.unwrap_or_else(|| series.iter().flat_map(|s| s.2.iter()).cloned().fold(0.0_f64, f64::max).max(1.0));
    if y_max_fixed.is_none() {
        y1 = nice_ceiling(y1);
    }
    let sx = |x: f64| pl + (x - x0) / (x1 - x0) * (w - pl - pr);
    let sy = |y: f64| h - pb - (y / y1).min(1.0) * (h - pt - pb);

    for i in 0..=4 {
        let yv = y1 * i as f64 / 4.0;
        let y = sy(yv);
        let _ = write!(out, r#"<line class="grid" x1="{pl}" x2="{}" y1="{y:.1}" y2="{y:.1}"/><text x="{}" y="{:.1}" text-anchor="end">{}</text>"#, w - pr, pl - 6.0, y + 4.0, fmt_num(yv));
    }
    for i in 0..=6 {
        let xv = x0 + (x1 - x0) * i as f64 / 6.0;
        let _ = write!(out, r#"<text x="{:.1}" y="{}" text-anchor="middle">{}s</text>"#, sx(xv), h - 8.0, fmt_num(xv));
    }
    for (label, color, values) in series {
        let mut d = String::new();
        for (i, (x, y)) in xs.iter().zip(values.iter()).enumerate() {
            let _ = write!(d, "{}{:.1},{:.1} ", if i == 0 { "M" } else { "L" }, sx(*x), sy(*y));
        }
        let _ = write!(out, r#"<path d="{d}" fill="none" stroke="{color}" stroke-width="1.8" stroke-linejoin="round"><title>{}</title></path>"#, esc(label));
    }
    let mut lx = pl;
    for (label, color, _) in series {
        let _ = write!(out, r#"<rect x="{lx}" y="{}" width="10" height="10" fill="{color}"/><text x="{}" y="{}">{}</text>"#, pt - 20.0, lx + 14.0, pt - 11.0, esc(label));
        lx += 14.0 + label.len() as f64 * 6.5 + 18.0;
    }
    out.push_str("</svg>");
    out
}

/// Grouped bars: one group per category, one bar per series.
fn bar_chart(title: &str, cats: &[&str], series: &[(&str, &str, Vec<f64>)]) -> String {
    let (w, h, pl, pr, pt, pb) = (960.0_f64, 260.0_f64, 48.0, 16.0, 28.0, 44.0);
    let mut out = String::new();
    let _ = write!(out, r#"<svg viewBox="0 0 {w} {h}" width="100%" style="max-width:{w}px;display:block;margin:8px 0" role="img" aria-label="{}">"#, esc(title));
    let _ = write!(out, r#"<text x="{pl}" y="16" style="font-weight:600">{}</text>"#, esc(title));
    if cats.is_empty() || series.is_empty() {
        let _ = write!(out, r#"<text x="{}" y="{}" text-anchor="middle">nothing yet</text></svg>"#, w / 2.0, h / 2.0);
        return out;
    }
    let ymax = nice_ceiling(series.iter().flat_map(|s| s.2.iter()).cloned().fold(0.0_f64, f64::max).max(1.0));
    let sy = |v: f64| h - pb - (v / ymax).min(1.0) * (h - pt - pb);
    for i in 0..=4 {
        let yv = ymax * i as f64 / 4.0;
        let y = sy(yv);
        let _ = write!(out, r#"<line class="grid" x1="{pl}" x2="{}" y1="{y:.1}" y2="{y:.1}"/><text x="{}" y="{:.1}" text-anchor="end">{}</text>"#, w - pr, pl - 6.0, y + 4.0, fmt_num(yv));
    }
    let gw = (w - pl - pr) / cats.len() as f64;
    let bw = (gw * 0.8) / series.len() as f64;
    for (ci, cat) in cats.iter().enumerate() {
        let gx = pl + gw * ci as f64 + gw * 0.1;
        for (si, (label, color, vals)) in series.iter().enumerate() {
            let v = vals.get(ci).copied().unwrap_or(0.0);
            let x = gx + bw * si as f64;
            let y = sy(v);
            let _ = write!(out, r#"<rect x="{x:.1}" y="{y:.1}" width="{:.1}" height="{:.1}" fill="{color}" rx="2"><title>{}: {} {}</title></rect>"#, (bw - 1.5).max(1.0), (h - pb - y).max(0.0), esc(cat), fmt_num(v), esc(label));
        }
        let _ = write!(out, r#"<text x="{:.1}" y="{}" text-anchor="middle">{}</text>"#, gx + gw * 0.4, h - 26.0, esc(cat));
    }
    let mut lx = pl;
    for (label, color, _) in series {
        let _ = write!(out, r#"<rect x="{lx}" y="{}" width="10" height="10" fill="{color}"/><text x="{}" y="{}">{}</text>"#, h - 14.0, lx + 14.0, h - 5.0, esc(label));
        lx += 14.0 + label.len() as f64 * 6.5 + 18.0;
    }
    out.push_str("</svg>");
    out
}

/// A symmetric heat matrix over the same labels on both axes.
fn heat_matrix(title: &str, labels: &[&str], value: &dyn Fn(&str, &str) -> f64) -> String {
    let n = labels.len().max(1);
    let (cell, left, top) = (54.0_f64, 120.0_f64, 110.0_f64);
    let (w, h) = (left + cell * n as f64 + 12.0, top + cell * n as f64 + 12.0);
    let mut out = String::new();
    let _ = write!(out, r#"<svg viewBox="0 0 {w:.0} {h:.0}" width="100%" style="max-width:{w:.0}px;display:block;margin:8px 0" role="img" aria-label="{}">"#, esc(title));
    let _ = write!(out, r#"<text x="8" y="16" style="font-weight:600">{}</text>"#, esc(title));
    let max = labels.iter().flat_map(|a| labels.iter().map(move |b| value(a, b))).fold(0.0_f64, f64::max).max(1.0);
    for (i, a) in labels.iter().enumerate() {
        let _ = write!(out, r#"<text x="{:.0}" y="{:.0}" text-anchor="end">{}</text>"#, left - 6.0, top + cell * i as f64 + cell / 2.0 + 4.0, esc(a));
        let _ = write!(out, r#"<text x="{:.0}" y="{:.0}" text-anchor="end" transform="rotate(-55 {:.0} {:.0})">{}</text>"#, left + cell * i as f64 + cell / 2.0, top - 8.0, left + cell * i as f64 + cell / 2.0, top - 8.0, esc(a));
        for (j, b) in labels.iter().enumerate() {
            let v = value(a, b);
            let alpha = if v <= 0.0 { 0.06 } else { 0.15 + 0.85 * (v / max) };
            let ocean = trunk_caster_sdk::ocean_between(a, b).unwrap_or("home");
            let _ = write!(
                out,
                r#"<rect x="{:.0}" y="{:.0}" width="{:.0}" height="{:.0}" rx="4" fill="var(--used)" fill-opacity="{alpha:.2}"><title>{} ↔ {}: {} calls · {}</title></rect><text x="{:.0}" y="{:.0}" text-anchor="middle" style="fill:var(--ink);font-weight:600">{}</text>"#,
                left + cell * j as f64 + 2.0, top + cell * i as f64 + 2.0, cell - 4.0, cell - 4.0, esc(a), esc(b), fmt_num(v), esc(ocean),
                left + cell * j as f64 + cell / 2.0, top + cell * i as f64 + cell / 2.0 + 4.0, if v > 0.0 { fmt_num(v) } else { String::new() }
            );
        }
    }
    out.push_str("</svg>");
    out
}

fn nice_ceiling(v: f64) -> f64 {
    if v <= 0.0 {
        return 1.0;
    }
    let mag = 10f64.powf(v.log10().floor());
    let n = v / mag;
    let step = if n <= 1.0 { 1.0 } else if n <= 2.0 { 2.0 } else if n <= 5.0 { 5.0 } else { 10.0 };
    step * mag
}

fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 || v >= 100.0 {
        format!("{:.0}", v)
    } else {
        format!("{:.1}", v)
    }
}

// ---------------------------------------------------------------------------
// Topics: one ranked list per header tab, for the band of graphs under the
// header (top and bottom of the last four tabs opened).
// ---------------------------------------------------------------------------

/// The header tabs in resistor-code order, each with its colour and the
/// ink that reads on it.
const TOPIC_COLOURS: &[(&str, &str)] = &[
    ("#7b4a26", "#fff"), // brown
    ("#d32f2f", "#fff"), // red
    ("#f57c00", "#fff"), // orange
    ("#fbc02d", "#1b1f24"), // yellow
    ("#388e3c", "#fff"), // green
    ("#1976d2", "#fff"), // blue
    ("#7b1fa2", "#fff"), // violet
    ("#757575", "#fff"), // grey
    ("#f5f5f5", "#1b1f24"), // white
    ("#212121", "#fff"), // black
    ("#c9a227", "#1b1f24"), // gold
    ("#b0b6bc", "#1b1f24"), // silver
];

fn topic_colour(i: usize) -> (&'static str, &'static str) {
    TOPIC_COLOURS[i % TOPIC_COLOURS.len()]
}

/// Every tab's ranked list: `{ path: { label, metric, colour, items: [[name, value], ...] } }`.
pub fn topics(rt: &Runtime) -> serde_json::Value {
    let st = &rt.state;
    let utc = rt.time_of_day();
    let add = |m: &mut BTreeMap<String, f64>, k: &str, v: f64| *m.entry(k.to_string()).or_default() += v;
    let site_of = |id: &str| st.frame(id).map(|f| if f.site.is_empty() { rt.site.clone() } else { f.site.clone() }).unwrap_or_else(|| id.to_string());
    let cont_of = |id: &str| st.frame(id).and_then(|f| f.continent.clone()).unwrap_or_else(|| "Other".into());
    let country_of = |id: &str| st.frame(id).and_then(|f| f.country.clone()).unwrap_or_else(|| rt.site.clone());

    let mut per_site = BTreeMap::new();
    let mut per_country = BTreeMap::new();
    let mut crossing = BTreeMap::new();
    let mut per_who = BTreeMap::new();
    for c in &st.connections {
        for f in [&c.from_frame, &c.to_frame] {
            add(&mut per_site, &site_of(f), 1.0);
            add(&mut per_country, &country_of(f), 1.0);
        }
        let (a, b) = (cont_of(&c.from_frame), cont_of(&c.to_frame));
        if a != b {
            let (x, y) = if a < b { (a, b) } else { (b, a) };
            add(&mut crossing, &format!("{x} ↔ {y}"), 1.0);
        }
        add(&mut per_who, &c.who, 1.0);
    }
    let mut panels = BTreeMap::new();
    let mut trunks = BTreeMap::new();
    let mut ports_site = BTreeMap::new();
    let mut load = BTreeMap::new();
    let mut protocols = BTreeMap::new();
    let mut site_pos: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for f in &st.frames {
        if let (Some(lat), Some(lon)) = (f.lat, f.lon) {
            site_pos.entry(site_of(&f.id)).or_insert((lat, lon));
        }
        let live = st.live_ports_of(&f.id).len() as f64;
        add(&mut panels, &f.id, live);
        add(&mut ports_site, &site_of(&f.id), live);
        add(&mut trunks, &f.id, f.casters.saturating_sub(st.free_casters(&f.id)) as f64);
        add(&mut protocols, &f.protocol_name, 1.0);
        if let Some(lon) = f.lon {
            load.insert(site_of(&f.id), rt.fader.day.multiplier_at(utc, lon));
        }
    }
    let mut xp = BTreeMap::new();
    let mut relay = BTreeMap::new();
    for c in &rt.crosspoints.current {
        add(&mut xp, &c.frame, 1.0);
        if st.frame(&c.frame).is_some_and(|f| f.protocol == crate::relay::PROTOCOL) {
            add(&mut relay, &c.frame, 1.0);
        }
    }
    let mut gpio = BTreeMap::new();
    for e in &rt.recent_gpio {
        add(&mut gpio, &e.who, 1.0);
    }

    // The Continents band is a heat aurora: every placed site, glowing with
    // the calls it carries.
    let heat: Vec<serde_json::Value> = site_pos
        .iter()
        .map(|(s, (lat, lon))| serde_json::json!([lat, lon, per_site.get(s).copied().unwrap_or(0.0), s]))
        .collect();
    let by_path: BTreeMap<&str, (&str, BTreeMap<String, f64>)> = BTreeMap::from([
        ("/", ("live calls per site", per_site)),
        ("/continents", ("live calls per country", per_country)),
        ("/overlord", ("calls between continents", crossing)),
        ("/panels", ("panels live per frame", panels)),
        ("/usage", ("trunks in use per frame", trunks)),
        ("/racks", ("live ports per site", ports_site)),
        ("/relay", ("closed crosspoints per relay matrix", relay)),
        ("/users", ("live calls per user", per_who)),
        ("/crosspoints", ("closed crosspoints per frame", xp)),
        ("/simulator", ("news-cycle load per site (×)", load)),
        ("/analyzer", ("GPIO commands per user", gpio)),
        ("/home", ("frames per protocol", protocols)),
    ]);
    let mut out = serde_json::Map::new();
    for (i, (path, label)) in NAV.iter().enumerate() {
        let Some((metric, m)) = by_path.get(path) else { continue };
        let mut items: Vec<(&String, &f64)> = m.iter().collect();
        items.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(b.0)));
        let (bg, ink) = topic_colour(i);
        out.insert(
            path.to_string(),
            serde_json::json!({ "label": label, "metric": metric, "colour": bg, "ink": ink, "items": items }),
        );
    }
    if let Some(t) = out.get_mut("/continents") {
        t["heat"] = serde_json::Value::Array(heat);
    }
    serde_json::Value::Object(out)
}
