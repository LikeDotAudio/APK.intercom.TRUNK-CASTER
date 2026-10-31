//! A small WebSocket server (RFC 6455, server→client text frames) so the
//! pages receive telemetry as a stream instead of polling. Plain `std`:
//! SHA-1 and base64 for the handshake, masking-aware reader for the few
//! frames a browser sends back (ping, close).

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Clients currently subscribed. Shared with the runtime, which broadcasts.
#[derive(Clone, Default)]
pub struct Broadcaster {
    clients: Arc<Mutex<Vec<TcpStream>>>,
}

impl Broadcaster {
    pub fn add(&self, s: TcpStream) {
        let _ = s.set_write_timeout(Some(Duration::from_millis(800)));
        let _ = s.set_nodelay(true);
        self.clients.lock().unwrap_or_else(|e| e.into_inner()).push(s);
    }

    pub fn count(&self) -> usize {
        self.clients.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// Send one text frame to every client; clients that fail are dropped.
    pub fn broadcast(&self, text: &str) -> usize {
        let frame = text_frame(text.as_bytes());
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        clients.retain_mut(|c| c.write_all(&frame).is_ok());
        clients.len()
    }
}

/// Finish the handshake on an HTTP request that asked to upgrade.
pub fn accept(stream: &mut TcpStream, key: &str) -> io::Result<()> {
    let mut input = key.trim().as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept = base64(&sha1(&input));
    let resp = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    stream.write_all(resp.as_bytes())?;
    stream.flush()
}

/// Read client frames until the socket closes; answer pings, honour close.
/// Runs on the connection's own thread; it never blocks the broadcaster.
pub fn read_loop(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(None);
    let mut hdr = [0u8; 2];
    loop {
        if stream.read_exact(&mut hdr).is_err() {
            return;
        }
        let opcode = hdr[0] & 0x0f;
        let masked = hdr[1] & 0x80 != 0;
        let mut len = (hdr[1] & 0x7f) as u64;
        if len == 126 {
            let mut b = [0u8; 2];
            if stream.read_exact(&mut b).is_err() {
                return;
            }
            len = u16::from_be_bytes(b) as u64;
        } else if len == 127 {
            let mut b = [0u8; 8];
            if stream.read_exact(&mut b).is_err() {
                return;
            }
            len = u64::from_be_bytes(b);
        }
        let mut mask = [0u8; 4];
        if masked && stream.read_exact(&mut mask).is_err() {
            return;
        }
        let mut payload = vec![0u8; len.min(1 << 20) as usize];
        if stream.read_exact(&mut payload).is_err() {
            return;
        }
        if masked {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
        }
        match opcode {
            0x8 => {
                let _ = stream.write_all(&frame(0x8, &payload));
                return;
            }
            0x9 => {
                let _ = stream.write_all(&frame(0xA, &payload));
            }
            _ => {}
        }
    }
}

fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![0x80 | opcode];
    let n = payload.len();
    if n < 126 {
        v.push(n as u8);
    } else if n < 65_536 {
        v.push(126);
        v.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        v.push(127);
        v.extend_from_slice(&(n as u64).to_be_bytes());
    }
    v.extend_from_slice(payload);
    v
}

fn text_frame(payload: &[u8]) -> Vec<u8> {
    frame(0x1, payload)
}

// --- SHA-1 and base64, enough for the handshake ----------------------------

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_accept_matches_rfc_example() {
        // RFC 6455 section 1.3.
        let mut input = b"dGhlIHNhbXBsZSBub25jZQ==".to_vec();
        input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        assert_eq!(base64(&sha1(&input)), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn frames_encode_length() {
        assert_eq!(text_frame(b"hi")[..2], [0x81, 2]);
        let big = vec![b'x'; 300];
        let f = text_frame(&big);
        assert_eq!(f[1], 126);
        assert_eq!(u16::from_be_bytes([f[2], f[3]]), 300);
    }
}
