//! Scanning helpers the prompt ports share: `prosePrompt` (the prompt with code blanked out) and the
//! `(^|\s)` prefix every mention regex starts with.

use crate::logic::copy::js;

/// `prosePrompt`: the prompt with code blanked: fenced blocks (``` and ~~~, open ones to the end) and inline
/// code spans become spaces, each byte one space and newlines kept, so offsets in the result are offsets in the
/// prompt.
pub fn prose_prompt(prompt: &str) -> String {
    let bytes = prompt.as_bytes();
    let mut out = String::with_capacity(prompt.len());
    let mut at = 0;
    while at < bytes.len() {
        let rest = &prompt[at..];
        let end = if rest.starts_with("```") || rest.starts_with("~~~") {
            let fence = &rest[..3];
            match rest[3..].find(fence) {
                Some(found) => Some(at + 3 + found + 3),
                None => Some(bytes.len()),
            }
        } else if bytes[at] == b'`' {
            // (`+)[^\n]*?(?:\1(?!`)|(?=\n|$)) with a run of one or two backticks (three or more is a fence).
            let run = bytes[at..].iter().take_while(|b| **b == b'`').count();
            let mut p = at + run;
            loop {
                if bytes[p..].starts_with(&bytes[at..at + run]) && bytes.get(p + run) != Some(&b'`') {
                    break Some(p + run);
                }
                if p >= bytes.len() || bytes[p] == b'\n' {
                    break Some(p);
                }
                p += 1;
            }
        } else {
            None
        };
        match end {
            Some(end) => {
                for c in prompt[at..end].chars() {
                    if c == '\n' {
                        out.push('\n');
                    } else {
                        out.extend(std::iter::repeat_n(' ', c.len_utf8()));
                    }
                }
                at = end;
            }
            None => {
                let c = rest.chars().next().expect("at < len");
                out.push(c);
                at += c.len_utf8();
            }
        }
    }
    out
}

/// The ways `(^|\s)` can match at byte `at`, as the length it consumes: empty at the very start, then one
/// whitespace char. Regex order: `^` first.
pub fn group_one_options(text: &str, at: usize) -> impl Iterator<Item = usize> {
    let whitespace = text.get(at..).and_then(|rest| rest.chars().next()).filter(|c| js::is_space(*c)).map(char::len_utf8);
    (at == 0).then_some(0).into_iter().chain(whitespace)
}

/// The next char boundary after `at` (or the end).
pub fn next_boundary(text: &str, at: usize) -> usize {
    text[at..].chars().next().map_or(text.len() + 1, |c| at + c.len_utf8())
}

/// Every non-overlapping match of `(^|\s)` followed by whatever `rest` accepts at the position after it, like
/// `String.prototype.matchAll`. `rest(text, pos)` returns the end of the match, or `None`. Yields
/// `(match_index, group_one_len, match_end)`.
pub fn scan_prefixed(text: &str, mut rest: impl FnMut(&str, usize) -> Option<usize>) -> Vec<(usize, usize, usize)> {
    let mut found = Vec::new();
    let mut at = 0;
    while at <= text.len() {
        let mut matched = false;
        for len in group_one_options(text, at) {
            if let Some(end) = rest(text, at + len) {
                found.push((at, len, end));
                at = end;
                matched = true;
                break;
            }
        }
        if !matched {
            at = next_boundary(text, at);
        }
    }
    found
}

/// `TRAILING_PUNCTUATION`: `[.,!?;:)\]}]` (the class, used in `+$` and `*$` form).
pub fn is_trailing_punctuation(c: char) -> bool {
    matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | ')' | ']' | '}')
}

/// `text.replace(/[.,!?;:)\]}]+$/, "")`.
pub fn strip_trailing_punctuation(text: &str) -> &str {
    text.trim_end_matches(is_trailing_punctuation)
}

/// `/^chat:[1-9]\d*[.,!?;:)\]}]*$/`: a path that reads as a Chat mention.
pub fn is_chat_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("chat:") else { return false };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && !rest.starts_with('0') && rest[digits..].chars().all(is_trailing_punctuation)
}

/// `Number.isSafeInteger` bound for ids read from digits.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Digits as `Number(digits)`, saturating where a float would stop being exact.
pub fn parse_number(digits: &str) -> u64 {
    digits.parse().unwrap_or(u64::MAX)
}

/// A UTF-16 offset (as a DOM or native selection gives it) as a byte offset into `text`; `None` when it falls
/// inside a surrogate pair or past the end.
pub fn utf16_to_byte(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, c) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += c.len_utf16();
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

/// A byte offset as a UTF-16 offset; `None` when it is not on a char boundary.
pub fn byte_to_utf16(text: &str, offset: usize) -> Option<usize> {
    text.is_char_boundary(offset).then(|| text[..offset].encode_utf16().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_becomes_spaces_and_keeps_offsets() {
        assert_eq!(prose_prompt("a `b` c"), "a     c");
        assert_eq!(prose_prompt("a ``b`c`` d"), "a         d");
        assert_eq!(prose_prompt("x ```\n@a\n``` y"), "x    \n  \n    y");
        assert_eq!(prose_prompt("~~~\n/tl"), "   \n   ");
        assert_eq!(prose_prompt("run `echo /tl"), "run          ");
        assert_eq!(prose_prompt("run `echo /tl\nnext"), "run          \nnext");
        assert_eq!(prose_prompt("``echo ` /tl ``"), "               ");
        assert_eq!(prose_prompt("é `é`").len(), "é `é`".len());
        assert_eq!(prose_prompt("é `é`"), "é     ");
        assert_eq!(prose_prompt("plain text"), "plain text");
        assert_eq!(prose_prompt("a ` b"), "a    ");
        assert_eq!(prose_prompt("a``"), "a  ");
    }

    #[test]
    fn utf16_offsets_convert_to_bytes_and_back() {
        let text = "🙂 use";
        assert_eq!(utf16_to_byte(text, 0), Some(0));
        assert_eq!(utf16_to_byte(text, 1), None);
        assert_eq!(utf16_to_byte(text, 2), Some(4));
        assert_eq!(utf16_to_byte(text, 6), Some(8));
        assert_eq!(utf16_to_byte(text, 7), None);
        assert_eq!(byte_to_utf16(text, 4), Some(2));
        assert_eq!(byte_to_utf16(text, 1), None);
    }

    #[test]
    fn chat_paths() {
        assert!(is_chat_path("chat:12"));
        assert!(is_chat_path("chat:12!"));
        assert!(is_chat_path("chat:12.)"));
        assert!(!is_chat_path("chat:0"));
        assert!(!is_chat_path("chat:12x"));
        assert!(!is_chat_path("chat:"));
        assert_eq!(strip_trailing_punctuation("a.b)."), "a.b");
    }
}
