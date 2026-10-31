//! Minimal SNMPv2c SET encoder (BER) so a port rename can be pushed to a
//! vendor frame that takes names over SNMP. No decoding, no walking: one
//! OctetString SET per call, optionally sent over UDP.

use std::io;
use std::net::UdpSocket;
use std::time::Duration;

fn len(n: usize) -> Vec<u8> {
    if n < 0x80 {
        vec![n as u8]
    } else if n < 0x100 {
        vec![0x81, n as u8]
    } else {
        vec![0x82, (n >> 8) as u8, n as u8]
    }
}

fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![tag];
    v.extend(len(body.len()));
    v.extend_from_slice(body);
    v
}

fn int(i: i64) -> Vec<u8> {
    let mut bytes = i.to_be_bytes().to_vec();
    while bytes.len() > 1 && ((bytes[0] == 0 && bytes[1] & 0x80 == 0) || (bytes[0] == 0xff && bytes[1] & 0x80 != 0)) {
        bytes.remove(0);
    }
    tlv(0x02, &bytes)
}

fn octets(s: &[u8]) -> Vec<u8> {
    tlv(0x04, s)
}

/// Dotted OID → BER OBJECT IDENTIFIER. Returns None for a malformed OID.
pub fn oid(dotted: &str) -> Option<Vec<u8>> {
    let parts: Vec<u64> = dotted.split('.').filter(|p| !p.is_empty()).map(|p| p.parse().ok()).collect::<Option<_>>()?;
    if parts.len() < 2 || parts[0] > 2 || parts[1] > 39 {
        return None;
    }
    let mut body = vec![(parts[0] * 40 + parts[1]) as u8];
    for &arc in &parts[2..] {
        let mut chunks = Vec::new();
        let mut a = arc;
        chunks.push((a & 0x7f) as u8);
        a >>= 7;
        while a > 0 {
            chunks.push((a & 0x7f) as u8 | 0x80);
            a >>= 7;
        }
        chunks.reverse();
        body.extend(chunks);
    }
    Some(tlv(0x06, &body))
}

/// Build an SNMPv2c SET-REQUEST setting `oid_dotted` to the string `value`.
pub fn set_request(community: &str, oid_dotted: &str, value: &str, request_id: i32) -> Option<Vec<u8>> {
    let varbind = tlv(0x30, &[oid(oid_dotted)?, octets(value.as_bytes())].concat());
    let varbinds = tlv(0x30, &varbind);
    let pdu = tlv(0xA3, &[int(request_id as i64), int(0), int(0), varbinds].concat());
    Some(tlv(0x30, &[int(1), octets(community.as_bytes()), pdu].concat()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fire the datagram at `target` (host or host:port). Does not wait for a
/// response beyond a short timeout; returns the number of bytes sent.
pub fn send(target: &str, default_port: u16, pdu: &[u8]) -> io::Result<usize> {
    let addr = if target.contains(':') { target.to_string() } else { format!("{target}:{default_port}") };
    let sock = UdpSocket::bind("0.0.0.0:0")?;
    sock.set_write_timeout(Some(Duration::from_secs(2)))?;
    sock.send_to(pdu, addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_known_oid() {
        // sysName.0 = 1.3.6.1.2.1.1.5.0 -> 06 08 2b 06 01 02 01 01 05 00
        assert_eq!(hex(&oid("1.3.6.1.2.1.1.5.0").unwrap()), "06082b060102010105" .to_string() + "00");
        assert!(oid("1.3.6.1.4.1.99999.1").is_some());
        assert!(oid("not.an.oid").is_none());
    }

    #[test]
    fn set_request_is_well_formed() {
        let pdu = set_request("private", "1.3.6.1.2.1.1.5.0", "Andrey", 1).unwrap();
        assert_eq!(pdu[0], 0x30);
        assert_eq!(pdu[1] as usize, pdu.len() - 2);
        // version 2c
        assert_eq!(&pdu[2..5], &[0x02, 0x01, 0x01]);
        // SET-REQUEST tag present
        assert!(pdu.contains(&0xA3));
        let h = hex(&pdu);
        assert!(h.contains(&hex(b"Andrey")));
    }
}
