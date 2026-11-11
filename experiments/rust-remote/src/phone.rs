//! Phone HTTP-over-channel codecs and deterministic, bounded local assembly state.
//! This is NOT pairing authorization, HTTP forwarding, or a socket lifecycle.
use crate::{channel::MAX_PLAIN_BYTES, Error, Result, MAX_SAFE_INTEGER};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::{BTreeMap, BTreeSet};

pub const CHUNK: usize = 256 * 1024;
pub const MAX_UPLOAD: usize = 8 * 1024 * 1024;
pub const MAX_RESPONSE: usize = 64 * 1024 * 1024;
pub const MAX_PENDING: usize = 80;
pub const MAX_LIVE: usize = 8;
pub const MAX_BATCH_ITEMS: usize = 4096;
pub const MAX_BATCH_DEPTH: usize = 16;
pub type Headers = indexmap::IndexMap<String, String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Method {
    GET,
    POST,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: i64,
    pub method: Method,
    pub path: String,
    pub headers: Headers,
    pub body: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub id: i64,
    pub status: u16,
    pub headers: Headers,
    pub body: Vec<u8>,
}

/// Opaque JSON string token. No surrogate replacement and no PUA sentinel mapping.
/// Feed as_json() into the owner jsjson parser exactly once at the owner boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct JsText(Box<RawValue>);
impl JsText {
    pub fn as_json(&self) -> &str {
        self.0.get()
    }
    pub fn to_unicode(&self) -> Result<String> {
        serde_json::from_str(self.as_json()).map_err(|_| Error::Schema)
    }
}
impl<'de> Deserialize<'de> for JsText {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(d)?;
        if !raw.get().starts_with('"') {
            return Err(serde::de::Error::custom("expected a JSON string"));
        }
        Ok(Self(raw))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RequestPart {
    t: String,
    id: i64,
    method: Method,
    path: String,
    headers: Headers,
    chunk: String,
    more: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ResponsePart {
    t: String,
    id: i64,
    status: u16,
    headers: Headers,
    chunk: String,
    more: bool,
}
fn valid_id(id: i64) -> bool {
    id.unsigned_abs() <= MAX_SAFE_INTEGER
}
fn route(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//")
}
fn chunks(bytes: &[u8]) -> Vec<String> {
    if bytes.is_empty() {
        vec![String::new()]
    } else {
        bytes.chunks(CHUNK).map(|b| STANDARD.encode(b)).collect()
    }
}
fn decode_chunk(text: &str) -> Result<Vec<u8>> {
    if text.len() > CHUNK.div_ceil(3) * 4 {
        return Err(Error::TooLarge);
    }
    let bytes = STANDARD.decode(text).map_err(|_| Error::Schema)?;
    if bytes.len() > CHUNK {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}
fn encode<T: Serialize>(v: &T) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(v).map_err(|_| Error::Schema)?;
    if bytes.len() > MAX_PLAIN_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(bytes)
}
fn bounded(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_PLAIN_BYTES {
        Err(Error::TooLarge)
    } else {
        Ok(())
    }
}

pub fn request_parts(request: &Request) -> Result<Vec<Vec<u8>>> {
    if !valid_id(request.id) || !route(&request.path) {
        return Err(Error::Schema);
    }
    if request.body.len() > MAX_UPLOAD {
        return Err(Error::TooLarge);
    }
    let parts = chunks(&request.body);
    let n = parts.len();
    parts
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            encode(&RequestPart {
                t: "req".into(),
                id: request.id,
                method: request.method.clone(),
                path: request.path.clone(),
                headers: request.headers.clone(),
                chunk,
                more: i + 1 < n,
            })
        })
        .collect()
}
pub fn response_parts(response: &Response) -> Result<Vec<Vec<u8>>> {
    if !valid_id(response.id) || !(100..=599).contains(&response.status) {
        return Err(Error::Schema);
    }
    if response.body.len() > MAX_RESPONSE {
        return Err(Error::TooLarge);
    }
    let parts = chunks(&response.body);
    let n = parts.len();
    parts
        .into_iter()
        .enumerate()
        .map(|(i, chunk)| {
            encode(&ResponsePart {
                t: "res".into(),
                id: response.id,
                status: response.status,
                headers: response.headers.clone(),
                chunk,
                more: i + 1 < n,
            })
        })
        .collect()
}

