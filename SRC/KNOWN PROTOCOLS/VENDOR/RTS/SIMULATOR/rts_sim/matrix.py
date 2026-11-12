"""MatrixDevice: ADAM / Cronus / Zeus-III frame with a port plan.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import random
import time
from .env import iso_now, np, tcp
from .plan import DEFAULT_PLAN, PORT_TYPES, build_ports, generate_panels
from .device import Device
from .audio import AudioEngine
from .trunk_master import TrunkMasterDevice


class MatrixDevice(Device):
    """ADAM / Cronus / Zeus-III frame with a port plan, generated panels, call
    state, tone generators and the Trunk-Caster audio port."""

    SUBTYPES = {"adam": "objIdMtx1Frame", "adam-bus": "objIdMtxBusExpanded", "cronus": "objIdMtxCronus",
                "zeus3": "objIdMtxZeusIII", "zeus3lite": "objIdMtxZeusIIILite"}

    def __init__(self, estate, cfg):
        self.subtype_key = (cfg.get("subtype") or "adam").lower()
        if self.subtype_key not in self.SUBTYPES:
            raise ValueError("matrix subtype must be one of %s" % ", ".join(self.SUBTYPES))
        cfg["subtype"] = self.subtype_key
        plan = cfg.get("plan") or DEFAULT_PLAN
        self.plan = [[t.upper(), int(c)] for t, c in plan]
        self.ports = build_ports(self.plan, cfg.get("port_names"))
        generate_panels(self.ports)
        self.alpha4 = (cfg.get("alpha") or cfg["name"][:4]).upper()[:4]
        self.alpha8 = (cfg.get("alpha8") or cfg["name"][:8]).upper()[:8]
        self.talks = {}        # from port -> {to: since}   (to = int port, or "ALPHA:port" for a trunk call)
        self.listens = {}      # port -> set(source ports)
        self.auto_calls = {}   # (from, to) -> end time, for chaos-generated calls
        self.trunk_calls = {}  # from port -> trunk number on the Trunk Master
        self.series = int(cfg.get("series") or cfg.get("audio_port") or 0)   # first socket of this intercom's series of 256
        self.audio_port = self.series
        super().__init__(estate, cfg)
        self.audio = None
        if self.series and tcp is not None and np is not None:
            self.audio = AudioEngine(self, self.series)
        elif self.series:
            self.log("%s: audio port disabled (%s)" % (self.name, "numpy missing" if np is None else "tc_protocol missing"))

    @property
    def nports(self):
        return len(self.ports)

    @property
    def port_alphas(self):
        return {n: p.alpha for n, p in self.ports.items()}

    def sys_object_id(self):
        return self.mib.oid(self.SUBTYPES[self.subtype_key])

    def sys_descr(self):
        return "Pretend RTS %s matrix frame, %d ports (Telex-Icom-MIB not loaded) - Trunk-Caster simulator" % (
            self.subtype_key.upper(), len(self.ports))

    # ---- call model -------------------------------------------------------------
    def port_by(self, ref):
        """port number from a number or an alpha"""
        if isinstance(ref, int):
            return ref
        if ref.isdigit():
            return int(ref)
        for p in self.ports.values():
            if p.alpha.upper() == ref.upper():
                return p.n
        raise KeyError("no port '%s'" % ref)

    def talk(self, frm, to, on=True):
        frm = self.port_by(frm)
        to_key = to if isinstance(to, str) and ":" in to else self.port_by(to)
        p = self.ports.get(frm)
        if p is None:
            raise KeyError("no port %s" % frm)
        if on and not p.can_talk:
            raise ValueError("%s (%s) cannot talk" % (p.alpha, p.ptype))
        with self.lock:
            if on:
                self.talks.setdefault(frm, {})[to_key] = time.time()
            else:
                d = self.talks.get(frm)
                if d:
                    d.pop(to_key, None)
                    if not d:
                        self.talks.pop(frm, None)
        if self.audio and isinstance(to_key, int):
            self.audio.send_state(to_key)

    def listen(self, port, src, on=True):
        port, src = self.port_by(port), self.port_by(src)
        with self.lock:
            if on:
                self.listens.setdefault(port, set()).add(src)
            else:
                s = self.listens.get(port)
                if s:
                    s.discard(src)
                    if not s:
                        self.listens.pop(port, None)

    def clear_port(self, port):
        with self.lock:
            self.talks.pop(port, None)
            self.listens.pop(port, None)
            for d in self.talks.values():
                d.pop(port, None)
        self.hangup(port)

    def call_remote(self, frm, icom_alpha, remote_port):
        frm = self.port_by(frm)
        tms = [d for d in self.estate.devices if isinstance(d, TrunkMasterDevice)]
        if not tms:
            return "no Trunk Master spawned"
        tk, text = tms[0].request_trunk(self.alpha4, frm, icom_alpha, int(remote_port))
        if tk:
            self.trunk_calls[frm] = tk
            self.talk(frm, "%s:%d" % (icom_alpha.upper(), int(remote_port)), True)
        return text

    def hangup(self, frm):
        frm = self.port_by(frm)
        tk = self.trunk_calls.pop(frm, None)
        with self.lock:
            d = self.talks.get(frm)
            if d:
                for k in [k for k in d if isinstance(k, str)]:
                    d.pop(k)
                if not d:
                    self.talks.pop(frm, None)
        if tk:
            for tm in self.estate.devices:
                if isinstance(tm, TrunkMasterDevice):
                    return tm.release_trunk(tk)
        return "port %d has no trunk call" % frm

    def active_calls(self):
        out = []
        with self.lock:
            for frm, targets in self.talks.items():
                for to, since in targets.items():
                    if isinstance(to, str):
                        alpha, _, rp = to.partition(":")
                        out.append({"from": self.ports[frm].alpha, "from_n": frm, "to": "P%s" % rp, "to_n": int(rp), "remote": alpha, "since": since})
                    else:
                        out.append({"from": self.ports[frm].alpha, "from_n": frm, "to": self.ports[to].alpha if to in self.ports else str(to), "to_n": to, "remote": None, "since": since})
        return out

    def users_calling(self):
        with self.lock:
            return sum(1 for frm, t in self.talks.items() if t and frm in self.ports and self.ports[frm].user)

    def port_state(self, port):
        with self.lock:
            talking_to = sorted(k for k in self.talks.get(port, {}) if isinstance(k, int))
            remote = [k for k in self.talks.get(port, {}) if isinstance(k, str)]
            incoming = [{"port": frm, "alpha": self.ports[frm].alpha, "since": targets[port]}
                        for frm, targets in self.talks.items() if port in targets and frm != port]
            listening = sorted(self.listens.get(port, ()))
        users = sum(1 for p in self.ports.values() if p.user)
        return {"port": port, "alpha": self.ports[port].alpha, "matrix": self.name, "talking_to": talking_to,
                "remote": remote, "listening": listening, "incoming": incoming,
                "users": users, "users_calling": self.users_calling(), "time": iso_now()}

    def set_online(self, on):
        super().set_online(on)
        for tm in self.estate.devices:
            if isinstance(tm, TrunkMasterDevice):
                tm.icom_status_changed(self)

    # ---- behaviour ----------------------------------------------------------------
    def tick(self):
        now = time.time()
        for key, end in list(self.auto_calls.items()):
            if now > end:
                self.auto_calls.pop(key)
                try:
                    self.talk(key[0], key[1], False)
                except Exception:
                    pass
        w = self.estate.traffic_weight(self)
        if w and random.random() < min(0.95, w * 0.3):
            talkers = [p for p in self.ports.values() if p.can_talk and p.keys and p.endpoint is None]
            if talkers:
                p = random.choice(talkers)
                to = random.choice(list(p.keys.values()))
                self.talk(p.n, to, True)
                self.auto_calls[(p.n, to)] = now + random.uniform(3, 15)

    # ---- console ------------------------------------------------------------------
    def console_help(self):
        return super().console_help() + [
            "plan                 the port plan and user count",
            "ports [TYPE]         list ports (optionally one type)",
            "panel <port>         the generated keypanel for a port",
            "key <port> <k> <target>   reassign a key",
            "name <port> <alpha>  rename a port",
            "talk <from> <to>     press a talk key (port numbers or alphas)",
            "untalk <from> <to>   release it",
            "listen <port> <src>  monitor a source (wireless / IFB listen)",
            "unlisten <port> <src>",
            "calls                who is calling whom right now",
            "call <port> <ICOM> <remote-port>   trunk call via the Trunk Master",
            "hangup <port>        release that port's trunk call",
            "endpoints            live computers joined on the audio port",
        ]

    def console_command(self, argv):
        cmd, a = argv[0].lower(), argv[1:]
        if cmd == "plan":
            users = sum(1 for p in self.ports.values() if p.user)
            lines = ["%-6s %3d  %s" % (t, c, PORT_TYPES[t]["desc"]) for t, c in self.plan]
            lines.append("total ports %d, users %d (types marked user: %s)" % (
                len(self.ports), users, ", ".join(t for t, c in self.plan if PORT_TYPES[t]["user"])))
            return "\n".join(lines)
        if cmd == "ports":
            want = a[0].upper() if a else None
            lines = []
            for p in self.ports.values():
                if want and p.ptype != want:
                    continue
                flags = []
                if p.endpoint:
                    flags.append("LIVE:" + p.endpoint["name"])
                t = self.talks.get(p.n)
                if t:
                    flags.append("talking->" + ",".join(str(k) for k in t))
                lines.append("%4d %-8s %-6s %s" % (p.n, p.alpha, p.ptype, " ".join(flags)))
            return "\n".join(lines)
        if cmd == "panel" and a:
            p = self.ports[self.port_by(a[0])]
            if not p.keys:
                return "%s (%s) has no keypanel" % (p.alpha, p.ptype)
            return "\n".join("key %d -> %4d %s" % (k, t, self.ports[t].alpha) for k, t in sorted(p.keys.items())) + "\ntone %.0f Hz" % p.freq
        if cmd == "key" and len(a) >= 3:
            self.ports[self.port_by(a[0])].keys[int(a[1])] = self.port_by(a[2])
            return "ok"
        if cmd == "name" and len(a) >= 2:
            self.ports[self.port_by(a[0])].alpha = a[1][:8]
            self.estate.refresh_trunk_masters()
            return "port %s = %s" % (a[0], a[1][:8])
        if cmd in ("talk", "untalk") and len(a) >= 2:
            self.talk(a[0], a[1], cmd == "talk")
            return "%s %s -> %s" % (cmd, a[0], a[1])
        if cmd in ("listen", "unlisten") and len(a) >= 2:
            self.listen(a[0], a[1], cmd == "listen")
            return "ok"
        if cmd == "calls":
            calls = self.active_calls()
            if not calls:
                return "no calls"
            now = time.time()
            return "\n".join("%-8s -> %s%-8s  %4.0fs" % (c["from"], (c["remote"] + ":") if c["remote"] else "", c["to"], now - c["since"]) for c in calls) + \
                "\nusers %d, users calling %d" % (sum(1 for p in self.ports.values() if p.user), self.users_calling())
        if cmd == "call" and len(a) >= 3:
            return self.call_remote(a[0], a[1], a[2])
        if cmd == "hangup" and a:
            return self.hangup(a[0])
        if cmd == "endpoints":
            if not self.audio:
                return "audio port not running"
            return "\n".join("port %d %s  %s  %s:%d  idle %.1fs" % (n, self.ports[n].alpha, e["name"], e["addr"][0], e["addr"][1], time.time() - e["last"])
                             for n, e in self.audio.endpoints.items()) or "no endpoints (start TRUNK-SIMULATOR/trunk_panel.py --matrix host:%d)" % self.series
        return super().console_command(argv)

    def summary(self):
        return super().summary() + "  alpha=%s ports=%d users=%d calling=%d audio=udp/%s" % (
            self.alpha4, len(self.ports), sum(1 for p in self.ports.values() if p.user), self.users_calling(), ("%d..%d" % (self.series, self.series + 255)) if self.series else "-")

    def map_state(self):
        s = super().map_state()
        s.update(alpha=self.alpha4, ports=len(self.ports), users=sum(1 for p in self.ports.values() if p.user),
                 users_calling=self.users_calling(), audio_port=self.series, series=self.series,
                 sockets=(self.audio.bound if self.audio else 0),
                 calls=[{"from": c["from"], "to": c["to"], "remote": c["remote"], "since": c["since"]} for c in self.active_calls()],
                 endpoints=[{"port": n, "alpha": self.ports[n].alpha, "name": e["name"]} for n, e in (self.audio.endpoints.items() if self.audio else [])])
        return s
