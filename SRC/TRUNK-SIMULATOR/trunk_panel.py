#!/usr/bin/env python3
"""
trunk_panel.py  --  your computer as an intercom port.

Joins a Trunk-Caster matrix simulator on its audio port, claims a port, and
gives you a keypanel window:

    * your microphone  -> the matrix        (8 TX keys: talk to a port)
    * the matrix       -> your speakers     (8 RX keys: listen to / monitor a port)
    * every key can "break away" into its own small always-on-top window
    * bottom-right counter: users on the matrix and users making calls
    * incoming calls to you light up and are listed, so you can see who is calling

Needs: tkinter (ships with Python), numpy, sounddevice.  Without sounddevice
the panel still works for keys and status, just with no audio.

    python trunk_panel.py --matrix 127.0.0.1:18100
    python trunk_panel.py --matrix 127.0.0.1:18100 --port 5 --name "Andrew's PC"
    python trunk_panel.py --list-devices
"""
import argparse
import queue
import socket
import sys
import threading
import time
import tkinter as tk
from collections import deque
from tkinter import ttk

HERE = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import tc_protocol as tcp  # noqa: E402

try:
    import numpy as np
except ImportError:
    np = None
try:
    import sounddevice as sd
except Exception:   # missing module or no PortAudio
    sd = None


# =============================================================================
# Link to the matrix
# =============================================================================
class MatrixLink(threading.Thread):
    def __init__(self, host, port, want_port, name, events):
        super().__init__(name="matrix-link", daemon=True)
        self.addr = (host, port)
        self.want_port, self.name = want_port, name
        self.events = events                 # queue of ("event", payload) for the GUI
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(0.5)
        self.seq = 0
        self.my_port = 0
        self.alpha = ""
        self.matrix = ""
        self.ports = []                      # [{"n","alpha","type","user"}]
        self.rx_frames = deque(maxlen=12)    # audio from the matrix
        self.connected = False
        self.last_rx = 0.0
        self.stop = threading.Event()
        self.tx_frames = 0
        self.rx_count = 0

    def next_seq(self):
        self.seq = (self.seq + 1) & 0xFFFF
        return self.seq

    def send(self, data):
        try:
            self.sock.sendto(data, self.addr)
        except OSError:
            pass

    def hello(self):
        self.send(tcp.pack_hello(self.my_port or self.want_port, self.next_seq(), self.name))

    def send_audio(self, pcm_bytes):
        if self.my_port:
            self.tx_frames += 1
            self.send(tcp.pack_audio(self.my_port, self.next_seq(), pcm_bytes))

    def key(self, kind, target, state):
        if self.my_port and target:
            self.send(tcp.pack_key(self.my_port, self.next_seq(), kind, target, state))

    def bye(self):
        if self.my_port:
            self.send(tcp.pack_bye(self.my_port, self.next_seq()))

    def run(self):
        last_hello = 0.0
        while not self.stop.is_set():
            now = time.time()
            if now - last_hello > tcp.HELLO_INTERVAL:
                self.hello()
                last_hello = now
            if self.connected and now - self.last_rx > tcp.ENDPOINT_TIMEOUT:
                self.connected = False
                self.events.put(("status", "lost contact with matrix"))
            try:
                data, _ = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            msg = tcp.unpack(data)
            if not msg:
                continue
            mtype, port, seq, flags, payload = msg
            self.last_rx = time.time()
            if mtype == tcp.TYPE_HELLO_ACK:
                info = tcp.loads(payload)
                self.my_port, self.alpha, self.matrix = info["port"], info["alpha"], info.get("matrix", "")
                if info.get("ports"):
                    self.ports = info["ports"]
                sock = info.get("socket")
                if sock and sock != self.addr[1]:
                    # the intercom told us which socket in its series is ours: move there and say hello on it
                    self.addr = (self.addr[0], int(sock))
                    self.events.put(("status", "assigned port %d %s, moving to socket udp/%d" % (self.my_port, self.alpha, sock)))
                    self.hello()
                    last_hello = time.time()
                    continue
                first = not self.connected
                self.connected = True
                if first:
                    self.events.put(("joined", info))
            elif mtype == tcp.TYPE_AUDIO:
                self.rx_count += 1
                self.rx_frames.append(payload[:tcp.FRAME_BYTES])
            elif mtype == tcp.TYPE_STATE:
                self.events.put(("state", tcp.loads(payload)))


