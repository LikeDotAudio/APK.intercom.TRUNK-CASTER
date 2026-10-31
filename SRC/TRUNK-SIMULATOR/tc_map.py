"""
tc_map.py  --  live map server for a Trunk-Caster estate.

Standard library only.  A brand simulator (or launch_all.py) hands this module
a callback that returns the current estate state, and optionally an action
callback for the button API.  It serves:

    /            the map page: flat (Leaflet) or spinning globe (globe.gl), user's choice;
                 black and white basemap, only coverage areas coloured; sunlight terminator;
                 intercoms grouped by continent with the 8x8 state frames under their capital;
                 multi-select; call direction as animated arrows; footer with traffic scenarios;
                 users / users-calling counter bottom right
    /geojson     FeatureCollection: one Point per intercom, one LineString per trunk call
    /state       the raw state JSON the callback returned
    /api/...     the button / scenario API (see API_HELP)

Device fields the page understands (all optional except name/type/lat/lon):
    name, type, subtype, vendor, stand_in, city, country, continent, iso2, site_kind (capital|state|trunkmaster),
    parent (alpha of the capital an 8x8 hangs off), lat, lon, coverage_m | coverage[[lat,lon]..], color,
    online, ports, users, users_calling, calls[{from,to,remote,since}], endpoints[], snmp_port, console_port,
    series, sockets, emulator_map_port, local_hour
links: [{from_device, from_port, to_device, to_port, since}]
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

API_HELP = {
    "/api/ports":    "?matrix=LOND                                  list the ports of a matrix",
    "/api/port":     "?matrix=LOND&port=1                           state of one port (talking_to, incoming, ...)",
    "/api/key":      "?matrix=LOND&port=1&kind=talk|listen&target=25&state=1|0   press / release a key",
    "/api/call":     "?matrix=LOND&port=3&icom=PARI&remote=5        trunk call to another intercom",
    "/api/hangup":   "?matrix=LOND&port=3                           release that port's trunk call",
    "/api/claim":    "?matrix=LOND&port=0&name=StreamDeck           reserve a port for a button panel (0 = next free panel)",
    "/api/release":  "?matrix=LOND&port=7                           give it back",
    "/api/scenario": "?name=olympics&level=0.4&host=PARI            traffic scenario: quiet, normal, olympics, sports, evening, breaking",
    "/api/matrices": "                                              every matrix the API can reach",
}


def to_geojson(state):
    features = []
    pos = {}
    for d in state.get("devices", []):
        if d.get("lat") is None or d.get("lon") is None:
            continue
        pos[d["name"]] = (d["lon"], d["lat"])
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [d["lon"], d["lat"]]},
            "properties": {k: v for k, v in d.items() if k not in ("lat", "lon")},
        })
    for ln in state.get("links", []):
        a, b = pos.get(ln["from_device"]), pos.get(ln["to_device"])
        if not a or not b:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [list(a), list(b)]},
            "properties": dict(ln, kind="call"),
        })
    return {"type": "FeatureCollection",
            "properties": {"time": state.get("time"), "tz": state.get("tz"), "totals": state.get("totals", {}),
                           "scenario": state.get("scenario")},
            "features": features}


HTML = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>Trunk-Caster map</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/globe.gl"></script>
<style>
 html,body{height:100%;margin:0;background:#000;font:13px/1.35 system-ui,Segoe UI,sans-serif;color:#eee;overflow:hidden}
 #wrap{display:flex;height:100%}
 #list{width:340px;flex:none;background:#000;border-right:1px solid #333;display:flex;flex-direction:column;min-height:0}
 #rows{overflow:auto;flex:1}
 #main{flex:1;position:relative;display:flex;flex-direction:column;min-width:0}
 #view{flex:1;position:relative;min-height:0}
 #map,#globe{position:absolute;inset:0}
 #globe{display:none;background:#000}
 .leaflet-tile{filter:grayscale(1) contrast(1.15)}
 .leaflet-container{background:#000}
 .tc-label{background:#000;color:#fff;border:1px solid #fff;border-radius:3px;font:11px system-ui,Segoe UI,sans-serif;padding:1px 5px;white-space:nowrap}
 .tc-label img{height:9px;vertical-align:-1px;margin-right:3px}
 .tc-label::before{border-top-color:#fff}
 .tc-label.small{font-size:9px;padding:0 3px;opacity:.85}
 .tc-label.dim{opacity:.25}
 .hdr{padding:10px 14px;border-bottom:1px solid #333}
 .hdr b{font-size:15px}.hdr small{color:#999;display:block;margin-top:2px}
 .filter{width:100%;box-sizing:border-box;margin-top:8px;background:#111;color:#fff;border:1px solid #444;padding:5px 8px;border-radius:4px}
 .grp{display:flex;align-items:center;gap:8px;padding:7px 14px;background:#0d0d0d;border-bottom:1px solid #222;cursor:pointer;position:sticky;top:0;z-index:2}
 .grp b{flex:1}.grp small{color:#999}.grp .tw{color:#666;width:12px}
 .grp button{background:#222;color:#ccc;border:1px solid #444;border-radius:3px;font-size:10px;padding:1px 6px;cursor:pointer}
 .row{display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid #1a1a1a;cursor:pointer}
 .row.sub{padding-left:34px;background:#050505}
 .row:hover{background:#151515}.row.sel{background:#1e2a1e;box-shadow:inset 3px 0 0 #6f6}
 .row .sw{width:12px;height:12px;border-radius:50%;border:2px solid #fff;flex:none}
 .row img.fl{height:11px;border:1px solid #333}
 .row .nm{font-weight:700;color:#fff}.row .ty{color:#999;font-size:11px}
 .row.sub .nm{font-weight:500;font-size:12px}
 .row .st{margin-left:auto;text-align:right;font-size:11px;color:#bbb;white-space:nowrap}
 .row .st b{color:#ff5a3c;font-size:13px}
 .row.busy .nm::after{content:" ●";color:#ff5a3c}
 .row.off .nm{color:#777;text-decoration:line-through}
 .row .tw{color:#666;width:10px;font-size:10px}
 .toolbar{position:absolute;left:12px;top:12px;z-index:1000;display:flex;gap:6px}
 .toolbar button,.foot button{background:#000;color:#fff;border:1px solid #666;border-radius:6px;padding:5px 10px;cursor:pointer;font:12px system-ui,Segoe UI,sans-serif}
 .toolbar button.on,.foot button.on{background:#fff;color:#000;border-color:#fff}
 .tc-counter{position:absolute;right:12px;bottom:12px;z-index:1000;background:#000;color:#fff;border:1px solid #fff;padding:10px 14px;border-radius:10px;min-width:220px}
 .tc-counter .big{font-size:32px;font-weight:700;letter-spacing:-1px;line-height:1.05}
 .tc-counter .big.hot{color:#ff5a3c}
 .tc-counter .r{display:flex;justify-content:space-between;gap:16px;margin-top:4px}
 .tc-counter small{color:#999}
 .tc-counter .selbox{border-top:1px solid #444;margin-top:8px;padding-top:6px;font-size:11px;color:#ccc;max-height:140px;overflow:auto}
 .tc-counter .selbox b{color:#6f6}
 .foot{flex:none;background:#000;border-top:1px solid #333;padding:8px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .foot .lbl{color:#999;font-size:11px;margin-right:4px}
 .foot input[type=range]{width:120px}
 .foot .status{margin-left:auto;color:#f0b429;font-size:12px;white-space:nowrap}
 .leaflet-popup-content-wrapper,.leaflet-popup-tip{background:#000;color:#fff;border:1px solid #fff}
 .leaflet-popup-content{font:13px/1.35 system-ui,Segoe UI,sans-serif;max-height:260px;overflow:auto}
 .leaflet-popup-content table{border-collapse:collapse}.leaflet-popup-content td{padding:1px 6px 1px 0}
 .leaflet-popup-content img.fl{height:12px;vertical-align:-1px;margin-right:4px}
 .pulse{animation:pulse 1s infinite alternate}@keyframes pulse{from{opacity:.55}to{opacity:1}}
 .flow{animation:dash 1.2s linear infinite}@keyframes dash{to{stroke-dashoffset:-24}}
 .arrow{color:#ff5a3c;font-size:18px;line-height:18px;text-shadow:0 0 3px #000;pointer-events:none}
 .ghtml{color:#fff;font:10px system-ui,Segoe UI,sans-serif;white-space:nowrap;text-shadow:0 0 3px #000;pointer-events:none}
 .ghtml img{height:9px;vertical-align:-1px;margin-right:3px}
 .legend{padding:8px 14px;color:#888;font-size:11px;border-top:1px solid #333}
</style></head><body>
<div id="wrap">
 <div id="list">
  <div class="hdr"><b>Trunk-Caster</b> &nbsp;<span id="count"></span><small id="tz"></small><small id="time"></small>
   <input class="filter" id="filter" placeholder="filter intercoms, cities, countries…"></div>
  <div id="rows"></div>
  <div class="legend">Click rows to select several intercoms. Red = calls; arrows and moving dashes show the direction, caller to called. Grey = offline.</div>
 </div>
 <div id="main">
  <div id="view">
   <div id="map"></div><div id="globe"></div>
   <div class="toolbar">
    <button id="btnFlat">Flat</button><button id="btnGlobe">Globe</button>
    <button id="btnSpin" title="spin the globe">Spin</button>
    <button id="btnSun" title="day and night">Sunlight</button>
    <button id="btnClear" title="clear selection">Clear selection</button>
   </div>
   <div class="tc-counter">
    <div><small>USERS</small><div class="big" id="users">–</div></div>
    <div><small>USERS MAKING CALLS</small><div class="big hot" id="calling">–</div></div>
    <div class="r"><span><small>ports</small> <b id="ports">–</b></span><span><small>active calls</small> <b id="calls">–</b></span><span><small>intercoms</small> <b id="ndev">–</b></span></div>
    <div class="selbox" id="selbox" style="display:none"></div>
   </div>
  </div>
  <div class="foot">
   <span class="lbl">CALL SIMULATORS</span>
   <button data-sc="quiet">Quiet</button>
   <button data-sc="normal">Normal</button>
   <button data-sc="olympics" title="host = first selected capital, or random">Olympics</button>
   <button data-sc="sports">Sporting events</button>
   <button data-sc="evening">Evening events</button>
   <button data-sc="breaking">Breaking news</button>
   <span class="lbl">level</span><input type="range" id="level" min="0" max="1" step="0.05" value="0.3">
   <span id="levelv" class="lbl">0.30</span>
   <span class="status" id="scstatus"></span>
  </div>
 </div>
</div>
<script>
// ---------------------------------------------------------------- state
let lastGj=null, selected=new Set(), collapsed=new Set(), capOpen=new Set(), view=localStorage.getItem('tc-view')||'flat';
let sun=(localStorage.getItem('tc-sun')||'on')==='on', spin=(localStorage.getItem('tc-spin')||'on')==='on';
const defaultCov={matrix:400,rvon:120,tm2000:200};
const flag=p=>p.iso2?`<img class="fl" src="https://flagcdn.com/w20/${p.iso2}.png" alt="">`:'';
const busyOf=p=>(p.users_calling||0)>0||(p.calls||[]).length>0;
const devColor=p=>p.color||'#4cc9f0';
const devs=()=>lastGj?lastGj.features.filter(f=>f.geometry.type==='Point').map(f=>f.properties):[];
const links=()=>lastGj?lastGj.features.filter(f=>f.geometry.type==='LineString'):[];
const byName=()=>{const m={};for(const p of devs())m[p.name]=p;return m;};
const selActive=()=>selected.size>0;
const isSel=p=>selected.has(p.name);
const touchesSel=l=>selected.has(l.properties.from_device)||selected.has(l.properties.to_device);

// ---------------------------------------------------------------- sunlight (terminator)
function sunPosition(date){
  const rad=Math.PI/180, jd=date.getTime()/86400000+2440587.5, n=jd-2451545.0;
  const L=((280.460+0.9856474*n)%360+360)%360, g=((357.528+0.9856003*n)%360+360)%360;
  const lam=L+1.915*Math.sin(g*rad)+0.020*Math.sin(2*g*rad), eps=23.439-0.0000004*n;
  const dec=Math.asin(Math.sin(eps*rad)*Math.sin(lam*rad))/rad;
  let ra=Math.atan2(Math.cos(eps*rad)*Math.sin(lam*rad),Math.cos(lam*rad))/rad; if(ra<0) ra+=360;
  const gmst=((18.697374558+24.06570982441908*n)%24+24)%24;
  let lon=ra-gmst*15; lon=((lon+540)%360)-180;
  return {dec, lon};
}
function nightPolygon(){      // [ [lat,lon], ... ] of the dark half, closed over the night pole
  const s=sunPosition(new Date()), rad=Math.PI/180, pts=[];
  for(let lon=-180;lon<=180;lon+=3){
    const ha=(lon-s.lon)*rad;
    let lat=Math.atan(-Math.cos(ha)/Math.tan(s.dec*rad))/rad;
    if(Math.abs(s.dec)<0.01) lat=0;
    pts.push([lat,lon]);
  }
  const pole=s.dec>0?-89.9:89.9;
  pts.push([pole,180]); pts.push([pole,-180]);
  return {pts, sun:s};
}

// ---------------------------------------------------------------- flat map
const map=L.map('map',{zoomControl:true,worldCopyJump:true,minZoom:1});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
let cover=L.layerGroup().addTo(map), night=L.layerGroup().addTo(map), lines=L.layerGroup().addTo(map), pts=L.layerGroup().addTo(map), fitted=false;
const markers={};
function fitMinZoom(){           // never show more than 3/2 of a world's width
  const w=document.getElementById('map').clientWidth; if(!w) return;
  const z=Math.ceil(Math.log2(w/(1.5*256)));
  map.setMinZoom(Math.max(1,z));
  if(map.getZoom()<map.getMinZoom()) map.setZoom(map.getMinZoom());
}
window.addEventListener('resize',fitMinZoom);
function popup(p){
  const n=byName(), L_=links();
  let h=`<b>${flag(p)}${p.city?p.city:p.name}</b> <small>${p.name}${p.country?' · '+p.country:''}${p.continent?' · '+p.continent:''}</small><br>`;
  h+=`<small>${p.vendor||p.type}${p.stand_in?' (stand-in '+p.stand_in+')':''}${p.site_kind==='state'?' · 8x8 state frame under '+(n[p.parent]?.city||p.parent):''}`;
  h+=` · ${p.online===false?'<span style="color:#f55">OFFLINE</span>':'online'}`;
  if(p.ports!=null) h+=` · ${p.ports} ports · ${p.users||0} users · <b>${p.users_calling||0} calling</b>`;
  if(p.local_hour!=null) h+=` · local ${String(Math.floor(p.local_hour)).padStart(2,'0')}:${String(Math.round((p.local_hour%1)*60)).padStart(2,'0')}`;
  h+=`</small><br><small style="color:#9ad">`;
  if(p.snmp_port) h+=`snmp udp/${p.snmp_port} · `; if(p.console_port) h+=`console tcp/${p.console_port} · `;
  if(p.series) h+=`series udp/${p.series} (+1..+${p.ports||255}, one socket per port) · `; if(p.emulator_map_port) h+=`api :${p.emulator_map_port}`;
  h+=`</small>`;
  if(p.endpoints&&p.endpoints.length) h+=`<br><small>live endpoints: ${p.endpoints.map(e=>e.name+' on '+e.alpha).join(', ')}</small>`;
  const out=(p.calls||[]), inc=L_.filter(l=>l.properties.to_device===p.name).map(l=>l.properties);
  if(out.length||inc.length){
    h+='<table style="margin-top:6px">';
    for(const c of out){const s=Math.max(0,Math.round(Date.now()/1000-c.since));
      h+=`<tr><td style="color:#ff5a3c">OUT →</td><td>${c.from}</td><td>→</td><td>${c.remote?(n[c.remote]?.city||c.remote)+' : ':''}${c.to}</td><td><small>${s}s</small></td></tr>`;}
    for(const c of inc){const s=Math.max(0,Math.round(Date.now()/1000-c.since));
      h+=`<tr><td style="color:#f0b429">IN ←</td><td>${c.to_port}</td><td>←</td><td>${n[c.from_device]?.city||c.from_device} : ${c.from_port}</td><td><small>${s}s</small></td></tr>`;}
    h+='</table>';
  } else h+='<br><small>no calls</small>';
  return h;
}
function drawFlat(){
  cover.clearLayers(); lines.clearLayers(); pts.clearLayers(); for(const k in markers) delete markers[k];
  const n=byName(), act=selActive();
  for(const p of devs()){
    const ll=[p.lat??0,p.lon??0]; if(p.lat==null) continue;
    const busy=busyOf(p), col=devColor(p), dim=act&&!isSel(p);
    const cov=p.coverage?L.polygon(p.coverage):L.circle(ll,{radius:p.coverage_m||defaultCov[p.type]||60});
    cov.setStyle({color:busy?'#ff5a3c':col,weight:busy?3:1.5,fillColor:p.online===false?'#666':col,fillOpacity:dim?.06:(p.online===false?.15:(busy?.6:.35)),opacity:dim?.2:1,className:busy&&!dim?'pulse':''});
    cov.bindPopup(()=>popup(p)); cov.addTo(cover);
    const small=p.site_kind==='state';
    const m=L.circleMarker(ll,{radius:busy?(small?5:7):(small?3:5),color:busy?'#ff5a3c':'#000',weight:2,fillColor:busy?'#ff5a3c':'#fff',fillOpacity:dim?.3:1});
    m.bindTooltip(`${flag(p)}${p.city?p.city.split(',')[0]:p.name}${busy?' · '+((p.calls||[]).length)+' call(s)':''}`,{permanent:!small||busy||isSel(p),direction:'top',offset:[0,-7],className:'tc-label'+(small?' small':'')+(dim?' dim':'')});
    m.bindPopup(()=>popup(p)); m.on('click',()=>toggleSel(p.name,true)); m.addTo(pts); markers[p.name]=m;
  }
  for(const f of links()){
    const l=f.properties, a=n[l.from_device], b=n[l.to_device]; if(!a||!b) continue;
    const dim=act&&!touchesSel(f);
    const line=L.polyline([[a.lat,a.lon],[b.lat,b.lon]],{color:'#ff5a3c',weight:dim?1:2.5,opacity:dim?.15:.9,dashArray:'8 8',className:dim?'':'flow'});
    line.bindTooltip(`${a.city||a.name} : ${l.from_port} → ${b.city||b.name} : ${l.to_port}`,{sticky:true,className:'tc-label'});
    line.addTo(lines);
    if(!dim){ const pa=map.latLngToLayerPoint([a.lat,a.lon]), pb=map.latLngToLayerPoint([b.lat,b.lon]);
      const ang=Math.atan2(pb.y-pa.y,pb.x-pa.x)*180/Math.PI;
      const mid=map.layerPointToLatLng(L.point(pa.x+(pb.x-pa.x)*0.72,pa.y+(pb.y-pa.y)*0.72));
      L.marker(mid,{icon:L.divIcon({className:'',html:`<div class="arrow" style="transform:rotate(${ang}deg)">➤</div>`,iconSize:[18,18],iconAnchor:[9,9]}),interactive:false}).addTo(lines); }
  }
  drawNightFlat();
}
function drawNightFlat(){
  night.clearLayers(); if(!sun) return;
  const {pts:np}=nightPolygon();
  for(const off of [-360,0,360]) L.polygon(np.map(([la,lo])=>[la,lo+off]),{stroke:false,fillColor:'#000',fillOpacity:.45,interactive:false}).addTo(night);
}
map.on('zoomend moveend',()=>{ if(view==='flat'&&lastGj) drawFlat(); });

// ---------------------------------------------------------------- globe
let globe=null;
function ensureGlobe(){
  if(globe||typeof Globe==='undefined') return;
  const el=document.getElementById('globe');
  globe=Globe()(el).globeImageUrl('https://unpkg.com/three-globe/example/img/earth-dark.jpg')
    .backgroundColor('#000').showAtmosphere(true).atmosphereColor('#ffffff').atmosphereAltitude(0.12)
    .pointsData([]).pointLat('lat').pointLng('lon').pointColor(d=>d._col).pointAltitude(d=>d._alt).pointRadius(d=>d._rad).pointsMerge(false)
    .ringsData([]).ringLat('lat').ringLng('lon').ringColor(()=>t=>`rgba(255,90,60,${1-t})`).ringMaxRadius(3).ringPropagationSpeed(2).ringRepeatPeriod(700)
    .arcsData([]).arcStartLat(d=>d.a.lat).arcStartLng(d=>d.a.lon).arcEndLat(d=>d.b.lat).arcEndLng(d=>d.b.lon)
    .arcColor(d=>d._dim?['rgba(255,90,60,.15)','rgba(255,90,60,.15)']:['rgba(255,200,120,.95)','rgba(255,60,30,.95)'])
    .arcDashLength(0.35).arcDashGap(0.25).arcDashAnimateTime(1800).arcStroke(d=>d._dim?0.3:0.8).arcAltitudeAutoScale(0.35)
    .arcLabel(d=>`${d.a.city||d.a.name} : ${d.l.from_port} → ${d.b.city||d.b.name} : ${d.l.to_port}`)
    .polygonsData([]).polygonCapColor(()=>'rgba(0,0,0,0.55)').polygonSideColor(()=>'rgba(0,0,0,0)').polygonStrokeColor(()=>'rgba(255,255,255,0.25)').polygonAltitude(0.004)
    .htmlElementsData([]).htmlLat('lat').htmlLng('lon').htmlAltitude(0.01).htmlElement(d=>{const e=document.createElement('div');e.className='ghtml';e.innerHTML=`${flag(d)}${d.city?d.city.split(',')[0]:d.name}`;e.style.opacity=d._dim?.25:1;return e;})
    .onPointClick(d=>toggleSel(d.name,true));
  globe.controls().autoRotateSpeed=0.5;
  globe.pointOfView({lat:25,lng:-20,altitude:2.2});
  new ResizeObserver(()=>{ if(view==='globe'){globe.width(el.clientWidth); globe.height(el.clientHeight);} }).observe(el);
}
function drawGlobe(){
  ensureGlobe(); if(!globe) return;
  const n=byName(), act=selActive();
  const pd=devs().filter(p=>p.lat!=null).map(p=>{const busy=busyOf(p), dim=act&&!isSel(p), small=p.site_kind==='state';
    return Object.assign({},p,{_col:dim?'rgba(120,120,120,.35)':(busy?'#ff5a3c':devColor(p)),_alt:busy?0.06+0.01*(p.calls||[]).length:(small?0.006:0.015),_rad:small?0.18:(busy?0.5:0.35)});});
  globe.pointsData(pd);
  globe.ringsData(pd.filter(p=>busyOf(p)&&!(act&&!isSel(p))));
  globe.arcsData(links().map(f=>{const l=f.properties;return {a:n[l.from_device],b:n[l.to_device],l,_dim:act&&!touchesSel(f)};}).filter(x=>x.a&&x.b));
  globe.htmlElementsData(pd.filter(p=>p.site_kind!=='state'||isSel(p)||busyOf(p)).map(p=>Object.assign({},p,{_dim:act&&!isSel(p)})));
  const {pts:np}=nightPolygon();
  globe.polygonsData(sun?[{geometry:{type:'Polygon',coordinates:[np.map(([la,lo])=>[lo,la]).concat([[np[0][1],np[0][0]]])]}}]:[]);
  globe.controls().autoRotate=spin;
}

// ---------------------------------------------------------------- list (continents > capitals > state 8x8s)
function renderList(){
  const rows=document.getElementById('rows'); rows.innerHTML='';
  const q=(document.getElementById('filter').value||'').toLowerCase();
  const all=devs().filter(p=>!q||(p.name+' '+(p.city||'')+' '+(p.country||'')+' '+(p.continent||'')+' '+(p.vendor||'')).toLowerCase().includes(q));
  document.getElementById('count').textContent=all.length+' intercoms';
  const groups={};
  for(const p of all){ const g=p.continent||'Other'; (groups[g]=groups[g]||[]).push(p); }
  const order=['North America','South America','Europe','Africa','Middle East','Asia','Oceania','Other'];
  for(const g of order.concat(Object.keys(groups).filter(k=>!order.includes(k)))){
    const list=groups[g]; if(!list) continue;
    const users=list.reduce((s,p)=>s+(p.users||0),0), calling=list.reduce((s,p)=>s+(p.users_calling||0),0), ncalls=list.reduce((s,p)=>s+((p.calls||[]).length),0);
    const gh=document.createElement('div'); gh.className='grp';
    gh.innerHTML=`<span class="tw">${collapsed.has(g)?'▸':'▾'}</span><b>${g}</b><small>${list.length} · ${users} users · <span style="color:#ff5a3c">${calling} calling</span>${ncalls?' · '+ncalls+' calls':''}</small><button title="select all here">select</button>`;
    gh.onclick=()=>{ if(collapsed.has(g)) collapsed.delete(g); else collapsed.add(g); renderList(); };
    gh.querySelector('button').onclick=e=>{ e.stopPropagation(); for(const p of list) selected.add(p.name); onSelChange(); };
    rows.appendChild(gh);
    if(collapsed.has(g)) continue;
    const parents=list.filter(p=>p.site_kind!=='state').sort((a,b)=>(busyOf(b)-busyOf(a))||(a.city||a.name).localeCompare(b.city||b.name));
    const kids=list.filter(p=>p.site_kind==='state');
    for(const p of parents){
      rows.appendChild(rowFor(p,false,kids.filter(k=>k.parent===p.name||k.parent===p.alpha)));
      if(capOpen.has(p.name)) for(const k of kids.filter(k=>k.parent===p.name||k.parent===p.alpha).sort((a,b)=>(busyOf(b)-busyOf(a))||a.city.localeCompare(b.city))) rows.appendChild(rowFor(k,true,[]));
    }
    for(const k of kids.filter(k=>!parents.some(p=>p.name===k.parent||p.alpha===k.parent))) rows.appendChild(rowFor(k,true,[]));
  }
}
function rowFor(p,sub,kids){
  const d=document.createElement('div');
  d.className='row'+(sub?' sub':'')+(p.online===false?' off':'')+(busyOf(p)?' busy':'')+(isSel(p)?' sel':'');
  const st=p.ports!=null?`${p.users||0} users<br><b>${p.users_calling||0}</b> calling`:p.channels!=null?`${p.channels_up}/${p.channels} ch up`:p.trunks!=null?`${p.trunks_in_use}/${p.trunks} trunks`:'';
  const kidsBusy=kids.filter(k=>busyOf(k)).length;
  d.innerHTML=`${kids.length?`<span class="tw">${capOpen.has(p.name)?'▾':'▸'}</span>`:'<span class="tw"></span>'}<span class="sw" style="background:${p.online===false?'#666':devColor(p)}"></span>${flag(p)}
    <span><span class="nm">${p.city?p.city:p.name}</span><br><span class="ty">${p.name}${sub?' · 8x8':''}${p.vendor?' · '+p.vendor:''}${p.ports?' · '+p.ports+' ports':''}${kids.length?' · '+kids.length+' state 8x8s'+(kidsBusy?' ('+kidsBusy+' busy)':''):''}</span>
    <br><span class="ty" style="color:#9ad">${p.snmp_port?'snmp '+p.snmp_port:''}${p.console_port?' · con '+p.console_port:''}${p.series?' · series '+p.series:''}</span></span><span class="st">${st}</span>`;
  const tw=d.querySelector('.tw');
  if(kids.length) tw.onclick=e=>{ e.stopPropagation(); if(capOpen.has(p.name)) capOpen.delete(p.name); else capOpen.add(p.name); renderList(); };
  d.onclick=()=>toggleSel(p.name,false);
  return d;
}
document.getElementById('filter').addEventListener('input',renderList);

// ---------------------------------------------------------------- selection
function toggleSel(name,fromMap){
  if(selected.has(name)) selected.delete(name); else selected.add(name);
  onSelChange(fromMap);
}
function updateSelBox(){
  const n=byName(); for(const k of [...selected]) if(!n[k]) selected.delete(k);
  const sel=[...selected].map(k=>n[k]).filter(Boolean), box=document.getElementById('selbox');
  if(!sel.length){ box.style.display='none'; return sel; }
  {
    const users=sel.reduce((s,p)=>s+(p.users||0),0), calling=sel.reduce((s,p)=>s+(p.users_calling||0),0);
    let h=`<b>${sel.length} selected</b> · ${users} users · <b style="color:#ff5a3c">${calling} calling</b><br>`;
    for(const p of sel){
      const out=(p.calls||[]), inc=links().filter(l=>l.properties.to_device===p.name);
      h+=`<div style="margin-top:3px">${flag(p)}<b>${p.city||p.name}</b> <small style="color:#999">${p.name}</small>`;
      for(const c of out) h+=`<br>&nbsp;&nbsp;<span style="color:#ff5a3c">→</span> ${c.from} → ${c.remote?(n[c.remote]?.city||c.remote)+' : ':''}${c.to}`;
      for(const l of inc) h+=`<br>&nbsp;&nbsp;<span style="color:#f0b429">←</span> ${l.properties.to_port} ← ${n[l.properties.from_device]?.city||l.properties.from_device} : ${l.properties.from_port}`;
      h+='</div>';
    }
    box.innerHTML=h; box.style.display='block';
  }
  return sel;
}
function onSelChange(fromMap){
  const sel=updateSelBox();
  redraw();
  if(sel.length&&!fromMap){
    if(view==='flat'){ const b=L.latLngBounds(sel.map(p=>[p.lat,p.lon])); map.fitBounds(b.pad(sel.length===1?0.5:0.3),{maxZoom:sel.length===1?12:8}); }
    else if(globe){ const la=sel.reduce((s,p)=>s+p.lat,0)/sel.length, lo=sel.reduce((s,p)=>s+p.lon,0)/sel.length; globe.pointOfView({lat:la,lng:lo,altitude:sel.length===1?0.8:1.6},800); }
  }
  renderList();
}
document.getElementById('btnClear').onclick=()=>{ selected.clear(); onSelChange(true); };

// ---------------------------------------------------------------- views / toggles
function setView(v){
  view=v; localStorage.setItem('tc-view',v);
  document.getElementById('map').style.display=v==='flat'?'block':'none';
  document.getElementById('globe').style.display=v==='globe'?'block':'none';
  document.getElementById('btnFlat').classList.toggle('on',v==='flat'); document.getElementById('btnGlobe').classList.toggle('on',v==='globe');
  document.getElementById('btnSpin').style.display=v==='globe'?'':'none';
  if(v==='flat'){ setTimeout(()=>{map.invalidateSize(); fitMinZoom(); if(!fitted&&lastGj){fitted=true;}},50); }
  else { ensureGlobe(); if(globe){ const el=document.getElementById('globe'); setTimeout(()=>{globe.width(el.clientWidth); globe.height(el.clientHeight);},50);} }
  redraw();
}
document.getElementById('btnFlat').onclick=()=>setView('flat');
document.getElementById('btnGlobe').onclick=()=>setView('globe');
document.getElementById('btnSpin').onclick=()=>{ spin=!spin; localStorage.setItem('tc-spin',spin?'on':'off'); document.getElementById('btnSpin').classList.toggle('on',spin); if(globe) globe.controls().autoRotate=spin; };
document.getElementById('btnSun').onclick=()=>{ sun=!sun; localStorage.setItem('tc-sun',sun?'on':'off'); document.getElementById('btnSun').classList.toggle('on',sun); redraw(); };
document.getElementById('btnSpin').classList.toggle('on',spin); document.getElementById('btnSun').classList.toggle('on',sun);

// ---------------------------------------------------------------- footer: call simulators
const levelEl=document.getElementById('level');
levelEl.oninput=()=>document.getElementById('levelv').textContent=Number(levelEl.value).toFixed(2);
for(const b of document.querySelectorAll('.foot button[data-sc]')){
  b.onclick=async()=>{
    const n=byName(); const host=[...selected].map(k=>n[k]).find(p=>p&&p.site_kind==='capital');
    const q=new URLSearchParams({name:b.dataset.sc,level:levelEl.value}); if(host&&b.dataset.sc==='olympics') q.set('host',host.alpha||host.name);
    document.getElementById('scstatus').textContent='setting '+b.dataset.sc+'…';
    try{ const r=await fetch('/api/scenario?'+q.toString()); const j=await r.json(); if(!j.ok) throw new Error(j.error); }
    catch(e){ document.getElementById('scstatus').textContent='scenario error: '+e; }
    refresh();
  };
}
function showScenario(sc){
  for(const b of document.querySelectorAll('.foot button[data-sc]')) b.classList.toggle('on',sc&&b.dataset.sc===sc.name);
  if(!sc){ document.getElementById('scstatus').textContent=''; return; }
  const n=byName();
  let t=`${sc.name.toUpperCase()} · level ${Number(sc.level).toFixed(2)}`;
  if(sc.host) t+=` · host ${n[sc.host]?.city||sc.host}`;
  if(sc.hosts&&sc.hosts.length) t+=` · venues ${sc.hosts.map(h=>n[h]?.city||h).join(', ')}`;
  const s=sunPosition(new Date()); t+=` · sun over ${s.lon.toFixed(0)}°${s.lon<0?'W':'E'}`;
  document.getElementById('scstatus').textContent=t;
}

// ---------------------------------------------------------------- refresh
function redraw(){ if(!lastGj) return; if(view==='flat') drawFlat(); else drawGlobe(); }
async function refresh(){
  try{
    const r=await fetch('/geojson',{cache:'no-store'}); const gj=await r.json(); lastGj=gj;
    const t=gj.properties.totals||{};
    document.getElementById('users').textContent=t.users??'–'; document.getElementById('calling').textContent=t.users_calling??'–';
    document.getElementById('ports').textContent=t.ports??'–'; document.getElementById('calls').textContent=t.calls??'–'; document.getElementById('ndev').textContent=devs().length;
    document.getElementById('tz').textContent=gj.properties.tz||''; document.getElementById('time').textContent=gj.properties.time||'';
    showScenario(gj.properties.scenario); if(selActive()) updateSelBox(); redraw(); renderList();
    if(!fitted&&view==='flat'&&devs().length){ fitted=true; fitMinZoom(); map.fitBounds(L.latLngBounds(devs().map(p=>[p.lat,p.lon])).pad(0.05)); }
  }catch(e){ document.getElementById('time').textContent='feed error: '+e; }
}
map.setView([20,0],2);
setView(view); refresh(); setInterval(refresh,2000);
</script></body></html>
"""


