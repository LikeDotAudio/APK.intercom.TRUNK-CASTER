#!/usr/bin/env python3
"""
rts_intercom_sim.py  --  a stand-alone, pretend RTS / Telex intercom estate.

Standard library only for SNMP, console and map.  Audio mixing uses numpy if
it is installed (it is optional; without it the audio port is simply off).

What it does
------------
* Parses every *.mib file in ../SNMP (by the module name INSIDE the file, so
  mislabeled filenames do not matter) and builds the Telex OID tree.
* Spawns any number of pretend devices, each with its own SNMP agent (v1/v2c:
  GET, GETNEXT, GETBULK, SET) and a small TCP "console" you can telnet into.
* Device types
    matrix   ADAM / Cronus / Zeus-III frame with a PORT PLAN (panels, cameras,
             lighting, audio, field, IFB, wireless).  Every talk-capable port
             gets a generated pretend panel (8 keys) and a tone generator, so
             you can hear who is calling.  Speaks the Trunk-Caster audio
             protocol (TRUNK-SIMULATOR/tc_protocol.py) on its audio port so
             your computer can join as a port.
    rvon     RVON-1 / RVON-8 / RVON-C / RVON-I/O / RVON-16 VoIP device
    tm2000   TM-2000 Trunk Master: knows every spawned matrix, defines trunks
             between them, tracks trunk usage, raises noTrunksTrap.
* Sends SNMPv2c traps to any trap targets you configure.
* Serves a live GeoJSON map (http://127.0.0.1:8080/) with every intercom as a
  marker, trunk calls as lines, and a bottom-right counter of users and users
  making calls.
* Built-in walk/get client and trap listener for testing with nothing else.

Quick start
-----------
    python rts_intercom_sim.py                      (default estate)
    python rts_intercom_sim.py --walk 127.0.0.1:16101
    python rts_intercom_sim.py --trap-listener 16200
    telnet 127.0.0.1 17101          then: help, plan, calls, talk 1 25
    open http://127.0.0.1:8080/
    python ../../TRUNK-SIMULATOR/trunk_panel.py --matrix 127.0.0.1:18100
"""
import argparse
import glob
import json
import math
import os
import random
import re
import selectors
import socket
import sys
import threading
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_up(folder_name, start=HERE, levels=6):
    """Walk up from this file until a folder with that name is found (the repo moves things around)."""
    d = start
    for _ in range(levels):
        d = os.path.dirname(d)
        cand = os.path.join(d, folder_name)
        if os.path.isdir(cand):
            return cand
    return os.path.normpath(os.path.join(start, "..", "..", folder_name))


TRUNK_SIM_DIR = _find_up("TRUNK-SIMULATOR")
if TRUNK_SIM_DIR not in sys.path:
    sys.path.insert(0, TRUNK_SIM_DIR)
try:
    import tc_protocol as tcp
    from tc_map import MapServer, local_tz_label, iso_now
except ImportError:  # the shared modules live in ../../TRUNK-SIMULATOR
    tcp = None
    MapServer = None

    def local_tz_label():
        return time.strftime("%Z")

    def iso_now():
        return time.strftime("%Y-%m-%dT%H:%M:%S%z")

try:
    import numpy as np
except ImportError:
    np = None

# =============================================================================
# BER / SNMP wire encoding
# =============================================================================
TAG_INT, TAG_OCTSTR, TAG_NULL, TAG_OID, TAG_SEQ = 0x02, 0x04, 0x05, 0x06, 0x30
TAG_IPADDR, TAG_COUNTER32, TAG_GAUGE32, TAG_TIMETICKS, TAG_COUNTER64 = 0x40, 0x41, 0x42, 0x43, 0x46
TAG_NOSUCHOBJ, TAG_NOSUCHINST, TAG_ENDOFMIB = 0x80, 0x81, 0x82
PDU_GET, PDU_GETNEXT, PDU_RESPONSE, PDU_SET = 0xA0, 0xA1, 0xA2, 0xA3
PDU_TRAPV1, PDU_GETBULK, PDU_INFORM, PDU_TRAPV2 = 0xA4, 0xA5, 0xA6, 0xA7

ERR_NOERROR, ERR_TOOBIG, ERR_NOSUCHNAME, ERR_BADVALUE, ERR_READONLY, ERR_GENERR = 0, 1, 2, 3, 4, 5
ERR_NOACCESS, ERR_WRONGTYPE, ERR_NOTWRITABLE = 6, 7, 17

TAG_NAMES = {TAG_INT: "INTEGER", TAG_OCTSTR: "STRING", TAG_NULL: "NULL", TAG_OID: "OID",
             TAG_IPADDR: "IpAddress", TAG_COUNTER32: "Counter32", TAG_GAUGE32: "Gauge32",
             TAG_TIMETICKS: "Timeticks", TAG_COUNTER64: "Counter64",
             TAG_NOSUCHOBJ: "noSuchObject", TAG_NOSUCHINST: "noSuchInstance", TAG_ENDOFMIB: "endOfMibView"}


def ber_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def tlv(tag, payload):
    return bytes([tag]) + ber_len(len(payload)) + payload


