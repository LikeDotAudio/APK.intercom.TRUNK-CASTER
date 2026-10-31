#!/usr/bin/env python3
"""
launch_all.py  --  kick off every vendor emulator with its locations, and serve
one combined map of all of them.

Reads emulators.json (next to this file).  For each vendor:
  * if its emulator script exists, start it with its capitals, ports and vendor label;
  * otherwise start the stand-in emulator (RTS) for those capitals, labelled with
    the vendor's name, so the capitals are live on the map anyway.

Then runs a combined map on combined_map_port that merges every emulator's
/state feed and forwards /api/* calls to whichever emulator owns the matrix.

    python launch_all.py                 start everything, map at http://127.0.0.1:8080/
    python launch_all.py --list          show what would start, and on which ports
    python launch_all.py --only RTS,Riedel
    Ctrl-C stops all of them.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from tc_map import MapServer, local_tz_label, iso_now  # noqa: E402


def log(msg):
    sys.stdout.write(time.strftime("%H:%M:%S ") + msg + "\n")
    sys.stdout.flush()


def fetch_json(url, timeout=2.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


class Child:
    def __init__(self, vendor, script, args, map_port, capitals, stand_in_for=None):
        self.vendor, self.script, self.args, self.map_port, self.capitals = vendor, script, args, map_port, capitals
        self.stand_in_for = stand_in_for
        self.proc = None
        self.state = None
        self.last_ok = 0.0
        self.error = None

    @property
    def label(self):
        return self.vendor if not self.stand_in_for else "%s (stand-in: %s)" % (self.stand_in_for, self.vendor)

    def start(self, quiet):
        cmd = [sys.executable, "-u", self.script] + self.args
        if quiet:
            cmd.append("--quiet")
        self.proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        threading.Thread(target=self._pump, daemon=True).start()
        log("started %-28s pid %-6d map :%d  %s" % (self.label, self.proc.pid, self.map_port, " ".join(self.capitals)))

    def _pump(self):
        for line in self.proc.stdout:
            line = line.rstrip()
            if line and "DeprecationWarning" not in line and "re.split" not in line:
                log("[%s] %s" % (self.stand_in_for or self.vendor, line))

    def refresh(self):
        try:
            self.state = fetch_json("http://127.0.0.1:%d/state" % self.map_port)
            self.last_ok = time.time()
            self.error = None
        except Exception as exc:
            self.error = str(exc)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Launcher:
    def __init__(self, registry, only=None, chaos=None):
        self.reg = registry
        self.children = []
        self.only = {v.strip().lower() for v in only.split(",")} if only else None
        stand_in = registry.get("stand_in", "RTS")
        stand_in_script = None
        for v in registry["vendors"]:
            if v["vendor"].lower() == stand_in.lower():
                stand_in_script = os.path.join(ROOT, v["emulator"])
        chaos = registry.get("chaos", 0.0) if chaos is None else chaos
        for v in registry["vendors"]:
            if self.only and v["vendor"].lower() not in self.only:
                continue
            script = os.path.join(ROOT, v["emulator"])
            common = ["--world", "--capitals", ",".join(v["capitals"]), "--base-port", str(v["base_port"]),
                      "--map-port", str(v["map_port"]), "--chaos", str(chaos)]
            if os.path.exists(script):
                self.children.append(Child(v["vendor"], script, common + ["--vendor", v["vendor"]], v["map_port"], v["capitals"]))
            elif stand_in_script and os.path.exists(stand_in_script):
                self.children.append(Child(stand_in, stand_in_script, common + ["--vendor", v["vendor"]], v["map_port"], v["capitals"], stand_in_for=v["vendor"]))
            else:
                log("no emulator for %s and no stand-in available" % v["vendor"])

    def start_all(self, quiet):
        for c in self.children:
            c.start(quiet)

    def stop_all(self):
        for c in self.children:
            c.stop()

    # ---- combined state -------------------------------------------------------
    def poll_loop(self):
        while True:
            for c in self.children:
                c.refresh()
            time.sleep(1.0)

    def state(self):
        devices, links = [], []
        totals = {"users": 0, "users_calling": 0, "ports": 0, "calls": 0, "devices": 0, "emulators": len(self.children), "emulators_up": 0}
        for c in self.children:
            st = c.state
            if not st or time.time() - c.last_ok > 10:
                # emulator not answering: show its capitals as offline placeholders
                for alpha in c.capitals:
                    cap = CAPITALS.get(alpha)
                    if cap:
                        devices.append({"name": alpha, "type": "matrix", "subtype": "?", "vendor": c.stand_in_for or c.vendor,
                                        "city": cap[0], "country": cap[1], "lat": cap[2], "lon": cap[3], "continent": cap[4], "online": False,
                                        "coverage_m": 400, "color": "#666666", "calls": [], "note": "emulator not answering: %s" % (c.error or "starting")})
                continue
            totals["emulators_up"] += 1
            for d in st.get("devices", []):
                d = dict(d)
                d["vendor"] = c.stand_in_for or d.get("vendor") or c.vendor
                if c.stand_in_for:
                    d["stand_in"] = c.vendor
                d["emulator_map_port"] = c.map_port
                devices.append(d)
            links.extend(st.get("links", []))
            t = st.get("totals", {})
            for k in ("users", "users_calling", "ports", "calls", "devices"):
                totals[k] += t.get(k, 0)
        scenario = next((c.state.get("scenario") for c in self.children if c.state and c.state.get("scenario")), None)
        return {"time": iso_now(), "tz": local_tz_label(), "totals": totals, "devices": devices, "links": links, "scenario": scenario,
                "emulators": [{"vendor": c.vendor, "stand_in_for": c.stand_in_for, "map_port": c.map_port, "capitals": c.capitals,
                               "up": bool(c.state) and time.time() - c.last_ok <= 10, "error": c.error} for c in self.children]}

    def action(self, name, params):
        if name == "emulators":
            return self.state()["emulators"]
        if name == "scenario":
            # estate-wide: fan out to every emulator; the host city only exists in one of them, the others pick randomly
            out = {}
            for c in self.children:
                try:
                    url = "http://127.0.0.1:%d/api/scenario?%s" % (c.map_port, urllib.parse.urlencode(params))
                    out[c.stand_in_for or c.vendor] = fetch_json(url, timeout=5).get("result")
                except Exception as exc:
                    out[c.stand_in_for or c.vendor] = {"error": str(exc)}
            return out
        if name == "matrices":
            out = []
            for c in self.children:
                try:
                    out.extend(fetch_json("http://127.0.0.1:%d/api/matrices" % c.map_port)["result"])
                except Exception:
                    pass
            return out
        m = params.get("matrix", "").upper()
        owner = None
        for c in self.children:
            if m in [x.upper() for x in c.capitals]:
                owner = c
                break
        if owner is None:
            for c in self.children:
                for d in (c.state or {}).get("devices", []):
                    if d.get("name", "").upper() == m or d.get("alpha", "").upper() == m:
                        owner = c
        if owner is None:
            raise KeyError("no emulator owns matrix '%s'" % m)
        url = "http://127.0.0.1:%d/api/%s?%s" % (owner.map_port, name, urllib.parse.urlencode(params))
        data = fetch_json(url, timeout=5)
        if not data.get("ok"):
            raise ValueError(data.get("error", "emulator error"))
        return data["result"]


def load_capitals():
    """Pull the capital table out of the RTS simulator so the launcher shows placeholders for dead emulators."""
    try:
        sys.path.insert(0, os.path.join(ROOT, "KNOWN PROTOCOLS", "VENDOR", "RTS", "SIMULATOR"))
        import rts_intercom_sim
        return {a: (city, country, lat, lon, rts_intercom_sim.CONTINENT.get(a)) for a, city, country, lat, lon in rts_intercom_sim.WORLD_CAPITALS}
    except Exception:
        return {}


CAPITALS = load_capitals()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Start every vendor emulator with its locations and serve one combined map.")
    ap.add_argument("--registry", default=os.path.join(HERE, "emulators.json"))
    ap.add_argument("--only", help="comma list of vendors to start (default all)")
    ap.add_argument("--chaos", type=float, help="override the registry's random-activity level")
    ap.add_argument("--map-port", type=int, help="override combined_map_port")
    ap.add_argument("--list", action="store_true", help="show the plan and exit")
    ap.add_argument("--quiet", action="store_true", help="pass --quiet to the emulators")
    args = ap.parse_args(argv)
    with open(args.registry, "r", encoding="utf-8") as fh:
        reg = json.load(fh)
    launcher = Launcher(reg, args.only, args.chaos)
    port = args.map_port or reg.get("combined_map_port", 8080)
    if args.list:
        for c in launcher.children:
            print("%-30s %-60s map :%d  %d capitals: %s" % (c.label, os.path.relpath(c.script, ROOT), c.map_port, len(c.capitals), ", ".join(c.capitals)))
        print("combined map on :%d" % port)
        return 0
    log("local time zone: %s" % local_tz_label())
    launcher.start_all(args.quiet)
    threading.Thread(target=launcher.poll_loop, daemon=True).start()
    srv = MapServer(launcher.state, "0.0.0.0", port, log, launcher.action)
    srv.start()
    log("combined map: http://127.0.0.1:%d/   (%d emulators)" % (port, len(launcher.children)))
    try:
        while True:
            time.sleep(1.0)
            for c in launcher.children:
                if c.proc and c.proc.poll() is not None:
                    log("%s exited with code %s" % (c.label, c.proc.returncode))
                    c.proc = None
    except KeyboardInterrupt:
        pass
    finally:
        log("stopping emulators")
        launcher.stop_all()
        srv.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
