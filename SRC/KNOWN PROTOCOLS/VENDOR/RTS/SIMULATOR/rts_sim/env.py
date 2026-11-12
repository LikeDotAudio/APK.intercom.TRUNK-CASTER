"""Where the simulator lives, and the optional shared modules (tc_protocol, tc_map, numpy).

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import os
import sys
import time


# The SIMULATOR folder (this package's parent), as when everything was one file.
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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
