"""
tc_protocol.py  --  the Trunk-Caster common language.

Every brand simulator (RTS, Riedel, Clear-Com, ...) speaks this on its audio
port, and the TRUNK-SIMULATOR soft panel (your computer) speaks it back.
It is deliberately tiny: one UDP socket, fixed 20 ms frames of 8 kHz 16-bit
mono PCM, and a handful of control messages.

Sockets: an intercom owns a SERIES of 256 consecutive UDP ports.  Series + 0 is
the intercom's own socket (send HELLO there to be given a port); series + n is
the socket of matrix port n (n = 1..255), one generator = one socket, and only
the endpoint that owns port n is spoken to on it.  HELLO_ACK carries "series"
and "socket" so an endpoint knows where to move.

Frame layout (big-endian):

    0  2   magic   b"TC"
    2  1   version 1
    3  1   type    see TYPE_*
    4  2   port    intercom port number this frame is about (0 = unassigned)
    6  2   seq     sender sequence number (wraps)
    8  2   flags   reserved / per-type
   10  ..  payload

Payloads
    HELLO       utf-8 name of the endpoint.  Endpoint -> matrix, repeat every
                HELLO_INTERVAL seconds as a keepalive.  port=0 asks the matrix
                to assign a free user port.
    HELLO_ACK   JSON: {"port":n,"alpha":"PNL01","matrix":"LOND","series":22304,"socket":22305,
                       "ports":[{"n":1,"alpha":"PNL01","type":"PANEL","user":true,"socket":22305}, ...]}
                (the "ports" list is only filled when answered on the port's own socket)
    AUDIO       FRAME_SAMPLES int16 little-endian samples (one 20 ms frame).
                Endpoint -> matrix: what the endpoint's mic hears.
                Matrix -> endpoint: the mix the endpoint should play.
    KEY         struct ">BHB": kind (KEY_TALK / KEY_LISTEN), target port, state (1 on / 0 off)
    STATE       JSON from the matrix about the endpoint's port:
                {"talking_to":[n..], "listening":[n..],
                 "incoming":[{"port":n,"alpha":"CAM03","since":epoch}, ...],
                 "users":56, "users_calling":3, "time":"2026-10-20T14:55:02-04:00"}
    BYE         empty
"""
import json
import struct

MAGIC = b"TC"
VERSION = 1

TYPE_HELLO, TYPE_HELLO_ACK, TYPE_AUDIO, TYPE_KEY, TYPE_STATE, TYPE_BYE = 1, 2, 3, 4, 5, 6
TYPE_NAMES = {1: "HELLO", 2: "HELLO_ACK", 3: "AUDIO", 4: "KEY", 5: "STATE", 6: "BYE"}

KEY_TALK, KEY_LISTEN = 0, 1

SAMPLE_RATE = 8000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000      # 160
FRAME_BYTES = FRAME_SAMPLES * 2
HELLO_INTERVAL = 3.0
ENDPOINT_TIMEOUT = 10.0

HEADER = struct.Struct(">2sBBHHH")
KEY_PAYLOAD = struct.Struct(">BHB")


def pack(msg_type, port, seq, payload=b"", flags=0):
    return HEADER.pack(MAGIC, VERSION, msg_type, port & 0xFFFF, seq & 0xFFFF, flags & 0xFFFF) + payload


def unpack(data):
    """-> (type, port, seq, flags, payload) or None if not ours."""
    if len(data) < HEADER.size:
        return None
    magic, version, msg_type, port, seq, flags = HEADER.unpack_from(data)
    if magic != MAGIC or version != VERSION:
        return None
    return msg_type, port, seq, flags, data[HEADER.size:]


def pack_hello(port, seq, name):
    return pack(TYPE_HELLO, port, seq, name.encode("utf-8"))


def pack_hello_ack(port, seq, info):
    return pack(TYPE_HELLO_ACK, port, seq, json.dumps(info, separators=(",", ":")).encode("utf-8"))


def pack_audio(port, seq, pcm_bytes):
    return pack(TYPE_AUDIO, port, seq, pcm_bytes)


def pack_key(port, seq, kind, target, state):
    return pack(TYPE_KEY, port, seq, KEY_PAYLOAD.pack(kind, target & 0xFFFF, 1 if state else 0))


def unpack_key(payload):
    kind, target, state = KEY_PAYLOAD.unpack_from(payload)
    return kind, target, bool(state)


def pack_state(port, seq, state):
    return pack(TYPE_STATE, port, seq, json.dumps(state, separators=(",", ":")).encode("utf-8"))


def pack_bye(port, seq):
    return pack(TYPE_BYE, port, seq)


def loads(payload):
    return json.loads(payload.decode("utf-8"))