# =============================================================================
# Audio: mic -> 8 kHz frames -> matrix ;  matrix frames -> speaker
# =============================================================================
class Audio:
    def __init__(self, link, in_dev=None, out_dev=None, rate=48000):
        self.link = link
        self.rate = rate
        self.factor = rate // tcp.SAMPLE_RATE
        self.block = tcp.FRAME_SAMPLES * self.factor
        self.in_dev, self.out_dev = in_dev, out_dev
        self.in_stream = self.out_stream = None
        self.mic_level = 0.0
        self.spk_level = 0.0
        self.muted = False
        self.mic_open = False
        self.error = None
        self.acc = np.zeros(0, dtype=np.float32) if np is not None else None

    def start(self):
        if sd is None or np is None:
            self.error = "sounddevice/numpy not available: no audio"
            return False
        try:
            self.in_stream = sd.InputStream(samplerate=self.rate, channels=1, dtype="float32", blocksize=self.block,
                                            device=self.in_dev, callback=self._on_input)
            self.out_stream = sd.OutputStream(samplerate=self.rate, channels=1, dtype="float32", blocksize=self.block,
                                              device=self.out_dev, callback=self._on_output)
            self.in_stream.start()
            self.out_stream.start()
            self.error = None
            return True
        except Exception as exc:
            self.error = "audio start failed: %s" % exc
            self.stop()
            return False

    def stop(self):
        for s in (self.in_stream, self.out_stream):
            try:
                if s:
                    s.stop()
                    s.close()
            except Exception:
                pass
        self.in_stream = self.out_stream = None

    def _on_input(self, indata, frames, t, status):
        mono = indata[:, 0]
        self.mic_level = float(np.sqrt(np.mean(mono * mono)) + 1e-9)
        if self.muted:
            return
        # decimate to 8 kHz by block averaging (cheap anti-alias), then int16
        usable = (len(mono) // self.factor) * self.factor
        down = mono[:usable].reshape(-1, self.factor).mean(axis=1)
        self.acc = np.concatenate([self.acc, down]) if len(self.acc) else down
        while len(self.acc) >= tcp.FRAME_SAMPLES:
            frame, self.acc = self.acc[:tcp.FRAME_SAMPLES], self.acc[tcp.FRAME_SAMPLES:]
            if self.mic_open:
                self.link.send_audio(np.clip(frame * 32767.0, -32767, 32767).astype("<i2").tobytes())

    def _on_output(self, outdata, frames, t, status):
        if self.link.rx_frames:
            pcm = np.frombuffer(self.link.rx_frames.popleft(), dtype="<i2").astype(np.float32) / 32768.0
            up = np.repeat(pcm, self.factor)[:frames]
            if len(up) < frames:
                up = np.pad(up, (0, frames - len(up)))
            self.spk_level = float(np.sqrt(np.mean(up * up)) + 1e-9)
            outdata[:, 0] = up
        else:
            self.spk_level *= 0.8
            outdata.fill(0)


# =============================================================================
# Key model + views (a key can have several views: docked + broken away)
# =============================================================================
class Key:
    def __init__(self, panel, kind, slot):
        self.panel, self.kind, self.slot = panel, kind, slot
        self.target = None       # port number
        self.active = False
        self.incoming = False    # someone on this target is talking to me
        self.views = []

    @property
    def label(self):
        return "TALK %d" % self.slot if self.kind == tcp.KEY_TALK else "LISTEN %d" % self.slot

    def alpha(self):
        if not self.target:
            return "--"
        for p in self.panel.link.ports:
            if p["n"] == self.target:
                return p["alpha"]
        return "P%d" % self.target

    def set_target(self, n):
        if self.active and self.target:
            self.panel.link.key(self.kind, self.target, False)
            self.active = False
        self.target = n
        if n:
            self.panel.remember_assignments()
        self.refresh()

    def toggle(self):
        if not self.target:
            self.panel.status("assign a port to this key first")
            return
        self.active = not self.active
        self.panel.link.key(self.kind, self.target, self.active)
        if self.kind == tcp.KEY_TALK:
            self.panel.update_mic_gate()
        self.refresh()

    def refresh(self):
        for v in self.views:
            v.refresh()


class KeyView(ttk.Frame):
    """One rendering of a Key.  Used docked in the main window and in a breakaway window."""

    def __init__(self, master, key, breakaway_cb=None, big=False):
        super().__init__(master, padding=4)
        self.key = key
        key.views.append(self)
        self.var = tk.StringVar(value=key.alpha())
        self.combo = ttk.Combobox(self, textvariable=self.var, width=10 if not big else 14, state="readonly")
        self.combo.bind("<<ComboboxSelected>>", self._chosen)
        self.combo.pack(fill="x")
        self.btn = tk.Button(self, text=key.label, width=10 if not big else 16, height=2 if not big else 4,
                             font=("Segoe UI", 10 if not big else 16, "bold"), relief="raised", command=key.toggle)
        self.btn.pack(fill="both", expand=True, pady=(4, 2))
        if breakaway_cb:
            ttk.Button(self, text="⇱ break away", width=12, command=lambda: breakaway_cb(key)).pack(fill="x")
        self.refresh()

    def _chosen(self, _evt):
        txt = self.var.get()
        n = int(txt.split()[0]) if txt and txt[0].isdigit() else None
        self.key.set_target(n)

    def refresh(self):
        k = self.key
        choices = ["%d %s %s" % (p["n"], p["alpha"], p["type"]) for p in k.panel.link.ports
                   if p["n"] != k.panel.link.my_port and (k.kind == tcp.KEY_LISTEN or p["type"] not in ("WLESS",))]
        self.combo["values"] = choices
        self.var.set(next((c for c in choices if c.startswith("%d " % k.target)), "--") if k.target else "--")
        if k.kind == tcp.KEY_TALK:
            bg = "#d9342b" if k.active else ("#f0b429" if k.incoming else "#e6e6e6")
        else:
            bg = "#2e9e4f" if k.active else "#e6e6e6"
        fg = "white" if (k.active or k.incoming) else "black"
        txt = "%s\n%s" % (k.label, k.alpha())
        if k.incoming and not k.active:
            txt += "\n◄ CALLING"
        self.btn.configure(bg=bg, fg=fg, activebackground=bg, text=txt, relief="sunken" if k.active else "raised")

    def destroy(self):
        if self in self.key.views:
            self.key.views.remove(self)
        super().destroy()


# =============================================================================
# The panel window
# =============================================================================
class Panel:
    def __init__(self, root, args):
        self.root = root
        self.args = args
        self.events = queue.Queue()
        host, _, port = args.matrix.rpartition(":")
        self.link = MatrixLink(host or "127.0.0.1", int(port or 18100), args.port, args.name, self.events)
        self.audio = Audio(self.link, args.input_device, args.output_device, args.rate)
        self.keys = [Key(self, tcp.KEY_TALK, i + 1) for i in range(8)] + [Key(self, tcp.KEY_LISTEN, i + 1) for i in range(8)]
        self.breakaways = {}
        self.state = {}
        self.assigned_once = False
        root.title("TRUNK-SIMULATOR  ·  My Computer as a matrix port")
        root.minsize(900, 420)
        self._build()
        self.link.start()
        if not self.audio.start():
            self.status(self.audio.error or "no audio")
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(100, self.poll)

    # ---- layout ---------------------------------------------------------------
    def _build(self):
        r = self.root
        top = ttk.Frame(r, padding=8)
        top.pack(fill="x")
        self.hdr = ttk.Label(top, text="connecting to %s ..." % self.args.matrix, font=("Segoe UI", 12, "bold"))
        self.hdr.pack(side="left")
        self.tzlbl = ttk.Label(top, text="", foreground="#666")
        self.tzlbl.pack(side="right")

        dev = ttk.Frame(r, padding=(8, 0))
        dev.pack(fill="x")
        ttk.Label(dev, text="mic").pack(side="left")
        self.mic_meter = ttk.Progressbar(dev, length=140, maximum=1.0)
        self.mic_meter.pack(side="left", padx=4)
        self.mute_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(dev, text="mute mic", variable=self.mute_var, command=self._mute).pack(side="left", padx=8)
        ttk.Label(dev, text="speaker").pack(side="left", padx=(16, 0))
        self.spk_meter = ttk.Progressbar(dev, length=140, maximum=1.0)
        self.spk_meter.pack(side="left", padx=4)
        self.audio_lbl = ttk.Label(dev, text="", foreground="#666")
        self.audio_lbl.pack(side="left", padx=12)

        body = ttk.Frame(r, padding=8)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="TX  (my microphone → matrix)", font=("Segoe UI", 10, "bold")).grid(row=0, column=0, columnspan=8, sticky="w")
        for i, k in enumerate(self.keys[:8]):
            KeyView(body, k, self.breakaway).grid(row=1, column=i, sticky="nsew")
        ttk.Label(body, text="RX  (matrix → my speakers)", font=("Segoe UI", 10, "bold")).grid(row=2, column=0, columnspan=8, sticky="w", pady=(10, 0))
        for i, k in enumerate(self.keys[8:]):
            KeyView(body, k, self.breakaway).grid(row=3, column=i, sticky="nsew")
        for i in range(8):
            body.columnconfigure(i, weight=1)

        bottom = ttk.Frame(r, padding=8)
        bottom.pack(fill="x", side="bottom")
        self.incoming_lbl = ttk.Label(bottom, text="no incoming calls", foreground="#a60")
        self.incoming_lbl.pack(side="left")
        self.status_lbl = ttk.Label(bottom, text="", foreground="#666")
        self.status_lbl.pack(side="left", padx=16)
        self.counter = tk.Label(bottom, text="USERS –\nCALLING –", justify="right", font=("Segoe UI", 12, "bold"),
                                bg="#1c1c22", fg="#f3f3f3", padx=12, pady=6)
        self.counter.pack(side="right")

    def breakaway(self, key):
        if key in self.breakaways:
            self.breakaways[key].lift()
            return
        win = tk.Toplevel(self.root)
        win.title("%s  %s" % (key.label, key.alpha()))
        win.attributes("-topmost", True)
        win.resizable(False, False)
        view = KeyView(win, key, None, big=True)
        view.pack(fill="both", expand=True)

        def closed():
            view.destroy()
            win.destroy()
            self.breakaways.pop(key, None)
        win.protocol("WM_DELETE_WINDOW", closed)
        self.breakaways[key] = win

    # ---- behaviour --------------------------------------------------------------
    def status(self, txt):
        self.status_lbl.configure(text=txt)

    def _mute(self):
        self.audio.muted = self.mute_var.get()

    def update_mic_gate(self):
        self.audio.mic_open = any(k.active for k in self.keys if k.kind == tcp.KEY_TALK)

    def remember_assignments(self):
        pass

    def default_assignments(self):
        """First time we see the port list: put sensible things on the keys."""
        ports = [p for p in self.link.ports if p["n"] != self.link.my_port]
        if not ports or self.assigned_once:
            return
        self.assigned_once = True

        def pick(types, count, exclude):
            out = []
            for t in types:
                for p in ports:
                    if p["type"] == t and p["n"] not in exclude and len(out) < count:
                        out.append(p["n"])
                        exclude.add(p["n"])
            return out
        used = set()
        tx = pick(["CAM"], 3, used) + pick(["PANEL"], 2, used) + pick(["IFB"], 2, used) + pick(["AUDIO"], 1, used)
        used = set()
        rx = pick(["PANEL"], 3, used) + pick(["IFB"], 2, used) + pick(["CAM"], 2, used) + pick(["WLESS"], 1, used)
        for k, n in zip(self.keys[:8], tx):
            k.target = n
        for k, n in zip(self.keys[8:], rx):
            k.target = n
        for k in self.keys:
            k.refresh()

    def on_state(self, st):
        self.state = st
        inc = st.get("incoming", [])
        inc_ports = {c["port"] for c in inc}
        for k in self.keys:
            was = k.incoming
            k.incoming = k.kind == tcp.KEY_TALK and k.target in inc_ports
            if was != k.incoming:
                k.refresh()
        if inc:
            self.incoming_lbl.configure(text="CALLING YOU: " + ", ".join("%s (%ds)" % (c["alpha"], time.time() - c["since"]) for c in inc))
        else:
            self.incoming_lbl.configure(text="no incoming calls")
        self.counter.configure(text="USERS %s\nCALLING %s" % (st.get("users", "–"), st.get("users_calling", "–")))
        self.tzlbl.configure(text=st.get("time", ""))

    def poll(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "joined":
                    self.hdr.configure(text="%s  ·  I am port %d %s on %s" % (self.args.name, payload["port"], payload["alpha"], payload.get("matrix", "")))
                    self.status("joined; audio port %s" % self.args.matrix)
                    self.default_assignments()
                    for k in self.keys:
                        k.refresh()
                elif kind == "state":
                    self.on_state(payload)
                elif kind == "status":
                    self.status(payload)
        except queue.Empty:
            pass
        self.mic_meter["value"] = min(1.0, self.audio.mic_level * 6)
        self.spk_meter["value"] = min(1.0, self.audio.spk_level * 6)
        if self.audio.error:
            self.audio_lbl.configure(text=self.audio.error)
        else:
            self.audio_lbl.configure(text="%d Hz, mic %s · tx %d rx %d frames" % (
                self.audio.rate, "OPEN" if self.audio.mic_open else "closed", self.link.tx_frames, self.link.rx_count))
        self.root.after(100, self.poll)

    def close(self):
        for k in self.keys:
            if k.active and k.target:
                self.link.key(k.kind, k.target, False)
        self.link.bye()
        self.link.stop.set()
        self.audio.stop()
        self.root.destroy()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Your computer as an intercom port (TRUNK-SIMULATOR soft panel).")
    ap.add_argument("--matrix", default="127.0.0.1:20256", help="host:socket of a matrix: its series socket (+0) to be assigned a port, or series+n to take port n directly. Washington is 20256, London 22304.")
    ap.add_argument("--port", type=int, default=0, help="matrix port number to ask for when connecting to the series socket (0 = let the matrix pick a free panel)")
    ap.add_argument("--name", default=socket.gethostname(), help="how this computer shows up on the matrix and the map")
    ap.add_argument("--input-device", help="sounddevice input device index or name")
    ap.add_argument("--output-device", help="sounddevice output device index or name")
    ap.add_argument("--rate", type=int, default=48000, help="sound card sample rate (multiple of 8000)")
    ap.add_argument("--list-devices", action="store_true")
    ap.add_argument("--test-seconds", type=float, default=0, help="auto-quit after N seconds (for scripted tests)")
    ap.add_argument("--auto-talk", type=int, default=0, help="with --test-seconds: latch TX key 1 to this port on join")
    args = ap.parse_args(argv)
    if args.list_devices:
        print(sd.query_devices() if sd else "sounddevice not installed")
        return 0
    for attr in ("input_device", "output_device"):
        v = getattr(args, attr)
        if v is not None and v.isdigit():
            setattr(args, attr, int(v))
    if args.rate % tcp.SAMPLE_RATE:
        ap.error("--rate must be a multiple of %d" % tcp.SAMPLE_RATE)
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except Exception:
        pass
    panel = Panel(root, args)
    if args.test_seconds:
        def report():
            print("test: connected=%s port=%d alpha=%s tx_frames=%d rx_frames=%d audio=%s" % (
                panel.link.connected, panel.link.my_port, panel.link.alpha, panel.link.tx_frames, panel.link.rx_count,
                panel.audio.error or "ok %d Hz" % panel.audio.rate))
            print("test: state=%s" % __import__("json").dumps(panel.state)[:400])
            panel.close()
        if args.auto_talk:
            def latch():
                if panel.link.connected:
                    panel.keys[0].set_target(args.auto_talk)
                    panel.keys[0].toggle()
                else:
                    root.after(200, latch)
            root.after(300, latch)
        root.after(int(args.test_seconds * 1000), report)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
