//! Ordered desktop rpc/evt fragmentation. One incomplete frame per reader.
use crate::{channel::MAX_PLAIN_BYTES, Error, Result, MAX_SAFE_INTEGER};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::Value;
pub const PART_THRESHOLD: usize = 768 * 1024;
pub const PIECE_BYTES: usize = 512 * 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PARTS: usize = MAX_FRAME_BYTES / PIECE_BYTES;
pub const PEER_BUDGET: usize = 2 * MAX_FRAME_BYTES;
const MAX_DATA: usize = PIECE_BYTES.div_ceil(3) * 4;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Rpc,
    Evt,
}
impl Direction {
    fn tag(self) -> &'static str {
        match self {
            Self::Rpc => "rpc",
            Self::Evt => "evt",
        }
    }
}

pub struct FrameWriter {
    direction: Direction,
    last_id: u64,
}
impl FrameWriter {
    pub fn new(direction: Direction) -> Self {
        Self {
            direction,
            last_id: 0,
        }
    }
    /// Preserves the caller's JSON bytes. Validates JSON and size before allocating pieces.
    pub fn write(&mut self, json: &str) -> Result<Vec<Vec<u8>>> {
        if json.len() > MAX_FRAME_BYTES {
            return Err(Error::TooLarge);
        }
        serde_json::from_str::<Value>(json).map_err(|_| Error::Schema)?;
        if json.len() <= PART_THRESHOLD {
            return Ok(vec![format!(
                "{{\"t\":\"{}\",\"frame\":{json}}}",
                self.direction.tag()
            )
            .into_bytes()]);
        }
        if self.last_id == MAX_SAFE_INTEGER {
            return Err(Error::Exhausted);
        }
        self.last_id += 1;
        let n = json.len().div_ceil(PIECE_BYTES);
        Ok(json
            .as_bytes()
            .chunks(PIECE_BYTES)
            .enumerate()
            .map(|(i, chunk)| {
                let data = STANDARD.encode(chunk);
                format!(
                    "{{\"t\":\"part\",\"id\":{},\"i\":{i},\"n\":{n},\"data\":\"{data}\"}}",
                    self.last_id
                )
                .into_bytes()
            })
            .collect())
    }
}
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", deny_unknown_fields)]
enum Message {
    Rpc {
        frame: Value,
    },
    Evt {
        frame: Value,
    },
    Part {
        id: u64,
        i: usize,
        n: usize,
        data: String,
    },
}
struct Partial {
    id: u64,
    next: usize,
    count: usize,
    bytes: Vec<u8>,
}
pub struct FrameReader {
    direction: Direction,
    max_bytes: usize,
    partial: Option<Partial>,
}
impl FrameReader {
    pub fn new(direction: Direction) -> Self {
        Self {
            direction,
            max_bytes: MAX_FRAME_BYTES,
            partial: None,
        }
    }
    pub fn with_limit(direction: Direction, max_bytes: usize) -> Result<Self> {
        if max_bytes == 0 || max_bytes > MAX_FRAME_BYTES {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            direction,
            max_bytes,
            partial: None,
        })
    }
    pub fn pending(&self) -> bool {
        self.partial.is_some()
    }
    pub fn buffered_bytes(&self) -> usize {
        self.partial.as_ref().map_or(0, |p| p.bytes.len())
    }
    pub fn reset(&mut self) {
        self.partial = None;
    }
    /// Caller delivers each decrypted batch item in order. On every error the partial frame is released.
    pub fn read(&mut self, encoded: &[u8]) -> Result<Option<Value>> {
        let result = self.read_inner(encoded);
        if result.is_err() {
            self.reset();
        }
        result
    }
    fn read_inner(&mut self, encoded: &[u8]) -> Result<Option<Value>> {
        if encoded.len() > MAX_PLAIN_BYTES {
            return Err(Error::TooLarge);
        }
        let msg: Message = serde_json::from_slice(encoded).map_err(|_| Error::BadPart)?;
        match msg {
            Message::Rpc { frame } if self.direction == Direction::Rpc => self.whole(frame),
            Message::Evt { frame } if self.direction == Direction::Evt => self.whole(frame),
            Message::Part { id, i, n, data } => {
                if id == 0 || id > MAX_SAFE_INTEGER || n < 2 || i >= n {
                    return Err(Error::BadPart);
                }
                if n > self.max_bytes.div_ceil(PIECE_BYTES) {
                    return Err(Error::TooLarge);
                }
                if self
                    .partial
                    .as_ref()
                    .map_or(i != 0, |p| id != p.id || n != p.count || i != p.next)
                {
                    return Err(Error::BadPart);
                }
                if data.len() > MAX_DATA {
                    return Err(Error::BadPart);
                }
                let piece = STANDARD.decode(data).map_err(|_| Error::BadPart)?;
                if piece.len() > PIECE_BYTES {
                    return Err(Error::BadPart);
                }
                let p = self.partial.get_or_insert_with(|| Partial {
                    id,
                    next: 0,
                    count: n,
                    bytes: Vec::new(),
                });
                if p.bytes.len() + piece.len() > self.max_bytes {
                    return Err(Error::TooLarge);
                }
                p.bytes.extend_from_slice(&piece);
                p.next += 1;
                if p.next < p.count {
                    return Ok(None);
                }
                let p = self.partial.take().unwrap();
                let frame = serde_json::from_slice(&p.bytes).map_err(|_| Error::Schema)?;
                Ok(Some(frame))
            }
            _ => Err(Error::BadPart),
        }
    }
    fn whole(&self, frame: Value) -> Result<Option<Value>> {
        if self.pending() {
            return Err(Error::BadPart);
        }
        if serde_json::to_vec(&frame).map_err(|_| Error::Schema)?.len() > self.max_bytes {
            return Err(Error::TooLarge);
        }
        Ok(Some(frame))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmentation_id_cannot_leave_javascript_safe_range() {
        let mut writer = FrameWriter::new(Direction::Rpc);
        writer.last_id = MAX_SAFE_INTEGER;
        let large = format!("\"{}\"", "x".repeat(PART_THRESHOLD));
        assert_eq!(writer.write(&large), Err(Error::Exhausted));
        assert!(writer.write("null").is_ok());
    }
}
