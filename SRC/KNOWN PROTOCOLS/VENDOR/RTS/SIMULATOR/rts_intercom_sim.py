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
import glob  # noqa: F401  (kept: the old one-file module exposed it)
import json
import math  # noqa: F401  (kept: the old one-file module exposed it)
import os
import random  # noqa: F401  (kept: the old one-file module exposed it)
import re  # noqa: F401  (kept: the old one-file module exposed it)
import selectors  # noqa: F401  (kept: the old one-file module exposed it)
import socket  # noqa: F401  (kept: the old one-file module exposed it)
import sys
import threading  # noqa: F401  (kept: the old one-file module exposed it)
import time  # noqa: F401  (kept: the old one-file module exposed it)
from collections import deque  # noqa: F401

# The simulator lives in the rts_sim package next to this file (one module per part: env, ber, mib,
# plan, device, audio, matrix, rvon, trunk_master, estate, client).  This script stays the entry
# point and re-exports every name, so `import rts_intercom_sim` keeps working.
from rts_sim.env import HERE, iso_now, local_tz_label, MapServer, np, tcp, TRUNK_SIM_DIR, _find_up  # noqa: F401
from rts_sim.ber import (  # noqa: F401
    ber_len, build_message, dec_int, dec_oid, dec_seq, dec_tlv, dec_value, enc_int, enc_oid, enc_value,
    ERR_BADVALUE, ERR_GENERR, ERR_NOACCESS, ERR_NOERROR, ERR_NOSUCHNAME, ERR_NOTWRITABLE, ERR_READONLY,
    ERR_TOOBIG, ERR_WRONGTYPE, fmt_value, oid_parse, oid_str, parse_message, PDU_GET, PDU_GETBULK,
    PDU_GETNEXT, PDU_INFORM, PDU_RESPONSE, PDU_SET, PDU_TRAPV1, PDU_TRAPV2, TAG_COUNTER32,
    TAG_COUNTER64, TAG_ENDOFMIB, TAG_GAUGE32, TAG_INT, TAG_IPADDR, TAG_NAMES, TAG_NOSUCHINST,
    TAG_NOSUCHOBJ, TAG_NULL, TAG_OCTSTR, TAG_OID, TAG_SEQ, TAG_TIMETICKS, tlv
)
from rts_sim.mib import Mib, MibObject, strip_comments, SYS_OIDS, SYS_TAGS, TextualConvention, WELL_KNOWN  # noqa: F401
from rts_sim.plan import (  # noqa: F401
    build_ports, capital_ports, CONTINENT, DEFAULT_PLAN, generate_panels, ISO2, parse_plan, Port,
    PORT_TYPES, SERIES_BASE, SERIES_SIZE, SMALL_PLAN, subsite_alpha4, SUBSITE_CONSOLE_BASE,
    subsite_ports, SUBSITE_SERIES_BASE, SUBSITE_SERIES_SIZE, SUBSITE_SNMP_BASE, SUBSITES,
    WORLD_CAPITALS, WORLD_PORT_BASE, _a, _alphas, _grp
)
from rts_sim.device import alpha_bytes, Device, FALSE, TRUE, truth  # noqa: F401
from rts_sim.audio import AudioEngine  # noqa: F401
from rts_sim.matrix import MatrixDevice  # noqa: F401
from rts_sim.rvon import RvonDevice  # noqa: F401
from rts_sim.trunk_master import TrunkMasterDevice  # noqa: F401
from rts_sim.estate import DEVICE_CLASSES, Estate, hsl_hex, spawn_config, world_config  # noqa: F401
from rts_sim.client import (  # noqa: F401
    check_mibs, client_get, client_walk, dump_oids, snmp_request, trap_listener, _target
)


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
