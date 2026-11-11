//! Synthetic-only HTTP-over-phone dispatch. No network client or configurable endpoint.
use crate::phone::{Headers, Method, Request, Response, CHUNK, MAX_RESPONSE, MAX_UPLOAD};
use crate::{Error, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, MutexGuard};
pub const TARGET: &str = "http://synthetic.invalid";
pub const TOKEN: &str = "synthetic-http-bridge-token";
pub const TIMEOUT_MS: u64 = 340_000;
/// Time to encode/queue/deliver a timeout response after Node's fetch deadline.
pub const DELIVERY_MARGIN_MS: u64 = 5_000;
pub const REQUEST_LIFETIME_MS: u64 = TIMEOUT_MS + DELIVERY_MARGIN_MS;
const MAX_HEADERS: usize = 64 * 1024;
const BLOCKED: &[&str] = &[
    "host",
    "origin",
    "authorization",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "cookie",
];

/// A borrowed body; no payload recoding, surrogate substitution or network I/O.
pub struct Plan<'a> {
    pub method: Method,
    pub url: String,
    pub headers: Headers,
    pub body: Option<&'a [u8]>,
    pub timeout_ms: u64,
}
fn header_bytes(headers: &Headers) -> Result<usize> {
    let size = headers
        .iter()
        .try_fold(0usize, |n, (k, v)| {
            n.checked_add(k.len())?
                .checked_add(v.len())
                .and_then(|n| n.checked_add(128))
        })
        .ok_or(Error::TooLarge)?;
    if size > MAX_HEADERS {
        Err(Error::TooLarge)
    } else {
        Ok(size)
    }
}
fn index(name: &str) -> Option<u32> {
    let n = name.parse::<u32>().ok()?;
    (n < u32::MAX && n.to_string() == name).then_some(n)
}
pub fn prepare(request: &Request) -> Result<Plan<'_>> {
    if !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request.path.len() > 16 * 1024
    {
        return Err(Error::Schema);
    }
    header_bytes(&request.headers)?;
    if request.body.len() > MAX_UPLOAD {
        return Err(Error::TooLarge);
    }
    // Object.entries enumerates canonical array-index property names first.
    let mut entries: Vec<_> = request.headers.iter().enumerate().collect();
    entries.sort_by_key(|(at, (name, _))| match index(name) {
        Some(n) => (0, u64::from(n)),
        None => (1, *at as u64),
    });
    let mut headers = Headers::new();
    for (_, (name, value)) in entries {
        // Node's plain {} assignment ignores a string value for the __proto__ setter.
        if name == "__proto__" || BLOCKED.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        headers.insert(name.clone(), value.clone());
    }
    headers.insert("Authorization".into(), format!("Bearer {TOKEN}"));
    Ok(Plan {
        method: request.method.clone(),
        url: format!("{TARGET}{}", request.path),
        headers,
        body: (request.method == Method::POST && !request.body.is_empty())
            .then_some(request.body.as_slice()),
        timeout_ms: TIMEOUT_MS,
    })
}
pub enum Outcome {
    Response {
        status: u16,
        headers: Headers,
        body: Vec<u8>,
    },
    /// Fake observation of a response exceeding Node's 64 MiB cap; allocates no huge body.
    TooLarge,
    Timeout,
    Unavailable,
}
fn error_response(id: i64, status: u16, message: &str) -> Response {
    let mut headers = Headers::new();
    headers.insert("content-type".into(), "application/json".into());
    Response {
        id,
        status,
        headers,
        body: serde_json::to_vec(&serde_json::json!({"v":1,"error":{"message":message}})).unwrap(),
    }
}
pub fn response(id: i64, outcome: Outcome) -> Result<Response> {
    match outcome {
        Outcome::TooLarge => Ok(error_response(id, 502, "Response too large")),
        Outcome::Timeout => Ok(error_response(
            id,
            504,
            "The computer took too long to answer",
        )),
        Outcome::Unavailable => Ok(error_response(id, 502, "The computer could not be reached")),
        Outcome::Response {
            status,
            headers,
            body,
        } => {
            if body.len() > MAX_RESPONSE {
                return Ok(error_response(id, 502, "Response too large"));
            }
            if !(100..=599).contains(&status) {
                return Err(Error::Schema);
            }
            header_bytes(&headers)?;
            let mut forwarded = Headers::new();
            for field in ["content-type", "etag"] {
                let values: Vec<_> = headers
                    .iter()
                    .filter(|(k, _)| k.eq_ignore_ascii_case(field))
                    .map(|(_, v)| v.trim_matches([' ', '\t']).to_owned())
                    .collect();
                if !values.is_empty() {
                    forwarded.insert(field.into(), values.join(", "));
                }
            }
            Ok(Response {
                id,
                status,
                headers: forwarded,
                body,
            })
        }
    }
}
#[derive(Debug, Serialize)]
pub struct DispatchRecord {
    pub request_id: i64,
    pub method: Method,
    pub sent_body_bytes: Option<usize>,
    pub sent_body_sha256: Option<String>,
    pub status: u16,
    pub response_parts: usize,
}
struct State {
    outcome: Option<Outcome>,
    calls: usize,
}
/// A bounded one-shot fake HTTP exchange. Clones share the same consumable outcome.
/// The constructor has no URL, credentials, callback or existing-store parameter.
#[derive(Clone)]
pub struct MemoryHttp(Arc<Mutex<State>>);
impl MemoryHttp {
    pub fn new(outcome: Outcome) -> Result<Self> {
        if let Outcome::Response {
            status,
            headers,
            body,
        } = &outcome
        {
            if !(100..=599).contains(status) {
                return Err(Error::Schema);
            }
            header_bytes(headers)?;
            // Length-only checks miss caller-retained empty map/string allocations.
            let retained = headers
                .iter()
                .try_fold(
                    headers.capacity().checked_mul(128).ok_or(Error::TooLarge)?,
                    |n, (k, v)| n.checked_add(k.capacity())?.checked_add(v.capacity()),
                )
                .ok_or(Error::TooLarge)?;
            if retained > MAX_HEADERS {
                return Err(Error::TooLarge);
            }
            if body.capacity() > MAX_RESPONSE {
                return Err(Error::TooLarge);
            }
            if headers.iter().any(|(k, v)| {
                k.is_empty()
                    || !k
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
                    || v.chars()
                        .any(|c| c as u32 > 255 || matches!(c, '\0' | '\r' | '\n'))
            }) {
                return Err(Error::Schema);
            }
        }
        Ok(Self(Arc::new(Mutex::new(State {
            outcome: Some(outcome),
            calls: 0,
        }))))
    }
    pub fn calls(&self) -> usize {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).calls
    }
    pub(crate) fn retained_capacity(&self) -> usize {
        let state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match &state.outcome {
            Some(Outcome::Response { headers, body, .. }) => {
                body.capacity()
                    + headers.capacity() * 128
                    + headers
                        .iter()
                        .map(|(k, v)| k.capacity() + v.capacity())
                        .sum::<usize>()
                    + 512
            }
            _ => 512,
        }
    }
    /// Conservative additional connection/device/global bytes required before invocation.
    /// Diagnostic only: dispatch takes the reservation atomically, not this observation.
    pub fn required_bytes(&self, request: &Request) -> Result<usize> {
        self.prepare_exchange()?.bounds(request).map(|b| b.total)
    }
    pub(crate) fn prepare_exchange(&self) -> Result<PreparedExchange<'_>> {
        let state = self.0.lock().map_err(|_| Error::Unauthorized)?;
        if state.outcome.is_none() {
            return Err(Error::Order);
        }
        Ok(PreparedExchange(state))
    }
}
pub(crate) struct DispatchBounds {
    pub wire: usize,
    pub parts: usize,
    pub total: usize,
}
/// Locks the one-shot fake until preflight succeeds or the attempt is abandoned.
pub(crate) struct PreparedExchange<'a>(MutexGuard<'a, State>);
impl PreparedExchange<'_> {
    pub(crate) fn bounds(&self, request: &Request) -> Result<DispatchBounds> {
        let (bytes, headers) = match self.0.outcome.as_ref().ok_or(Error::Order)? {
            Outcome::Response { body, headers, .. } => (body.len(), header_bytes(headers)?),
            _ => (128, 256),
        };
        let parts = bytes.div_ceil(CHUNK).max(1);
        let wire = bytes.div_ceil(3) * 4 + parts * (headers * 6 + 512);
        let metadata = request
            .path
            .len()
            .checked_add(header_bytes(&request.headers)?)
            .ok_or(Error::TooLarge)?;
        // All frame leases + encoding/encryption scratch, retained simultaneously.
        // The same final frame lease moves into the mailbox; delivery adds no charge.
        let total = wire
            .checked_mul(4)
            .and_then(|n| n.checked_add(parts * 512))
            .and_then(|n| n.checked_add(metadata.checked_mul(3)?))
            .and_then(|n| n.checked_add(4096))
            .ok_or(Error::TooLarge)?;
        Ok(DispatchBounds { wire, parts, total })
    }
    pub(crate) fn exchange(
        mut self,
        id: i64,
        plan: &Plan<'_>,
    ) -> Result<(Response, DispatchRecord)> {
        let outcome = self.0.outcome.take().ok_or(Error::Order)?;
        self.0.calls += 1;
        let response = response(id, outcome)?;
        let record = DispatchRecord {
            request_id: id,
            method: plan.method.clone(),
            sent_body_bytes: plan.body.map(<[u8]>::len),
            sent_body_sha256: plan.body.map(|b| format!("{:x}", Sha256::digest(b))),
            status: response.status,
            response_parts: response.body.len().div_ceil(CHUNK).max(1),
        };
        Ok((response, record))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_estimate_covers_escaping_headers_and_every_chunk_boundary() {
        for len in [0, 1, 2, 3, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2 + 2] {
            for repetitions in [0, 1, 100] {
                let controls: String = (1..32u8)
                    .filter(|b| !matches!(b, b'\r' | b'\n'))
                    .map(char::from)
                    .collect();
                let headers = Headers::from([
                    (
                        "content-type".into(),
                        format!("{}\\\"", controls.repeat(repetitions)),
                    ),
                    ("ETag".into(), "\tfirst\t".into()),
                    ("etag".into(), "second".into()),
                ]);
                let http = MemoryHttp::new(Outcome::Response {
                    status: 200,
                    headers,
                    body: vec![255; len],
                })
                .unwrap();
                let request = Request {
                    id: -9_007_199_254_740_991,
                    method: Method::GET,
                    path: "/rpc".into(),
                    headers: Headers::new(),
                    body: vec![],
                };
                let exchange = http.prepare_exchange().unwrap();
                let bound = exchange.bounds(&request).unwrap();
                let (response, _) = exchange
                    .exchange(request.id, &prepare(&request).unwrap())
                    .unwrap();
                let frames = crate::phone::response_parts(&response).unwrap();
                assert_eq!(bound.parts, frames.len());
                assert!(frames.iter().map(|f| f.len() + 25).sum::<usize>() <= bound.wire);
            }
        }
    }
}
