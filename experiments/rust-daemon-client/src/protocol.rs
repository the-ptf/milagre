//! Protocol-v1 framing and paging adapted from rust-desktop/src/transport.rs.
use crate::{
    notify::Queue, protocol, Authority, ClientOptions, Error, Hello, Hydration, Notice, Result,
    RuntimeSnapshot, SnapshotReceipt,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    os::unix::net::UnixStream,
    sync::Arc,
    time::{Duration, Instant},
};

const JS_MAX: u64 = 9_007_199_254_740_991;

pub(crate) struct Engine {
    stream: UnixStream,
    input: Vec<u8>,
    pub(crate) options: ClientOptions,
    pub(crate) authority: Arc<Authority>,
    pub(crate) notices: Arc<Queue>,
    pub(crate) connection: u64,
    next_id: u64,
    last_wire_seq: Option<u64>,
    capabilities: BTreeSet<String>,
    methods: BTreeSet<String>,
    generation: u64,
    accepted_generation: u64,
    accepted_watermark: Option<u64>,
    #[cfg(test)]
    pub(crate) page_deadline: Option<Instant>,
}
impl Engine {
    pub(crate) fn new(
        stream: UnixStream,
        authority: Arc<Authority>,
        options: ClientOptions,
        notices: Arc<Queue>,
        connection: u64,
    ) -> Result<Self> {
        stream
            .set_read_timeout(Some(Duration::from_millis(20)))
            .map_err(|_| Error::Disconnected)?;
        stream
            .set_write_timeout(Some(options.request_timeout))
            .map_err(|_| Error::Disconnected)?;
        Ok(Self {
            stream,
            input: Vec::new(),
            authority,
            options,
            notices,
            connection,
            next_id: 0,
            last_wire_seq: None,
            capabilities: BTreeSet::new(),
            methods: BTreeSet::new(),
            generation: 0,
            accepted_generation: 0,
            accepted_watermark: None,
            #[cfg(test)]
            page_deadline: None,
        })
    }
    pub(crate) fn handshake(&mut self) -> Result<Hello> {
        let value = self.request_unchecked(
            "daemon:status",
            json!([]),
            Instant::now() + self.options.request_timeout,
        )?;
        if value["protocolVersion"] != 1
            || value["closing"] != false
            || value["pid"].as_u64() != Some(self.authority.pid as u64)
        {
            return Err(protocol(
                "incompatible, closing or unexpected fixture owner",
            ));
        }
        self.capabilities = strings(&value["capabilities"])?;
        self.methods = strings(&value["methods"])?;
        for required in ["snapshot-pages-v1", "result-pages-v1"] {
            if !self.capabilities.contains(required) {
                return Err(Error::Capability {
                    required: required.into(),
                });
            }
        }
        Ok(Hello {
            wire: 1,
            capabilities: self.capabilities.clone(),
            owner: value,
        })
    }
    pub(crate) fn request(&mut self, method: &str, args: Value, expires: Instant) -> Result<Value> {
        if !self.methods.contains(method) {
            return Err(Error::Capability {
                required: format!("method:{method}"),
            });
        }
        self.request_unchecked(method, args, expires)
    }
    fn request_unchecked(&mut self, method: &str, args: Value, expires: Instant) -> Result<Value> {
        let response = self.exchange(method, args, expires)?;
        if let Some(manifest) = response.get("pages") {
            let (id, count) = self.manifest(manifest, "pageId")?;
            let mut parts = String::new();
            for index in 0..count {
                let page = self.page_exchange("daemon:result-page", json!([id, index]), expires)?;
                self.append(&mut parts, &page["result"])?;
            }
            serde_json::from_str(&parts).map_err(|_| protocol("paged result is not JSON"))
        } else {
            response
                .get("result")
                .cloned()
                .ok_or_else(|| protocol("response has neither result nor pages"))
        }
    }
    fn page_exchange(&mut self, method: &str, args: Value, expires: Instant) -> Result<Value> {
        #[cfg(test)]
        let expires = self.page_deadline.take().unwrap_or(expires);
        // The original operation was submitted before it returned this manifest.
        // A later page fetch failing before its own write cannot undo that fact.
        self.exchange(method, args, expires)
            .map_err(|error| match error {
                Error::TimedOut { .. } => Error::TimedOut { submitted: true },
                error => error,
            })
    }
    fn exchange(&mut self, method: &str, args: Value, expires: Instant) -> Result<Value> {
        self.next_id = self
            .next_id
            .checked_add(1)
            .filter(|id| *id <= JS_MAX)
            .ok_or_else(|| protocol("request ids exhausted"))?;
        let id = self.next_id;
        let mut frame =
            serde_json::to_vec(&json!({"v":1,"id":id,"method":method,"args":args,"pages":true}))
                .map_err(|_| protocol("request encoding failed"))?;
        if frame.len() > self.options.max_frame_bytes {
            return Err(Error::StateTooLarge { hydration: None });
        }
        frame.push(b'\n');
        if Instant::now() >= expires {
            return Err(Error::TimedOut { submitted: false });
        }
        self.stream
            .set_write_timeout(Some(
                expires
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_nanos(1)),
            ))
            .map_err(|_| Error::Disconnected)?;
        self.stream
            .write_all(&frame)
            .map_err(|_| Error::Disconnected)?;
        loop {
            if Instant::now() >= expires {
                return Err(Error::TimedOut { submitted: true });
            }
            if let Some(frame) = self.read()? {
                if self.event(&frame)? {
                    continue;
                }
                let received = safe_integer(&frame["id"], "response id")?;
                if received < id {
                    continue;
                } // Late reply to a timed-out local wait. Never replay it.
                if received != id {
                    return Err(protocol("unsolicited response id"));
                }
                if let Some(error) = frame.get("error").filter(|value| !value.is_null()) {
                    return Err(remote(error)?);
                }
                return Ok(frame);
            }
        }
    }
    pub(crate) fn idle(&mut self) -> Result<()> {
        if let Some(frame) = self.read()? {
            if !self.event(&frame)? {
                let id = safe_integer(&frame["id"], "response id")?;
                if id > self.next_id {
                    return Err(protocol("unsolicited response id"));
                }
            }
        }
        Ok(())
    }
    fn read(&mut self) -> Result<Option<Value>> {
        if let Some(end) = self.input.iter().position(|byte| *byte == b'\n') {
            if end > self.options.max_frame_bytes {
                return Err(Error::StateTooLarge { hydration: None });
            }
            let frame: Value = serde_json::from_slice(&self.input[..end])
                .map_err(|_| protocol("invalid JSON frame"))?;
            self.input.drain(..=end);
            if frame["v"] != 1 {
                return Err(protocol("incompatible wire version"));
            }
            return Ok(Some(frame));
        }
        if self.input.len() > self.options.max_frame_bytes {
            return Err(Error::StateTooLarge { hydration: None });
        }
        let mut chunk = [0u8; 8192];
        // Read at most one byte beyond the limit to distinguish an exact boundary from overflow.
        let allowed = chunk
            .len()
            .min(self.options.max_frame_bytes + 1 - self.input.len());
        match self.stream.read(&mut chunk[..allowed]) {
            Ok(0) => Err(Error::Disconnected),
            Ok(count) => {
                self.input.extend_from_slice(&chunk[..count]);
                self.read_buffered()
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err(Error::Disconnected),
        }
    }
    fn read_buffered(&mut self) -> Result<Option<Value>> {
        if self.input.contains(&b'\n') {
            self.read()
        } else if self.input.len() > self.options.max_frame_bytes {
            Err(Error::StateTooLarge { hydration: None })
        } else {
            Ok(None)
        }
    }
    fn event(&mut self, frame: &Value) -> Result<bool> {
        let Some(event) = frame.get("event") else {
            return Ok(false);
        };
        if frame.get("id").is_some() {
            return Err(protocol("mixed response and event frame"));
        }
        let wire_seq = safe_integer(&event["seq"], "event sequence")?;
        if self.last_wire_seq.is_some_and(|last| wire_seq <= last) {
            return Err(protocol("event sequence regressed or repeated"));
        }
        self.last_wire_seq = Some(wire_seq);
        let channel = event["channel"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| protocol("event channel missing"))?
            .to_owned();
        let payload = event
            .get("payload")
            .cloned()
            .ok_or_else(|| protocol("event payload missing"))?;
        if self
            .accepted_watermark
            .is_some_and(|watermark| wire_seq <= watermark)
        {
            return Ok(true);
        }
        let scope = event_scope(&channel, &payload);
        let bytes = event.to_string().len();
        self.notices.push(
            Notice::Event {
                wire_seq,
                scope,
                channel,
                payload,
            },
            bytes,
        )?;
        Ok(true)
    }
    /// One bounded read per worker iteration; all failures are terminal for events.
    pub(crate) fn hydrate(&mut self) -> Result<()> {
        let Some(batch) = self.notices.hydration() else {
            return Ok(());
        };
        if batch.scope.as_deref() != Some(&self.authority.project) {
            return Err(Error::StateTooLarge {
                hydration: batch.scope.map(|scope| Hydration {
                    scope,
                    method: "project:read".into(),
                }),
            });
        }
        let mut body = self.request(
            "project:read",
            json!([self.authority.project, {"state":true}]),
            batch.expires,
        )?;
        if body["path"].as_str() != Some(&self.authority.project) || !body["state"].is_object() {
            return Err(protocol("invalid Project hydration result"));
        }
        let state = body.as_object_mut().unwrap().remove("state").unwrap();
        self.notices.hydrated(batch, state)
    }
    pub(crate) fn snapshot(&mut self, expires: Instant) -> Result<RuntimeSnapshot> {
        self.notices.hold();
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| protocol("snapshot generation exhausted"))?;
        if !self.methods.contains("daemon:snapshot") {
            return Err(Error::Capability {
                required: "method:daemon:snapshot".into(),
            });
        }
        let frame = self.exchange("daemon:snapshot", json!([{"paged":true}]), expires)?;
        let manifest = frame
            .get("result")
            .ok_or_else(|| protocol("snapshot manifest missing"))?;
        let watermark = safe_integer(&manifest["eventSeq"], "snapshot watermark")?;
        let (id, count) = self.manifest(manifest, "snapshotId")?;
        let mut parts = String::new();
        for index in 0..count {
            let page = self.page_exchange("daemon:snapshot-page", json!([id, index]), expires)?;
            self.append(&mut parts, &page["result"])?;
        }
        let body: Value =
            serde_json::from_str(&parts).map_err(|_| protocol("snapshot is not JSON"))?;
        if !body.is_object() || body["eventSeq"].as_u64() != Some(watermark) {
            return Err(protocol("snapshot watermark disagrees with manifest"));
        }
        if self
            .accepted_watermark
            .is_some_and(|accepted| watermark < accepted)
        {
            return Err(protocol("snapshot watermark regressed"));
        }
        Ok(RuntimeSnapshot {
            body,
            event_seq: watermark,
            receipt: SnapshotReceipt {
                connection: self.connection,
                generation: self.generation,
                watermark,
            },
        })
    }
    pub(crate) fn accept(&mut self, receipt: SnapshotReceipt) -> Result<()> {
        if receipt.connection != self.connection
            || receipt.generation != self.generation
            || receipt.generation < self.accepted_generation
            || self
                .accepted_watermark
                .is_some_and(|watermark| receipt.watermark < watermark)
        {
            return Err(Error::StaleSnapshot);
        }
        if receipt.generation == self.accepted_generation {
            return if self.accepted_watermark == Some(receipt.watermark) {
                Ok(())
            } else {
                Err(Error::StaleSnapshot)
            };
        }
        self.accepted_generation = receipt.generation;
        self.accepted_watermark = Some(receipt.watermark);
        self.notices.release(receipt.watermark);
        Ok(())
    }
    fn manifest(&self, manifest: &Value, id_field: &str) -> Result<(Value, usize)> {
        let count = manifest["pageCount"]
            .as_u64()
            .filter(|count| *count > 0 && *count <= self.options.max_pages as u64)
            .ok_or_else(|| protocol("invalid page count"))?;
        let id = &manifest[id_field];
        if !(id
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 1024)
            || id.as_u64().is_some_and(|id| id > 0 && id <= JS_MAX))
        {
            return Err(protocol("invalid page identity"));
        }
        Ok((id.clone(), count as usize))
    }
    fn append(&self, parts: &mut String, page: &Value) -> Result<()> {
        let text = page
            .as_str()
            .ok_or_else(|| protocol("page is not a string"))?;
        if text.len() > self.options.max_paged_bytes.saturating_sub(parts.len()) {
            return Err(Error::StateTooLarge { hydration: None });
        }
        parts.push_str(text);
        Ok(())
    }
}
fn strings(value: &Value) -> Result<BTreeSet<String>> {
    let array = value
        .as_array()
        .ok_or_else(|| protocol("expected a string list"))?;
    array
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| protocol("expected a string list"))
        })
        .collect()
}
pub(crate) fn safe_integer(value: &Value, field: &str) -> Result<u64> {
    value
        .as_u64()
        .filter(|value| *value <= JS_MAX)
        .ok_or_else(|| protocol(format!("invalid {field}")))
}
fn remote(value: &Value) -> Result<Error> {
    Ok(Error::Remote {
        code: value["code"]
            .as_str()
            .ok_or_else(|| protocol("remote error code missing"))?
            .into(),
        message: value["message"]
            .as_str()
            .ok_or_else(|| protocol("remote error message missing"))?
            .into(),
        payload: value.clone(),
    })
}
fn event_scope(channel: &str, payload: &Value) -> Option<String> {
    if channel == "project:state" {
        return payload["path"].as_str().map(str::to_owned);
    }
    if channel == "link:state" {
        return payload["linkId"]
            .as_str()
            .map(|id| format!("milagre-link:{id}"));
    }
    payload["chatId"]
        .as_str()
        .map(|id| {
            id.rsplit_once('#')
                .map_or(id, |(scope, _)| scope)
                .to_owned()
        })
        .or_else(|| payload["projectPath"].as_str().map(str::to_owned))
}
