use serde_json::{json, Value};
use std::{
    fmt,
    io::{self, BufRead},
};

pub const VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PENDING: usize = 32;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub type RpcResult = Result<Value, RpcError>;

#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}
impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
    pub fn value(&self) -> Value {
        let mut value = json!({"code":self.code,"message":self.message});
        if let Some(details) = &self.details {
            value["details"] = details.clone();
        }
        value
    }
}
impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for RpcError {}
impl From<io::Error> for RpcError {
    fn from(value: io::Error) -> Self {
        Self::new("IO_ERROR", value.to_string())
    }
}

pub fn read_frame(reader: &mut impl BufRead, limit: usize) -> Result<Option<Value>, RpcError> {
    let mut frame = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Err(RpcError::new("INVALID_REQUEST", "Incomplete JSON frame"))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(buffer.len());
        if frame.len().saturating_add(take) > limit {
            return Err(RpcError::new(
                "FRAME_TOO_LARGE",
                "Frame exceeds the local daemon size limit",
            ));
        }
        frame.extend_from_slice(&buffer[..take]);
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            break;
        }
    }
    serde_json::from_slice(&frame)
        .map(Some)
        .map_err(|_| RpcError::new("INVALID_REQUEST", "Expected a JSON frame"))
}
pub fn encode(value: &Value, limit: usize) -> Result<Vec<u8>, RpcError> {
    let mut frame =
        serde_json::to_vec(value).map_err(|e| RpcError::new("INVALID_RESPONSE", e.to_string()))?;
    frame.push(b'\n');
    if frame.len() > limit {
        return Err(RpcError::new(
            "FRAME_TOO_LARGE",
            "Response exceeds the local daemon size limit",
        ));
    }
    Ok(frame)
}
pub fn valid_id(id: &Value) -> bool {
    id.as_str()
        .is_some_and(|id| id.encode_utf16().count() <= 128)
        || safe_integer(id).is_some_and(|id| id > 0)
}
pub fn safe_integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|value| {
            value.is_finite()
                && value.fract() == 0.0
                && *value >= 0.0
                && *value <= MAX_SAFE_INTEGER as f64
        })
        .map(|value| value as u64)
}
pub fn page_size(limit: usize) -> usize {
    ((limit.saturating_sub(512)) / 6).clamp(1, 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn bounded_frames_and_javascript_ids() {
        let mut reader = Cursor::new(b"{\"v\":1}\n{\"v\":2}\n");
        assert_eq!(read_frame(&mut reader, 8).unwrap(), Some(json!({"v":1})));
        assert_eq!(read_frame(&mut reader, 8).unwrap(), Some(json!({"v":2})));
        assert_eq!(read_frame(&mut reader, 8).unwrap(), None);
        assert_eq!(
            read_frame(&mut Cursor::new(b"123456789"), 8)
                .unwrap_err()
                .code,
            "FRAME_TOO_LARGE"
        );
        assert!(read_frame(&mut Cursor::new(b"{}"), 8).is_err());
        assert!(read_frame(&mut Cursor::new(b"nope\n"), 8).is_err());
        for value in [
            json!(1),
            json!(MAX_SAFE_INTEGER),
            json!(""),
            json!("a".repeat(128)),
        ] {
            assert!(valid_id(&value));
        }
        for value in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!(MAX_SAFE_INTEGER + 1),
            Value::Null,
            json!("🦀".repeat(65)),
        ] {
            assert!(!valid_id(&value));
        }
    }
}
