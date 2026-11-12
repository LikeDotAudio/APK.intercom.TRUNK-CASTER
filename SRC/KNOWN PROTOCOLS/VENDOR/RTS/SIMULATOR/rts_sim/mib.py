"""Tiny MIB parser (enough for the Telex SMIv2 files).

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import glob
import os
import re
from .ber import (
    TAG_COUNTER32,
    TAG_COUNTER64,
    TAG_GAUGE32,
    TAG_INT,
    TAG_IPADDR,
    TAG_OCTSTR,
    TAG_OID,
    TAG_TIMETICKS,
    oid_str,
)


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
