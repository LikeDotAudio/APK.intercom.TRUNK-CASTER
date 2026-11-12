"""Built-in client / trap listener.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import os
import random
import socket
import sys
import time
from .ber import (
    PDU_GET,
    PDU_GETNEXT,
    PDU_INFORM,
    PDU_TRAPV1,
    PDU_TRAPV2,
    TAG_ENDOFMIB,
    TAG_NAMES,
    TAG_NULL,
    TAG_OID,
    build_message,
    fmt_value,
    oid_parse,
    oid_str,
    parse_message,
)


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
