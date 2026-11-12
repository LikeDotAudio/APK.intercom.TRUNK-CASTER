"""AudioEngine: the matrix's series of sockets.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import math
import selectors
import socket
import threading
import time
from collections import deque
from .env import local_tz_label, np, tcp


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
