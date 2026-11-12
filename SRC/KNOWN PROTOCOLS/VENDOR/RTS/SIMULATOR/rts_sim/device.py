"""Device model: one pretend box (OID store + SNMP agent + console).

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import random
import socket
import threading
import time
from .ber import (
    ERR_BADVALUE,
    ERR_NOERROR,
    ERR_NOSUCHNAME,
    ERR_NOTWRITABLE,
    ERR_READONLY,
    ERR_WRONGTYPE,
    PDU_GET,
    PDU_GETBULK,
    PDU_GETNEXT,
    PDU_RESPONSE,
    PDU_SET,
    PDU_TRAPV2,
    TAG_ENDOFMIB,
    TAG_NAMES,
    TAG_NOSUCHINST,
    TAG_NOSUCHOBJ,
    TAG_NULL,
    TAG_OID,
    TAG_TIMETICKS,
    build_message,
    fmt_value,
    oid_parse,
    parse_message,
)
from .mib import SYS_OIDS


# =============================================================================
# Device model
# =============================================================================
TRUE, FALSE = 1, 2


def truth(b):
    return TRUE if b else FALSE


def alpha_bytes(text, size):
    return text.encode("utf-8")[:size].ljust(size, b" ")


class Device:
    """One pretend box: an OID store + SNMP agent + console."""

    def __init__(self, estate, cfg):
        self.estate, self.mib, self.cfg = estate, estate.mib, cfg
        self.name, self.dtype, self.subtype = cfg["name"], cfg["type"], cfg.get("subtype", "")
        self.snmp_port = int(cfg["snmp_port"])
        self.console_port = int(cfg.get("console_port", 0) or 0)
        self.community = cfg.get("community", estate.community)
        self.bind = cfg.get("bind", estate.bind)
        self.lat, self.lon = cfg.get("lat"), cfg.get("lon")
        self.coverage_m = cfg.get("coverage_m")          # radius of the coloured coverage area on the map
        self.coverage = cfg.get("coverage")              # or a polygon: [[lat, lon], ...] of the building
        self.color = cfg.get("color")                    # coverage colour; estate assigns one if missing
        self.city, self.country, self.continent = cfg.get("city"), cfg.get("country"), cfg.get("continent")
        self.iso2, self.site_kind, self.parent = cfg.get("iso2"), cfg.get("site_kind", "capital"), cfg.get("parent")
        self.vendor = cfg.get("vendor", estate.vendor)
        self.location = cfg.get("location") or (", ".join(x for x in (self.city, self.country) if x) or "Trunk-Caster lab")
        self.contact = cfg.get("contact", "simulator")
        self.start = time.time()
        self.lock = threading.RLock()
        self.store, self._sorted = {}, None
        self.stats = {"in": 0, "out": 0, "badcomm": 0}
        self.log = estate.log
        self.online = True
        self.populate_system()

    # ---- OID store ----------------------------------------------------------
    def uptime_ticks(self):
        return int((time.time() - self.start) * 100) & 0xFFFFFFFF

    @staticmethod
    def _idx(index):
        return tuple(index if isinstance(index, (tuple, list)) else (index,))

    def put(self, name, index, value, writable=False, tag=None):
        oid = self.mib.oid(name) + self._idx(index)
        with self.lock:
            self.store[oid] = [tag if tag is not None else self.mib.tag_for(name), value, writable]
            self._sorted = None
        return oid

    def get(self, name, index=(0,)):
        e = self.store.get(self.mib.oid(name) + self._idx(index))
        return None if e is None else (e[1]() if callable(e[1]) else e[1])

    def set(self, name, index, value):
        with self.lock:
            self.store[self.mib.oid(name) + self._idx(index)][1] = value

    def bump(self, name, index, by=1):
        with self.lock:
            e = self.store.get(self.mib.oid(name) + self._idx(index))
            if e:
                e[1] = (e[1] + by) & 0xFFFFFFFF

    def sorted_oids(self):
        with self.lock:
            if self._sorted is None:
                self._sorted = sorted(self.store)
            return self._sorted

    def read(self, oid):
        e = self.store.get(oid)
        if e is None:
            return None
        return e[0], (e[1]() if callable(e[1]) else e[1])

    def next_oid(self, oid):
        keys = self.sorted_oids()
        lo, hi = 0, len(keys)
        while lo < hi:
            mid = (lo + hi) // 2
            if keys[mid] <= oid:
                lo = mid + 1
            else:
                hi = mid
        return keys[lo] if lo < len(keys) else None

    def exists_prefix(self, oid):
        for n in range(len(oid), 0, -1):
            if oid[:n] in self.mib.by_oid:
                return self.mib.by_oid[oid[:n]].kind in ("column", "scalar")
            if oid[:n] in SYS_OIDS.values():
                return True
        return False

    # ---- system group -------------------------------------------------------
    def sys_object_id(self):
        return self.mib.oid("objIdMtx1Frame")

    def sys_descr(self):
        return "Pretend %s (%s) - Trunk-Caster simulator" % (self.dtype, self.subtype or "generic")

    def populate_system(self):
        self.put("sysDescr", 0, self.sys_descr())
        self.put("sysObjectID", 0, self.sys_object_id())
        self.put("sysUpTime", 0, self.uptime_ticks)
        self.put("sysContact", 0, self.contact, writable=True)
        self.put("sysName", 0, self.name, writable=True)
        self.put("sysLocation", 0, self.location, writable=True)
        self.put("sysServices", 0, 72)
        self.put("snmpInPkts", 0, lambda: self.stats["in"])
        self.put("snmpOutPkts", 0, lambda: self.stats["out"])
        self.put("snmpInBadCommunityNames", 0, lambda: self.stats["badcomm"])
        self.put("snmpEnableAuthenTraps", 0, 2)

    # ---- SNMP agent -----------------------------------------------------------
    def serve_snmp(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((self.bind, self.snmp_port))
        except OSError as exc:
            self.log("%s: cannot bind SNMP udp/%d (%s); SNMP off for this device" % (self.name, self.snmp_port, exc))
            return
        sock.settimeout(0.5)
        while not self.estate.stop.is_set():
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            if not self.online:
                continue          # an offline frame does not answer
            try:
                resp = self.handle(data, addr)
                if resp:
                    sock.sendto(resp, addr)
                    self.stats["out"] += 1
            except Exception as exc:
                self.log("%s: bad SNMP packet from %s:%d (%s)" % (self.name, addr[0], addr[1], exc))
        sock.close()

    def handle(self, data, addr):
        self.stats["in"] += 1
        version, community, pdu, req_id, f1, f2, vbs = parse_message(data)
        if community != self.community:
            self.stats["badcomm"] += 1
            self.log("%s: wrong community '%s' from %s" % (self.name, community, addr[0]))
            return None
        v1 = (version == 0)
        out, err, err_idx = [], ERR_NOERROR, 0

        if pdu == PDU_GET:
            for i, (oid, _, _) in enumerate(vbs, 1):
                r = self.read(oid)
                if r is None:
                    if v1:
                        err, err_idx = ERR_NOSUCHNAME, i
                        out.append((oid, TAG_NULL, None))
                    else:
                        out.append((oid, TAG_NOSUCHINST if self.exists_prefix(oid) else TAG_NOSUCHOBJ, None))
                else:
                    out.append((oid, r[0], r[1]))
        elif pdu == PDU_GETNEXT:
            for i, (oid, _, _) in enumerate(vbs, 1):
                nxt = self.next_oid(oid)
                if nxt is None:
                    if v1:
                        err, err_idx = ERR_NOSUCHNAME, i
                        out.append((oid, TAG_NULL, None))
                    else:
                        out.append((oid, TAG_ENDOFMIB, None))
                else:
                    t, v = self.read(nxt)
                    out.append((nxt, t, v))
        elif pdu == PDU_GETBULK and not v1:
            non_rep, max_rep = max(0, f1), max(0, min(f2, 200))
            for oid, _, _ in vbs[:non_rep]:
                nxt = self.next_oid(oid)
                if nxt is None:
                    out.append((oid, TAG_ENDOFMIB, None))
                else:
                    t, v = self.read(nxt)
                    out.append((nxt, t, v))
            cursors = [oid for oid, _, _ in vbs[non_rep:]]
            for _ in range(max_rep):
                progressed = False
                for k, cur in enumerate(cursors):
                    if cur is None:
                        continue
                    nxt = self.next_oid(cur)
                    if nxt is None:
                        out.append((cur, TAG_ENDOFMIB, None))
                        cursors[k] = None
                    else:
                        t, v = self.read(nxt)
                        out.append((nxt, t, v))
                        cursors[k] = nxt
                        progressed = True
                if not progressed:
                    break
        elif pdu == PDU_SET:
            for i, (oid, tag, val) in enumerate(vbs, 1):
                e = self.store.get(oid)
                if e is None:
                    err, err_idx = (ERR_NOSUCHNAME if v1 else ERR_NOTWRITABLE), i
                    break
                if not e[2]:
                    err, err_idx = (ERR_READONLY if v1 else ERR_NOTWRITABLE), i
                    break
                if tag != e[0]:
                    err, err_idx = (ERR_BADVALUE if v1 else ERR_WRONGTYPE), i
                    break
            if err == ERR_NOERROR:
                with self.lock:
                    for oid, tag, val in vbs:
                        self.store[oid][1] = val
                        self.log("%s: SET %s = %s" % (self.name, self.mib.lookup(oid), fmt_value(tag, val)))
            out = [(oid, tag, val) for oid, tag, val in vbs]
        else:
            return None
        return build_message(version, community, PDU_RESPONSE, req_id, err, err_idx, out)

    # ---- traps ----------------------------------------------------------------
    def trap(self, notification_name, varbinds=()):
        if not self.estate.trap_targets:
            return
        vbs = [(SYS_OIDS["sysUpTime"] + (0,), TAG_TIMETICKS, self.uptime_ticks()),
               (SYS_OIDS["snmpTrapOID"] + (0,), TAG_OID, self.mib.oid(notification_name))]
        for name, index, value in varbinds:
            vbs.append((self.mib.oid(name) + self._idx(index), self.mib.tag_for(name), value))
        msg = build_message(1, self.community, PDU_TRAPV2, random.randint(1, 2 ** 30), 0, 0, vbs)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for host, port in self.estate.trap_targets:
            try:
                s.sendto(msg, (host, port))
            except OSError as exc:
                self.log("%s: trap to %s:%d failed (%s)" % (self.name, host, port, exc))
        s.close()
        self.log("%s: TRAP %s" % (self.name, notification_name))

    # ---- console ----------------------------------------------------------------
    def serve_console(self):
        if not self.console_port:
            return
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind((self.bind, self.console_port))
        except OSError as exc:
            self.log("%s: cannot bind console tcp/%d (%s); console off for this device" % (self.name, self.console_port, exc))
            return
        srv.listen(4)
        srv.settimeout(0.5)
        while not self.estate.stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self.console_session, args=(conn,), daemon=True).start()
        srv.close()

    def console_session(self, conn):
        def send(txt):
            try:
                conn.sendall((txt + "\r\n").encode("utf-8", "replace"))
            except OSError:
                pass
        send("%s  [%s/%s]  pretend RTS console. Type 'help'." % (self.name, self.dtype, self.subtype or "-"))
        buf = b""
        try:
            while not self.estate.stop.is_set():
                try:
                    conn.sendall(("%s> " % self.name).encode())
                except OSError:
                    break
                while b"\n" not in buf:
                    chunk = conn.recv(1024)
                    if not chunk:
                        return
                    buf += chunk
                line, _, buf = buf.partition(b"\n")
                line = line.decode("utf-8", "replace").strip()
                if not line:
                    continue
                if line.lower() in ("quit", "exit", "bye"):
                    send("bye")
                    return
                try:
                    reply = self.console_command(line.split())
                except Exception as exc:
                    reply = "error: %s" % exc
                for ln in (reply or "ok").splitlines():
                    send(ln)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def console_help(self):
        return ["help                 this list",
                "show                 device summary",
                "walk [prefix]        dump this device's OID store",
                "sysname <text>       change sysName",
                "geo <lat> <lon>      move this device on the map",
                "coverage <metres>    radius of the coloured coverage area on the map",
                "color <#rrggbb>      coverage colour",
                "offline | online     stop/start answering (SNMP and Trunk Master)",
                "trap <notification>  fire a raw notification by MIB name (e.g. warmStart)",
                "quit"]

    def console_command(self, argv):
        cmd, a = argv[0].lower(), argv[1:]
        if cmd == "help":
            return "\n".join(self.console_help())
        if cmd == "show":
            return self.summary()
        if cmd == "walk":
            prefix = oid_parse(a[0]) if a else ()
            lines = []
            for oid in self.sorted_oids():
                if oid[:len(prefix)] != prefix:
                    continue
                t, v = self.read(oid)
                lines.append("%-40s %-10s %s" % (self.mib.lookup(oid), TAG_NAMES.get(t, "?"), fmt_value(t, v)))
            return "\n".join(lines) or "(nothing under that prefix)"
        if cmd == "sysname" and a:
            self.set("sysName", 0, " ".join(a))
            return "sysName = %s" % " ".join(a)
        if cmd == "geo" and len(a) >= 2:
            self.lat, self.lon = float(a[0]), float(a[1])
            return "now at %.5f, %.5f" % (self.lat, self.lon)
        if cmd == "coverage" and a:
            self.coverage_m, self.coverage = float(a[0]), None
            return "coverage radius %s m" % a[0]
        if cmd == "color" and a:
            self.color = a[0]
            return "coverage colour %s" % a[0]
        if cmd in ("offline", "online"):
            self.set_online(cmd == "online")
            return "%s is now %s" % (self.name, cmd)
        if cmd == "trap" and a:
            self.trap(a[0])
            return "sent %s" % a[0]
        return "unknown command '%s' (try help)" % cmd

    def set_online(self, on):
        self.online = on

    def summary(self):
        return "%s  type=%s subtype=%s snmp=udp/%d console=tcp/%d community=%s online=%s uptime=%.0fs objects=%d" % (
            self.name, self.dtype, self.subtype, self.snmp_port, self.console_port, self.community, self.online,
            time.time() - self.start, len(self.store))

    def tick(self):
        pass

    def map_state(self):
        return {"name": self.name, "type": self.dtype, "subtype": self.subtype, "lat": self.lat, "lon": self.lon,
                "online": self.online, "snmp_port": self.snmp_port, "console_port": self.console_port,
                "coverage_m": self.coverage_m, "coverage": self.coverage, "color": self.color,
                "city": self.city, "country": self.country, "continent": self.continent, "vendor": self.vendor,
                "iso2": self.iso2, "site_kind": self.site_kind, "parent": self.parent,
                "local_hour": self.local_hour()}

    def local_hour(self):
        """Solar local time from longitude, as a decimal hour (used for noon / evening traffic)."""
        if self.lon is None:
            return None
        utc = time.gmtime()
        return round((utc.tm_hour + utc.tm_min / 60.0 + self.lon / 15.0) % 24.0, 2)
