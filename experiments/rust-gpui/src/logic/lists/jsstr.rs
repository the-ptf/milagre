//! JavaScript string semantics the ported logic depends on: which characters `trim` and `\s` treat as
//! whitespace, and lengths and cuts counted in UTF-16 code units (`String.length`, `slice`).

/// `true` for what JavaScript's `String.prototype.trim` and `\s` call whitespace. Rust's
/// `char::is_whitespace` differs: it has U+0085 (JS does not) and lacks U+FEFF (JS has it).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `s.length`: the length in UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, units)`, except that it never splits a surrogate pair (a Rust `String` cannot hold half of one):
/// the longest prefix of whole characters within `units` code units.
pub fn utf16_prefix(s: &str, units: usize) -> &str {
    let mut used = 0;
    for (index, c) in s.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &s[..index];
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_follows_javascript() {
        assert_eq!(js_trim("\u{feff} a \u{a0}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn lengths_count_utf16_units() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("ab😀c", 3), "ab");
        assert_eq!(utf16_prefix("ab😀c", 4), "ab😀");
        assert_eq!(utf16_prefix("abc", 10), "abc");
    }
}
