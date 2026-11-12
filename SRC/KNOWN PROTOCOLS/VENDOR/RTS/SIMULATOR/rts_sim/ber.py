"""BER / SNMP wire encoding.

Part of rts_intercom_sim.py, split into the rts_sim package; rts_intercom_sim.py stays the
entry point and re-exports every name."""
import socket


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
