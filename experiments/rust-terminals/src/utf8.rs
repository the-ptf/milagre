//! Streaming UTF-8 decoding of PTY output, matching node-pty's `setEncoding("utf8")`, which is Node's StringDecoder
//! (src/string_decoder.cc). At the end of each chunk, an incomplete character is held back by its lead byte's
//! length alone (so `E0 80` waits for a third byte even though it can no longer be valid); the held bytes become
//! their own string once complete, or as soon as a byte that can't continue them arrives. Everything else is
//! decoded with WHATWG replacement (one U+FFFD per maximal subpart), as V8 does. At end of stream the held bytes
//! are decoded the same way.

#[derive(Debug, Default)]
pub struct Utf8Stream {
    held: Vec<u8>,
    missing: usize,
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn continuation(byte: u8) -> bool {
    byte & 0xc0 == 0x80
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let mut data = bytes;
        let mut out = String::new();
        if self.missing > 0 {
            if let Some(stop) = data.iter().take(self.missing).position(|byte| !continuation(*byte)) {
                // A byte that can't continue the held character ends it as it is and starts a new one.
                self.held.extend_from_slice(&data[..stop]);
                data = &data[stop..];
                self.missing = 0;
            }
            let found = data.len().min(self.missing);
            self.held.extend_from_slice(&data[..found]);
            data = &data[found..];
            self.missing -= found;
            if self.missing > 0 {
                return out;
            }
            out.push_str(&lossy(&self.held));
            self.held.clear();
        }
        if data.is_empty() {
            return out;
        }
        let mut buffered = 0;
        let mut missing = 0;
        let mut index = data.len() - 1;
        loop {
            buffered += 1;
            let byte = data[index];
            if continuation(byte) {
                if buffered >= 4 || index == 0 {
                    buffered = 0;
                    break;
                }
                index -= 1;
                continue;
            }
            let need = if byte & 0xe0 == 0xc0 {
                2
            } else if byte & 0xf0 == 0xe0 {
                3
            } else if byte & 0xf8 == 0xf0 {
                4
            } else {
                buffered = 0;
                break;
            };
            if buffered >= need {
                buffered = 0;
            } else {
                missing = need - buffered;
            }
            break;
        }
        let (body, tail) = data.split_at(data.len() - buffered);
        out.push_str(&lossy(body));
        self.held = tail.to_vec();
        self.missing = missing;
        out
    }

    /// End of stream: held bytes are decoded as they are.
    pub fn finish(&mut self) -> String {
        self.missing = 0;
        let out = lossy(&self.held);
        self.held.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_split_characters() {
        let mut d = Utf8Stream::new();
        let bytes = "ação 😀".as_bytes();
        let mut out = String::new();
        for byte in bytes {
            out.push_str(&d.decode(&[*byte]));
        }
        assert_eq!(out, "ação 😀");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn replaces_invalid_and_truncated() {
        let mut d = Utf8Stream::new();
        assert_eq!(d.decode(&[0xe2, 0x82, b'A', 0xff]), "\u{fffd}A\u{fffd}");
        assert_eq!(d.decode(&[0xf0, 0x9f]), "");
        assert_eq!(d.finish(), "\u{fffd}");
    }
}
