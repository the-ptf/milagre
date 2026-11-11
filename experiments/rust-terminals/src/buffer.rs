//! The in-memory replay buffer of one Terminal, ported from `append`/`since`/`read` in terminals.cjs.
//!
//! Offsets, lengths and the character cap are counted in UTF-16 code units, because that is what JavaScript string
//! lengths are and what every viewer already sends back as `after`. Text is kept as UTF-16 so cuts land on exactly the
//! same unit as in Node. The one difference: where Node would hand out a lone surrogate (a cut through an astral
//! character that the Node code does not guard), Rust strings can't hold one, so it goes out as U+FFFD, which is also
//! one unit long. Offsets never drift.

use std::collections::VecDeque;

pub const MAX_BUFFER_CHARS: usize = 1024 * 1024;
pub const MAX_BUFFER_LINES: usize = 10_000;
/// The smallest read limit a viewer may ask for.
pub const MIN_READ_LIMIT: usize = 4096;

#[derive(Debug, Clone)]
struct Chunk {
    start: u64,
    text: Vec<u16>,
    lines: usize,
}

#[derive(Debug, Clone)]
pub struct OutputBuffer {
    chunks: VecDeque<Chunk>,
    end: u64,
    chars: usize,
    lines: usize,
    max_chars: usize,
    max_lines: usize,
}

/// What a read hands to a viewer, before the Terminal adds `ended` and its info.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slice {
    pub offset: u64,
    pub data: Vec<u16>,
    pub reset: bool,
    /// A limited, in-order read that left output behind: the viewer must read again before it can see `ended`.
    pub more: bool,
}

fn line_count(text: &[u16]) -> usize {
    text.iter().filter(|unit| **unit == 0x0a).count()
}

/// A cut never splits a surrogate pair: the head stops before a lone high half.
pub fn head_end(data: &[u16], limit: usize) -> usize {
    let code = data[limit - 1];
    if (0xd800..=0xdbff).contains(&code) {
        limit - 1
    } else {
        limit
    }
}

/// ...and the tail starts after a lone low half.
pub fn tail_start(data: &[u16], limit: usize) -> usize {
    let start = data.len() - limit;
    let code = data[start];
    if (0xdc00..=0xdfff).contains(&code) {
        start + 1
    } else {
        start
    }
}

/// UTF-16 to a Rust string; a lone surrogate becomes U+FFFD (one unit, so lengths still match Node's).
pub fn to_string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

