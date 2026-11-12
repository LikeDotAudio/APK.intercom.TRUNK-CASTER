"""Estate: all spawned devices + the map, and the config builders.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import json
import math
import random
import sys
import threading
import time
from collections import deque
from .env import MapServer, iso_now, local_tz_label
from .plan import (
    CONTINENT,
    DEFAULT_PLAN,
    ISO2,
    SERIES_SIZE,
    SMALL_PLAN,
    SUBSITES,
    WORLD_CAPITALS,
    capital_ports,
    subsite_alpha4,
    subsite_ports,
)
from .matrix import MatrixDevice
from .rvon import RvonDevice
from .trunk_master import TrunkMasterDevice


DEVICE_CLASSES = {"matrix": MatrixDevice, "rvon": RvonDevice, "tm2000": TrunkMasterDevice, "tm": TrunkMasterDevice}


# =============================================================================
# Estate: all spawned devices + the map
# =============================================================================
class Estate:
    def __init__(self, mib, cfg, verbose=True):
        self.mib = mib
        self.bind = cfg.get("bind", "0.0.0.0")
        self.community = cfg.get("community", "public")
        self.chaos = float(cfg.get("chaos", 0.0))
        self.vendor = cfg.get("vendor", "RTS")
        # traffic scenario driven from the map footer: name, level (0..1), host (alpha of a host city), hosts (sporting venues)
        self.scenario = {"name": cfg.get("scenario", "normal"), "level": self.chaos, "host": None, "hosts": [], "since": time.time()}
        self.map_port = int(cfg.get("map_port", 8080) or 0)
        self.trap_targets = []
        for t in cfg.get("trap_targets", []):
            host, _, port = t.rpartition(":")
            self.trap_targets.append((host or "127.0.0.1", int(port or 162)))
        self.stop = threading.Event()
        self.verbose = verbose
        self.devices = []
        for dcfg in cfg["devices"]:
            cls = DEVICE_CLASSES.get(dcfg["type"].lower())
            if cls is None:
                raise ValueError("unknown device type '%s' (matrix, rvon, tm2000)" % dcfg["type"])
            self.devices.append(cls(self, dict(dcfg)))
        matrices = [d for d in self.devices if isinstance(d, MatrixDevice)]
        for d in self.devices:
            if isinstance(d, TrunkMasterDevice):
                d.populate(matrices)
        palette = ["#4cc9f0", "#f9c74f", "#90be6d", "#f3722c", "#b5179e", "#43aa8b", "#f94144", "#577590"]
        for i, d in enumerate(self.devices):
            if not d.color:
                d.color = palette[i % len(palette)]
            if d.coverage_m is None and not d.coverage:
                d.coverage_m = {"matrix": 150, "rvon": 50, "tm2000": 80}.get(d.dtype, 60)
        self.map = None

    def log(self, msg, warn=False):
        if self.verbose or warn or "cannot bind" in msg or "unavailable" in msg or "not started" in msg:
            sys.stdout.write(time.strftime("%H:%M:%S ") + msg + "\n")
            sys.stdout.flush()

    def refresh_trunk_masters(self):
        for d in self.devices:
            if isinstance(d, TrunkMasterDevice):
                d.refresh_alphas()

    # ---- traffic scenarios ---------------------------------------------------------
    SCENARIOS = {
        "quiet":    "nothing happens unless someone presses a key",
        "normal":   "light random traffic everywhere, state capitals spike at local noon and on the hour",
        "olympics": "a host city (pick one or random) is flooded: everyone trunks to it, its own traffic x4",
        "sports":   "several sporting venues at once: three random capitals run hot, the rest idle",
        "evening":  "evening events: cities where it is 18:00-23:00 local run hot, the rest sleep",
        "breaking": "breaking news: everything x2 with bursts",
    }

    def set_scenario(self, name, level=None, host=None):
        name = (name or "normal").lower()
        if name not in self.SCENARIOS:
            raise ValueError("scenario must be one of %s" % ", ".join(self.SCENARIOS))
        mats = [d for d in self.devices if isinstance(d, MatrixDevice) and not d.parent]
        sc = {"name": name, "level": float(level) if level is not None else max(self.scenario["level"], 0.15),
              "host": None, "hosts": [], "since": time.time()}
        if name == "olympics" and mats:
            hostm = next((m for m in mats if host and (m.alpha4 == host.upper() or m.name.upper() == host.upper())), None) or random.choice(mats)
            sc["host"] = hostm.alpha4
        if name == "sports" and mats:
            sc["hosts"] = [m.alpha4 for m in random.sample(mats, min(3, len(mats)))]
        self.scenario = sc
        self.log("scenario -> %s" % json.dumps(sc))
        return sc

    def traffic_weight(self, m):
        """How busy matrix m should be right now (0 = silent, 1 = the old chaos=1)."""
        sc = self.scenario
        name, level = sc["name"], sc["level"]
        if name == "quiet" or level <= 0:
            return 0.0
        w = level
        lh = m.local_hour()
        if name == "olympics":
            w *= 4.0 if m.alpha4 == sc["host"] or m.parent == sc["host"] else 1.5
        elif name == "sports":
            w *= 3.0 if (m.alpha4 in sc["hosts"] or m.parent in sc["hosts"]) else 0.4
        elif name == "evening":
            w *= 3.0 if (lh is not None and 18 <= lh < 23) else 0.25
        elif name == "breaking":
            w *= 2.0 + (1.5 if int(time.time()) % 20 < 4 else 0)
        if m.parent and lh is not None:             # the 8x8 frames: higher than normal hit at noon, on the hour, off the hour
            minute = (lh % 1.0) * 60
            if 11.75 <= lh < 12.25:
                w *= 6.0
            elif minute < 2 or minute > 58:
                w *= 3.0
            elif 29 <= minute < 31:
                w *= 1.8
        return w

    # ---- button API (Stream Deck, Companion, PANELS/streamdeck_emulator.py) ------
    def matrix(self, ref):
        for d in self.devices:
            if isinstance(d, MatrixDevice) and ref and (d.name.upper() == ref.upper() or d.alpha4 == ref.upper()):
                return d
        raise KeyError("no matrix '%s' (have: %s)" % (ref, ", ".join(d.alpha4 for d in self.devices if isinstance(d, MatrixDevice))))

    def action(self, name, p):
        on = str(p.get("state", "1")).lower() in ("1", "on", "true", "down", "press")
        if name == "matrices":
            return [{"name": d.name, "alpha": d.alpha4, "city": d.city, "ports": d.nports, "parent": d.parent} for d in self.devices if isinstance(d, MatrixDevice)]
        if name == "scenario":
            if p.get("name"):
                return self.set_scenario(p["name"], p.get("level"), p.get("host"))
            return dict(self.scenario, available=self.SCENARIOS)
        m = self.matrix(p.get("matrix", ""))
        if name == "ports":
            return [{"n": q.n, "alpha": q.alpha, "type": q.ptype, "user": q.user, "talk": q.can_talk, "listen": q.can_listen,
                     "live": bool(q.endpoint), "keys": q.keys} for q in m.ports.values()]
        if name == "port":
            return m.port_state(m.port_by(p["port"]))
        if name == "key":
            kind = p.get("kind", "talk").lower()
            if kind == "talk":
                m.talk(p["port"], p["target"], on)
            elif kind == "listen":
                m.listen(p["port"], p["target"], on)
            else:
                raise ValueError("kind must be talk or listen")
            return m.port_state(m.port_by(p["port"]))
        if name == "call":
            return m.call_remote(p["port"], p["icom"], p["remote"])
        if name == "hangup":
            return m.hangup(p["port"])
        if name == "claim":
            n = int(p.get("port", 0) or 0)
            if n == 0:
                free = [q for q in m.ports.values() if q.user and q.can_talk and q.endpoint is None]
                if not free:
                    raise ValueError("no free panel port")
                n = free[0].n
            q = m.ports[n]
            if q.endpoint and q.endpoint.get("addr") is not None:
                raise ValueError("port %d is live on an audio endpoint" % n)
            q.endpoint = dict(addr=None, name=p.get("name", "button panel"), last=time.time(), frames=deque(maxlen=1), seq=0, since=time.time(), buttons=True)
            return {"port": n, "alpha": q.alpha, "matrix": m.name}
        if name == "release":
            n = m.port_by(p["port"])
            q = m.ports[n]
            if q.endpoint and q.endpoint.get("buttons"):
                q.endpoint = None
                m.clear_port(n)
            return {"port": n, "released": True}
        raise KeyError("unknown action '%s'; GET /api/help" % name)

    def state(self):
        devices = [d.map_state() for d in self.devices]
        links = []
        by_alpha = {d.alpha4: d.name for d in self.devices if isinstance(d, MatrixDevice)}
        users = calls = ports = calling = 0
        for d in self.devices:
            if isinstance(d, MatrixDevice):
                ports += d.nports
                users += sum(1 for p in d.ports.values() if p.user)
                calling += d.users_calling()
                for c in d.active_calls():
                    calls += 1
                    if c["remote"] and c["remote"] in by_alpha:
                        links.append({"from_device": d.name, "from_port": c["from"], "to_device": by_alpha[c["remote"]],
                                      "to_port": c["to"], "since": c["since"]})
        return {"time": iso_now(), "tz": local_tz_label(), "vendor": self.vendor, "map_port": self.map_port, "scenario": self.scenario,
                "totals": {"users": users, "users_calling": calling, "ports": ports, "calls": calls, "devices": len(self.devices)},
                "devices": devices, "links": links}

    def run(self):
        self.log("local time zone: %s" % local_tz_label())
        threads = []
        for d in self.devices:
            threads.append(threading.Thread(target=d.serve_snmp, name=d.name + "-snmp", daemon=True))
            threads.append(threading.Thread(target=d.serve_console, name=d.name + "-console", daemon=True))
            if isinstance(d, MatrixDevice) and d.audio:
                threads.append(d.audio)
        for t in threads:
            t.start()
        if self.map_port and MapServer is not None:
            try:
                self.map = MapServer(self.state, self.bind, self.map_port, self.log, self.action)
                self.map.start()
            except OSError as exc:
                self.log("map server not started on %d: %s" % (self.map_port, exc))
        time.sleep(0.2)
        for d in self.devices:
            d.trap("coldStart")
        self.log("estate up: %d device(s). Ctrl-C to stop." % len(self.devices))
        for d in self.devices:
            self.log("  " + d.summary())
        try:
            while not self.stop.is_set():
                time.sleep(1.0)
                for d in self.devices:
                    try:
                        d.tick()
                    except Exception as exc:
                        self.log("%s: tick error %s" % (d.name, exc))
        except KeyboardInterrupt:
            pass
        self.stop.set()
        if self.map:
            self.map.stop()
        self.log("estate stopping")


def spawn_config(spec, base_snmp=16100, community="public", trap_targets=None, chaos=0.0, center=(40.7128, -74.0060), map_port=8080):
    """'tm2000=1,adam=1,cronus=1,rvon16=2'  ->  config dict with auto ports and map positions"""
    devices, counters = [], {}
    snmp_port, console_port = base_snmp, base_snmp + 1000
    for part in spec.split(","):
        if not part.strip():
            continue
        kind, _, count = part.strip().partition("=")
        kind = kind.strip().lower()
        for _ in range(int(count or 1)):
            counters[kind] = counters.get(kind, 0) + 1
            n = counters[kind]
            if kind in ("tm", "tm2000"):
                d = {"type": "tm2000", "name": "TM%d" % n}
            elif kind in MatrixDevice.SUBTYPES or kind == "matrix":
                sub = "adam" if kind == "matrix" else kind
                short = {"adam": "ADM", "adam-bus": "ABX", "cronus": "CRO", "zeus3": "ZEU", "zeus3lite": "ZLT"}[sub]
                d = {"type": "matrix", "subtype": sub, "name": "%s%d" % (short, n), "alpha": "%s%d" % (short, n),
                     "plan": DEFAULT_PLAN, "series": 40000 + SERIES_SIZE * (len(devices) + 1)}
            elif kind in RvonDevice.SUBTYPES or kind == "rvon":
                d = {"type": "rvon", "subtype": kind if kind != "rvon" else "rvon16", "name": "%s-%d" % (kind.upper(), n)}
            else:
                raise ValueError("unknown spawn kind '%s'" % kind)
            d["snmp_port"], d["console_port"] = snmp_port, console_port
            snmp_port += 1
            console_port += 1
            devices.append(d)
    # scatter on the map around the centre
    lat0, lon0 = center
    for i, d in enumerate(devices):
        ang = 2 * math.pi * i / max(1, len(devices))
        r = 0.0 if len(devices) == 1 else 0.06 + 0.02 * (i % 3)
        d["lat"], d["lon"] = round(lat0 + r * math.sin(ang), 5), round(lon0 + r * math.cos(ang) / math.cos(math.radians(lat0)), 5)
    rv = [d for d in devices if d["type"] == "rvon"]
    for i in range(0, len(rv) - 1, 2):
        rv[i]["partner"], rv[i + 1]["partner"] = rv[i + 1]["name"], rv[i]["name"]
    return {"bind": "0.0.0.0", "community": community, "trap_targets": trap_targets or [], "chaos": chaos,
            "map_port": map_port, "devices": devices}


def world_config(base_snmp=16100, community="public", trap_targets=None, chaos=0.0, map_port=8080, plan=None,
                 subtype="adam", trunks_per_pair=1, coverage_m=400, capitals=None, vendor="RTS", subsites=True):
    """One Trunk Master plus one matrix per country capital (all 56, or the `capitals` alpha codes given),
    plus a small 8x8 frame in every state / provincial capital of those countries."""
    plan = plan or DEFAULT_PLAN
    wanted = [c for c in WORLD_CAPITALS if not capitals or c[0] in capitals]
    if not wanted:
        raise ValueError("no capitals matched %s" % capitals)
    tm_lat, tm_lon = wanted[0][3] + 0.01, wanted[0][4] + 0.01
    devices = [{"type": "tm2000", "name": "TM-" + vendor.upper()[:8], "snmp_port": base_snmp, "console_port": base_snmp + 1000,
                "lat": tm_lat, "lon": tm_lon, "city": wanted[0][1], "country": wanted[0][2], "continent": CONTINENT.get(wanted[0][0]),
                "coverage_m": 250, "color": "#ffffff", "trunks_per_pair": trunks_per_pair, "iso2": ISO2.get(wanted[0][0]),
                "site_kind": "trunkmaster"}]
    hues = len(WORLD_CAPITALS)
    for i, (alpha, city, country, lat, lon) in enumerate(wanted):
        h = (WORLD_CAPITALS.index((alpha, city, country, lat, lon)) * 360.0 / hues + 200) % 360
        d = {"type": "matrix", "subtype": subtype, "name": alpha, "alpha": alpha, "alpha8": city.upper()[:8],
             "city": city, "country": country, "continent": CONTINENT.get(alpha), "iso2": ISO2.get(alpha),
             "site_kind": "capital", "lat": lat, "lon": lon,
             "coverage_m": coverage_m, "color": hsl_hex(h, 0.75, 0.55), "plan": plan}
        d.update(capital_ports(alpha))          # fixed worldwide, independent of base_snmp
        devices.append(d)
        if subsites:
            for k, (parent, sname, place, slat, slon) in enumerate(SUBSITES, 1):
                if parent != alpha:
                    continue
                s = {"type": "matrix", "subtype": "zeus3lite", "name": sname, "alpha": subsite_alpha4(sname), "alpha8": sname[:8],
                     "city": place, "country": country, "continent": CONTINENT.get(alpha), "iso2": ISO2.get(alpha),
                     "site_kind": "state", "parent": alpha, "lat": slat, "lon": slon,
                     "coverage_m": coverage_m / 2.5, "color": hsl_hex(h, 0.55, 0.7), "plan": SMALL_PLAN}
                s.update(subsite_ports(k))
                devices.append(s)
    return {"bind": "0.0.0.0", "community": community, "trap_targets": trap_targets or [], "chaos": chaos,
            "map_port": map_port, "vendor": vendor, "devices": devices}


def hsl_hex(h, s, l):
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = l - c / 2
    r, g, b = {0: (c, x, 0), 1: (x, c, 0), 2: (0, c, x), 3: (0, x, c), 4: (x, 0, c), 5: (c, 0, x)}[int(h // 60) % 6]
    return "#%02x%02x%02x" % (int((r + m) * 255), int((g + m) * 255), int((b + m) * 255))
