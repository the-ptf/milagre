//! Ordered desktop frames, retained as raw JSON under shared memory reservations.
use crate::{
    budget::{ConnectionBudget, Reservation},
    channel::MAX_PLAIN_BYTES,
    raw_json, Error, Result, MAX_SAFE_INTEGER,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::ops::Deref;
pub const PART_THRESHOLD: usize = 768 * 1024;
pub const PIECE_BYTES: usize = 512 * 1024;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PARTS: usize = MAX_FRAME_BYTES / PIECE_BYTES;
pub const PEER_BUDGET: usize = 2 * MAX_FRAME_BYTES;
pub const FRAME_TIMEOUT_MS: u64 = 15_000;
pub use crate::raw_json::{MAX_DEPTH, MAX_TOKENS};
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
/// Returned buffers remain budgeted until dropped. Borrow them to send; do not
/// copy them into an unbudgeted queue. No owning iterator or Clone is exposed.
pub struct EncodedFrames {
    frames: Vec<Vec<u8>>,
    _reservation: Reservation,
}
impl std::fmt::Debug for EncodedFrames {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncodedFrames")
            .field("count", &self.frames.len())
            .finish()
    }
}
impl PartialEq for EncodedFrames {
    fn eq(&self, other: &Self) -> bool {
        self.frames == other.frames
    }
}
impl Eq for EncodedFrames {}
impl Deref for EncodedFrames {
    type Target = [Vec<u8>];
    fn deref(&self) -> &Self::Target {
        &self.frames
    }
}
pub struct FrameWriter {
    direction: Direction,
    last_id: u64,
    budget: ConnectionBudget,
}
impl FrameWriter {
    pub fn new(direction: Direction) -> Self {
        Self::with_budget(direction, ConnectionBudget::standalone())
    }
    pub fn with_budget(direction: Direction, budget: ConnectionBudget) -> Self {
        Self {
            direction,
            last_id: 0,
            budget,
        }
    }
    pub fn write(&mut self, json: &str) -> Result<EncodedFrames> {
        if json.len() > MAX_FRAME_BYTES {
            return Err(Error::TooLarge);
        }
        raw_json::validate(json.as_bytes())?;
        let split = json.len() > PART_THRESHOLD;
        if split && self.last_id == MAX_SAFE_INTEGER {
            return Err(Error::Exhausted);
        }
        let id = self.last_id + u64::from(split);
        let n = if split {
            json.len().div_ceil(PIECE_BYTES)
        } else {
            1
        };
        let prefix = |i| format!("{{\"t\":\"part\",\"id\":{id},\"i\":{i},\"n\":{n},\"data\":\"");
        let head = format!("{{\"t\":\"{}\",\"frame\":", self.direction.tag());
        let payload = if split {
            json.as_bytes()
                .chunks(PIECE_BYTES)
                .enumerate()
                .map(|(i, p)| prefix(i).len() + p.len().div_ceil(3) * 4 + 2)
                .sum()
        } else {
            head.len() + json.len() + 1
        };
        // Include vector headers plus bounded prefix formatting scratch, before payload allocation.
        let reservation = self.budget.reserve(
            payload
                + n * std::mem::size_of::<Vec<u8>>()
                + std::mem::size_of::<EncodedFrames>()
                + 512,
        )?;
        let mut frames = Vec::with_capacity(n);
        if split {
            for (i, piece) in json.as_bytes().chunks(PIECE_BYTES).enumerate() {
                let prefix = prefix(i);
                let len = piece.len().div_ceil(3) * 4;
                let mut out = Vec::with_capacity(prefix.len() + len + 2);
                out.extend_from_slice(prefix.as_bytes());
                out.resize(prefix.len() + len, 0);
                STANDARD
                    .encode_slice(piece, &mut out[prefix.len()..])
                    .map_err(|_| Error::Schema)?;
                out.extend_from_slice(b"\"}");
                frames.push(out);
            }
        } else {
            let mut out = Vec::with_capacity(payload);
            out.extend_from_slice(head.as_bytes());
            out.extend_from_slice(json.as_bytes());
            out.push(b'}');
            frames.push(out);
        }
        self.last_id = id;
        Ok(EncodedFrames {
            frames,
            _reservation: reservation,
        })
    }
}
/// Lossless UTF-8 JSON bytes. Parse with the owner's jsjson only after applying
/// that service's own parsed-object budget. The lease is held through the handoff.
pub struct RawFrame {
    bytes: Vec<u8>,
    _reservation: Reservation,
}
impl RawFrame {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl std::fmt::Debug for RawFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawFrame")
            .field("bytes", &self.bytes.len())
            .finish()
    }
}
impl PartialEq for RawFrame {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}
impl Eq for RawFrame {}
#[derive(Deserialize)]
struct Tag<'a> {
    #[serde(borrow)]
    t: &'a str,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Whole<'a> {
    #[serde(borrow)]
    t: &'a str,
    #[serde(borrow)]
    frame: &'a RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Part<'a> {
    #[serde(borrow)]
    t: &'a str,
    id: u64,
    i: usize,
    n: usize,
    #[serde(borrow)]
    data: &'a str,
}
struct Piece {
    bytes: Vec<u8>,
    _reservation: Reservation,
}
struct Partial {
    id: u64,
    count: usize,
    size: usize,
    pieces: Vec<Piece>,
    deadline: u64,
    _reservation: Reservation,
}
pub struct FrameReader {
    direction: Direction,
    max_bytes: usize,
    timeout_ms: u64,
    budget: ConnectionBudget,
    partial: Option<Partial>,
}
impl FrameReader {
    pub fn new(direction: Direction) -> Self {
        Self::with_budget(
            direction,
            MAX_FRAME_BYTES,
            FRAME_TIMEOUT_MS,
            ConnectionBudget::standalone(),
        )
        .unwrap()
    }
    pub fn with_limit(direction: Direction, max_bytes: usize) -> Result<Self> {
        Self::with_budget(
            direction,
            max_bytes,
            FRAME_TIMEOUT_MS,
            ConnectionBudget::standalone(),
        )
    }
    pub fn with_budget(
        direction: Direction,
        max_bytes: usize,
        timeout_ms: u64,
        budget: ConnectionBudget,
    ) -> Result<Self> {
        if max_bytes == 0 || max_bytes > MAX_FRAME_BYTES || timeout_ms == 0 {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            direction,
            max_bytes,
            timeout_ms,
            budget,
            partial: None,
        })
    }
    pub fn pending(&self) -> bool {
        self.partial.is_some()
    }
    pub fn buffered_bytes(&self) -> usize {
        self.partial.as_ref().map_or(0, |p| p.size)
    }
    pub fn deadline_ms(&self) -> Option<u64> {
        self.partial.as_ref().map(|p| p.deadline)
    }
    pub fn reset(&mut self) {
        self.partial = None;
    }
    /// Caller must schedule even while no input arrives. Expiry releases every lease;
    /// carrier must close on true. Incoming fragments cannot extend the first deadline.
    pub fn expire(&mut self, now_ms: u64) -> bool {
        if self.partial.as_ref().is_some_and(|p| now_ms >= p.deadline) {
            self.reset();
            true
        } else {
            false
        }
    }
    pub fn read(&mut self, encoded: &[u8], now_ms: u64) -> Result<Option<RawFrame>> {
        if self.expire(now_ms) {
            return Err(Error::Timeout);
        }
        let result = self.read_inner(encoded, now_ms);
        if result.is_err() {
            self.reset();
        }
        result
    }
    fn read_inner(&mut self, encoded: &[u8], now_ms: u64) -> Result<Option<RawFrame>> {
        if encoded.len() > MAX_PLAIN_BYTES {
            return Err(Error::TooLarge);
        }
        let raw = raw_json::validate_envelope(encoded).map_err(|e| {
            if e == Error::Schema {
                Error::BadPart
            } else {
                e
            }
        })?;
        if !raw.get().starts_with('{') {
            return Err(Error::BadPart);
        }
        let tag: Tag = serde_json::from_str(raw.get()).map_err(|_| Error::BadPart)?;
        if tag.t == self.direction.tag() {
            if self.pending() {
                return Err(Error::BadPart);
            }
            let whole: Whole = serde_json::from_str(raw.get()).map_err(|_| Error::BadPart)?;
            if whole.t != self.direction.tag() {
                return Err(Error::BadPart);
            }
            let bytes = whole.frame.get().as_bytes();
            if bytes.len() > self.max_bytes {
                return Err(Error::TooLarge);
            }
            raw_json::validate(bytes)?;
            let reservation = self
                .budget
                .reserve(bytes.len() + std::mem::size_of::<RawFrame>())?;
            return Ok(Some(RawFrame {
                bytes: bytes.to_vec(),
                _reservation: reservation,
            }));
        }
        if tag.t != "part" {
            return Err(Error::BadPart);
        }
        let part: Part = serde_json::from_str(raw.get()).map_err(|_| Error::BadPart)?;
        let Part { t, id, i, n, data } = part;
        if t != "part" || id == 0 || id > MAX_SAFE_INTEGER || n < 2 || i >= n {
            return Err(Error::BadPart);
        }
        if n > self.max_bytes.div_ceil(PIECE_BYTES) {
            return Err(Error::TooLarge);
        }
        if self.partial.as_ref().map_or(i != 0, |p| {
            id != p.id || n != p.count || i != p.pieces.len()
        }) {
            return Err(Error::BadPart);
        }
        if data.len() > MAX_DATA || data.len() % 4 != 0 {
            return Err(Error::BadPart);
        }
        let padded = data.bytes().rev().take_while(|b| *b == b'=').count();
        if padded > 2 {
            return Err(Error::BadPart);
        }
        let length = (data.len() / 4 * 3)
            .checked_sub(padded)
            .ok_or(Error::BadPart)?;
        if length > PIECE_BYTES {
            return Err(Error::BadPart);
        }
        if self.buffered_bytes() + length > self.max_bytes {
            return Err(Error::TooLarge);
        }
        if self.partial.is_none() {
            let deadline = now_ms
                .checked_add(self.timeout_ms)
                .ok_or(Error::Exhausted)?;
            let reservation = self
                .budget
                .reserve(n * std::mem::size_of::<Piece>() + std::mem::size_of::<Partial>())?;
            self.partial = Some(Partial {
                id,
                count: n,
                size: 0,
                pieces: Vec::with_capacity(n),
                deadline,
                _reservation: reservation,
            });
        }
        let reservation = self.budget.reserve(length)?;
        let mut bytes = vec![0; length];
        let decoded = STANDARD
            .decode_slice(data, &mut bytes)
            .map_err(|_| Error::BadPart)?;
        if decoded != length {
            return Err(Error::BadPart);
        }
        let p = self.partial.as_mut().unwrap();
        p.size += length;
        p.pieces.push(Piece {
            bytes,
            _reservation: reservation,
        });
        if p.pieces.len() < n {
            return Ok(None);
        }
        let p = self.partial.take().unwrap();
        // Both pieces and contiguous result are charged during final assembly.
        let reservation = self
            .budget
            .reserve(p.size + std::mem::size_of::<RawFrame>())?;
        let mut bytes = Vec::with_capacity(p.size);
        for piece in &p.pieces {
            bytes.extend_from_slice(&piece.bytes);
        }
        raw_json::validate(&bytes)?;
        Ok(Some(RawFrame {
            bytes,
            _reservation: reservation,
        }))
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
        assert!(matches!(writer.write(&large), Err(Error::Exhausted)));
        assert!(writer.write("null").is_ok());
    }
}