impl OutputBuffer {
    pub fn new(max_chars: usize, max_lines: usize) -> Self {
        OutputBuffer { chunks: VecDeque::new(), end: 0, chars: 0, lines: 0, max_chars: max_chars.max(1), max_lines }
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    pub fn start(&self) -> u64 {
        self.chunks.front().map_or(self.end, |chunk| chunk.start)
    }

    /// Units currently kept.
    pub fn chars(&self) -> usize {
        self.chars
    }

    pub fn lines(&self) -> usize {
        self.lines
    }

    /// Appends output; returns false for empty text (nothing changes and nobody is woken).
    pub fn append_str(&mut self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.append(units)
    }

    pub fn append(&mut self, text: Vec<u16>) -> bool {
        if text.is_empty() {
            return false;
        }
        let lines = line_count(&text);
        let len = text.len();
        self.chunks.push_back(Chunk { start: self.end, text, lines });
        self.end += len as u64;
        self.chars += len;
        self.lines += lines;
        while self.chunks.len() > 1 && (self.chars > self.max_chars || self.lines > self.max_lines) {
            let first = self.chunks.pop_front().expect("more than one chunk");
            self.chars -= first.text.len();
            self.lines -= first.lines;
        }
        // One chunk larger than the whole buffer keeps only its tail.
        if self.chunks.len() == 1 && self.chunks[0].text.len() > self.max_chars {
            let only = &mut self.chunks[0];
            let cut = only.text.len() - self.max_chars;
            only.text.drain(..cut);
            only.start += cut as u64;
            only.lines = line_count(&only.text);
            self.chars = only.text.len();
            self.lines = only.lines;
        }
        true
    }

    /// Everything after `after`, or all kept output with `reset` when `after` is outside what is kept.
    pub fn since(&self, after: u64) -> (bool, Vec<u16>) {
        if after < self.start() || after > self.end {
            return (true, self.chunks.iter().flat_map(|chunk| chunk.text.iter().copied()).collect());
        }
        let mut data = Vec::new();
        for chunk in &self.chunks {
            let chunk_end = chunk.start + chunk.text.len() as u64;
            if chunk_end <= after {
                continue;
            }
            if chunk.start >= after {
                data.extend_from_slice(&chunk.text);
            } else {
                data.extend_from_slice(&chunk.text[(after - chunk.start) as usize..]);
            }
        }
        (false, data)
    }

    /// `since` plus the `limit` rule of `terminal:read`: the oldest part of what follows `after`, or the newest of a
    /// reset, never splitting a surrogate pair.
    pub fn read(&self, after: u64, limit: Option<usize>) -> Slice {
        let (reset, data) = self.since(after);
        if let Some(limit) = limit.filter(|limit| *limit > 0) {
            if data.len() > limit {
                if reset {
                    let from = tail_start(&data, limit);
                    return Slice { offset: self.end, data: data[from..].to_vec(), reset, more: false };
                }
                let cut = head_end(&data, limit);
                return Slice { offset: after + cut as u64, data: data[..cut].to_vec(), reset, more: true };
            }
        }
        Slice { offset: self.end, data, reset, more: false }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(units: &[u16]) -> String {
        to_string(units)
    }

    #[test]
    fn reads_after_offset_and_resets_late_viewers() {
        let mut b = OutputBuffer::new(MAX_BUFFER_CHARS, MAX_BUFFER_LINES);
        b.append_str("hello ");
        b.append_str("world");
        let first = b.read(0, None);
        assert_eq!((s(&first.data).as_str(), first.offset, first.reset), ("hello world", 11, false));
        b.append_str("!");
        assert_eq!(s(&b.read(11, None).data), "!");
        let late = b.read(99, None);
        assert_eq!((s(&late.data).as_str(), late.reset), ("hello world!", true));
    }

    #[test]
    fn limited_reads_never_split_a_pair() {
        let mut b = OutputBuffer::new(14_000, MAX_BUFFER_LINES);
        b.append_str(&format!("{}😀{}", "a".repeat(4095), "b".repeat(5000)));
        let first = b.read(0, Some(4096));
        assert_eq!((first.data.len(), first.offset, first.more), (4095, 4095, true));
        let rest = b.read(4095, Some(8192));
        assert_eq!((s(&rest.data), rest.offset), (format!("😀{}", "b".repeat(5000)), 9097));
    }

    #[test]
    fn line_and_char_caps() {
        let mut b = OutputBuffer::new(MAX_BUFFER_CHARS, 3);
        for line in ["a\n", "b\n", "c\n", "d\n"] {
            b.append_str(line);
        }
        let read = b.read(0, None);
        assert_eq!((s(&read.data).as_str(), read.offset, read.reset), ("b\nc\nd\n", 8, true));
        let mut small = OutputBuffer::new(4, MAX_BUFFER_LINES);
        small.append_str("abcdefgh");
        let read = small.read(0, None);
        assert_eq!((s(&read.data).as_str(), read.offset), ("efgh", 8));
    }

    #[test]
    fn a_cut_through_an_astral_character_keeps_unit_counts() {
        // Node keeps a lone low surrogate here; Rust sends U+FFFD, also one unit.
        let mut b = OutputBuffer::new(3, MAX_BUFFER_LINES);
        b.append_str("x😀ab");
        assert_eq!(b.chars(), 3);
        let read = b.read(0, None);
        assert_eq!((s(&read.data).as_str(), read.offset), ("\u{fffd}ab", 5));
    }

    #[test]
    fn empty_text_changes_nothing() {
        let mut b = OutputBuffer::new(10, 10);
        assert!(!b.append_str(""));
        assert_eq!(b.end(), 0);
    }
}