/// Configurable LOCAL admission limits. The Node upload limit counts padded base64
/// estimates, not exact decoded length; this implementation preserves that behavior.
#[derive(Debug, Clone, Copy)]
pub struct AssemblyLimits {
    pub pending: usize,
    pub body_bytes: usize,
    pub total_bytes: usize,
    pub timeout_ms: u64,
}
impl Default for AssemblyLimits {
    fn default() -> Self {
        Self {
            pending: MAX_PENDING,
            body_bytes: MAX_UPLOAD,
            total_bytes: 16 * 1024 * 1024,
            timeout_ms: 20_000,
        }
    }
}
struct Upload {
    request: Request,
    estimated: usize,
    held: usize,
    deadline: u64,
}
pub struct RequestAssembler {
    limits: AssemblyLimits,
    uploads: BTreeMap<i64, Upload>,
    ignored: BTreeSet<i64>,
    held: usize,
    closed: bool,
}
impl RequestAssembler {
    pub fn new(limits: AssemblyLimits) -> Result<Self> {
        if limits.pending == 0
            || limits.pending > MAX_PENDING
            || limits.body_bytes == 0
            || limits.body_bytes > MAX_UPLOAD
            || limits.total_bytes == 0
            || limits.total_bytes > 64 * 1024 * 1024
            || limits.timeout_ms == 0
        {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            limits,
            uploads: BTreeMap::new(),
            ignored: BTreeSet::new(),
            held: 0,
            closed: false,
        })
    }
    pub fn pending(&self) -> usize {
        self.uploads.len()
    }
    pub fn buffered_bytes(&self) -> usize {
        self.held
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    fn remove(&mut self, id: i64) -> Option<Upload> {
        let value = self.uploads.remove(&id)?;
        self.held -= value.held;
        Some(value)
    }
    /// Cancels LOCAL assembly; no wire cancel exists. Tail chunks are ignored through
    /// their final part. At most 64 abandoned IDs are retained; overflow closes state.
    pub fn cancel(&mut self, id: i64) -> Result<bool> {
        if self.remove(id).is_none() {
            return Ok(false);
        }
        if self.ignored.len() == 64 {
            self.disconnect();
            return Err(Error::TooLarge);
        }
        self.ignored.insert(id);
        Ok(true)
    }
    pub fn expire(&mut self, now_ms: u64) -> Result<Vec<i64>> {
        let expired: Vec<_> = self
            .uploads
            .iter()
            .filter(|(_, u)| now_ms >= u.deadline)
            .map(|(id, _)| *id)
            .collect();
        for id in &expired {
            self.cancel(*id)?;
        }
        Ok(expired)
    }
    /// Returns a completed upload, or None while incomplete/ignoring a cancelled tail.
    /// Invalid wire input closes and releases all assembly state; the carrier must close too.
    /// Caller must invoke expire before admission and run its own 16-active/64-queued scheduler.
    pub fn receive(&mut self, bytes: &[u8], now_ms: u64) -> Result<Option<Request>> {
        if self.closed {
            return Err(Error::Envelope);
        }
        let result = self.receive_inner(bytes, now_ms);
        if result.is_err() {
            self.disconnect();
        }
        result
    }
    fn receive_inner(&mut self, bytes: &[u8], now_ms: u64) -> Result<Option<Request>> {
        bounded(bytes)?;
        let p: RequestPart = serde_json::from_slice(bytes).map_err(|_| Error::Schema)?;
        if p.t != "req" || !valid_id(p.id) {
            return Err(Error::Schema);
        }
        if self.ignored.contains(&p.id) {
            if !p.more {
                self.ignored.remove(&p.id);
            }
            return Ok(None);
        }
        if let Some(u) = self.uploads.get(&p.id) {
            if now_ms >= u.deadline {
                self.cancel(p.id)?;
                if !p.more {
                    self.ignored.remove(&p.id);
                }
                return Ok(None);
            }
        }
        let chunk = decode_chunk(&p.chunk)?;
        if !self.uploads.contains_key(&p.id) {
            if !route(&p.path) {
                return Err(Error::Schema);
            }
            if self.uploads.len() >= self.limits.pending {
                return Err(Error::TooLarge);
            }
            // Metadata is kept only for the first part, exactly as the Node assembler does.
            let held = p.path.len()
                + p.headers
                    .iter()
                    .map(|(k, v)| k.len() + v.len())
                    .sum::<usize>();
            if self.held + held > self.limits.total_bytes {
                return Err(Error::TooLarge);
            }
            let deadline = now_ms
                .checked_add(self.limits.timeout_ms)
                .ok_or(Error::Exhausted)?;
            self.uploads.insert(
                p.id,
                Upload {
                    request: Request {
                        id: p.id,
                        method: p.method,
                        path: p.path,
                        headers: p.headers,
                        body: Vec::new(),
                    },
                    estimated: 0,
                    held,
                    deadline,
                },
            );
            self.held += held;
        }
        let u = self.uploads.get_mut(&p.id).unwrap();
        u.estimated += p.chunk.len() * 3 / 4;
        if u.estimated > self.limits.body_bytes || self.held + chunk.len() > self.limits.total_bytes
        {
            return Err(Error::TooLarge);
        }
        u.request.body.extend_from_slice(&chunk);
        u.held += chunk.len();
        self.held += chunk.len();
        if p.more {
            Ok(None)
        } else {
            Ok(Some(self.remove(p.id).unwrap().request))
        }
    }
    pub fn disconnect(&mut self) -> Vec<i64> {
        let ids = self.uploads.keys().copied().collect();
        self.uploads.clear();
        self.ignored.clear();
        self.held = 0;
        self.closed = true;
        ids
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Cancelled,
    Timeout,
    Disconnected,
    InvalidResponse,
    Limit,
}
#[derive(Debug)]
pub enum Event {
    Response(Response),
    Failed { id: i64, reason: Failure },
    Live { id: i64, data: JsText },
    LiveClosed { id: i64 },
    SendPong,
}
struct Pending {
    deadline: u64,
    response: Option<Response>,
    held: usize,
}
/// One phone-side connection generation. Create a NEW instance after disconnect.
/// Effects are returned in wire order, not invoked as callbacks during mutation.
pub struct Dispatcher {
    next: i64,
    pending: BTreeMap<i64, Pending>,
    lives: BTreeSet<i64>,
    held: usize,
    max_total: usize,
    closed: bool,
}
#[derive(Deserialize)]
struct Tag {
    t: String,
}
#[derive(Deserialize)]
struct Batch {
    items: Vec<Box<RawValue>>,
}
#[derive(Deserialize)]
struct Live {
    id: i64,
    data: JsText,
}
#[derive(Deserialize)]
struct Id {
    id: i64,
}
impl Dispatcher {
    pub fn new(max_total: usize) -> Result<Self> {
        if max_total == 0 || max_total > MAX_RESPONSE {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            next: 1,
            pending: BTreeMap::new(),
            lives: BTreeSet::new(),
            held: 0,
            max_total,
            closed: false,
        })
    }
    pub fn pending(&self) -> usize {
        self.pending.len()
    }
    pub fn live_count(&self) -> usize {
        self.lives.len()
    }
    pub fn buffered_bytes(&self) -> usize {
        self.held
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    fn id(&mut self) -> Result<i64> {
        if self.closed {
            return Err(Error::Envelope);
        }
        if self.next as u64 > MAX_SAFE_INTEGER {
            return Err(Error::Exhausted);
        }
        let id = self.next;
        self.next += 1;
        Ok(id)
    }
    /// Deadline is caller-owned monotonic time; no fixed 30-second cap on slow RPCs.
    pub fn begin(&mut self, deadline_ms: u64) -> Result<i64> {
        if self.pending.len() >= MAX_PENDING {
            return Err(Error::TooLarge);
        }
        let id = self.id()?;
        self.pending.insert(
            id,
            Pending {
                deadline: deadline_ms,
                response: None,
                held: 0,
            },
        );
        Ok(id)
    }
    pub fn subscribe(&mut self) -> Result<i64> {
        if self.lives.len() >= MAX_LIVE {
            return Err(Error::TooLarge);
        }
        let id = self.id()?;
        self.lives.insert(id);
        Ok(id)
    }
    pub fn close_live(&mut self, id: i64) -> bool {
        self.lives.remove(&id)
    }
    fn remove(&mut self, id: i64) -> Option<Pending> {
        let p = self.pending.remove(&id)?;
        self.held -= p.held;
        Some(p)
    }
    pub fn cancel(&mut self, id: i64) -> Option<Event> {
        self.remove(id).map(|_| Event::Failed {
            id,
            reason: Failure::Cancelled,
        })
    }
    pub fn expire(&mut self, now_ms: u64) -> Vec<Event> {
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| now_ms >= p.deadline)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .map(|id| {
                self.remove(id);
                Event::Failed {
                    id,
                    reason: Failure::Timeout,
                }
            })
            .collect()
    }
    pub fn disconnect(&mut self) -> Vec<Event> {
        let mut out: Vec<_> = self
            .pending
            .keys()
            .map(|id| Event::Failed {
                id: *id,
                reason: Failure::Disconnected,
            })
            .collect();
        out.extend(self.lives.iter().map(|id| Event::LiveClosed { id: *id }));
        self.pending.clear();
        self.lives.clear();
        self.held = 0;
        self.closed = true;
        out
    }
    /// Validates bounded batch structure BEFORE dispatching any item. Unknown tags are
    /// ignored like mobile. Bad individual responses fail only their pending request.
    /// Protocol-level errors disconnect and return teardown effects, never discard them.
    pub fn receive(&mut self, bytes: &[u8], now_ms: u64) -> (Vec<Event>, Result<()>) {
        if self.closed {
            return (Vec::new(), Err(Error::Envelope));
        }
        let mut out = self.expire(now_ms);
        let parsed = flatten(bytes);
        let items = match parsed {
            Ok(items) => items,
            Err(e) => {
                out.extend(self.disconnect());
                return (out, Err(e));
            }
        };
        for (tag, raw) in items {
            let result = self.dispatch(&tag, raw.get().as_bytes(), &mut out);
            if let Err(e) = result {
                out.extend(self.disconnect());
                return (out, Err(e));
            }
        }
        (out, Ok(()))
    }
    fn dispatch(&mut self, tag: &str, raw: &[u8], out: &mut Vec<Event>) -> Result<()> {
        match tag {
            "res" => {
                let id: Id = serde_json::from_slice(raw).map_err(|_| Error::Schema)?;
                if !self.pending.contains_key(&id.id) {
                    return Ok(());
                }
                let result = self.response(raw);
                match result {
                    Ok(Some(response)) => out.push(Event::Response(response)),
                    Ok(None) => {}
                    Err(e) => {
                        self.remove(id.id);
                        out.push(Event::Failed {
                            id: id.id,
                            reason: if e == Error::TooLarge {
                                Failure::Limit
                            } else {
                                Failure::InvalidResponse
                            },
                        });
                    }
                }
            }
            "live" => {
                let live: Live = serde_json::from_slice(raw).map_err(|_| Error::Schema)?;
                if self.lives.contains(&live.id) {
                    out.push(Event::Live {
                        id: live.id,
                        data: live.data,
                    });
                }
            }
            "live-close" => {
                let id: Id = serde_json::from_slice(raw).map_err(|_| Error::Schema)?;
                if self.lives.remove(&id.id) {
                    out.push(Event::LiveClosed { id: id.id });
                }
            }
            "ping" => out.push(Event::SendPong),
            _ => {}
        }
        Ok(())
    }
    fn response(&mut self, raw: &[u8]) -> Result<Option<Response>> {
        let p: ResponsePart = serde_json::from_slice(raw).map_err(|_| Error::Schema)?;
        if !valid_id(p.id) || !(100..=599).contains(&p.status) {
            return Err(Error::Schema);
        }
        let chunk = decode_chunk(&p.chunk)?;
        let pending = self.pending.get_mut(&p.id).ok_or(Error::Schema)?;
        if pending.response.is_none() {
            let metadata = p
                .headers
                .iter()
                .map(|(k, v)| k.len() + v.len())
                .sum::<usize>();
            if self.held + metadata > self.max_total {
                return Err(Error::TooLarge);
            }
            self.held += metadata;
            pending.held += metadata;
            pending.response = Some(Response {
                id: p.id,
                status: p.status,
                headers: p.headers,
                body: Vec::new(),
            });
        }
        let response = pending.response.as_mut().unwrap();
        if response.body.len() + chunk.len() > MAX_RESPONSE
            || self.held + chunk.len() > self.max_total
        {
            return Err(Error::TooLarge);
        }
        response.body.extend_from_slice(&chunk);
        pending.held += chunk.len();
        self.held += chunk.len();
        if p.more {
            Ok(None)
        } else {
            Ok(self.remove(p.id).unwrap().response)
        }
    }
}
fn flatten(bytes: &[u8]) -> Result<Vec<(String, Box<RawValue>)>> {
    bounded(bytes)?;
    let root: Box<RawValue> = serde_json::from_slice(bytes).map_err(|_| Error::Schema)?;
    let mut stack = vec![(root, 0)];
    let mut leaves = Vec::new();
    let mut count = 0;
    while let Some((raw, depth)) = stack.pop() {
        count += 1;
        if count > MAX_BATCH_ITEMS || depth > MAX_BATCH_DEPTH {
            return Err(Error::TooLarge);
        }
        let tag: Tag = serde_json::from_str(raw.get()).map_err(|_| Error::Schema)?;
        if tag.t == "batch" {
            let batch: Batch = serde_json::from_str(raw.get()).map_err(|_| Error::Schema)?;
            if count + stack.len() + batch.items.len() > MAX_BATCH_ITEMS {
                return Err(Error::TooLarge);
            }
            stack.extend(batch.items.into_iter().rev().map(|item| (item, depth + 1)));
        } else {
            leaves.push((tag.t, raw));
        }
    }
    Ok(leaves)
}
