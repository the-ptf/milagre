//! Allocation-free admission scan followed by serde's borrowed RawValue grammar
//! validation. Never builds a Value tree. Limits are deliberately below owner parser
//! recursion limits; JSON string tokens (including lone surrogate escapes) stay raw.
use crate::{Error, Result};
use serde_json::value::RawValue;
pub const MAX_DEPTH: usize = 64;
pub const MAX_TOKENS: usize = 65_536;
pub fn validate(bytes: &[u8]) -> Result<&RawValue> {
    validate_with_limits(bytes, MAX_DEPTH, MAX_TOKENS)
}
// {"t":"rpc","frame":PAYLOAD} adds one nesting level and eight lexical tokens.
pub fn validate_envelope(bytes: &[u8]) -> Result<&RawValue> {
    validate_with_limits(bytes, MAX_DEPTH + 1, MAX_TOKENS + 8)
}
fn validate_with_limits(bytes: &[u8], max_depth: usize, max_tokens: usize) -> Result<&RawValue> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::Schema)?;
    let (mut depth, mut tokens, mut quoted, mut escaped, mut primitive) =
        (0usize, 0usize, false, false, false);
    for &b in bytes {
        if quoted {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                quoted = false;
            }
            continue;
        }
        match b {
            b'"' => {
                quoted = true;
                primitive = false;
                tokens += 1;
            }
            b'{' | b'[' => {
                depth += 1;
                primitive = false;
                tokens += 1;
                if depth > max_depth {
                    return Err(Error::TooLarge);
                }
            }
            b'}' | b']' => {
                depth = depth.checked_sub(1).ok_or(Error::Schema)?;
                primitive = false;
                tokens += 1;
            }
            b',' | b':' => {
                primitive = false;
                tokens += 1;
            }
            b' ' | b'\r' | b'\n' | b'\t' => {
                primitive = false;
            }
            _ => {
                if !primitive {
                    tokens += 1;
                    primitive = true;
                }
            }
        }
        if tokens > max_tokens {
            return Err(Error::TooLarge);
        }
    }
    serde_json::from_str::<&RawValue>(text).map_err(|_| Error::Schema)
}
