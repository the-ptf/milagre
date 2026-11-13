use crate::{
    protocol::{page_size, safe_integer},
    RpcError,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

struct Capture {
    pages: Vec<String>,
    next: usize,
    bytes: usize,
    touched: Instant,
}
pub(crate) struct Pages {
    captures: HashMap<u64, Capture>,
    next_id: u64,
    held: usize,
    max_bytes: usize,
    page_size: usize,
    ttl: Duration,
}
impl Pages {
    pub fn new(frame: usize, max_bytes: usize, ttl: Duration) -> Self {
        Self {
            captures: HashMap::new(),
            next_id: 0,
            held: 0,
            max_bytes,
            page_size: page_size(frame),
            ttl,
        }
    }
    pub fn expire(&mut self) {
        self.captures.retain(|_, capture| {
            if capture.touched.elapsed() >= self.ttl {
                self.held -= capture.bytes;
                false
            } else {
                true
            }
        });
    }
    pub fn capture(&mut self, text: String) -> Result<Value, RpcError> {
        self.expire();
        if text.len() > self.max_bytes {
            return Err(RpcError::new(
                "FRAME_TOO_LARGE",
                "Paged result exceeds the configured byte budget",
            ));
        }
        if self.captures.len() >= 32 || self.held.saturating_add(text.len()) > self.max_bytes {
            return Err(RpcError::new(
                "PAGES_BUSY",
                "Too many large responses are waiting on this connection. Try again.",
            ));
        }
        let mut pages = Vec::new();
        let mut offset = 0;
        while offset < text.len() {
            let mut end = (offset + self.page_size).min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            // Config enforces a minimum frame size, so a Unicode scalar always fits.
            pages.push(text[offset..end].to_string());
            offset = end;
        }
        if pages.is_empty() {
            pages.push(String::new());
        }
        if pages.len() > 1024 {
            return Err(RpcError::new(
                "FRAME_TOO_LARGE",
                "Paged result exceeds 1024 pages",
            ));
        }
        self.next_id += 1;
        let count = pages.len();
        self.held += text.len();
        self.captures.insert(
            self.next_id,
            Capture {
                pages,
                next: 0,
                bytes: text.len(),
                touched: Instant::now(),
            },
        );
        Ok(json!({"pageId":self.next_id,"pageCount":count}))
    }
    pub fn page(&mut self, id: &Value, index: &Value) -> Result<Value, RpcError> {
        self.expire();
        let id = safe_integer(id).ok_or_else(|| {
            RpcError::new(
                "COMMAND_FAILED",
                "This paged response expired. Send the request again.",
            )
        })?;
        let capture = self.captures.get_mut(&id).ok_or_else(|| {
            RpcError::new(
                "COMMAND_FAILED",
                "This paged response expired. Send the request again.",
            )
        })?;
        if safe_integer(index) != Some(capture.next as u64) || capture.next >= capture.pages.len() {
            return Err(RpcError::new("COMMAND_FAILED", "This page is out of order. Read the pages from the first, or send the request again."));
        }
        let text = capture.pages[capture.next].clone();
        capture.next += 1;
        capture.touched = Instant::now();
        if capture.next == capture.pages.len() {
            self.held -= capture.bytes;
            self.captures.remove(&id);
        }
        Ok(Value::String(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_preserve_unicode_enforce_order_and_release_budgets() {
        let text = "a🦀\n\"".repeat(100);
        let mut pages = Pages::new(1024, text.len(), Duration::from_secs(30));
        let manifest = pages.capture(text.clone()).unwrap();
        assert!(manifest["pageId"].is_number());
        assert_eq!(pages.capture("x".into()).unwrap_err().code, "PAGES_BUSY");
        assert!(pages.page(&manifest["pageId"], &json!(1)).is_err());
        let mut joined = String::new();
        for index in 0..manifest["pageCount"].as_u64().unwrap() {
            joined.push_str(
                pages
                    .page(&manifest["pageId"], &json!(index))
                    .unwrap()
                    .as_str()
                    .unwrap(),
            );
        }
        assert_eq!(joined, text);
        assert_eq!(pages.held, 0);
        assert!(pages.page(&manifest["pageId"], &json!(0)).is_err());
        assert!(pages.capture("y".into()).is_ok());
    }
    #[test]
    fn expired_pages_release_memory() {
        let mut pages = Pages::new(1024, 10, Duration::ZERO);
        let manifest = pages.capture("1234567890".into()).unwrap();
        assert!(pages.page(&manifest["pageId"], &json!(0)).is_err());
        assert!(pages.capture("1234567890".into()).is_ok());
    }
}
