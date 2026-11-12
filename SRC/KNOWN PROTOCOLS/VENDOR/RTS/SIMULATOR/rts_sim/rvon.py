"""RvonDevice: RVON-1 / RVON-8 / RVON-C / RVON-I/O / RVON-16 VoIP device.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import random
import time
from .device import Device, truth


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
