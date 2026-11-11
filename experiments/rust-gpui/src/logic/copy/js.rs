//! JavaScript semantics the ported TypeScript leans on, written out so the Rust matches it: `Math.round`, the
//! `\s` class and `String.prototype.trim`, `\w`, and UTF-16 lengths.

/// `Math.round`: halves round toward positive infinity (`-0.5` gives `-0`, `2.5` gives `3`).
pub fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Math.round` as an integer.
pub fn round_i64(value: f64) -> i64 {
    round(value) as i64
}

/// Whether a char is in JavaScript's `\s` class (and what `trim` removes).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// JavaScript's `String.prototype.trim`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// JavaScript's `\w`: ASCII letters, digits and underscore.
pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// A number as `String(n)` prints it for the values the ported code produces (integers and short decimals).
pub fn number_string(value: f64) -> String {
    if value == value.trunc() && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// `text.length` in JavaScript: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(text.length - n)` kept to whole chars: the last `n` UTF-16 units, never splitting a surrogate pair
/// (JavaScript would; the ported callers only cut prose, so a split half would draw as a replacement mark).
pub fn tail_utf16(text: &str, n: usize) -> &str {
    let mut units = 0;
    let mut start = text.len();
    for (index, c) in text.char_indices().rev() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        start = index;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_math_round() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49), 0.0);
        assert_eq!(round(94.5), 95.0);
    }

    #[test]
    fn trim_uses_the_javascript_whitespace_set() {
        assert_eq!(trim("\u{FEFF} a \u{A0}"), "a");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn numbers_print_like_string() {
        assert_eq!(number_string(1.0), "1");
        assert_eq!(number_string(1.5), "1.5");
        assert_eq!(number_string(12.0), "12");
    }

    #[test]
    fn tail_keeps_whole_chars() {
        assert_eq!(tail_utf16("héllo", 3), "llo");
        assert_eq!(tail_utf16("a😀b", 2), "b");
        assert_eq!(utf16_len("a😀"), 3);
    }
}
