//! The Ward-Beck crosspoint line: the unifying words of Trunk-Caster.
//!
//! Every crosspoint on every frame of every protocol is expressed as one
//! comma-separated line:
//!
//! ```text
//! SITE,FRAME,INPUT,INPUT_NAME,CLOSE/OPEN,OUTPUT_NAME,OUTPUT,FRAME,SITE
//! ```
//!
//! The left side is where the signal enters, the right side where it
//! leaves. Both sides carry their own frame and site, so one line can
//! express a crosspoint inside a frame (same frame, same site) or an
//! end-to-end connection between two frames anywhere (anything to
//! anything). `CLOSE` makes the connection; `OPEN` expresses that it is
//! not there any more.
//!
//! A **check-in** is a line whose INPUT is `CHECKIN`: the frame restates,
//! periodically, how many crosspoints it has closed, followed by one
//! `CLOSE` line per crosspoint. A listener that missed deltas can rebuild
//! the frame's state from the latest check-in alone.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Switch {
    Close,
    Open,
}

impl Switch {
    pub fn as_str(self) -> &'static str {
        match self {
            Switch::Close => "CLOSE",
            Switch::Open => "OPEN",
        }
    }
}

/// The marker INPUT of a check-in line.
pub const CHECKIN: &str = "CHECKIN";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Line {
    pub site: String,
    pub frame: String,
    pub input: String,
    pub input_name: String,
    pub switch: Switch,
    pub output_name: String,
    pub output: String,
    pub out_frame: String,
    pub out_site: String,
}

impl Line {
    /// A crosspoint inside one frame.
    pub fn local(site: &str, frame: &str, input: &str, input_name: &str, switch: Switch, output_name: &str, output: &str) -> Line {
        Line {
            site: site.into(),
            frame: frame.into(),
            input: input.into(),
            input_name: input_name.into(),
            switch,
            output_name: output_name.into(),
            output: output.into(),
            out_frame: frame.into(),
            out_site: site.into(),
        }
    }

    /// An end-to-end connection between two frames, possibly at two sites.
    #[allow(clippy::too_many_arguments)]
    pub fn between(
        site: &str,
        frame: &str,
        input: &str,
        input_name: &str,
        switch: Switch,
        output_name: &str,
        output: &str,
        out_frame: &str,
        out_site: &str,
    ) -> Line {
        Line {
            site: site.into(),
            frame: frame.into(),
            input: input.into(),
            input_name: input_name.into(),
            switch,
            output_name: output_name.into(),
            output: output.into(),
            out_frame: out_frame.into(),
            out_site: out_site.into(),
        }
    }

    /// A check-in: `SITE,FRAME,CHECKIN,<when>,CLOSE|OPEN,<n> crosspoints,<n>,FRAME,SITE`.
    /// `CLOSE` when the frame has crosspoints closed, `OPEN` when it is idle.
    pub fn checkin(site: &str, frame: &str, when: &str, closed: usize) -> Line {
        Line::local(
            site,
            frame,
            CHECKIN,
            when,
            if closed > 0 { Switch::Close } else { Switch::Open },
            &format!("{closed} crosspoints"),
            &closed.to_string(),
        )
    }

    pub fn is_checkin(&self) -> bool {
        self.input == CHECKIN
    }

    pub fn is_local(&self) -> bool {
        self.frame == self.out_frame && self.site == self.out_site
    }

    /// Parse one line. Fields are trimmed; a field containing a comma must
    /// be double-quoted.
    pub fn parse(text: &str) -> Result<Line, String> {
        let f = split_csv(text.trim());
        if f.len() != 9 {
            return Err(format!("expected 9 fields, got {}", f.len()));
        }
        let switch = match f[4].to_ascii_uppercase().as_str() {
            "CLOSE" => Switch::Close,
            "OPEN" => Switch::Open,
            other => return Err(format!("field 5 must be CLOSE or OPEN, got {other}")),
        };
        Ok(Line {
            site: f[0].clone(),
            frame: f[1].clone(),
            input: f[2].clone(),
            input_name: f[3].clone(),
            switch,
            output_name: f[5].clone(),
            output: f[6].clone(),
            out_frame: f[7].clone(),
            out_site: f[8].clone(),
        })
    }

    /// The opposite switch, same crosspoint.
    pub fn flipped(&self) -> Line {
        let mut l = self.clone();
        l.switch = match self.switch {
            Switch::Close => Switch::Open,
            Switch::Open => Switch::Close,
        };
        l
    }
}

impl fmt::Display for Line {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{},{},{},{},{},{},{},{},{}",
            q(&self.site),
            q(&self.frame),
            q(&self.input),
            q(&self.input_name),
            self.switch.as_str(),
            q(&self.output_name),
            q(&self.output),
            q(&self.out_frame),
            q(&self.out_site)
        )
    }
}

fn q(s: &str) -> String {
    if s.contains(',') || s.contains('"') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn split_csv(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_q && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => in_q = !in_q,
            ',' if !in_q => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    out.push(cur.trim().to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let l = Line::between("HQ", "dante-01", "U00", "Andrey", Switch::Close, "Sam", "U05", "sip-03", "HQ");
        let s = l.to_string();
        assert_eq!(s, "HQ,dante-01,U00,Andrey,CLOSE,Sam,U05,sip-03,HQ");
        assert_eq!(Line::parse(&s).unwrap(), l);
        assert!(!l.is_local());
        assert_eq!(l.flipped().switch, Switch::Open);
    }

    #[test]
    fn checkin_line() {
        let c = Line::checkin("HQ", "rvon-02", "2026-10-20T12:00:00Z", 4);
        assert!(c.is_checkin());
        assert_eq!(c.to_string(), "HQ,rvon-02,CHECKIN,2026-10-20T12:00:00Z,CLOSE,4 crosspoints,4,rvon-02,HQ");
        assert_eq!(Line::checkin("HQ", "rvon-02", "t", 0).switch, Switch::Open);
    }

    #[test]
    fn quoted_fields() {
        let l = Line::local("Site, North", "f", "U01", "Smith, J", Switch::Open, "x", "C0");
        let s = l.to_string();
        assert!(s.starts_with("\"Site, North\""));
        assert_eq!(Line::parse(&s).unwrap(), l);
        assert!(Line::parse("a,b,c").is_err());
    }
}
