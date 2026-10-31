#!/usr/bin/env python3
"""
streamdeck_emulator.py  --  a Stream Deck on screen.

Loads a panel definition (see panel.schema.json), draws the key grid the way the
real device would show it, and presses the real keys through the matrix HTTP
API, exactly as a hardware Stream Deck would through Companion.  Polls the API
for feedback so keys light up when someone calls the panel's port.

    python streamdeck_emulator.py streamdeck-xl.json
    python streamdeck_emulator.py streamdeck-mk2.json --api http://127.0.0.1:8080 --matrix PARI --port 0

Standard library only (tkinter + urllib).
"""
import argparse
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
import urllib.parse
import urllib.request
from tkinter import ttk


class Api:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def call(self, _action, **params):
        url = "%s/api/%s?%s" % (self.base, _action, urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}))
        with urllib.request.urlopen(url, timeout=3) as r:
            data = json.loads(r.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(data.get("error", "api error"))
        return data["result"]


class Emulator:
    def __init__(self, root, panel, args):
        self.root, self.panel, self.args = root, panel, args
        self.api = Api(args.api or panel.get("api") or "http://127.0.0.1:8180")
        self.matrix = args.matrix or panel["matrix"]
        self.port = args.port if args.port is not None else panel.get("port", 0)
        self.alpha = ""
        self.ports = {}            # alpha -> n, and n -> alpha
        self.page = "main"
        self.latched = {}          # (action, target) -> bool
        self.state = {}
        self.events = queue.Queue()
        self.buttons = {}          # (row, col) -> (tk.Button, button-def)
        dev = panel["device"]
        self.rows, self.cols, self.px = dev["rows"], dev["cols"], int(dev.get("key_px", 72))
        root.title("%s  ·  %s  ·  %s" % (panel["name"], dev["model"], self.matrix))
        root.configure(bg="#111")
        self.hdr = tk.Label(root, text="connecting…", bg="#111", fg="#aaa", font=("Segoe UI", 10))
        self.hdr.grid(row=0, column=0, columnspan=self.cols, sticky="w", padx=10, pady=(8, 2))
        self.grid = tk.Frame(root, bg="#111")
        self.grid.grid(row=1, column=0, columnspan=self.cols, padx=10, pady=6)
        self.foot = tk.Label(root, text="", bg="#111", fg="#f0b429", font=("Segoe UI", 10, "bold"), anchor="w")
        self.foot.grid(row=2, column=0, columnspan=self.cols, sticky="we", padx=10, pady=(0, 8))
        self.counter = tk.Label(root, text="", bg="#111", fg="#ddd", font=("Segoe UI", 9), anchor="e")
        self.counter.grid(row=2, column=self.cols - 1, sticky="e", padx=10)
        if dev.get("encoders"):
            enc = tk.Frame(root, bg="#111")
            enc.grid(row=3, column=0, columnspan=self.cols, pady=(0, 8))
            for e in panel.get("encoders", []):
                tk.Label(enc, text="◉ %s" % e.get("label", e["action"]), bg="#111", fg="#888", font=("Segoe UI", 9), width=14).pack(side="left", padx=4)
        self.draw_page()
        root.protocol("WM_DELETE_WINDOW", self.close)
        threading.Thread(target=self.connect, daemon=True).start()
        root.after(100, self.poll)

    # ---- connect & feedback ----------------------------------------------------
    def connect(self):
        try:
            ports = self.api.call("ports", matrix=self.matrix)
            for p in ports:
                self.ports[p["alpha"].upper()] = p["n"]
                self.ports[p["n"]] = p["alpha"]
            info = self.api.call("claim", matrix=self.matrix, port=self.port, name=self.panel.get("name_on_matrix", self.panel["name"]))
            self.port, self.alpha = info["port"], info["alpha"]
            self.events.put(("hdr", "%s  ·  I am port %d %s on %s  ·  %s" % (self.panel["name"], self.port, self.alpha, self.matrix, self.api.base)))
            while True:
                try:
                    st = self.api.call("port", matrix=self.matrix, port=self.port)
                    self.events.put(("state", st))
                except Exception as exc:
                    self.events.put(("hdr", "feedback error: %s" % exc))
                time.sleep(max(0.2, self.panel.get("poll_ms", 1000) / 1000.0))
        except Exception as exc:
            self.events.put(("hdr", "cannot connect: %s" % exc))

    def target_n(self, target):
        if target is None:
            return None
        t = str(target)
        if t.isdigit():
            return int(t)
        return self.ports.get(t.upper())

    # ---- drawing ----------------------------------------------------------------
    def page_buttons(self):
        if self.page == "main":
            return self.panel["buttons"]
        return self.panel.get("pages", {}).get(self.page, [])

    def draw_page(self):
        for w in self.grid.winfo_children():
            w.destroy()
        self.buttons = {}
        defs = {(b["row"], b["col"]): b for b in self.page_buttons()}
        for r in range(self.rows):
            for c in range(self.cols):
                b = defs.get((r, c), {"row": r, "col": c, "action": "none"})
                btn = tk.Button(self.grid, width=1, height=1, bd=0, relief="flat", font=("Segoe UI", 9 if self.px < 90 else 11, "bold"),
                                wraplength=self.px - 10, justify="center", activebackground="#333")
                btn.configure(text=b.get("label") if b.get("label") is not None else (b.get("target") or ""))
                btn.grid(row=r, column=c, padx=4, pady=4, ipadx=0, ipady=0, sticky="nsew")
                btn.config(width=max(6, self.px // 9), height=max(2, self.px // 24))
                btn.bind("<ButtonPress-1>", lambda e, bd=b: self.press(bd, True))
                btn.bind("<ButtonRelease-1>", lambda e, bd=b: self.press(bd, False))
                self.buttons[(r, c)] = (btn, b)
        self.refresh_colors()

    def colors(self, b):
        c = {"idle": "#2b2b2b", "active": "#d9342b", "incoming": "#f0b429", "text": "#ffffff"}
        c.update(b.get("colors", {}))
        if b["action"] == "none":
            c["idle"] = "#161616"
        return c

    def refresh_colors(self):
        talking = set(self.state.get("talking_to", []))
        listening = set(self.state.get("listening", []))
        incoming = {c["port"] for c in self.state.get("incoming", [])}
        remote = self.state.get("remote", [])
        for (r, c), (btn, b) in self.buttons.items():
            col = self.colors(b)
            n = self.target_n(b.get("target"))
            bg = col["idle"]
            if b["action"] == "talk" and n in talking:
                bg = col["active"]
            elif b["action"] == "talk" and n in incoming:
                bg = col["incoming"]
            elif b["action"] == "listen" and n in listening:
                bg = col.get("active", "#2e9e4f")
            elif b["action"] == "call" and remote and b.get("target", "").upper() in [x.upper() for x in remote]:
                bg = col["active"]
            elif b["action"] == "reply" and incoming:
                bg = col["incoming"] if not self.latched.get(("reply", None)) else col["active"]
            btn.configure(bg=bg, fg=col["text"], activebackground=bg)

    # ---- pressing ----------------------------------------------------------------
    def press(self, b, down):
        act = b["action"]
        if act == "none":
            return
        if act == "page":
            if down:
                self.page = b.get("target", "main")
                self.draw_page()
            return
        mode = b.get("mode", "momentary")
        key = (act, b.get("target"))
        if mode == "latch":
            if not down:
                return
            state = not self.latched.get(key, False)
            self.latched[key] = state
        else:
            state = down
        threading.Thread(target=self.send, args=(b, state), daemon=True).start()

    def send(self, b, state):
        act, target = b["action"], b.get("target")
        try:
            if act == "talk":
                self.api.call("key", matrix=self.matrix, port=self.port, kind="talk", target=target, state=int(state))
            elif act == "listen":
                self.api.call("key", matrix=self.matrix, port=self.port, kind="listen", target=target, state=int(state))
            elif act == "call":
                if state:
                    icom, _, rport = str(target).partition(":")
                    res = self.api.call("call", matrix=self.matrix, port=self.port, icom=icom, remote=rport or "1")
                    self.events.put(("foot", str(res)))
                else:
                    self.api.call("hangup", matrix=self.matrix, port=self.port)
            elif act == "hangup":
                if state:
                    self.events.put(("foot", str(self.api.call("hangup", matrix=self.matrix, port=self.port))))
            elif act == "reply":
                inc = self.state.get("incoming", [])
                if inc:
                    self.api.call("key", matrix=self.matrix, port=self.port, kind="talk", target=inc[0]["port"], state=int(state))
                    self.latched[("reply", None)] = state
            st = self.api.call("port", matrix=self.matrix, port=self.port)
            self.events.put(("state", st))
        except Exception as exc:
            self.events.put(("foot", "error: %s" % exc))

    def poll(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "hdr":
                    self.hdr.configure(text=payload)
                elif kind == "foot":
                    self.foot.configure(text=payload)
                elif kind == "state":
                    self.state = payload
                    inc = payload.get("incoming", [])
                    self.foot.configure(text=("CALLING YOU: " + ", ".join(c["alpha"] for c in inc)) if inc else "")
                    self.counter.configure(text="users %s · calling %s" % (payload.get("users", "-"), payload.get("users_calling", "-")))
                    self.refresh_colors()
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def close(self):
        try:
            if self.alpha:
                for n in self.state.get("talking_to", []):          # let go of anything still keyed
                    self.api.call("key", matrix=self.matrix, port=self.port, kind="talk", target=n, state=0)
                self.api.call("release", matrix=self.matrix, port=self.port)
        except Exception:
            pass
        self.root.destroy()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Stream Deck emulator for Trunk-Caster panels.")
    ap.add_argument("panel", nargs="?", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "streamdeck-xl.json"))
    ap.add_argument("--api", help="base URL of the matrix API (overrides the panel file)")
    ap.add_argument("--matrix", help="matrix alpha (overrides the panel file)")
    ap.add_argument("--port", type=int, help="port to claim, 0 = next free (overrides the panel file)")
    ap.add_argument("--test-seconds", type=float, default=0, help="auto-quit after N seconds and print the state")
    ap.add_argument("--auto-press", help="with --test-seconds: press the key at row,col (e.g. 0,0) after connecting")
    args = ap.parse_args(argv)
    with open(args.panel, "r", encoding="utf-8") as fh:
        panel = json.load(fh)
    root = tk.Tk()
    emu = Emulator(root, panel, args)
    if args.test_seconds:
        if args.auto_press:
            r, c = (int(x) for x in args.auto_press.split(","))

            def do_press():
                if emu.alpha:
                    emu.press(emu.buttons[(r, c)][1], True)      # held until the test ends
                else:
                    root.after(200, do_press)
            root.after(300, do_press)

        def report():
            print("test: port=%d alpha=%s matrix=%s state=%s" % (emu.port, emu.alpha, emu.matrix, json.dumps(emu.state)[:300]))
            print("test: header=%s  foot=%s" % (emu.hdr.cget("text"), emu.foot.cget("text")))
            emu.close()
        root.after(int(args.test_seconds * 1000), report)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