class MapServer:
    """Serves the map, the feeds and (if action_callback is given) the button API.

    action_callback(name, params) -> dict   where name is e.g. "key" and params a
    flat dict of strings from the query string / POST body.  Raise ValueError or
    KeyError for a 400, anything else is a 500."""

    def __init__(self, state_callback, host="0.0.0.0", port=8080, log=None, action_callback=None):
        self.state_callback = state_callback
        self.action_callback = action_callback
        self.host, self.port = host, port
        self.log = log or (lambda m: None)
        self.httpd = None

    def start(self):
        cb, log, act = self.state_callback, self.log, self.action_callback

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def _send(self, code, ctype, body):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)

            def _params(self):
                u = urlsplit(self.path)
                params = {k: v[-1] for k, v in parse_qs(u.query).items()}
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    body = self.rfile.read(length).decode("utf-8", "replace")
                    if "json" in self.headers.get("Content-Type", ""):
                        try:
                            params.update({k: str(v) for k, v in json.loads(body).items()})
                        except ValueError:
                            pass
                    else:
                        params.update({k: v[-1] for k, v in parse_qs(body).items()})
                return u.path, params

            def _api(self):
                path, params = self._params()
                if act is None:
                    self._send(404, "application/json", b'{"error":"no action handler"}')
                    return
                name = path[len("/api/"):].strip("/")
                if not name or name == "help":
                    self._send(200, "application/json", json.dumps(API_HELP, indent=1).encode())
                    return
                try:
                    result = act(name, params)
                    self._send(200, "application/json", json.dumps({"ok": True, "result": result}).encode("utf-8"))
                except (ValueError, KeyError) as exc:
                    self._send(400, "application/json", json.dumps({"ok": False, "error": str(exc)}).encode("utf-8"))
                except Exception as exc:
                    log("api error: %s" % exc)
                    self._send(500, "application/json", json.dumps({"ok": False, "error": str(exc)}).encode("utf-8"))

            def do_POST(self):
                if self.path.startswith("/api/"):
                    self._api()
                else:
                    self._send(404, "text/plain", b"not found")

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                try:
                    if path in ("/", "/index.html"):
                        self._send(200, "text/html; charset=utf-8", HTML.encode("utf-8"))
                    elif path == "/geojson":
                        self._send(200, "application/geo+json", json.dumps(to_geojson(cb())).encode("utf-8"))
                    elif path == "/state":
                        self._send(200, "application/json", json.dumps(cb()).encode("utf-8"))
                    elif path.startswith("/api/") or path == "/api":
                        self._api()
                    else:
                        self._send(404, "text/plain", b"not found")
                except Exception as exc:
                    log("map server error: %s" % exc)
                    self._send(500, "text/plain", str(exc).encode())

        self.httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, name="tc-map", daemon=True).start()
        self.log("map: http://127.0.0.1:%d/  (geojson at /geojson, raw at /state, api at /api/help)" % self.port)

    def stop(self):
        if self.httpd:
            self.httpd.shutdown()


def local_tz_label():
    off = -time.altzone if time.localtime().tm_isdst and time.daylight else -time.timezone
    sign = "+" if off >= 0 else "-"
    off = abs(off)
    return "%s (UTC%s%02d:%02d)" % (time.strftime("%Z"), sign, off // 3600, (off % 3600) // 60)


def iso_now():
    """Local time with numeric offset, e.g. 2026-10-20T15:02:11-04:00"""
    t = time.strftime("%Y-%m-%dT%H:%M:%S")
    z = time.strftime("%z")
    return t + (z[:3] + ":" + z[3:] if len(z) == 5 else z)
