//! An approximation of `String.prototype.localeCompare` (ICU root collation, what Electron's default locale gives
//! for file names), enough for sorting paths. Not a Unicode collation implementation.
//!
//! Primary order: whitespace, punctuation and symbols (in ICU's order), digits, then letters with case and accents
//! ignored. Ties break on accents, then lowercase before uppercase. Digits compare as characters ("10" < "2").
//! Letters outside Latin-1 compare by lowercase code point after the ASCII letters.

use std::cmp::Ordering;

const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// (primary, secondary accent mark, tertiary case: 0 lower, 1 upper)
fn weights(c: char) -> (u32, u32, u32) {
    if c.is_whitespace() {
        return (c as u32, 0, 0);
    }
    if let Some(i) = PUNCTUATION.find(c) {
        return (0x100 + i as u32, 0, 0);
    }
    if c.is_ascii_digit() {
        return (0x200 + c as u32 - '0' as u32, 0, 0);
    }
    let (base, accent) = strip_accent(c);
    let upper = base.is_uppercase();
    let lower = base.to_lowercase().next().unwrap_or(base);
    let primary = if lower.is_ascii_lowercase() { 0x300 + lower as u32 - 'a' as u32 } else { 0x400 + lower as u32 };
    (primary, accent, u32::from(upper))
}

/// Latin-1 and Latin Extended-A letters with a diacritic: (base letter, accent id).
fn strip_accent(c: char) -> (char, u32) {
    const TABLE: &[(&str, char)] = &[
        ("ÀÁÂÃÄÅĀĂĄ", 'A'),
        ("àáâãäåāăą", 'a'),
        ("ÇĆĈĊČ", 'C'),
        ("çćĉċč", 'c'),
        ("ĎĐ", 'D'),
        ("ďđ", 'd'),
        ("ÈÉÊËĒĔĖĘĚ", 'E'),
        ("èéêëēĕėęě", 'e'),
        ("ĜĞĠĢ", 'G'),
        ("ĝğġģ", 'g'),
        ("ÌÍÎÏĨĪĬĮİ", 'I'),
        ("ìíîïĩīĭįı", 'i'),
        ("ŁĹĻĽ", 'L'),
        ("łĺļľ", 'l'),
        ("ÑŃŅŇ", 'N'),
        ("ñńņň", 'n'),
        ("ÒÓÔÕÖØŌŎŐ", 'O'),
        ("òóôõöøōŏő", 'o'),
        ("ŔŖŘ", 'R'),
        ("ŕŗř", 'r'),
        ("ŚŜŞŠ", 'S'),
        ("śŝşš", 's'),
        ("ŢŤ", 'T'),
        ("ţť", 't'),
        ("ÙÚÛÜŨŪŬŮŰŲ", 'U'),
        ("ùúûüũūŭůűų", 'u'),
        ("ÝŶŸ", 'Y'),
        ("ýÿŷ", 'y'),
        ("ŹŻŽ", 'Z'),
        ("źżž", 'z'),
    ];
    for (group, base) in TABLE {
        if let Some(i) = group.chars().position(|g| g == c) {
            return (*base, 1 + i as u32);
        }
    }
    (c, 0)
}

/// Compares two names the way `a.localeCompare(b)` orders them (negative, zero, positive as `Ordering`).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let wa: Vec<_> = a.chars().map(weights).collect();
    let wb: Vec<_> = b.chars().map(weights).collect();
    let by = |pick: fn(&(u32, u32, u32)) -> u32| -> Ordering { wa.iter().map(pick).cmp(wb.iter().map(pick)) };
    by(|w| w.0).then_with(|| by(|w| w.1)).then_with(|| by(|w| w.2))
}
