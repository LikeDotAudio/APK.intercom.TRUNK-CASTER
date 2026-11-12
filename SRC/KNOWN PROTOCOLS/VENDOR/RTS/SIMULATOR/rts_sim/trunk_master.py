"""TrunkMasterDevice: the TM-2000 Trunk Master.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import random
import threading
import time
from .device import Device, TRUE, alpha_bytes, truth


# -----------------------------------------------------------------------------
class TrunkMasterDevice(Device):
    """TM-2000 Trunk Master: knows every spawned matrix, defines trunks between
    each pair, tracks trunk state and raises the Telex-TM-MIB notifications."""

    def __init__(self, estate, cfg):
        self.icoms, self.trunks = [], {}
        self.trunks_per_pair = int(cfg.get("trunks_per_pair", 4))
        self.trunk_ports_reserved = 8   # each frame keeps its top 8 ports as trunk ports (the 8x8 trunk block)
        self.standby_ip = cfg.get("standby_ip", "0.0.0.0")
        self.other_present = bool(cfg.get("standby_ip"))
        self.clear_timeout = int(cfg.get("clear_alloc_timeout", 30))
        self.errors_cleared_at = time.time()
        super().__init__(estate, cfg)

    def sys_object_id(self):
        return self.mib.oid("sysTypeTM2000")

    def sys_descr(self):
        return "Pretend RTS TM-2000 Trunk Master v8.7.0 - Trunk-Caster simulator"

    def populate(self, matrices):
        self.icoms = list(matrices)
        m = self.mib
        self.put("tmStdbyIpAddr", 0, self.standby_ip)
        self.put("tmNumIcomPorts", 0, max(8, len(self.icoms)))
        self.put("tmVdpEnabled", 0, truth(False))
        self.put("tmVersion", 0, "TM-2000 v8.7.0 (pretend)")
        self.put("tmNumIcoms", 0, 256)
        self.put("tmNumTrunks", 0, 10000)
        self.put("tmNumFnTypes", 0, 2)
        self.put("tmNumGroups", 0, 1000)
        caps = m.tcs["TmCapabTypes"].enum
        self.put("tmNumCapabs", 0, len(caps))
        for label, idx in caps.items():
            self.put("tmCapabPresent", idx, truth(label in ("tkAllocSecs", "ifbSl", "unicode")))
        for n, mx in enumerate(self.icoms, 1):
            self.put("icomAlpha4", n, alpha_bytes(mx.alpha4, 4))
            self.put("icomAlpha6", n, alpha_bytes(mx.alpha8[:6], 6))
            self.put("icomAlpha8", n, alpha_bytes(mx.alpha8, 8))
            self.put("icomAlpha8u", n, alpha_bytes(mx.alpha8, 8))
            self.put("icomComPort", n, n)
            self.put("icomBaudRate", n, 38400)
            self.put("isTalking", n, lambda d=mx: truth(d.online))
            self.put("isNewProtocol", n, truth(True))
            self.put("isSize", n, mx.nports)
            for col in ("isErrorsFrom", "isErrorsTo", "isErrorRateFrom", "isErrorRateTo"):
                self.put(col, n, 0)
        self.refresh_alphas()
        self.put("gnName", 1, "ALL-ICOMS")
        for n in range(1, len(self.icoms) + 1):
            self.put("gmIsMember", (1, n), truth(True))
        self.put("optWaitForTalk", 0, truth(False))
        self.put("optDynamicAlloc", 0, truth(False))
        self.put("optAutoClear", 0, truth(True))
        self.put("optClearAllocTimeout", 0, self.clear_timeout)
        self.put("optLogEnabled", 0, truth(False))
        self.put("tmErrorsCleared", 0, lambda: int((self.errors_cleared_at - self.start) * 100))
        self.put("thisTmActive", 0, truth(True))
        self.put("otPresent", 0, lambda: truth(self.other_present))
        self.put("otActive", 0, truth(False))
        for col in ("otErrorsFrom", "otErrorsTo", "otErrorRateFrom", "otErrorRateTo"):
            self.put(col, 0, 0)
        self.put("otThreshValue", 0, 20, writable=True)
        self.put("icomThreshValue", 0, 20, writable=True)
        # trunks: capital to capital between every pair; a state / provincial 8x8 only trunks to its own capital
        tk = 1
        used = {n: mx.nports for n, mx in enumerate(self.icoms, 1)}
        idx_of = {mx.alpha4: n for n, mx in enumerate(self.icoms, 1)}
        idx_of.update({mx.name: n for n, mx in enumerate(self.icoms, 1)})
        for a in range(1, len(self.icoms) + 1):
            for b in range(a + 1, len(self.icoms) + 1):
                ma, mb = self.icoms[a - 1], self.icoms[b - 1]
                if ma.parent or mb.parent:
                    child, other = (ma, mb) if ma.parent else (mb, ma)
                    if idx_of.get(child.parent) != (b if child is ma else a):
                        continue
                for _ in range(self.trunks_per_pair):
                    pa, pb = used[a], used[b]
                    used[a] -= 1
                    used[b] -= 1
                    if pa < 1 or pb < 1:
                        break
                    self.trunks[tk] = dict(from_icom=a, from_port=pa, to_icom=b, to_port=pb, state="idle", since=time.time(), users=None)
                    self.put("tkFromIcom", tk, a)
                    self.put("tkFromPort", tk, pa)
                    self.put("tkToIcom", tk, b)
                    self.put("tkToPort", tk, pb)
                    self.put("tkCanCascade", tk, truth(True))
                    self.put("tkFixed", tk, truth(False))
                    self.put("tsState", tk, lambda t=tk: self.mib.enum("TrunkState", self.trunks[t]["state"]))
                    tk += 1

    def refresh_alphas(self):
        for n, mx in enumerate(self.icoms, 1):
            for p in mx.ports.values():
                for col, size in (("taAlpha4", 4), ("taAlpha6", 6), ("taAlpha8", 8), ("taAlpha8u", 8)):
                    self.put(col, (n, 1, p.n), alpha_bytes(p.alpha, size))

    def icom_index(self, alpha4):
        for n, mx in enumerate(self.icoms, 1):
            if mx.alpha4 == alpha4.upper() or mx.name.upper() == alpha4.upper():
                return n
        raise KeyError("no intercom '%s' (known: %s)" % (alpha4, ", ".join(x.alpha4 for x in self.icoms)))

    def icom_status_changed(self, matrix):
        n = self.icoms.index(matrix) + 1
        for t in self.trunks.values():
            if n in (t["from_icom"], t["to_icom"]):
                if not matrix.online:
                    t["state"], t["since"], t["users"] = "outOfService", time.time(), None
                elif t["state"] == "outOfService":
                    t["state"], t["since"] = "idle", time.time()
        self.trap("icomStatusChgd", [("isTalking", n, truth(matrix.online))])

    def request_trunk(self, from_alpha, from_port, to_alpha, to_port):
        """-> (trunk number or None, text)"""
        a, b = self.icom_index(from_alpha), self.icom_index(to_alpha)
        if a == b:
            return None, "same intercom, no trunk needed"
        for tk, t in sorted(self.trunks.items()):
            if {t["from_icom"], t["to_icom"]} == {a, b} and t["state"] == "idle":
                t.update(state="inUse", since=time.time(), users=(from_alpha.upper(), from_port, to_alpha.upper(), to_port))
                self.log("%s: trunk %d %s:%d -> %s:%d inUse" % (self.name, tk, from_alpha, from_port, to_alpha, to_port))
                return tk, "trunk %d allocated: %s port %d -> %s port %d (trunk ports %d/%d)" % (
                    tk, from_alpha.upper(), from_port, to_alpha.upper(), to_port, t["from_port"], t["to_port"])
        self.trap("noTrunksTrap", [("noTksFromIcom", 0, a), ("noTksToIcom", 0, b)])
        return None, "NO TRUNKS available between %s and %s (noTrunksTrap sent)" % (from_alpha.upper(), to_alpha.upper())

    def release_trunk(self, tk):
        t = self.trunks.get(tk)
        if not t:
            return "no trunk %d" % tk
        if t["state"] in ("inUse", "allocd"):
            new = "allocd" if (self.get("optAutoClear") == TRUE and t["state"] == "inUse") else "idle"
            t.update(state=new, since=time.time())
            if new == "idle":
                t["users"] = None
            return "trunk %d -> %s" % (tk, new)
        return "trunk %d is %s" % (tk, t["state"])

    def tick(self):
        now = time.time()
        for t in self.trunks.values():
            if t["state"] == "allocd" and now - t["since"] > self.clear_timeout:
                t.update(state="idle", since=now, users=None)
        est = self.estate
        if len(self.icoms) > 1 and est.scenario["name"] != "quiet":
            for _ in range(max(1, len(self.icoms) // 6)):      # a few trunk-call chances per second, scaled to the estate
                self._maybe_trunk_call(est, now)

    def _maybe_trunk_call(self, est, now):
        if True:
            a = random.choice(self.icoms)
            w = est.traffic_weight(a)
            if not (w and random.random() < min(0.9, w * 0.08)):
                return
            host = est.scenario.get("host")
            hosts = [m for m in self.icoms if m.alpha4 == host or m.name == host]
            if hosts and a not in hosts and random.random() < 0.7:
                b = hosts[0]                                  # everyone calls the host city
            elif a.parent:
                b = next((m for m in self.icoms if m.alpha4 == a.parent or m.name == a.parent), None) or random.choice(self.icoms)
            else:
                b = random.choice(self.icoms)
            if b is a:
                return
            pa = [p for p in a.ports.values() if p.can_talk and p.endpoint is None]
            pb = [p for p in b.ports.values() if p.can_listen]
            if pa and pb:
                frm, to = random.choice(pa), random.choice(pb)
                a.call_remote(frm.n, b.alpha4, to.n)
                a.auto_calls[(frm.n, "%s:%d" % (b.alpha4, to.n))] = now + random.uniform(5, 20)
                threading.Timer(random.uniform(5, 20), lambda: a.hangup(frm.n)).start()

    def console_help(self):
        return super().console_help() + [
            "icoms                intercoms this Trunk Master knows",
            "trunks               trunk table and states",
            "call <fromAlpha4> <fromPort> <toAlpha4> <toPort>   allocate a trunk (noTrunksTrap if none)",
            "hangup <tkNum>       release a trunk",
            "oos <tkNum> | maint <tkNum> | idle <tkNum>   force a trunk state",
            "standby on|off       pretend the other Trunk Master appears/disappears (otStatusChgd)",
            "clear-errors         reset error counters (tmErrorsCleared)",
            "errors <icomIndex> <n>   inject n comm errors (icomErrorRateExceeded if over threshold)",
        ]

    def console_command(self, argv):
        cmd, a = argv[0].lower(), argv[1:]
        if cmd == "icoms":
            return "\n".join("%3d %-4s %-8s ports=%-4d talking=%s" % (n, mx.alpha4, mx.alpha8, mx.nports, "yes" if mx.online else "NO")
                             for n, mx in enumerate(self.icoms, 1)) or "(no matrices spawned)"
        if cmd == "trunks":
            return "\n".join("tk%-4d %s:%d <-> %s:%d  %-17s %s" % (
                tk, self.icoms[t["from_icom"] - 1].alpha4, t["from_port"], self.icoms[t["to_icom"] - 1].alpha4, t["to_port"],
                t["state"], ("%s:%d->%s:%d" % t["users"]) if t["users"] else "") for tk, t in sorted(self.trunks.items())) or "(no trunks)"
        if cmd == "call" and len(a) >= 4:
            return self.request_trunk(a[0], int(a[1]), a[2], int(a[3]))[1]
        if cmd == "hangup" and a:
            return self.release_trunk(int(a[0]))
        if cmd in ("oos", "maint", "idle") and a:
            t = self.trunks.get(int(a[0]))
            if not t:
                return "no trunk %s" % a[0]
            t.update(state={"oos": "outOfService", "maint": "inMaintenanceMode", "idle": "idle"}[cmd], since=time.time(), users=None)
            return "trunk %s -> %s" % (a[0], t["state"])
        if cmd == "standby" and a:
            self.other_present = a[0].lower() in ("on", "1", "yes", "true")
            self.trap("otStatusChgd", [("otPresent", 0, truth(self.other_present))])
            return "other Trunk Master present=%s" % self.other_present
        if cmd == "clear-errors":
            self.errors_cleared_at = time.time()
            for n in range(1, len(self.icoms) + 1):
                for col in ("isErrorsFrom", "isErrorsTo", "isErrorRateFrom", "isErrorRateTo"):
                    self.set(col, n, 0)
            return "error counters cleared"
        if cmd == "errors" and len(a) >= 2:
            n, cnt = int(a[0]), int(a[1])
            self.bump("isErrorsFrom", n, cnt)
            rate = min(255, self.get("isErrorRateFrom", n) + cnt)
            self.set("isErrorRateFrom", n, rate)
            if rate > self.get("icomThreshValue"):
                self.trap("icomErrorRateExceeded", [("isErrorRateFrom", n, rate), ("isErrorRateTo", n, self.get("isErrorRateTo", n))])
                return "intercom %d error rate %d exceeds threshold %d (trap sent)" % (n, rate, self.get("icomThreshValue"))
            return "intercom %d error rate now %d" % (n, rate)
        return super().console_command(argv)

    def summary(self):
        states = {}
        for t in self.trunks.values():
            states[t["state"]] = states.get(t["state"], 0) + 1
        return super().summary() + "  icoms=%d trunks=%d %s" % (len(self.icoms), len(self.trunks), states)

    def map_state(self):
        s = super().map_state()
        s.update(icoms=[mx.alpha4 for mx in self.icoms], trunks=len(self.trunks),
                 trunks_in_use=sum(1 for t in self.trunks.values() if t["state"] == "inUse"),
                 calls=[{"from": "%s:%d" % (t["users"][0], t["users"][1]), "to": "%d" % t["users"][3], "remote": t["users"][2], "since": t["since"]}
                        for t in self.trunks.values() if t["state"] == "inUse" and t["users"]])
        return s
