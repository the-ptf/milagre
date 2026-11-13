//! Lossless outbound MCP JSON. Content strings stay as raw JSON, including lone UTF-16 surrogates.
use serde_json::{value::RawValue, Value};
use tokio::sync::OwnedSemaphorePermit;

pub enum McpReply {
    Json(Value),
    Raw(RawMcpReply),
}
/// Validated JSON bytes plus an optional reservation held until the writer finishes or discards it.
/// No Unicode sentinel encoding is used, so PUA and U+10FFFE cannot collide with stored content.
pub struct RawMcpReply {
    bytes: Vec<u8>,
    pub(crate) reservation: Option<OwnedSemaphorePermit>,
}
impl RawMcpReply {
    pub fn from_bytes(mut bytes: Vec<u8>) -> Result<Self, &'static str> {
        serde_json::from_slice::<&RawValue>(&bytes).map_err(|_| "Invalid raw MCP JSON.")?;
        // RawValue preserves formatting. Remove insignificant whitespace in place for NDJSON.
        let (mut out, mut quoted, mut escaped) = (0, false, false);
        for at in 0..bytes.len() {
            let byte = bytes[at];
            if quoted {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == b'"' {
                    quoted = false;
                }
            } else if byte == b'"' {
                quoted = true;
            } else if byte.is_ascii_whitespace() {
                continue;
            }
            bytes[out] = byte;
            out += 1;
        }
        bytes.truncate(out);
        Ok(Self { bytes, reservation: None })
    }
    /// Direct Value-based consumers cannot represent lone surrogates. Native transport uses raw bytes.
    pub fn into_value(self) -> Result<Value, &'static str> {
        serde_json::from_slice(&self.bytes).map_err(|_| "MCP reply requires the lossless wire handler.")
    }
    pub(crate) fn frame(mut self, request_id: &str, limit: usize) -> Result<EncodedReply, usize> {
        let id = serde_json::to_string(request_id).expect("request id serializes");
        let prefix = format!(
            "{{\"type\":\"control_response\",\"response\":{{\"subtype\":\"success\",\"request_id\":{id},\"response\":{{\"mcp_response\":"
        );
        let suffix = b"}}}\n";
        let size = prefix.len().saturating_add(self.bytes.len()).saturating_add(suffix.len() - 1);
        if size > limit {
            return Err(size);
        }
        let old = self.bytes.len();
        // Avoid geometric capacity growth when adding the small control envelope.
        self.bytes.reserve_exact(size + 1 - old);
        self.bytes.resize(size + 1, 0);
        self.bytes.copy_within(..old, prefix.len());
        self.bytes[..prefix.len()].copy_from_slice(prefix.as_bytes());
        self.bytes[prefix.len() + old..].copy_from_slice(suffix);
        Ok(EncodedReply { bytes: self.bytes, reservation: self.reservation })
    }
}
pub(crate) struct EncodedReply {
    pub bytes: Vec<u8>,
    pub reservation: Option<OwnedSemaphorePermit>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_json_keeps_surrogates_and_compacts_only_outside_strings() {
        let input = b" { \"jsonrpc\": \"2.0\", \"id\":1, \"result\": {\"text\":\"\\ud800 / \\udfff \\n \\\"\"} } \n".to_vec();
        let raw = RawMcpReply::from_bytes(input).unwrap();
        let framed = raw.frame("outer", 4096).unwrap();
        let text = String::from_utf8(framed.bytes).unwrap();
        assert!(text.contains(r#""text":"\ud800 / \udfff \n \"""#));
        assert_eq!(text.lines().count(), 1);
        serde_json::from_str::<&RawValue>(text.trim_end()).unwrap();
        assert!(RawMcpReply::from_bytes(br#"{"text":"\uZZZZ"}"#.to_vec()).is_err());
    }
}
