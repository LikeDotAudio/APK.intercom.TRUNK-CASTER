//! Panel labels. Intercom panels show a name in 6, 8 or 16 characters, so
//! every person gets all three cuts, with full emoji support: an emoji (with
//! its skin tone, variation selector, ZWJ sequence or flag pair) counts as
//! one character, never as several and never split in half.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    pub full: String,
    /// Six-character panels.
    pub l6: String,
    /// Eight-character panels.
    pub l8: String,
    /// Sixteen-character panels.
    pub l16: String,
    /// Length of `full` in panel characters (grapheme clusters).
    pub chars: usize,
    /// True when a 6-character panel cannot show the whole name.
    pub over6: bool,
    pub over8: bool,
    pub over16: bool,
}

impl Label {
    /// Derive every cut from the full name.
    pub fn new(full: &str) -> Label {
        let full = full.trim();
        let g = graphemes(full);
        let cut = |n: usize| g.iter().take(n).cloned().collect::<String>();
        Label {
            full: full.to_string(),
            l6: cut(6),
            l8: cut(8),
            l16: cut(16),
            chars: g.len(),
            over6: g.len() > 6,
            over8: g.len() > 8,
            over16: g.len() > 16,
        }
    }

    /// Derive, then apply explicit overrides (each trimmed to its width).
    pub fn with_overrides(full: &str, l6: Option<&str>, l8: Option<&str>, l16: Option<&str>) -> Label {
        let mut l = Label::new(full);
        if let Some(s) = l6 {
            l.l6 = fit(s, 6);
        }
        if let Some(s) = l8 {
            l.l8 = fit(s, 8);
        }
        if let Some(s) = l16 {
            l.l16 = fit(s, 16);
        }
        l
    }

    /// The label for a panel of `width` characters.
    pub fn for_width(&self, width: usize) -> &str {
        match width {
            w if w <= 6 => &self.l6,
            w if w <= 8 => &self.l8,
            _ => &self.l16,
        }
    }
}

/// First `n` panel characters of `s`.
pub fn fit(s: &str, n: usize) -> String {
    graphemes(s.trim()).into_iter().take(n).collect()
}

/// Number of panel characters in `s`.
pub fn width(s: &str) -> usize {
    graphemes(s).len()
}

fn is_combining(c: char) -> bool {
    let u = c as u32;
    (0x0300..=0x036F).contains(&u)        // combining diacritics
        || (0x1AB0..=0x1AFF).contains(&u)
        || (0x1DC0..=0x1DFF).contains(&u)
        || (0x20D0..=0x20FF).contains(&u)
        || (0xFE00..=0xFE0F).contains(&u)  // variation selectors (emoji presentation)
        || (0xFE20..=0xFE2F).contains(&u)
        || (0x1F3FB..=0x1F3FF).contains(&u) // skin tone modifiers
        || (0xE0020..=0xE007F).contains(&u) // tag sequences (subdivision flags)
        || u == 0x200C                      // zero width non-joiner
        || u == 0x200D                      // zero width joiner glues to the previous...
}

fn is_regional_indicator(c: char) -> bool {
    (0x1F1E6..=0x1F1FF).contains(&(c as u32))
}

/// Split into grapheme clusters: good enough for names and emoji without
/// pulling in a Unicode database. Handles combining marks, variation
/// selectors, skin tones, ZWJ sequences (👨‍👩‍👧), flags (🇺🇸) and CRLF.
pub fn graphemes(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut join_next = false;
    let mut pending_flag = false;
    for c in s.chars() {
        let glue = join_next
            || is_combining(c)
            || (pending_flag && is_regional_indicator(c))
            || (c == '\n' && out.last().map_or(false, |g| g == "\r"));
        if glue && !out.is_empty() {
            out.last_mut().unwrap().push(c);
        } else {
            out.push(c.to_string());
        }
        join_next = c == '\u{200D}'; // ...and the character after it joins too
        pending_flag = is_regional_indicator(c) && !glue;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_names() {
        let l = Label::new("Andrey Kuzub");
        assert_eq!((l.l6.as_str(), l.l8.as_str(), l.l16.as_str()), ("Andrey", "Andrey K", "Andrey Kuzub"));
        assert_eq!(l.chars, 12);
        assert!(l.over6 && l.over8 && !l.over16);
        assert_eq!(Label::new("Sam").l6, "Sam");
    }

    #[test]
    fn emoji_count_as_one() {
        assert_eq!(width("🎙️Dir"), 4); // mic + variation selector, then D i r
        assert_eq!(width("👨‍👩‍👧 fam"), 5); // family ZWJ sequence is one
        assert_eq!(width("🇺🇸 NYC"), 5); // flag pair is one
        assert_eq!(width("👍🏽ok"), 3); // thumbs up with skin tone is one
        let l = Label::new("🎙️ Studio B Director");
        assert_eq!(l.l6, "🎙️ Stud");
        assert_eq!(l.l8, "🎙️ Studio");
    }

    #[test]
    fn overrides_are_fitted() {
        let l = Label::with_overrides("Andrey Kuzub", Some("ANDREY!!"), None, None);
        assert_eq!(l.l6, "ANDREY");
        assert_eq!(l.l8, "Andrey K");
    }
}
