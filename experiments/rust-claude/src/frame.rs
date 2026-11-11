//! Bounded newline framing for the CLI's stream-json stdout.
//!
//! The CLI writes one JSON object per line (NDJSON). A frame is bounded while it is still being
//! received, not only once complete, so a CLI that never sends a newline cannot grow memory without
//! limit. Parsing rules follow the public Python SDK's `_parse_stdout_line` (see README for the pinned
//! revision): blank lines carry nothing, a line that does not start with `{` is non-protocol output
//! (some CLI builds print debug lines to stdout) and is skipped, and a line that starts with `{` but
//! does not parse is corrupt and ends the stream.

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// What one complete stdout line turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    /// A JSON object, exactly as the CLI wrote it (all fields kept).
    Json(Value),
    /// Nothing to deliver: whitespace only.
    Blank,
    /// Text that is not a JSON object. First 200 characters kept for diagnostics.
    NonJson(String),
}

#[derive(Debug, Clone, thiserror::Error, PartialEq)]
pub enum FrameError {
    #[error("stdout frame exceeded {limit} bytes")]
    TooLarge { limit: usize },
    #[error("stdout line is not valid JSON: {0}")]
    Corrupt(String),
    #[error("stdout read failed: {0}")]
    Read(String),
}

fn preview(text: &str) -> String {
    text.chars().take(200).collect()
}

/// Classify one complete line. `\r` and surrounding whitespace are meaningless on a complete line.
pub fn parse_line(bytes: &[u8]) -> Result<Line, FrameError> {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Line::Blank);
    }
    if !trimmed.starts_with('{') {
        return Ok(Line::NonJson(preview(trimmed)));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(value @ Value::Object(_)) => Ok(Line::Json(value)),
        Ok(_) => Err(FrameError::Corrupt(preview(trimmed))),
        Err(error) => Err(FrameError::Corrupt(format!("{error}: {}", preview(trimmed)))),
    }
}

/// Reads newline-terminated frames with a hard size limit.
pub struct LineReader<R> {
    reader: R,
    limit: usize,
    pending: Vec<u8>,
    done: bool,
}

/// A frame read from the stream: a complete line, or the unterminated tail found at EOF.
#[derive(Debug, PartialEq)]
pub enum Frame {
    Line(Vec<u8>),
    /// Bytes after the last newline at EOF. The CLI ends every message with `\n`, so a tail is either a
    /// producer that omits the final newline (parse it) or a write cut off mid-frame (drop it).
    Tail(Vec<u8>),
}

impl<R: AsyncBufRead + Unpin> LineReader<R> {
    pub fn new(reader: R, limit: usize) -> Self {
        Self { reader, limit, pending: Vec::new(), done: false }
    }

    /// The next frame, `Ok(None)` at EOF. After an error the reader yields `Ok(None)`.
    pub async fn next(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.done {
            return Ok(None);
        }
        loop {
            let available = match self.reader.fill_buf().await {
                Ok(buffer) => buffer,
                Err(error) => {
                    self.done = true;
                    return Err(FrameError::Read(error.to_string()));
                }
            };
            if available.is_empty() {
                self.done = true;
                if self.pending.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(Frame::Tail(std::mem::take(&mut self.pending))));
            }
            if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
                if self.pending.len() + index > self.limit {
                    self.done = true;
                    return Err(FrameError::TooLarge { limit: self.limit });
                }
                self.pending.extend_from_slice(&available[..index]);
                self.reader.consume(index + 1);
                return Ok(Some(Frame::Line(std::mem::take(&mut self.pending))));
            }
            let length = available.len();
            if self.pending.len() + length > self.limit {
                self.done = true;
                return Err(FrameError::TooLarge { limit: self.limit });
            }
            self.pending.extend_from_slice(available);
            self.reader.consume(length);
        }
    }
}

/// Serialize one outgoing frame (JSON + `\n`), refusing anything over `limit` bytes.
pub fn encode(value: &Value, limit: usize) -> Result<Vec<u8>, usize> {
    let mut bytes = serde_json::to_vec(value).expect("serde_json::Value always serializes");
    if bytes.len() > limit {
        return Err(bytes.len());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    async fn frames(input: &[u8], limit: usize, capacity: usize) -> Vec<Result<Option<Frame>, FrameError>> {
        let mut reader = LineReader::new(BufReader::with_capacity(capacity, input), limit);
        let mut out = Vec::new();
        loop {
            let next = reader.next().await;
            let stop = !matches!(next, Ok(Some(_)));
            out.push(next);
            if stop {
                return out;
            }
        }
    }

    #[tokio::test]
    async fn splits_lines_across_small_chunks() {
        let out = frames(b"{\"a\":1}\n{\"b\":\"x y\"}\n", 64, 3).await;
        assert_eq!(out[0], Ok(Some(Frame::Line(b"{\"a\":1}".to_vec()))));
        assert_eq!(out[1], Ok(Some(Frame::Line(b"{\"b\":\"x y\"}".to_vec()))));
        assert_eq!(out[2], Ok(None));
    }

    #[tokio::test]
    async fn tail_without_newline_is_returned_at_eof() {
        let out = frames(b"{\"a\":1}\n{\"b\":2}", 64, 4).await;
        assert_eq!(out[1], Ok(Some(Frame::Tail(b"{\"b\":2}".to_vec()))));
    }

    #[tokio::test]
    async fn bounds_an_unterminated_frame_while_it_grows() {
        let big = vec![b'x'; 100];
        let out = frames(&big, 10, 4).await;
        assert_eq!(out[0], Err(FrameError::TooLarge { limit: 10 }));
    }

    #[tokio::test]
    async fn exact_limit_is_accepted() {
        let out = frames(b"0123456789\n", 10, 4).await;
        assert_eq!(out[0], Ok(Some(Frame::Line(b"0123456789".to_vec()))));
    }

    #[test]
    fn classifies_lines() {
        assert_eq!(parse_line(b"  \r"), Ok(Line::Blank));
        assert_eq!(parse_line(b"[SandboxDebug] hi"), Ok(Line::NonJson("[SandboxDebug] hi".into())));
        assert!(matches!(parse_line(b"{\"a\":"), Err(FrameError::Corrupt(_))));
        assert_eq!(parse_line(b"{\"a\":1}\r"), Ok(Line::Json(serde_json::json!({"a":1}))));
    }

    #[test]
    fn encode_refuses_oversize() {
        let value = serde_json::json!({"text": "x".repeat(50)});
        assert!(encode(&value, 10).is_err());
        assert!(encode(&value, 1000).unwrap().ends_with(b"\n"));
    }
}