def enc_int(v, tag=TAG_INT):
    v = int(v)
    if tag == TAG_INT:
        n = max(1, (v.bit_length() + 8) // 8)
        b = v.to_bytes(n, "big", signed=True)
        while len(b) > 1 and ((b[0] == 0x00 and b[1] < 0x80) or (b[0] == 0xFF and b[1] >= 0x80)):
            b = b[1:]
        return tlv(tag, b)
    v &= 0xFFFFFFFFFFFFFFFF if tag == TAG_COUNTER64 else 0xFFFFFFFF
    b = v.to_bytes(max(1, (v.bit_length() + 7) // 8), "big")
    if b[0] & 0x80:
        b = b"\x00" + b
    return tlv(tag, b)


def enc_oid(oid):
    oid = tuple(oid)
    if len(oid) < 2:
        oid = oid + (0,) * (2 - len(oid))
    out = bytearray([40 * oid[0] + oid[1]])
    for sub in oid[2:]:
        if sub < 0x80:
            out.append(sub)
        else:
            chunk = []
            while sub:
                chunk.append(sub & 0x7F)
                sub >>= 7
            chunk.reverse()
            out.extend([c | 0x80 for c in chunk[:-1]] + [chunk[-1]])
    return tlv(TAG_OID, bytes(out))


def enc_value(tag, v):
    if tag in (TAG_INT, TAG_COUNTER32, TAG_GAUGE32, TAG_TIMETICKS, TAG_COUNTER64):
        return enc_int(v, tag)
    if tag == TAG_OCTSTR:
        return tlv(TAG_OCTSTR, v if isinstance(v, (bytes, bytearray)) else str(v).encode("utf-8"))
    if tag == TAG_IPADDR:
        return tlv(TAG_IPADDR, socket.inet_aton(v) if isinstance(v, str) else bytes(v))
    if tag == TAG_OID:
        return enc_oid(v)
    if tag in (TAG_NULL, TAG_NOSUCHOBJ, TAG_NOSUCHINST, TAG_ENDOFMIB):
        return tlv(tag, b"")
    raise ValueError("cannot encode tag 0x%02x" % tag)


def dec_tlv(buf, pos=0):
    tag = buf[pos]
    pos += 1
    length = buf[pos]
    pos += 1
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(buf[pos:pos + n], "big")
        pos += n
    return tag, buf[pos:pos + length], pos + length


def dec_seq(payload):
    items, pos = [], 0
    while pos < len(payload):
        tag, body, pos = dec_tlv(payload, pos)
        items.append((tag, body))
    return items


def dec_int(payload, signed=True):
    return int.from_bytes(payload, "big", signed=signed) if payload else 0


def dec_oid(payload):
    if not payload:
        return ()
    first = payload[0]
    oid = [first // 40, first % 40] if first < 128 else [2, first - 80]
    v = 0
    for b in payload[1:]:
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            oid.append(v)
            v = 0
    return tuple(oid)


def dec_value(tag, body):
    if tag == TAG_INT:
        return dec_int(body, True)
    if tag in (TAG_COUNTER32, TAG_GAUGE32, TAG_TIMETICKS, TAG_COUNTER64):
        return dec_int(body, False)
    if tag == TAG_OCTSTR:
        return bytes(body)
    if tag == TAG_OID:
        return dec_oid(body)
    if tag == TAG_IPADDR:
        return socket.inet_ntoa(bytes(body)) if len(body) == 4 else bytes(body)
    return None


def parse_message(data):
    """-> version, community, pdu_tag, request_id, f1, f2, [(oid, tag, value), ...]"""
    _, body, _ = dec_tlv(data)
    items = dec_seq(body)
    version = dec_int(items[0][1])
    community = items[1][1].decode("latin-1")
    pdu_tag, pdu_body = items[2]
    f = dec_seq(pdu_body)
    req_id, f1, f2 = dec_int(f[0][1]), dec_int(f[1][1]), dec_int(f[2][1])
    varbinds = []
    for _, vb in dec_seq(f[3][1]):
        parts = dec_seq(vb)
        oid = dec_oid(parts[0][1])
        vtag, vbody = parts[1]
        varbinds.append((oid, vtag, dec_value(vtag, vbody)))
    return version, community, pdu_tag, req_id, f1, f2, varbinds


def build_message(version, community, pdu_tag, req_id, f1, f2, varbinds):
    vbs = b"".join(tlv(TAG_SEQ, enc_oid(o) + enc_value(t, v)) for o, t, v in varbinds)
    pdu = tlv(pdu_tag, enc_int(req_id) + enc_int(f1) + enc_int(f2) + tlv(TAG_SEQ, vbs))
    return tlv(TAG_SEQ, enc_int(version) + tlv(TAG_OCTSTR, community.encode("latin-1")) + pdu)


def oid_str(oid):
    return ".".join(str(x) for x in oid)


def oid_parse(s):
    s = s.strip().lstrip(".")
    return tuple(int(x) for x in s.split(".")) if s else ()


def fmt_value(tag, v):
    if tag == TAG_OCTSTR:
        try:
            txt = v.decode("utf-8")
            if all(32 <= ord(c) < 127 for c in txt):
                return '"%s"' % txt
        except Exception:
            pass
        return "hex:" + v.hex()
    if tag == TAG_OID:
        return oid_str(v)
    if tag == TAG_TIMETICKS:
        return "%d (%.2f s)" % (v, v / 100.0)
    return str(v)


# =============================================================================
# Tiny MIB parser  (enough for the Telex SMIv2 files)
# =============================================================================
WELL_KNOWN = {
    "iso": (1,), "org": (1, 3), "dod": (1, 3, 6), "internet": (1, 3, 6, 1),
    "mgmt": (1, 3, 6, 1, 2), "mib-2": (1, 3, 6, 1, 2, 1), "system": (1, 3, 6, 1, 2, 1, 1),
    "interfaces": (1, 3, 6, 1, 2, 1, 2), "snmp": (1, 3, 6, 1, 2, 1, 11),
    "experimental": (1, 3, 6, 1, 3), "private": (1, 3, 6, 1, 4), "enterprises": (1, 3, 6, 1, 4, 1),
    "snmpV2": (1, 3, 6, 1, 6), "snmpModules": (1, 3, 6, 1, 6, 3), "snmpMIB": (1, 3, 6, 1, 6, 3, 1),
    "snmpMIBObjects": (1, 3, 6, 1, 6, 3, 1, 1), "snmpTraps": (1, 3, 6, 1, 6, 3, 1, 1, 5),
}

SYS_OIDS = {
    "sysDescr": (1, 3, 6, 1, 2, 1, 1, 1), "sysObjectID": (1, 3, 6, 1, 2, 1, 1, 2),
    "sysUpTime": (1, 3, 6, 1, 2, 1, 1, 3), "sysContact": (1, 3, 6, 1, 2, 1, 1, 4),
    "sysName": (1, 3, 6, 1, 2, 1, 1, 5), "sysLocation": (1, 3, 6, 1, 2, 1, 1, 6),
    "sysServices": (1, 3, 6, 1, 2, 1, 1, 7),
    "snmpInPkts": (1, 3, 6, 1, 2, 1, 11, 1), "snmpOutPkts": (1, 3, 6, 1, 2, 1, 11, 2),
    "snmpInBadCommunityNames": (1, 3, 6, 1, 2, 1, 11, 4), "snmpEnableAuthenTraps": (1, 3, 6, 1, 2, 1, 11, 30),
    "snmpTrapOID": (1, 3, 6, 1, 6, 3, 1, 1, 4, 1), "coldStart": (1, 3, 6, 1, 6, 3, 1, 1, 5, 1),
    "warmStart": (1, 3, 6, 1, 6, 3, 1, 1, 5, 2),
}
SYS_TAGS = {"sysDescr": TAG_OCTSTR, "sysObjectID": TAG_OID, "sysUpTime": TAG_TIMETICKS, "sysContact": TAG_OCTSTR,
            "sysName": TAG_OCTSTR, "sysLocation": TAG_OCTSTR, "sysServices": TAG_INT,
            "snmpInPkts": TAG_COUNTER32, "snmpOutPkts": TAG_COUNTER32, "snmpInBadCommunityNames": TAG_COUNTER32,
            "snmpEnableAuthenTraps": TAG_INT, "snmpTrapOID": TAG_OID}


class MibObject:
    __slots__ = ("name", "module", "parent", "sub", "kind", "syntax", "access", "index", "description", "oid")

    def __init__(self, name, module, parent, sub, kind, syntax="", access="", index=None, description=""):
        self.name, self.module, self.parent, self.sub, self.kind = name, module, parent, int(sub), kind
        self.syntax, self.access, self.index, self.description, self.oid = syntax, access, index or [], description, None


class TextualConvention:
    __slots__ = ("name", "module", "base", "enum")

    def __init__(self, name, module, base, enum):
        self.name, self.module, self.base, self.enum = name, module, base, enum


def strip_comments(text):
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '"':
                in_str = False
            i += 1
        elif c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif text.startswith("--", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        else:
            out.append(c)
            i += 1
    return "".join(out)


class Mib:
    """All modules in a folder merged into one name space."""

    def __init__(self):
        self.objects, self.tcs, self.modules, self.by_oid, self.warnings = {}, {}, {}, {}, []

    def load_folder(self, folder):
        paths = []
        for pat in ("*.mib", "*.txt", "*.my"):
            paths += glob.glob(os.path.join(folder, pat))
        for path in sorted(paths):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    self.load_text(fh.read(), os.path.basename(path))
            except Exception as exc:
                self.warnings.append("%s: %s" % (os.path.basename(path), exc))
        self.resolve()
        return self

    def load_text(self, text, filename="<text>"):
        text = strip_comments(text)
        m = re.search(r"^\s*([\w-]+)\s+DEFINITIONS\s*::=\s*BEGIN", text, re.M)
        module = m.group(1) if m else filename
        self.modules[module] = filename

        for m in re.finditer(r"^\s*([\w-]+)\s+OBJECT IDENTIFIER\s*::=\s*\{\s*([\w-]+)\s+(\d+)\s*\}", text, re.M):
            self.objects[m.group(1)] = MibObject(m.group(1), module, m.group(2), m.group(3), "node")
        for m in re.finditer(r"^\s*([\w-]+)\s+MODULE-IDENTITY\b.*?::=\s*\{\s*([\w-]+)\s+(\d+)\s*\}", text, re.M | re.S):
            self.objects[m.group(1)] = MibObject(m.group(1), module, m.group(2), m.group(3), "module")
        for m in re.finditer(r"^\s*([\w-]+)\s+(OBJECT-TYPE|NOTIFICATION-TYPE|AGENT-CAPABILITIES|MODULE-COMPLIANCE|OBJECT-GROUP|NOTIFICATION-GROUP)\b(.*?)::=\s*\{\s*([\w-]+)\s+(\d+)\s*\}", text, re.M | re.S):
            name, macro, body, parent, sub = m.groups()
            if macro != "OBJECT-TYPE":
                kind = "notification" if macro == "NOTIFICATION-TYPE" else "meta"
                self.objects[name] = MibObject(name, module, parent, sub, kind, description=self._descr(body))
                continue
            syn = re.search(r"SYNTAX\s+(.+?)\s*(?:\n\s*(?:UNITS|MAX-ACCESS|ACCESS|STATUS)\b)", body, re.S)
            syntax = " ".join(syn.group(1).split()) if syn else ""
            acc = re.search(r"(?:MAX-ACCESS|ACCESS)\s+([\w-]+)", body)
            idx = re.search(r"INDEX\s*\{([^}]*)\}", body)
            index = [x.strip() for x in idx.group(1).split(",")] if idx else []
            kind = "table" if syntax.startswith("SEQUENCE OF") else ("row" if index else "column")
            self.objects[name] = MibObject(name, module, parent, sub, kind, syntax, acc.group(1) if acc else "", index, self._descr(body))

        starts = [(m.start(), m.group(1)) for m in re.finditer(r"^\s*([\w-]+)\s*::=\s*TEXTUAL-CONVENTION", text, re.M)]
        for i, (pos, name) in enumerate(starts):
            end = starts[i + 1][0] if i + 1 < len(starts) else len(text)
            chunk = text[pos:end]
            syn = re.search(r"SYNTAX\s+(.*)", chunk, re.S)
            syntax = syn.group(1) if syn else ""
            syntax = re.split(r"\n\s*\n|\nEND\b|\n[\w-]+\s*::=", syntax, maxsplit=1)[0]
            base = re.split(r"[\s({]", syntax.strip(), maxsplit=1)[0]
            enum = {}
            em = re.search(r"\{(.*)\}", syntax, re.S)
            if em and base == "INTEGER":
                for lm in re.finditer(r"([\w-]+)\s*\(\s*(-?\d+)\s*\)", em.group(1)):
                    enum[lm.group(1)] = int(lm.group(2))
            self.tcs[name] = TextualConvention(name, module, base, enum)

    @staticmethod
    def _descr(body):
        m = re.search(r'DESCRIPTION\s+"([^"]*)"', body, re.S)
        return " ".join(m.group(1).split()) if m else ""

    def resolve(self):
        def res(name, depth=0):
            if name in WELL_KNOWN:
                return WELL_KNOWN[name]
            obj = self.objects.get(name)
            if obj is None or depth > 64:
                return None
            if obj.oid is None:
                parent = res(obj.parent, depth + 1)
                obj.oid = None if parent is None else parent + (obj.sub,)
            return obj.oid
        for name, obj in list(self.objects.items()):
            if res(name) is None:
                self.warnings.append("unresolved parent '%s' for %s" % (obj.parent, name))
        for obj in self.objects.values():
            if obj.kind == "column":
                p = self.objects.get(obj.parent)
                if not (p and p.kind == "row"):
                    obj.kind = "scalar"
            if obj.oid is not None:
                self.by_oid[obj.oid] = obj

    def oid(self, name):
        if name in SYS_OIDS:
            return SYS_OIDS[name]
        obj = self.objects.get(name)
        if obj is None or obj.oid is None:
            raise KeyError("MIB object '%s' not found" % name)
        return obj.oid

    def tag_for(self, name):
        if name in SYS_TAGS:
            return SYS_TAGS[name]
        obj = self.objects[name]
        base = re.split(r"[\s({]", obj.syntax.strip(), maxsplit=1)[0] if obj.syntax else "INTEGER"
        seen = set()
        while base in self.tcs and base not in seen:
            seen.add(base)
            base = self.tcs[base].base
        return {"Integer32": TAG_INT, "INTEGER": TAG_INT, "TruthValue": TAG_INT, "OCTET": TAG_OCTSTR,
                "DisplayString": TAG_OCTSTR, "IpAddress": TAG_IPADDR, "Counter32": TAG_COUNTER32,
                "Gauge32": TAG_GAUGE32, "Unsigned32": TAG_GAUGE32, "TimeTicks": TAG_TIMETICKS,
                "Counter64": TAG_COUNTER64, "OBJECT": TAG_OID}.get(base, TAG_INT)

    def enum(self, tc_name, label):
        return self.tcs[tc_name].enum[label]

    def lookup(self, oid):
        oid = tuple(oid)
        for n in range(len(oid), 0, -1):
            obj = self.by_oid.get(oid[:n])
            if obj:
                rest = oid[n:]
                return obj.name + ("." + oid_str(rest) if rest else "")
        for name, o in SYS_OIDS.items():
            if oid[:len(o)] == o:
                return name + ("." + oid_str(oid[len(o):]) if oid[len(o):] else "")
        return oid_str(oid)

    def module_mismatches(self):
        return [(f, m) for m, f in self.modules.items() if os.path.splitext(f)[0].lower() != m.lower()]


# =============================================================================
# Port plan  (the "default 10 types" of things that live on a matrix)
# =============================================================================
PORT_TYPES = {
    #            prefix  human user?  can talk  can listen  description
    "PANEL": dict(prefix="PNL", user=True,  talk=True,  listen=True,  desc="keypanel position"),
    "CAM":   dict(prefix="CAM", user=False, talk=True,  listen=True,  desc="camera headset / CCU"),
    "LIGHT": dict(prefix="LGT", user=False, talk=True,  listen=True,  desc="lighting position"),
    "AUDIO": dict(prefix="AUD", user=False, talk=True,  listen=True,  desc="audio position"),
    "FIELD": dict(prefix="FLD", user=True,  talk=True,  listen=True,  desc="field / remote 4-wire"),
    "IFB":   dict(prefix="IFB", user=False, talk=False, listen=False, desc="IFB feed to talent"),
    "WLESS": dict(prefix="WLS", user=True,  talk=False, listen=True,  desc="wireless licence, monitoring (rx only)"),
    "PL":    dict(prefix="PL",  user=False, talk=False, listen=False, desc="party-line"),
    "TRUNK": dict(prefix="TRK", user=False, talk=False, listen=False, desc="trunk to another intercom"),
    "SPARE": dict(prefix="SPR", user=False, talk=False, listen=False, desc="unassigned"),
}
DEFAULT_PLAN = [["PANEL", 24], ["CAM", 10], ["LIGHT", 8], ["AUDIO", 8], ["FIELD", 8], ["IFB", 24], ["WLESS", 24]]

# One intercom per country capital: 56 of them.  (alpha4, city, country, lat, lon)
WORLD_CAPITALS = [
    ("WASH", "Washington", "United States", 38.9072, -77.0369), ("OTTA", "Ottawa", "Canada", 45.4215, -75.6972),
    ("MEXC", "Mexico City", "Mexico", 19.4326, -99.1332), ("BRAS", "Brasilia", "Brazil", -15.7939, -47.8828),
    ("BUEN", "Buenos Aires", "Argentina", -34.6037, -58.3816), ("SANT", "Santiago", "Chile", -33.4489, -70.6693),
    ("LIMA", "Lima", "Peru", -12.0464, -77.0428), ("BOGO", "Bogota", "Colombia", 4.7110, -74.0721),
    ("LOND", "London", "United Kingdom", 51.5074, -0.1278), ("PARI", "Paris", "France", 48.8566, 2.3522),
    ("BERL", "Berlin", "Germany", 52.5200, 13.4050), ("MADR", "Madrid", "Spain", 40.4168, -3.7038),
    ("LISB", "Lisbon", "Portugal", 38.7223, -9.1393), ("ROME", "Rome", "Italy", 41.9028, 12.4964),
    ("AMST", "Amsterdam", "Netherlands", 52.3676, 4.9041), ("BRUS", "Brussels", "Belgium", 50.8503, 4.3517),
    ("BERN", "Bern", "Switzerland", 46.9480, 7.4474), ("VIEN", "Vienna", "Austria", 48.2082, 16.3738),
    ("PRAG", "Prague", "Czechia", 50.0755, 14.4378), ("WARS", "Warsaw", "Poland", 52.2297, 21.0122),
    ("BUDA", "Budapest", "Hungary", 47.4979, 19.0402), ("STOC", "Stockholm", "Sweden", 59.3293, 18.0686),
    ("OSLO", "Oslo", "Norway", 59.9139, 10.7522), ("COPE", "Copenhagen", "Denmark", 55.6761, 12.5683),
    ("HELS", "Helsinki", "Finland", 60.1699, 24.9384), ("DUBL", "Dublin", "Ireland", 53.3498, -6.2603),
    ("ATHE", "Athens", "Greece", 37.9838, 23.7275), ("ANKA", "Ankara", "Turkey", 39.9334, 32.8597),
    ("MOSC", "Moscow", "Russia", 55.7558, 37.6173), ("KYIV", "Kyiv", "Ukraine", 50.4501, 30.5234),
    ("CAIR", "Cairo", "Egypt", 30.0444, 31.2357), ("NAIR", "Nairobi", "Kenya", -1.2921, 36.8219),
    ("ABUJ", "Abuja", "Nigeria", 9.0765, 7.3986), ("PRET", "Pretoria", "South Africa", -25.7479, 28.2293),
    ("ADDI", "Addis Ababa", "Ethiopia", 9.0300, 38.7400), ("ACCR", "Accra", "Ghana", 5.6037, -0.1870),
    ("RABA", "Rabat", "Morocco", 34.0209, -6.8416), ("RIYA", "Riyadh", "Saudi Arabia", 24.7136, 46.6753),
    ("ABUD", "Abu Dhabi", "United Arab Emirates", 24.4539, 54.3773), ("DOHA", "Doha", "Qatar", 25.2854, 51.5310),
    ("TEHR", "Tehran", "Iran", 35.6892, 51.3890), ("BAGH", "Baghdad", "Iraq", 33.3152, 44.3661),
    ("DELH", "New Delhi", "India", 28.6139, 77.2090), ("ISLA", "Islamabad", "Pakistan", 33.6844, 73.0479),
    ("DHAK", "Dhaka", "Bangladesh", 23.8103, 90.4125), ("BEIJ", "Beijing", "China", 39.9042, 116.4074),
    ("TOKY", "Tokyo", "Japan", 35.6762, 139.6503), ("SEOU", "Seoul", "South Korea", 37.5665, 126.9780),
    ("BANG", "Bangkok", "Thailand", 13.7563, 100.5018), ("HANO", "Hanoi", "Vietnam", 21.0278, 105.8342),
    ("JAKA", "Jakarta", "Indonesia", -6.2088, 106.8456), ("KUAL", "Kuala Lumpur", "Malaysia", 3.1390, 101.6869),
    ("SING", "Singapore", "Singapore", 1.3521, 103.8198), ("MANI", "Manila", "Philippines", 14.5995, 120.9842),
    ("CANB", "Canberra", "Australia", -35.2809, 149.1300), ("WELL", "Wellington", "New Zealand", -41.2865, 174.7762),
]
assert len(WORLD_CAPITALS) == 56

CONTINENT = {}
for _grp, _alphas in {
    "North America": "WASH OTTA MEXC", "South America": "BRAS BUEN SANT LIMA BOGO",
    "Europe": "LOND PARI BERL MADR LISB ROME AMST BRUS BERN VIEN PRAG WARS BUDA STOC OSLO COPE HELS DUBL ATHE ANKA MOSC KYIV",
    "Africa": "CAIR NAIR ABUJ PRET ADDI ACCR RABA", "Middle East": "RIYA ABUD DOHA TEHR BAGH",
    "Asia": "DELH ISLA DHAK BEIJ TOKY SEOU BANG HANO JAKA KUAL SING MANI", "Oceania": "CANB WELL",
}.items():
    for _a in _alphas.split():
        CONTINENT[_a] = _grp
assert len(CONTINENT) == 56

ISO2 = dict(zip([c[0] for c in WORLD_CAPITALS], (
    "us ca mx br ar cl pe co gb fr de es pt it nl be ch at cz pl hu se no dk fi ie gr tr ru ua "
    "eg ke ng za et gh ma sa ae qa ir iq in pk bd cn jp kr th vn id my sg ph au nz").split()))

# Smaller 8x8 frames in every state / provincial capital, hanging off their national capital.
# (parent capital alpha, name, state or province, lat, lon)
SUBSITES = [
    # United States
    ("WASH", "US-AL", "Montgomery, Alabama", 32.3792, -86.3077), ("WASH", "US-AK", "Juneau, Alaska", 58.3019, -134.4197),
    ("WASH", "US-AZ", "Phoenix, Arizona", 33.4484, -112.0740), ("WASH", "US-AR", "Little Rock, Arkansas", 34.7465, -92.2896),
    ("WASH", "US-CA", "Sacramento, California", 38.5816, -121.4944), ("WASH", "US-CO", "Denver, Colorado", 39.7392, -104.9903),
    ("WASH", "US-CT", "Hartford, Connecticut", 41.7658, -72.6734), ("WASH", "US-DE", "Dover, Delaware", 39.1582, -75.5244),
    ("WASH", "US-FL", "Tallahassee, Florida", 30.4383, -84.2807), ("WASH", "US-GA", "Atlanta, Georgia", 33.7490, -84.3880),
    ("WASH", "US-HI", "Honolulu, Hawaii", 21.3069, -157.8583), ("WASH", "US-ID", "Boise, Idaho", 43.6150, -116.2023),
    ("WASH", "US-IL", "Springfield, Illinois", 39.7817, -89.6501), ("WASH", "US-IN", "Indianapolis, Indiana", 39.7684, -86.1581),
    ("WASH", "US-IA", "Des Moines, Iowa", 41.5868, -93.6250), ("WASH", "US-KS", "Topeka, Kansas", 39.0473, -95.6752),
    ("WASH", "US-KY", "Frankfort, Kentucky", 38.2009, -84.8733), ("WASH", "US-LA", "Baton Rouge, Louisiana", 30.4515, -91.1871),
    ("WASH", "US-ME", "Augusta, Maine", 44.3106, -69.7795), ("WASH", "US-MD", "Annapolis, Maryland", 38.9784, -76.4922),
    ("WASH", "US-MA", "Boston, Massachusetts", 42.3601, -71.0589), ("WASH", "US-MI", "Lansing, Michigan", 42.7325, -84.5555),
    ("WASH", "US-MN", "Saint Paul, Minnesota", 44.9537, -93.0900), ("WASH", "US-MS", "Jackson, Mississippi", 32.2988, -90.1848),
    ("WASH", "US-MO", "Jefferson City, Missouri", 38.5767, -92.1735), ("WASH", "US-MT", "Helena, Montana", 46.5891, -112.0391),
    ("WASH", "US-NE", "Lincoln, Nebraska", 40.8136, -96.7026), ("WASH", "US-NV", "Carson City, Nevada", 39.1638, -119.7674),
    ("WASH", "US-NH", "Concord, New Hampshire", 43.2081, -71.5376), ("WASH", "US-NJ", "Trenton, New Jersey", 40.2206, -74.7597),
    ("WASH", "US-NM", "Santa Fe, New Mexico", 35.6870, -105.9378), ("WASH", "US-NY", "Albany, New York", 42.6526, -73.7562),
    ("WASH", "US-NC", "Raleigh, North Carolina", 35.7796, -78.6382), ("WASH", "US-ND", "Bismarck, North Dakota", 46.8083, -100.7837),
    ("WASH", "US-OH", "Columbus, Ohio", 39.9612, -82.9988), ("WASH", "US-OK", "Oklahoma City, Oklahoma", 35.4676, -97.5164),
    ("WASH", "US-OR", "Salem, Oregon", 44.9429, -123.0351), ("WASH", "US-PA", "Harrisburg, Pennsylvania", 40.2732, -76.8867),
    ("WASH", "US-RI", "Providence, Rhode Island", 41.8240, -71.4128), ("WASH", "US-SC", "Columbia, South Carolina", 34.0007, -81.0348),
    ("WASH", "US-SD", "Pierre, South Dakota", 44.3683, -100.3510), ("WASH", "US-TN", "Nashville, Tennessee", 36.1627, -86.7816),
    ("WASH", "US-TX", "Austin, Texas", 30.2672, -97.7431), ("WASH", "US-UT", "Salt Lake City, Utah", 40.7608, -111.8910),
    ("WASH", "US-VT", "Montpelier, Vermont", 44.2601, -72.5754), ("WASH", "US-VA", "Richmond, Virginia", 37.5407, -77.4360),
    ("WASH", "US-WA", "Olympia, Washington", 47.0379, -122.9007), ("WASH", "US-WV", "Charleston, West Virginia", 38.3498, -81.6326),
    ("WASH", "US-WI", "Madison, Wisconsin", 43.0731, -89.4012), ("WASH", "US-WY", "Cheyenne, Wyoming", 41.1400, -104.8202),
    # Canada
    ("OTTA", "CA-ON", "Toronto, Ontario", 43.6532, -79.3832), ("OTTA", "CA-QC", "Quebec City, Quebec", 46.8139, -71.2080),
    ("OTTA", "CA-BC", "Victoria, British Columbia", 48.4284, -123.3656), ("OTTA", "CA-AB", "Edmonton, Alberta", 53.5461, -113.4938),
    ("OTTA", "CA-MB", "Winnipeg, Manitoba", 49.8951, -97.1384), ("OTTA", "CA-SK", "Regina, Saskatchewan", 50.4452, -104.6189),
    ("OTTA", "CA-NS", "Halifax, Nova Scotia", 44.6488, -63.5752), ("OTTA", "CA-NB", "Fredericton, New Brunswick", 45.9636, -66.6431),
    ("OTTA", "CA-NL", "St. John's, Newfoundland and Labrador", 47.5615, -52.7126), ("OTTA", "CA-PE", "Charlottetown, Prince Edward Island", 46.2382, -63.1311),
    ("OTTA", "CA-YT", "Whitehorse, Yukon", 60.7212, -135.0568), ("OTTA", "CA-NT", "Yellowknife, Northwest Territories", 62.4540, -114.3718),
    ("OTTA", "CA-NU", "Iqaluit, Nunavut", 63.7467, -68.5170),
    # Australia
    ("CANB", "AU-NSW", "Sydney, New South Wales", -33.8688, 151.2093), ("CANB", "AU-VIC", "Melbourne, Victoria", -37.8136, 144.9631),
    ("CANB", "AU-QLD", "Brisbane, Queensland", -27.4698, 153.0251), ("CANB", "AU-WA", "Perth, Western Australia", -31.9505, 115.8605),
    ("CANB", "AU-SA", "Adelaide, South Australia", -34.9285, 138.6007), ("CANB", "AU-TAS", "Hobart, Tasmania", -42.8821, 147.3272),
    ("CANB", "AU-NT", "Darwin, Northern Territory", -12.4634, 130.8456),
    # Germany
    ("BERL", "DE-BY", "Munich, Bavaria", 48.1351, 11.5820), ("BERL", "DE-BW", "Stuttgart, Baden-Wurttemberg", 48.7758, 9.1829),
    ("BERL", "DE-NW", "Dusseldorf, North Rhine-Westphalia", 51.2277, 6.7735), ("BERL", "DE-HE", "Wiesbaden, Hesse", 50.0782, 8.2398),
    ("BERL", "DE-NI", "Hanover, Lower Saxony", 52.3759, 9.7320), ("BERL", "DE-SN", "Dresden, Saxony", 51.0504, 13.7373),
    ("BERL", "DE-HH", "Hamburg", 53.5511, 9.9937), ("BERL", "DE-HB", "Bremen", 53.0793, 8.8017),
    ("BERL", "DE-SH", "Kiel, Schleswig-Holstein", 54.3233, 10.1228), ("BERL", "DE-RP", "Mainz, Rhineland-Palatinate", 49.9929, 8.2473),
    ("BERL", "DE-SL", "Saarbrucken, Saarland", 49.2402, 6.9969), ("BERL", "DE-TH", "Erfurt, Thuringia", 50.9848, 11.0299),
    ("BERL", "DE-ST", "Magdeburg, Saxony-Anhalt", 52.1205, 11.6276), ("BERL", "DE-BB", "Potsdam, Brandenburg", 52.3906, 13.0645),
    ("BERL", "DE-MV", "Schwerin, Mecklenburg-Vorpommern", 53.6355, 11.4012),
    # Brazil
    ("BRAS", "BR-SP", "Sao Paulo", -23.5505, -46.6333), ("BRAS", "BR-RJ", "Rio de Janeiro", -22.9068, -43.1729),
    ("BRAS", "BR-MG", "Belo Horizonte, Minas Gerais", -19.9167, -43.9345), ("BRAS", "BR-BA", "Salvador, Bahia", -12.9777, -38.5016),
    ("BRAS", "BR-PE", "Recife, Pernambuco", -8.0476, -34.8770), ("BRAS", "BR-CE", "Fortaleza, Ceara", -3.7319, -38.5267),
    ("BRAS", "BR-PA", "Belem, Para", -1.4558, -48.5039), ("BRAS", "BR-AM", "Manaus, Amazonas", -3.1190, -60.0217),
    ("BRAS", "BR-PR", "Curitiba, Parana", -25.4284, -49.2733), ("BRAS", "BR-RS", "Porto Alegre, Rio Grande do Sul", -30.0346, -51.2177),
    ("BRAS", "BR-SC", "Florianopolis, Santa Catarina", -27.5954, -48.5480), ("BRAS", "BR-GO", "Goiania, Goias", -16.6869, -49.2648),
    ("BRAS", "BR-MT", "Cuiaba, Mato Grosso", -15.6014, -56.0979), ("BRAS", "BR-MS", "Campo Grande, Mato Grosso do Sul", -20.4697, -54.6201),
    ("BRAS", "BR-ES", "Vitoria, Espirito Santo", -20.3155, -40.3128), ("BRAS", "BR-RN", "Natal, Rio Grande do Norte", -5.7945, -35.2110),
    ("BRAS", "BR-PB", "Joao Pessoa, Paraiba", -7.1195, -34.8450), ("BRAS", "BR-AL", "Maceio, Alagoas", -9.6658, -35.7353),
    ("BRAS", "BR-SE", "Aracaju, Sergipe", -10.9472, -37.0731), ("BRAS", "BR-PI", "Teresina, Piaui", -5.0892, -42.8019),
    ("BRAS", "BR-MA", "Sao Luis, Maranhao", -2.5307, -44.3068), ("BRAS", "BR-TO", "Palmas, Tocantins", -10.1840, -48.3336),
    ("BRAS", "BR-RO", "Porto Velho, Rondonia", -8.7612, -63.9004), ("BRAS", "BR-AC", "Rio Branco, Acre", -9.9754, -67.8249),
    ("BRAS", "BR-RR", "Boa Vista, Roraima", 2.8235, -60.6758), ("BRAS", "BR-AP", "Macapa, Amapa", 0.0349, -51.0694),
    # India
    ("DELH", "IN-MH", "Mumbai, Maharashtra", 19.0760, 72.8777), ("DELH", "IN-KA", "Bengaluru, Karnataka", 12.9716, 77.5946),
    ("DELH", "IN-TN", "Chennai, Tamil Nadu", 13.0827, 80.2707), ("DELH", "IN-WB", "Kolkata, West Bengal", 22.5726, 88.3639),
    ("DELH", "IN-TS", "Hyderabad, Telangana", 17.3850, 78.4867), ("DELH", "IN-GJ", "Gandhinagar, Gujarat", 23.2156, 72.6369),
    ("DELH", "IN-RJ", "Jaipur, Rajasthan", 26.9124, 75.7873), ("DELH", "IN-UP", "Lucknow, Uttar Pradesh", 26.8467, 80.9462),
    ("DELH", "IN-MP", "Bhopal, Madhya Pradesh", 23.2599, 77.4126), ("DELH", "IN-BR", "Patna, Bihar", 25.5941, 85.1376),
    ("DELH", "IN-PB", "Chandigarh, Punjab", 30.7333, 76.7794), ("DELH", "IN-KL", "Thiruvananthapuram, Kerala", 8.5241, 76.9366),
    ("DELH", "IN-OD", "Bhubaneswar, Odisha", 20.2961, 85.8245), ("DELH", "IN-AS", "Dispur, Assam", 26.1433, 91.7898),
    ("DELH", "IN-JH", "Ranchi, Jharkhand", 23.3441, 85.3096), ("DELH", "IN-CT", "Raipur, Chhattisgarh", 21.2514, 81.6296),
    ("DELH", "IN-UK", "Dehradun, Uttarakhand", 30.3165, 78.0322), ("DELH", "IN-HP", "Shimla, Himachal Pradesh", 31.1048, 77.1734),
    ("DELH", "IN-GA", "Panaji, Goa", 15.4909, 73.8278), ("DELH", "IN-AP", "Amaravati, Andhra Pradesh", 16.5062, 80.6480),
]
SMALL_PLAN = [["PANEL", 4], ["CAM", 2], ["FIELD", 1], ["IFB", 1]]       # the 8x8 frame

# sub-site k (1..n, table order): SNMP udp 36000+k, console tcp 37000+k, series udp 43000 + 16*k (+0 intercom, +1..+8 ports)
# (43000 rather than 40000: Windows on the lab machine refuses udp/42000)
SUBSITE_SNMP_BASE, SUBSITE_CONSOLE_BASE, SUBSITE_SERIES_BASE, SUBSITE_SERIES_SIZE = 36000, 37000, 43000, 16


def subsite_alpha4(name):
    cc, _, st = name.partition("-")
    return (cc[0] + "-" + st)[:4].ljust(4)


def subsite_ports(k):
    return {"snmp_port": SUBSITE_SNMP_BASE + k, "console_port": SUBSITE_CONSOLE_BASE + k,
            "series": SUBSITE_SERIES_BASE + SUBSITE_SERIES_SIZE * k}

# Every capital has one fixed, unique set of ports no matter which emulator process runs it.
# Capital i (1..56, table order):
#   SNMP     udp 16100 + i
#   console  tcp 17100 + i
#   series   udp 20000 + 256*i  ..  + 255 : the intercom's own socket at +0, one socket per
#            matrix port at +n (n = 1..255).  Only the endpoint that owns port n talks on +n.
WORLD_PORT_BASE = 16100
SERIES_BASE = 20000
SERIES_SIZE = 256


def capital_ports(alpha):
    i = [c[0] for c in WORLD_CAPITALS].index(alpha) + 1
    return {"snmp_port": WORLD_PORT_BASE + i, "console_port": WORLD_PORT_BASE + 1000 + i, "series": SERIES_BASE + SERIES_SIZE * i}


def parse_plan(text):
    """'PANEL=24,CAM=10,...' -> plan list"""
    plan = []
    for part in text.split(","):
        if part.strip():
            t, _, c = part.partition("=")
            plan.append([t.strip().upper(), int(c or 1)])
    return plan


class Port:
    __slots__ = ("n", "ptype", "alpha", "user", "can_talk", "can_listen", "keys", "freq", "endpoint", "phase")

    def __init__(self, n, ptype, alpha):
        info = PORT_TYPES[ptype]
        self.n, self.ptype, self.alpha = n, ptype, alpha
        self.user, self.can_talk, self.can_listen = info["user"], info["talk"], info["listen"]
        self.keys = {}          # key number (1..8) -> target port number  (the generated pretend panel)
        self.freq = 220.0 * 2 ** ((n * 7 % 36) / 12.0)   # each port gets its own identifying tone
        self.endpoint = None    # live external endpoint (your computer) if one has claimed this port
        self.phase = 0.0


def build_ports(plan, overrides=None):
    ports, n = {}, 1
    for ptype, count in plan:
        ptype = ptype.upper()
        if ptype not in PORT_TYPES:
            raise ValueError("unknown port type '%s'; choose from %s" % (ptype, ", ".join(PORT_TYPES)))
        for i in range(1, int(count) + 1):
            alpha = "%s%02d" % (PORT_TYPES[ptype]["prefix"], i)
            if overrides and str(n) in overrides:
                alpha = overrides[str(n)][:8]
            ports[n] = Port(n, ptype, alpha)
            n += 1
    return ports


def generate_panels(ports):
    """Give every talk-capable port 8 keys that make sense for what it is."""
    by_type = {}
    for p in ports.values():
        by_type.setdefault(p.ptype, []).append(p)
    rnd = random.Random(1234)
    for p in ports.values():
        if not p.can_talk:
            continue
        wants = {
            "PANEL": ["CAM", "CAM", "IFB", "IFB", "PANEL", "PANEL", "LIGHT", "AUDIO"],
            "CAM":   ["PANEL", "PANEL", "PANEL", "CAM", "AUDIO", "LIGHT", "PANEL", "IFB"],
            "LIGHT": ["PANEL", "PANEL", "LIGHT", "LIGHT", "CAM", "PANEL", "AUDIO", "FIELD"],
            "AUDIO": ["PANEL", "PANEL", "IFB", "IFB", "AUDIO", "FIELD", "CAM", "PANEL"],
            "FIELD": ["PANEL", "PANEL", "AUDIO", "IFB", "PANEL", "CAM", "FIELD", "PANEL"],
        }.get(p.ptype, ["PANEL"] * 8)
        used, k = set(), 1
        for want in wants:
            pool = [q for q in by_type.get(want, []) if q.n != p.n and q.n not in used] or \
                   [q for q in ports.values() if q.n != p.n and q.n not in used]
            if not pool:
                break
            q = pool[(p.n * 31 + k * 7 + rnd.randint(0, 2)) % len(pool)]
            p.keys[k] = q.n
            used.add(q.n)
            k += 1


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


# -----------------------------------------------------------------------------
class AudioEngine(threading.Thread):
    """The matrix's series of sockets.

    An intercom owns a series of 256 consecutive UDP ports starting at `series`:
        series + 0      the intercom's own socket: HELLO here with port=0 (or a
                        wanted port) and it tells you which socket is yours
        series + n      port n's socket, n = 1..255: one generator, one socket.
                        Only the endpoint that claimed port n is spoken to here.
    Each port socket carries that port's audio both ways, its KEY presses and
    its STATE.  Pretend panels (no endpoint) feed their tone generator into the
    mix when they talk."""

    def __init__(self, matrix, series):
        super().__init__(name=matrix.name + "-audio", daemon=True)
        self.m = matrix
        self.series = int(series)
        self.socks = {}            # n -> socket  (0 = the intercom's own socket)
        self.sel = selectors.DefaultSelector()
        self.endpoints = {}        # port n -> dict(addr, name, last, frames=deque, seq, since)
        self.lock = threading.Lock()
        self.seq = 0
        self.frame_count = 0
        self.bound = 0

    # ---- sockets -----------------------------------------------------------------
    def socket_for(self, n):
        return self.series + n

    def run(self):
        wanted = [0] + [n for n in sorted(self.m.ports) if n <= 255]
        for n in wanted:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((self.m.bind, self.series + n))
            except OSError as exc:
                self.m.log("%s: cannot bind socket udp/%d for port %d (%s)" % (self.m.name, self.series + n, n, exc))
                s.close()
                continue
            s.setblocking(False)
            self.socks[n] = s
            self.sel.register(s, selectors.EVENT_READ, n)
            self.bound += 1
        if 0 not in self.socks:
            self.m.log("%s: series socket udp/%d unavailable; audio off for this matrix" % (self.m.name, self.series))
            return
        if len(self.m.ports) > 255:
            self.m.log("%s: %d ports but a series holds 255 sockets; ports above 255 have no socket" % (self.m.name, len(self.m.ports)))
        threading.Thread(target=self.mixer, name=self.name + "-mix", daemon=True).start()
        while not self.m.estate.stop.is_set():
            for key, _ in self.sel.select(0.2):
                n = key.data
                try:
                    data, addr = key.fileobj.recvfrom(4096)
                except OSError:
                    continue
                msg = tcp.unpack(data)
                if not msg:
                    continue
                mtype, hdr_port, seq, flags, payload = msg
                try:
                    self.on_message(n, mtype, hdr_port, payload, addr)
                except Exception as exc:
                    self.m.log("%s audio: %s" % (self.m.name, exc))
        for s in self.socks.values():
            s.close()

    def send(self, port, addr, data):
        s = self.socks.get(port) or self.socks.get(0)
        if s is None:
            return
        try:
            s.sendto(data, addr)
        except OSError:
            pass

    def next_seq(self):
        self.seq = (self.seq + 1) & 0xFFFF
        return self.seq

    # ---- claiming -----------------------------------------------------------------
    def claim(self, port, name, addr):
        """Give `addr` port `port` (0 = next free panel).  Returns the port or None."""
        m = self.m
        with self.lock:
            for n, e in self.endpoints.items():          # already here?
                if e["addr"] == addr:
                    e["last"], e["name"] = time.time(), name
                    return n
            p = m.ports.get(port)
            if port == 0 or p is None or p.n not in self.socks or (p.endpoint and p.endpoint["addr"] not in (None, addr)):
                free = [q for q in m.ports.values() if q.user and q.can_talk and q.endpoint is None and q.n in self.socks]
                if not free:
                    return None
                port = free[0].n
            ep = dict(addr=addr, name=name, last=time.time(), frames=deque(maxlen=6), seq=0, since=time.time())
            self.endpoints[port] = ep
            m.ports[port].endpoint = ep
        m.log("%s: endpoint '%s' from %s:%d took port %d %s on socket udp/%d" % (
            m.name, name, addr[0], addr[1], port, m.ports[port].alpha, self.series + port))
        return port

    def hello_ack(self, port, addr):
        m = self.m
        info = {"port": port, "alpha": m.ports[port].alpha, "matrix": m.name, "tz": local_tz_label(),
                "series": self.series, "socket": self.series + port,
                "ports": [{"n": p.n, "alpha": p.alpha, "type": p.ptype, "user": p.user, "socket": self.series + p.n} for p in m.ports.values()]}
        self.send(port, addr, tcp.pack_hello_ack(port, self.next_seq(), info))
        self.send_state(port)

    def on_message(self, sock_n, mtype, hdr_port, payload, addr):
        m = self.m
        if sock_n == 0:
            # the intercom's own socket only hands out ports
            if mtype == tcp.TYPE_HELLO:
                port = self.claim(hdr_port, payload.decode("utf-8", "replace") or "endpoint", addr)
                if port is None:
                    return
                # answer from the intercom socket so the endpoint learns where to go
                self.send(0, addr, tcp.pack_hello_ack(port, self.next_seq(), {
                    "port": port, "alpha": m.ports[port].alpha, "matrix": m.name, "tz": local_tz_label(),
                    "series": self.series, "socket": self.series + port, "ports": []}))
            return
        port = sock_n                                   # the socket decides the port, not the header
        ep = self.endpoints.get(port)
        if mtype == tcp.TYPE_HELLO:
            if ep is None or ep["addr"] == addr:
                got = self.claim(port, payload.decode("utf-8", "replace") or "endpoint", addr)
                if got == port:
                    self.hello_ack(port, addr)
            else:
                m.log("%s: %s:%d tried socket udp/%d but port %d belongs to '%s'" % (m.name, addr[0], addr[1], self.series + port, port, ep["name"]))
            return
        if ep is None or ep["addr"] != addr:
            return                                       # it and only it
        ep["last"] = time.time()
        if mtype == tcp.TYPE_AUDIO:
            if len(payload) >= tcp.FRAME_BYTES:
                ep["frames"].append(payload[:tcp.FRAME_BYTES])
        elif mtype == tcp.TYPE_KEY:
            kind, target, state = tcp.unpack_key(payload)
            if kind == tcp.KEY_TALK:
                m.talk(port, target, state)
            else:
                m.listen(port, target, state)
            self.send_state(port)
        elif mtype == tcp.TYPE_BYE:
            self.drop(port)

    def drop(self, port):
        with self.lock:
            ep = self.endpoints.pop(port, None)
        if ep:
            self.m.ports[port].endpoint = None
            self.m.clear_port(port)
            self.m.log("%s: endpoint '%s' left port %d" % (self.m.name, ep["name"], port))

    def send_state(self, port):
        ep = self.endpoints.get(port)
        if ep and ep["addr"] is not None:
            self.send(port, ep["addr"], tcp.pack_state(port, self.next_seq(), self.m.port_state(port)))

    def broadcast_state(self):
        for port in list(self.endpoints):
            self.send_state(port)

    # ---- the 20 ms mixer loop --------------------------------------------------------
    def mixer(self):
        m = self.m
        frame_s = tcp.FRAME_MS / 1000.0
        n = tcp.FRAME_SAMPLES
        t_idx = np.arange(n, dtype=np.float32) / tcp.SAMPLE_RATE
        next_t = time.perf_counter()
        last_state = 0.0
        while not m.estate.stop.is_set():
            next_t += frame_s
            delay = next_t - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            elif delay < -0.5:
                next_t = time.perf_counter()
            self.frame_count += 1
            now = time.time()
            for port, ep in list(self.endpoints.items()):
                if now - ep["last"] > tcp.ENDPOINT_TIMEOUT:
                    self.drop(port)
            live = [(port, ep) for port, ep in self.endpoints.items() if ep["addr"] is not None]
            if not live:
                time.sleep(0.1)                       # nobody listening: idle cheaply
                next_t = time.perf_counter()
                continue
            sources = {}

            def src(pn):
                if pn in sources:
                    return sources[pn]
                p = m.ports.get(pn)
                out = None
                if p is not None:
                    if p.endpoint is not None and p.endpoint.get("addr") is not None:
                        if p.endpoint["frames"]:
                            out = np.frombuffer(p.endpoint["frames"].popleft(), dtype="<i2").astype(np.float32)
                    elif m.talks.get(pn):
                        if (self.frame_count // 20) % 3 != 2:        # 400 ms on / 200 ms off identifying tone
                            out = 6000.0 * np.sin(2 * math.pi * p.freq * t_idx + p.phase).astype(np.float32)
                        p.phase = (p.phase + 2 * math.pi * p.freq * frame_s) % (2 * math.pi)
                sources[pn] = out
                return out

            with m.lock:
                talks = {k: dict(v) for k, v in m.talks.items()}
                listens = {k: set(v) for k, v in m.listens.items()}
            for port, ep in live:
                mix = np.zeros(n, dtype=np.float32)
                heard = set()
                for talker, targets in talks.items():
                    if port in targets and talker != port:
                        heard.add(talker)
                for s_port in listens.get(port, ()):
                    heard.add(s_port)
                    for talker, targets in talks.items():
                        if s_port in targets and talker != port:
                            heard.add(talker)
                for h in heard:
                    frame = src(h)
                    if frame is not None:
                        mix += frame
                np.clip(mix, -32767, 32767, out=mix)
                self.send(port, ep["addr"], tcp.pack_audio(port, self.next_seq(), mix.astype("<i2").tobytes()))
            if now - last_state > 1.0:
                last_state = now
                self.broadcast_state()


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


# -----------------------------------------------------------------------------
class RvonDevice(Device):
    SUBTYPES = {"rvon1": ("objIdRvon1", 1, 0, 0, 0), "rvon8": ("objIdRvon8", 8, 0, 0, 0),
                "rvonc": ("objIdRvonC", 1, 0, 0, 1), "rvonio": ("objIdRvonIo", 8, 8, 8, 2),
                "rvon16": ("objIdRvon16", 16, 0, 0, 0)}

    def __init__(self, estate, cfg):
        self.subtype_key = (cfg.get("subtype") or "rvon16").lower().replace("-", "").replace("_", "")
        if self.subtype_key not in self.SUBTYPES:
            raise ValueError("rvon subtype must be one of %s" % ", ".join(self.SUBTYPES))
        cfg["subtype"] = self.subtype_key
        self.objid_name, self.nchan, self.ngpi, self.ngpo, self.npt = self.SUBTYPES[self.subtype_key]
        self.partner_ip = cfg.get("partner_ip", "127.0.0.1")
        self.chan_up, self.panel, self.chan_up_since = {}, {}, {}
        self.gpi, self.gpo = [False] * self.ngpi, [False] * self.ngpo
        super().__init__(estate, cfg)
        self.populate()

    def sys_object_id(self):
        return self.mib.oid(self.objid_name)

    def sys_descr(self):
        return "Pretend RTS %s VoIP intercom interface, %d channels - Trunk-Caster simulator" % (self.subtype_key.upper(), self.nchan)

    def populate(self):
        m = self.mib
        codec = m.enum("RvonCodec", self.cfg.get("codec", "g711u"))
        pkt_ms = int(self.cfg.get("packet_ms", 20))
        partner_type = m.enum("RvonDevice", {"rvon1": "rvon1", "rvon8": "rvon8", "rvonc": "rvonC", "rvonio": "rvonIo", "rvon16": "rvon16"}[self.subtype_key])
        self.put("numGpioInputs", 0, self.ngpi)
        self.put("numGpioOutputs", 0, self.ngpo)
        self.put("deviceDescription", 0, self.cfg.get("description", "%s pretend RVON" % self.name)[:63])
        self.put("numPassthroughPorts", 0, self.npt)
        self.put("gsInputs", 0, lambda: self._bits(self.gpi))
        self.put("gsOutputs", 0, lambda: self._bits(self.gpo))
        for ch in range(1, self.nchan + 1):
            up = ch <= int(self.cfg.get("channels_up", self.nchan))
            self.chan_up[ch] = up
            self.panel[ch] = self.subtype_key in ("rvonc", "rvon1") and up
            self.chan_up_since[ch] = time.time() if up else None
            self.put("ccPartnerIp", ch, self.partner_ip)
            self.put("ccPartnerType", ch, partner_type)
            self.put("ccPartnerChan", ch, ch)
            self.put("ccCodec", ch, codec)
            self.put("ccPktSizeMsec", ch, pkt_ms)
            self.put("ccPktSizeBytes", ch, pkt_ms * 8)
            self.put("ccVad", ch, truth(False))
            self.put("ccVadThreshold", ch, -99)
            self.put("ccDescription", ch, "%s ch%02d" % (self.name, ch))
            self.put("iogGainNetRx", ch, 0)
            self.put("iogGainNetTx", ch, 0)
            self.put("csPortNum", ch, 0 if self.subtype_key in ("rvon1", "rvonio") else ch)
            self.put("csIsUp", ch, lambda c=ch: truth(self.chan_up[c]))
            self.put("csPanelPresent", ch, lambda c=ch: truth(self.panel[c]))
            self.put("csUpTime", ch, lambda c=ch: int(time.time() - self.chan_up_since[c]) if self.chan_up_since[c] else 0)
            self.put("csCodec", ch, codec)
            self.put("csPktSizeMsec", ch, pkt_ms)
            self.put("csPktSizeBytes", ch, pkt_ms * 8)
            self.put("csVad", ch, truth(False))
            self.put("csNumConnects", ch, 1 if up else 0)
            for col in ("csNumUnderruns", "csNumOverruns", "csNumMissedSeqPkts", "csNumReplayedPkts",
                        "csVoicePktsTxd", "csVoicePktsRxd", "csDtmfRelayPktsTxd", "csDtmfRelayPktsRxd",
                        "csSilenceDetectedPktsTxd", "csSilenceDetectedPktsRxd", "csSuppressedSilencePktsTx"):
                self.put(col, ch, 0)
            self.put("csAvgJitter", ch, 2)
            self.put("csPlayoutBufferSize", ch, 120)
            self.put("csNomPlayoutDelay", ch, 40)
            self.put("csAvgPlayoutDelay", ch, 42)
            self.put("csMinPktIntervalTimeRx", ch, pkt_ms - 1)
            self.put("csMaxPktIntervalTimeRx", ch, pkt_ms + 3)
            for col in ("nweBadHeader", "nweBadMAC", "nweBadSSRC", "nweBadPayload", "nweBadDest", "nweLostPkts", "nweMicroOverrun"):
                self.put(col, ch, 0)
        for pt in range(1, self.npt + 1):
            self.put("ptcfgIp", pt, self.partner_ip)
            self.put("ptcfgSpeed", pt, 9600)
            for col in ("ptstatSnBytes", "ptstatSnErrors", "ptstatNsBytes", "ptstatNsErrors"):
                self.put(col, pt, 0)

    @staticmethod
    def _bits(flags):
        out = bytearray((len(flags) + 7) // 8 or 1)
        for i, f in enumerate(flags):
            if f:
                out[i // 8] |= 1 << (i % 8)
        return bytes(out)

    def set_channel(self, ch, up):
        if self.chan_up.get(ch) == up:
            return
        self.chan_up[ch] = up
        self.chan_up_since[ch] = time.time() if up else None
        if up:
            self.bump("csNumConnects", ch)
        self.trap("rvLinkStatChgd", [("csIsUp", ch, truth(up))])

    def set_panel(self, ch, present):
        if self.panel.get(ch) == present:
            return
        self.panel[ch] = present
        self.trap("rvPanelStatChgd", [("csPanelPresent", ch, truth(present))])

    def tick(self):
        pkt_per_s = 1000 // int(self.cfg.get("packet_ms", 20))
        for ch, up in self.chan_up.items():
            if up:
                self.bump("csVoicePktsTxd", ch, pkt_per_s)
                self.bump("csVoicePktsRxd", ch, pkt_per_s - random.choice((0, 0, 0, 1)))
                if random.random() < self.estate.chaos * 0.2:
                    self.bump("csNumMissedSeqPkts", ch)
                    self.bump("nweLostPkts", ch)
        if random.random() < self.estate.chaos * 0.02 and self.nchan:
            ch = random.randint(1, self.nchan)
            self.set_channel(ch, not self.chan_up[ch])

    def console_help(self):
        return super().console_help() + [
            "channels             channel status",
            "up <ch> | down <ch>  bring a VoIP channel up/down (sends rvLinkStatChgd)",
            "panel <ch> on|off    keypanel present/absent (sends rvPanelStatChgd)",
            "gpi <n> on|off       set a general purpose input",
            "gpo <n> on|off       set a general purpose output",
            "codec <ch> <g711u|g711a|g729|...>",
        ]

    def console_command(self, argv):
        cmd, a = argv[0].lower(), argv[1:]
        if cmd == "channels":
            return "\n".join("ch%02d %-4s panel=%-3s up=%5ds tx=%d rx=%d lost=%d" % (
                ch, "UP" if self.chan_up[ch] else "down", "yes" if self.panel[ch] else "no",
                self.get("csUpTime", ch), self.get("csVoicePktsTxd", ch), self.get("csVoicePktsRxd", ch), self.get("nweLostPkts", ch))
                for ch in range(1, self.nchan + 1))
        if cmd in ("up", "down") and a:
            self.set_channel(int(a[0]), cmd == "up")
            return "channel %s %s" % (a[0], cmd)
        if cmd == "panel" and len(a) >= 2:
            self.set_panel(int(a[0]), a[1].lower() in ("on", "1", "yes", "true"))
            return "panel on ch %s %s" % (a[0], a[1])
        if cmd in ("gpi", "gpo") and len(a) >= 2:
            arr = self.gpi if cmd == "gpi" else self.gpo
            n = int(a[0]) - 1
            if not 0 <= n < len(arr):
                return "this device has %d %s" % (len(arr), cmd.upper())
            arr[n] = a[1].lower() in ("on", "1", "yes", "true")
            return "%s %d = %s" % (cmd.upper(), n + 1, arr[n])
        if cmd == "codec" and len(a) >= 2:
            val = self.mib.enum("RvonCodec", a[1])
            self.set("ccCodec", int(a[0]), val)
            self.set("csCodec", int(a[0]), val)
            return "ch %s codec %s" % (a[0], a[1])
        return super().console_command(argv)

    def summary(self):
        return super().summary() + "  channels=%d up=%d" % (self.nchan, sum(1 for v in self.chan_up.values() if v))

    def map_state(self):
        s = super().map_state()
        s.update(channels=self.nchan, channels_up=sum(1 for v in self.chan_up.values() if v), calls=[])
        return s


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


# =============================================================================
# Built-in client / trap listener
# =============================================================================
def snmp_request(host, port, community, pdu, varbinds, version=1, timeout=2.0, f1=0, f2=0):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    req_id = random.randint(1, 2 ** 30)
    s.sendto(build_message(version, community, pdu, req_id, f1, f2, varbinds), (host, port))
    data, _ = s.recvfrom(65535)
    s.close()
    return parse_message(data)


def _target(target, default_port=161):
    host, _, port = target.rpartition(":")
    return host or "127.0.0.1", int(port or default_port)


def client_walk(mib, target, community, start_oid, version=1):
    host, port = _target(target)
    cur = oid_parse(start_oid) if start_oid and start_oid[0].isdigit() else (mib.oid(start_oid) if start_oid else (1, 3, 6, 1))
    count = 0
    while True:
        _, _, _, _, err, _, vbs = snmp_request(host, port, community, PDU_GETNEXT, [(cur, TAG_NULL, None)], version)
        if err or not vbs:
            print("error-status %d" % err)
            break
        oid, tag, val = vbs[0]
        if tag == TAG_ENDOFMIB or oid <= cur:
            break
        print("%-48s = %s: %s" % (mib.lookup(oid), TAG_NAMES.get(tag, "?"), fmt_value(tag, val)))
        count += 1
        cur = oid
    print("-- %d objects" % count)


def client_get(mib, target, community, oids, version=1):
    host, port = _target(target)
    vbs = []
    for o in oids:
        if o[0].isdigit():
            vbs.append((oid_parse(o), TAG_NULL, None))
        else:
            name, _, idx = o.partition(".")
            vbs.append((mib.oid(name) + (oid_parse(idx) if idx else (0,)), TAG_NULL, None))
    _, _, _, _, err, idx, out = snmp_request(host, port, community, PDU_GET, vbs, version)
    if err:
        print("error-status %d at index %d" % (err, idx))
    for oid, tag, val in out:
        print("%-48s = %s: %s" % (mib.lookup(oid), TAG_NAMES.get(tag, "?"), fmt_value(tag, val)))


def trap_listener(mib, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    print("listening for traps on udp/%d (Ctrl-C to stop)" % port, flush=True)
    try:
        while True:
            data, addr = s.recvfrom(65535)
            try:
                version, community, pdu, req_id, f1, f2, vbs = parse_message(data)
            except Exception as exc:
                print("bad packet from %s: %s" % (addr, exc), flush=True)
                continue
            kind = {PDU_TRAPV2: "TRAPv2c", PDU_INFORM: "INFORM", PDU_TRAPV1: "TRAPv1"}.get(pdu, "pdu 0x%02x" % pdu)
            print("%s %s from %s:%d community=%s" % (time.strftime("%H:%M:%S"), kind, addr[0], addr[1], community))
            for oid, tag, val in vbs:
                shown = mib.lookup(val) if tag == TAG_OID else fmt_value(tag, val)
                print("    %-44s = %s" % (mib.lookup(oid), shown))
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass


def dump_oids(mib):
    rows = sorted((o.oid, o) for o in mib.objects.values() if o.oid is not None)
    for oid, o in rows:
        print("%-36s %-12s %-26s %-16s %s" % (oid_str(oid), o.kind, o.name, o.access, (o.syntax or "")[:40]))
    print("-- %d objects, %d textual conventions, %d modules" % (len(rows), len(mib.tcs), len(mib.modules)))


def check_mibs(mib):
    print("modules found (by content):")
    for module, fname in sorted(mib.modules.items()):
        flag = "" if os.path.splitext(fname)[0].lower() == module.lower() else "   <-- filename does not match module"
        print("  %-22s in %s%s" % (module, fname, flag))
    needed = ["Telex-REG", "Telex-Icom-TC", "Telex-Icom-MIB", "Telex-RVON-MIB", "Telex-TM-MIB"]
    missing = [n for n in needed if n not in mib.modules]
    if missing:
        print("missing modules: %s" % ", ".join(missing))
        if "Telex-Icom-MIB" in missing:
            print("  (Telex-Icom-MIB describes the matrix frame itself; without it matrix devices only answer the system group)")
    for w in mib.warnings:
        print("warning: " + w)


# =============================================================================
def main(argv=None):
    ap = argparse.ArgumentParser(description="Pretend RTS / Telex intercom estate (SNMP + console + audio + map).")
    ap.add_argument("--mibs", default=os.path.join(HERE, "..", "SNMP"), help="folder with the Telex *.mib files")
    ap.add_argument("--config", help="JSON config file describing the devices")
    ap.add_argument("--spawn", help="quick spawn, e.g. tm2000=1,adam=1,cronus=1,rvon16=2 (types: tm2000, matrix, adam, adam-bus, cronus, zeus3, zeus3lite, rvon1, rvon8, rvonc, rvonio, rvon16)")
    ap.add_argument("--world", action="store_true", help="one Trunk Master + one matrix in each of 56 country capitals (the default)")
    ap.add_argument("--plan", help="port plan for every matrix, e.g. PANEL=24,CAM=10,LIGHT=8,AUDIO=8,FIELD=8,IFB=24,WLESS=24")
    ap.add_argument("--coverage", type=float, default=400, help="coverage radius in metres drawn around each capital's intercom")
    ap.add_argument("--capitals", help="with --world: only these alpha codes, e.g. LOND,PARI,BERL (default all 56)")
    ap.add_argument("--no-subsites", action="store_true", help="with --world: no 8x8 frames in the state / provincial capitals")
    ap.add_argument("--scenario", default="normal", help="starting traffic scenario: quiet, normal, olympics, sports, evening, breaking")
    ap.add_argument("--vendor", default="RTS", help="vendor label shown on the map (a launcher may run this as a stand-in for another vendor)")
    ap.add_argument("--base-port", type=int, default=16100, help="first SNMP udp port for --spawn (consoles +1000); audio series start at 40000")
    ap.add_argument("--map-port", type=int, default=8080, help="http port for the live GeoJSON map (0 = off)")
    ap.add_argument("--center", default="40.7128,-74.0060", help="lat,lon the spawned devices are scattered around")
    ap.add_argument("-c", "--community", default="public")
    ap.add_argument("--trap-target", action="append", default=[], help="host:port to send traps to (repeatable)")
    ap.add_argument("--chaos", type=float, default=0.0, help="0..1: random calls, link flaps and trunk churn")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--walk", metavar="HOST:PORT", help="client: walk a device")
    ap.add_argument("--get", metavar="HOST:PORT", help="client: get OIDs given with --oid")
    ap.add_argument("--oid", action="append", default=[], help="OID (name, name.index or numeric) for --walk/--get")
    ap.add_argument("--v1", action="store_true", help="client: use SNMPv1 instead of v2c")
    ap.add_argument("--trap-listener", type=int, metavar="PORT", help="run a trap receiver and print what arrives")
    ap.add_argument("--dump-oids", action="store_true", help="print the resolved Telex OID tree")
    ap.add_argument("--check-mibs", action="store_true", help="report which modules are present and filename mismatches")
    ap.add_argument("--write-config", metavar="FILE", help="write the (spawned or default) config to FILE and exit")
    ap.add_argument("--export-geojson", metavar="FILE", help="write a static GeoJSON of the estate layout and exit")
    args = ap.parse_args(argv)

    mib = Mib().load_folder(args.mibs)
    if not mib.objects:
        print("no MIB objects loaded from %s" % args.mibs)
        return 2
    version = 0 if args.v1 else 1

    if args.check_mibs:
        check_mibs(mib)
        return 0
    if args.dump_oids:
        dump_oids(mib)
        return 0
    if args.trap_listener:
        trap_listener(mib, args.trap_listener)
        return 0
    if args.walk:
        client_walk(mib, args.walk, args.community, args.oid[0] if args.oid else "", version)
        return 0
    if args.get:
        if not args.oid:
            ap.error("--get needs at least one --oid")
        client_get(mib, args.get, args.community, args.oid, version)
        return 0

    center = tuple(float(x) for x in args.center.split(","))
    if args.config:
        with open(args.config, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
        if args.trap_target:
            cfg.setdefault("trap_targets", []).extend(args.trap_target)
        if args.chaos:
            cfg["chaos"] = args.chaos
        cfg.setdefault("map_port", args.map_port)
    elif args.spawn and not args.world:
        cfg = spawn_config(args.spawn, args.base_port, args.community, args.trap_target, args.chaos, center, args.map_port)
        if args.plan:
            for d in cfg["devices"]:
                if d["type"] == "matrix":
                    d["plan"] = parse_plan(args.plan)
    else:
        if not args.world:
            print("no --config or --spawn given; spawning the world estate: one intercom per country capital (56)")
        cfg = world_config(args.base_port, args.community, args.trap_target, args.chaos, args.map_port,
                           parse_plan(args.plan) if args.plan else None, coverage_m=args.coverage,
                           capitals=[c.strip().upper() for c in args.capitals.split(",")] if args.capitals else None,
                           vendor=args.vendor, subsites=not args.no_subsites)
        cfg["scenario"] = args.scenario

    if args.write_config:
        with open(args.write_config, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        print("wrote %s" % args.write_config)
        return 0

    for fname, module in mib.module_mismatches():
        if not args.quiet:
            print("note: %s actually contains module %s" % (fname, module))
    if "Telex-Icom-MIB" not in mib.modules and not args.quiet:
        print("note: Telex-Icom-MIB is not in %s; matrix devices answer the system group only" % args.mibs)
    if tcp is None and not args.quiet:
        print("note: TRUNK-SIMULATOR/tc_protocol.py not found; audio ports and map are off")

    estate = Estate(mib, cfg, verbose=not args.quiet)
    if args.export_geojson:
        from tc_map import to_geojson
        with open(args.export_geojson, "w", encoding="utf-8") as fh:
            json.dump(to_geojson(estate.state()), fh, indent=2)
        print("wrote %s" % args.export_geojson)
        return 0
    estate.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
