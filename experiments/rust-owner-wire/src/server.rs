use crate::{
    pages::Pages,
    profile::assert_same_user,
    protocol::{read_frame_with, safe_integer, valid_id_with},
    IsolatedProfile, RpcError, RpcResult, MAX_FRAME_BYTES, MAX_PENDING, VERSION,
};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::HashMap,
    fs,
    io::{BufReader, Write},
    net::Shutdown,
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, SyncSender},
        Arc, Condvar, Mutex, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Config {
    pub max_frame_bytes: usize,
    pub page_budget_bytes: usize,
    pub page_ttl: Duration,
    pub max_clients: usize,
    pub require_authentication: bool,
    pub authentication_timeout: Duration,
    pub shutdown_timeout: Duration,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            page_budget_bytes: 128 * 1024 * 1024,
            page_ttl: Duration::from_secs(30),
            max_clients: 64,
            require_authentication: false,
            authentication_timeout: Duration::from_secs(5),
            shutdown_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClientView {
    pub focused: bool,
    pub project_path: Option<String>,
    pub link_id: Option<String>,
    pub chat_id: Option<String>,
}
impl ClientView {
    pub fn value(&self) -> Value {
        json!({"focused":self.focused,"projectPath":self.project_path,"linkId":self.link_id,"chatId":self.chat_id})
    }
}

/// No actor or client ID is accepted from request arguments. Every context belongs to its socket.
#[derive(Clone)]
pub struct ClientContext {
    client: Arc<Client>,
    pub events: EventSink,
}
impl ClientContext {
    pub fn client_id(&self) -> u64 {
        self.client.id
    }
    pub fn view(&self) -> ClientView {
        self.client.view.lock().unwrap().clone()
    }
    pub fn is_connected(&self) -> bool {
        !self.client.closed.load(Ordering::Acquire)
    }
    pub fn disconnect(&self) {
        self.client.disconnect();
    }
}

/// A future owner adapter implements this boundary. No Project or provider implementation is implied.
pub trait Handler: Send + Sync + 'static {
    /// Decode one bounded frame. The same representation must be used by encode_request_id,
    /// encode_result and string_len. Default handlers use ordinary Unicode; an owner may use lossless UTF-16.
    fn decode_request(&self, frame: &[u8]) -> Result<Value, RpcError> {
        serde_json::from_slice(frame)
            .map_err(|_| RpcError::new("INVALID_REQUEST", "Expected a JSON frame"))
    }
    fn encode_request_id(&self, id: &Value) -> Result<String, RpcError> {
        Ok(id.to_string())
    }
    fn string_len(&self, string: &str) -> usize {
        string.encode_utf16().count()
    }
    fn methods(&self) -> Vec<String>;
    fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult;
    /// Called under the publication lock. Do not publish events from inside snapshot.
    fn snapshot(&self, context: &ClientContext) -> RpcResult;
    /// Serialize domain results. An adapter may preserve JavaScript lone surrogates using JSON escapes.
    /// Must return one valid JSON value without literal newlines. Page fragments bypass this hook.
    fn encode_result(&self, result: &Value) -> Result<String, RpcError> {
        Ok(result.to_string())
    }
    fn view_changed(&self, _context: &ClientContext) -> RpcResult {
        Ok(Value::Null)
    }
    /// Accepted commands have completed before this runs. Failure leaves the listener available for another stop.
    fn shutdown(&self) -> RpcResult {
        Ok(Value::Null)
    }
    /// Notification only. Must not block, publish events or reenter the server. Resource owners must drain in shutdown.
    fn disconnected(&self, _client_id: u64) {}
}

#[derive(Clone)]
pub struct EventSink {
    inner: Weak<Inner>,
}
impl EventSink {
    pub fn emit(&self, channel: &str, payload: Value) -> Result<u64, RpcError> {
        self.transaction(|publication| publication.emit(channel, payload))
    }
    /// Mutate handler state and publish its event inside this closure, taking the handler lock *after* this lock.
    /// Snapshot uses the same lock, so its event watermark can never skip a state change absent from the snapshot.
    pub fn transaction<T>(
        &self,
        update: impl FnOnce(&Publication<'_>) -> Result<T, RpcError>,
    ) -> Result<T, RpcError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| RpcError::new("DAEMON_CLOSED", "Server is closed"))?;
        let _guard = inner.publication.lock().unwrap();
        update(&Publication { inner: &inner })
    }
}
pub struct Publication<'a> {
    inner: &'a Inner,
}
impl Publication<'_> {
    pub fn emit(&self, channel: &str, mut payload: Value) -> Result<u64, RpcError> {
        if channel.is_empty() || channel.len() > 128 {
            return Err(RpcError::new("INVALID_EVENT", "Invalid event channel"));
        }
        if let Some(object) = payload.as_object_mut() {
            let state_too_large = object
                .get("state")
                .map(|state| self.inner.handler.encode_result(state))
                .transpose()?
                .is_some_and(|text| text.len() > self.inner.config.max_frame_bytes / 4);
            if state_too_large {
                object.remove("state");
                object.insert("stateTooLarge".into(), Value::Bool(true));
            }
        }
        let seq = self.inner.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        // Keep v/event first: production client's events:false fast path depends on this byte prefix.
        let payload = self.inner.handler.encode_result(&payload)?;
        if payload.contains(['\n', '\r']) {
            return Err(RpcError::new(
                "INVALID_RESPONSE",
                "Encoded event payload must fit one JSON line",
            ));
        }
        let frame = format!("{{\"v\":{VERSION},\"event\":{{\"channel\":{},\"payload\":{payload},\"seq\":{seq}}}}}\n", json!(channel)).into_bytes();
        if frame.len() > self.inner.config.max_frame_bytes {
            return Err(RpcError::new(
                "FRAME_TOO_LARGE",
                "Event exceeds the local daemon size limit",
            ));
        }
        let clients: Vec<_> = self
            .inner
            .clients
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for client in clients {
            if client.authenticated.load(Ordering::Acquire) {
                let _ = client.enqueue(frame.clone());
            }
        }
        Ok(seq)
    }
}

pub struct Server {
    inner: Arc<Inner>,
    acceptor: Option<JoinHandle<()>>,
}
impl Server {
    pub fn bind(
        profile: IsolatedProfile,
        handler: Arc<dyn Handler>,
        config: Config,
    ) -> Result<Self, RpcError> {
        if !(1024..=MAX_FRAME_BYTES).contains(&config.max_frame_bytes)
            || config.page_budget_bytes == 0
            || config.page_budget_bytes > 128 * 1024 * 1024
            || !(1..=128).contains(&config.max_clients)
        {
            return Err(RpcError::new(
                "INVALID_CONFIG",
                "Frame, page or client budget is outside the supported limits",
            ));
        }
        let token = if config.require_authentication {
            let token = nonce();
            let directory = profile.path().join("daemon-private");
            fs::create_dir(&directory)?;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(directory.join("token"))?;
            file.write_all(token.as_bytes())?;
            Some(token)
        } else {
            None
        };
        // bind never unlinks an existing endpoint, even one that appears stale.
        let listener = UnixListener::bind(profile.socket_path())?;
        let socket_meta = fs::symlink_metadata(profile.socket_path())?;
        let setup = fs::set_permissions(profile.socket_path(), fs::Permissions::from_mode(0o600))
            .and_then(|()| listener.set_nonblocking(true));
        if let Err(error) = setup {
            if fs::symlink_metadata(profile.socket_path()).is_ok_and(|meta| {
                (meta.dev(), meta.ino()) == (socket_meta.dev(), socket_meta.ino())
            }) {
                let _ = fs::remove_file(profile.socket_path());
            }
            return Err(error.into());
        }
        let inner = Arc::new(Inner {
            profile,
            socket_identity: (socket_meta.dev(), socket_meta.ino()),
            config,
            handler,
            token,
            clients: Mutex::new(HashMap::new()),
            next_client: AtomicU64::new(0),
            sequence: AtomicU64::new(0),
            publication: Mutex::new(()),
            closing: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            active: Mutex::new(0),
            drained: Condvar::new(),
            shutdown_lock: Mutex::new(()),
        });
        let accepting = inner.clone();
        let acceptor = thread::spawn(move || {
            let mut last_sweep = Instant::now();
            while !accepting.stopped.load(Ordering::Acquire) {
                if last_sweep.elapsed() >= Duration::from_millis(100) {
                    let clients: Vec<_> = accepting
                        .clients
                        .lock()
                        .unwrap()
                        .values()
                        .cloned()
                        .collect();
                    for client in clients {
                        client.pages.lock().unwrap().expire();
                    }
                    last_sweep = Instant::now();
                }
                match listener.accept() {
                    Ok((socket, _)) => {
                        let clients = accepting.clients.lock().unwrap();
                        let full = clients.len() >= accepting.config.max_clients
                            || (accepting.config.require_authentication
                                && clients
                                    .values()
                                    .filter(|client| !client.authenticated.load(Ordering::Acquire))
                                    .count()
                                    >= 32);
                        drop(clients);
                        if full || assert_same_user(&socket).is_err() {
                            let _ = socket.shutdown(Shutdown::Both);
                            continue;
                        }
                        let _ = Client::start(socket, &accepting);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            inner,
            acceptor: Some(acceptor),
        })
    }
    pub fn profile_path(&self) -> &Path {
        self.inner.profile.path()
    }
    pub fn socket_path(&self) -> &Path {
        self.inner.profile.socket_path()
    }
    pub fn events(&self) -> EventSink {
        EventSink {
            inner: Arc::downgrade(&self.inner),
        }
    }
    pub fn is_stopped(&self) -> bool {
        self.inner.stopped.load(Ordering::Acquire)
    }
    pub fn shutdown(&self) -> Result<(), RpcError> {
        self.inner.shutdown(None)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if self.shutdown().is_err() {
            self.inner.stopped.store(true, Ordering::Release);
            let clients: Vec<_> = self
                .inner
                .clients
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect();
            for client in clients {
                client.disconnect();
            }
        }
        if let Some(acceptor) = self.acceptor.take() {
            let _ = acceptor.join();
        }
    }
}

struct Inner {
    profile: IsolatedProfile,
    socket_identity: (u64, u64),
    config: Config,
    handler: Arc<dyn Handler>,
    token: Option<String>,
    clients: Mutex<HashMap<u64, Arc<Client>>>,
    next_client: AtomicU64,
    sequence: AtomicU64,
    publication: Mutex<()>,
    closing: AtomicBool,
    stopped: AtomicBool,
    active: Mutex<usize>,
    drained: Condvar,
    shutdown_lock: Mutex<()>,
}
impl Inner {
    fn shutdown(
        self: &Arc<Self>,
        acknowledgement: Option<(&Client, &Value)>,
    ) -> Result<(), RpcError> {
        let _exclusive = self.shutdown_lock.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        self.closing.store(true, Ordering::Release);
        let expires = Instant::now() + self.config.shutdown_timeout;
        let mut active = self.active.lock().unwrap();
        while *active != 0 {
            let remaining = expires.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RpcError::new(
                    "SHUTDOWN_TIMEOUT",
                    "Accepted commands have not drained; the server remains closing",
                ));
            }
            active = self.drained.wait_timeout(active, remaining).unwrap().0;
        }
        drop(active);
        self.handler.shutdown()?;
        if let Some((client, id)) = acknowledgement {
            client.send(&json!({"v":VERSION,"id":id,"result":{"stopping":true}}))?;
        }
        EventSink {
            inner: Arc::downgrade(self),
        }
        .emit("daemon:stopping", json!({}))?;
        self.stopped.store(true, Ordering::Release);
        let clients: Vec<_> = self.clients.lock().unwrap().values().cloned().collect();
        for client in clients {
            client.end();
        }
        let flush_deadline = Instant::now() + Duration::from_secs(2);
        while !self.clients.lock().unwrap().is_empty() && Instant::now() < flush_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        // Delete only this binding's inode; never remove an endpoint installed by another process.
        if let Ok(meta) = fs::symlink_metadata(self.profile.socket_path()) {
            if (meta.dev(), meta.ino()) == self.socket_identity {
                let _ = fs::remove_file(self.profile.socket_path());
            }
        }
    }
}

enum Outbound {
    Frame(Vec<u8>, Option<(String, u64)>),
    End,
}
struct Client {
    id: u64,
    inner: Weak<Inner>,
    socket: UnixStream,
    outgoing: SyncSender<Outbound>,
    queued_bytes: AtomicUsize,
    closed: AtomicBool,
    authenticated: AtomicBool,
    view: Mutex<ClientView>,
    inflight: Mutex<HashMap<String, u64>>,
    next_request: AtomicU64,
    pages: Mutex<Pages>,
}
impl Client {
    fn start(socket: UnixStream, inner: &Arc<Inner>) -> Result<(), RpcError> {
        // macOS inherits the listener's nonblocking flag on accept; reader threads use blocking I/O.
        socket.set_nonblocking(false)?;
        socket.set_write_timeout(Some(Duration::from_secs(1)))?;
        let writer = socket.try_clone()?;
        let reader = socket.try_clone()?;
        let (outgoing, receiver) = mpsc::sync_channel(64);
        let client = Arc::new(Self {
            id: inner.next_client.fetch_add(1, Ordering::Relaxed) + 1,
            inner: Arc::downgrade(inner),
            socket,
            outgoing,
            queued_bytes: AtomicUsize::new(0),
            closed: AtomicBool::new(false),
            authenticated: AtomicBool::new(!inner.config.require_authentication),
            view: Mutex::new(ClientView::default()),
            inflight: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(0),
            pages: Mutex::new(Pages::new(
                inner.config.max_frame_bytes,
                inner.config.page_budget_bytes,
                inner.config.page_ttl,
            )),
        });
        inner
            .clients
            .lock()
            .unwrap()
            .insert(client.id, client.clone());
        let writing = client.clone();
        thread::spawn(move || {
            let mut writer = writer;
            while let Ok(frame) = receiver.recv() {
                match frame {
                    Outbound::Frame(bytes, release) => {
                        if let Some((identity, ticket)) = release {
                            writing.release_request(&identity, ticket);
                        }
                        let sent = writer.write_all(&bytes);
                        writing
                            .queued_bytes
                            .fetch_sub(bytes.len(), Ordering::AcqRel);
                        if sent.is_err() {
                            break;
                        }
                    }
                    Outbound::End => break,
                }
            }
            writing.disconnect();
        });
        if inner.config.require_authentication {
            let waiting = Arc::downgrade(&client);
            let timeout = inner.config.authentication_timeout;
            thread::spawn(move || {
                thread::sleep(timeout);
                if let Some(client) = waiting.upgrade() {
                    if !client.authenticated.load(Ordering::Acquire) {
                        client.disconnect();
                    }
                }
            });
        }
        let reading = client.clone();
        let max_frame = inner.config.max_frame_bytes;
        let codec = inner.handler.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            let mut challenge = None;
            loop {
                match read_frame_with(&mut reader, max_frame, |frame| codec.decode_request(frame)) {
                    Ok(Some(request)) => {
                        if !reading.receive(request, &mut challenge) {
                            break;
                        }
                    }
                    Ok(None) => {
                        reading.disconnect();
                        break;
                    }
                    Err(error) => {
                        reading.fail(&Value::Null, error);
                        reading.end();
                        break;
                    }
                }
            }
        });
        Ok(())
    }
    fn context(self: &Arc<Self>) -> ClientContext {
        ClientContext {
            client: self.clone(),
            events: EventSink {
                inner: self.inner.clone(),
            },
        }
    }
    fn disconnect(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.socket.shutdown(Shutdown::Both);
        // Wake an idle writer too; its sender otherwise lives in this same client.
        let _ = self.outgoing.try_send(Outbound::End);
        if let Some(inner) = self.inner.upgrade() {
            inner.clients.lock().unwrap().remove(&self.id);
            inner.handler.disconnected(self.id);
        }
    }
    fn end(&self) {
        if self.outgoing.try_send(Outbound::End).is_err() {
            self.disconnect();
        }
    }
    fn enqueue(&self, bytes: Vec<u8>) -> Result<(), RpcError> {
        self.enqueue_frame(bytes, None)
    }
    fn enqueue_frame(
        &self,
        bytes: Vec<u8>,
        release: Option<(String, u64)>,
    ) -> Result<(), RpcError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| RpcError::new("DAEMON_CLOSED", "Server is closed"))?;
        if self.closed.load(Ordering::Acquire) {
            return Err(RpcError::new("DAEMON_CLOSED", "Connection is closed"));
        }
        let size = bytes.len();
        if self.queued_bytes.fetch_add(size, Ordering::AcqRel)
            > 2 * inner.config.max_frame_bytes - size
        {
            self.queued_bytes.fetch_sub(size, Ordering::AcqRel);
            self.disconnect();
            return Err(RpcError::new("SLOW_CLIENT", "Client write budget exceeded"));
        }
        if self
            .outgoing
            .try_send(Outbound::Frame(bytes, release))
            .is_err()
        {
            self.queued_bytes.fetch_sub(size, Ordering::AcqRel);
            self.disconnect();
            return Err(RpcError::new("SLOW_CLIENT", "Client write queue is full"));
        }
        Ok(())
    }
    fn send(&self, value: &Value) -> Result<(), RpcError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| RpcError::new("DAEMON_CLOSED", "Server is closed"))?;
        // Envelopes and page fragments are ordinary Unicode. Only the echoed request
        // id has the handler's internal string representation. Do not reinterpret a
        // serialized page fragment, even when it contains a literal marker character.
        let mut fields = value
            .as_object()
            .cloned()
            .ok_or_else(|| RpcError::new("INVALID_RESPONSE", "Expected response envelope"))?;
        let id = fields.remove("id").unwrap_or(Value::Null);
        let mut text = serde_json::to_string(&fields)
            .map_err(|e| RpcError::new("INVALID_RESPONSE", e.to_string()))?;
        text.pop();
        if !fields.is_empty() {
            text.push(',');
        }
        text.push_str("\"id\":");
        text.push_str(&inner.handler.encode_request_id(&id)?);
        text.push_str("}\n");
        if text.len() > inner.config.max_frame_bytes {
            return Err(RpcError::new(
                "FRAME_TOO_LARGE",
                "Response exceeds the local daemon size limit",
            ));
        }
        self.send_encoded(&id, text.into_bytes())
    }
    fn valid_id(&self, id: &Value) -> bool {
        self.inner
            .upgrade()
            .is_some_and(|inner| valid_id_with(id, |s| inner.handler.string_len(s)))
    }
    fn send_encoded(&self, id: &Value, bytes: Vec<u8>) -> Result<(), RpcError> {
        let release = if self.valid_id(id) {
            let identity = request_identity(id);
            self.inflight
                .lock()
                .unwrap()
                .get(&identity)
                .copied()
                .map(|ticket| (identity, ticket))
        } else {
            None
        };
        self.enqueue_frame(bytes, release)
    }
    fn release_request(&self, identity: &str, ticket: u64) {
        let mut inflight = self.inflight.lock().unwrap();
        if inflight.get(identity) == Some(&ticket) {
            inflight.remove(identity);
        }
    }
    fn fail(&self, id: &Value, error: RpcError) {
        if let Err(failure) = self.send(&json!({"v":VERSION,"id":id,"error":error.value()})) {
            if failure.code == "FRAME_TOO_LARGE"
                && self.send(&json!({"v":VERSION,"id":id,"error":{"code":"FRAME_TOO_LARGE","message":"The command error exceeds the frame limit"}})).is_ok() {
                return;
            }
            self.disconnect();
        }
    }
    fn receive(self: &Arc<Self>, request: Value, challenge: &mut Option<(String, String)>) -> bool {
        let Some(inner) = self.inner.upgrade() else {
            return false;
        };
        let id = if self.valid_id(&request["id"]) {
            request["id"].clone()
        } else {
            Value::Null
        };
        if !self.authenticated.load(Ordering::Acquire) {
            let valid = safe_integer(&request["v"]) == Some(VERSION)
                && !id.is_null()
                && request["method"] == "daemon:authenticate"
                && request["args"]
                    .as_array()
                    .is_some_and(|args| args.len() == 1);
            let supplied = &request["args"][0];
            if valid && challenge.is_none() && valid_nonce(&supplied["clientNonce"]) {
                let client_nonce = supplied["clientNonce"].as_str().unwrap().to_string();
                let server_nonce = nonce();
                let proof = proof(
                    inner.token.as_ref().unwrap(),
                    "server",
                    &client_nonce,
                    &server_nonce,
                );
                *challenge = Some((client_nonce, server_nonce.clone()));
                let _ = self.send(&json!({"v":VERSION,"id":id,"result":{"serverNonce":server_nonce,"proof":proof}}));
                return true;
            }
            if valid
                && challenge.as_ref().is_some_and(|(client, server)| {
                    verify_proof(
                        inner.token.as_ref().unwrap(),
                        "client",
                        client,
                        server,
                        &supplied["proof"],
                    )
                })
            {
                self.authenticated.store(true, Ordering::Release);
                let _ = self.send(&json!({"v":VERSION,"id":id,"result":{"authenticated":true}}));
                return true;
            }
            self.fail(
                &id,
                RpcError::new("UNAUTHORIZED", "Local daemon authentication is required"),
            );
            self.end();
            return false;
        }
        if safe_integer(&request["v"]) != Some(VERSION) {
            self.fail(
                &id,
                RpcError::new("VERSION_MISMATCH", "Local protocol version 1 is required"),
            );
            return true;
        }
        if id.is_null()
            || !request["method"]
                .as_str()
                .is_some_and(|method| inner.handler.string_len(method) <= 128)
            || !request["args"].is_array()
        {
            self.fail(
                &id,
                RpcError::new("INVALID_REQUEST", "Expected id, method and an args array"),
            );
            return true;
        }
        let method = request["method"].as_str().unwrap();
        let stop = method == "daemon:stop";
        // Reserve acceptance under the same lock shutdown drains. Closing cannot race an uncounted accepted command.
        let mut active = inner.active.lock().unwrap();
        if inner.closing.load(Ordering::Acquire) && !stop {
            drop(active);
            self.fail(&id, RpcError::new("CLOSING", "The daemon is closing"));
            return true;
        }
        if *active >= 256 && !stop {
            drop(active);
            self.fail(
                &id,
                RpcError::new(
                    "TOO_MANY_REQUESTS",
                    "The isolated server's global request budget is full",
                ),
            );
            return true;
        }
        let mut inflight = self.inflight.lock().unwrap();
        let identity = request_identity(&id);
        if inflight.len() >= MAX_PENDING || inflight.contains_key(&identity) {
            drop(inflight);
            drop(active);
            self.fail(
                &id,
                RpcError::new(
                    "TOO_MANY_REQUESTS",
                    "Request ID is in use or too many requests are pending",
                ),
            );
            self.end();
            return false;
        }
        let ticket = self.next_request.fetch_add(1, Ordering::Relaxed) + 1;
        inflight.insert(identity.clone(), ticket);
        if !stop {
            *active += 1;
        }
        drop(inflight);
        drop(active);
        let client = self.clone();
        thread::spawn(move || {
            let _accepted = Accepted {
                client: client.clone(),
                inner: inner.clone(),
                identity,
                ticket,
                counted: !stop,
            };
            if stop {
                if let Err(error) = inner.shutdown(Some((&client, &id))) {
                    client.fail(&id, error);
                }
                return;
            }
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                client.dispatch(&inner, &request)
            }));
            let reply = outcome
                .unwrap_or_else(|_| Err(RpcError::new("COMMAND_FAILED", "Handler panicked")));
            match reply {
                Ok(result) => {
                    if let Err(error) = client.reply(&request, result) {
                        client.fail(&id, error);
                    }
                }
                Err(error) => client.fail(&id, error),
            }
        });
        true
    }
    fn dispatch(self: &Arc<Self>, inner: &Arc<Inner>, request: &Value) -> RpcResult {
        let method = request["method"].as_str().unwrap();
        let args = request["args"].as_array().unwrap();
        let context = self.context();
        let result = match method {
            "daemon:status" => {
                let mut methods = inner.handler.methods();
                methods.extend(
                    [
                        "daemon:status",
                        "daemon:snapshot",
                        "daemon:snapshot-page",
                        "daemon:result-page",
                        "daemon:focus",
                        "chat:set-open",
                        "daemon:stop",
                    ]
                    .map(str::to_string),
                );
                methods.sort();
                methods.dedup();
                json!({"pid":std::process::id(),"version":"rust-owner-wire-isolated-0.1.0","protocolVersion":VERSION,
                    "dataDir":inner.profile.path(),"socketPath":inner.profile.socket_path(),"closing":inner.closing.load(Ordering::Acquire),
                    "capabilities":["snapshot-pages-v1","result-pages-v1"],"methods":methods})
            }
            "daemon:snapshot" => {
                let _publication = inner.publication.lock().unwrap();
                let mut snapshot = inner.handler.snapshot(&context)?;
                let object = snapshot.as_object_mut().ok_or_else(|| {
                    RpcError::new("INVALID_RESPONSE", "Handler snapshot must be an object")
                })?;
                let seq = inner.sequence.load(Ordering::Acquire);
                object.insert("eventSeq".into(), json!(seq));
                if args.first().is_some_and(|arg| arg["paged"] == true) {
                    let manifest = self
                        .pages
                        .lock()
                        .unwrap()
                        .capture(inner.handler.encode_result(&snapshot)?)?;
                    json!({"snapshotId":manifest["pageId"],"pageCount":manifest["pageCount"],"eventSeq":seq})
                } else {
                    snapshot
                }
            }
            "daemon:snapshot-page" | "daemon:result-page" => self.pages.lock().unwrap().page(
                args.first().unwrap_or(&Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            )?,
            "daemon:focus" => {
                let focused = args
                    .first()
                    .and_then(|value| value["focused"].as_bool())
                    .ok_or_else(|| RpcError::new("COMMAND_FAILED", "Expected a focused boolean"))?;
                self.view.lock().unwrap().focused = focused;
                inner.handler.view_changed(&context)?;
                Value::Null
            }
            "chat:set-open" => {
                self.view.lock().unwrap().chat_id =
                    args.first().and_then(Value::as_str).map(str::to_string);
                inner.handler.view_changed(&context)?;
                Value::Null
            }
            "project:current" if context.view().project_path.is_some() => inner.handler.invoke(
                "project:snapshot",
                &[json!(context.view().project_path.unwrap())],
                &context,
            )?,
            _ if inner
                .handler
                .methods()
                .iter()
                .any(|registered| registered == method) =>
            {
                inner.handler.invoke(method, args, &context)?
            }
            _ => {
                return Err(RpcError::new(
                    "COMMAND_FAILED",
                    format!("Unknown command: {method}"),
                ))
            }
        };
        let mut view = self.view.lock().unwrap();
        if method == "link:open" {
            if let Some(id) = result["link"]["id"].as_str() {
                view.link_id = Some(id.into());
                view.project_path = None;
            }
        } else if matches!(
            method,
            "project:open"
                | "project:current"
                | "project:switch"
                | "canvas:open-project"
                | "onboarding:create"
                | "onboarding:clone"
                | "onboarding:init-git"
        ) || (method == "project:read" && args.get(1).is_some_and(Value::is_object))
        {
            if let Some(path) = result["path"].as_str() {
                view.project_path = Some(path.into());
                view.link_id = None;
            }
        }
        Ok(result)
    }
    fn reply(&self, request: &Value, result: Value) -> Result<(), RpcError> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| RpcError::new("DAEMON_CLOSED", "Server is closed"))?;
        let method = request["method"].as_str().unwrap();
        // A fragment is already serialized JSON text; interpreting it again can corrupt string boundaries.
        if matches!(method, "daemon:result-page" | "daemon:snapshot-page") {
            return self.send(&json!({"v":VERSION,"id":request["id"],"result":result}));
        }
        let text = inner.handler.encode_result(&result)?;
        if text.contains(['\n', '\r']) {
            return Err(RpcError::new(
                "INVALID_RESPONSE",
                "Encoded result must fit one JSON line",
            ));
        }
        if request["pages"] == true && text.len() > inner.config.max_frame_bytes / 4 {
            let pages = self.pages.lock().unwrap().capture(text)?;
            self.send(&json!({"v":VERSION,"id":request["id"],"pages":pages}))
        } else {
            let frame = format!(
                "{{\"v\":{VERSION},\"id\":{},\"result\":{text}}}\n",
                inner.handler.encode_request_id(&request["id"])?
            )
            .into_bytes();
            if frame.len() > inner.config.max_frame_bytes {
                return Err(RpcError::new(
                    "FRAME_TOO_LARGE",
                    "Response exceeds the local daemon size limit",
                ));
            }
            self.send_encoded(&request["id"], frame)
        }
    }
}
struct Accepted {
    client: Arc<Client>,
    inner: Arc<Inner>,
    identity: String,
    ticket: u64,
    counted: bool,
}
impl Drop for Accepted {
    fn drop(&mut self) {
        self.client.release_request(&self.identity, self.ticket);
        if self.counted {
            *self.inner.active.lock().unwrap() -= 1;
            self.inner.drained.notify_all();
        }
    }
}
fn request_identity(id: &Value) -> String {
    id.as_str().map_or_else(
        || format!("n:{}", safe_integer(id).unwrap()),
        |id| format!("s:{id}"),
    )
}
fn nonce() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn valid_nonce(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn proof(token: &str, role: &str, client: &str, server: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).unwrap();
    mac.update(format!("{role}:{client}:{server}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
fn verify_proof(token: &str, role: &str, client: &str, server: &str, supplied: &Value) -> bool {
    if !valid_nonce(supplied) {
        return false;
    }
    let Some(supplied) = supplied.as_str().and_then(|value| hex::decode(value).ok()) else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).unwrap();
    mac.update(format!("{role}:{client}:{server}").as_bytes());
    mac.verify_slice(&supplied).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Empty;
    impl Handler for Empty {
        fn methods(&self) -> Vec<String> {
            vec![]
        }
        fn invoke(&self, _: &str, _: &[Value], _: &ClientContext) -> RpcResult {
            Err(RpcError::new("NOT_IMPLEMENTED", "No fixture services"))
        }
        fn snapshot(&self, _: &ClientContext) -> RpcResult {
            Ok(json!({}))
        }
    }
    #[test]
    fn bind_refuses_to_unlink_an_existing_endpoint() {
        let profile = IsolatedProfile::create().unwrap();
        let socket = profile.socket_path().to_path_buf();
        fs::write(&socket, "sentinel").unwrap();
        assert!(Server::bind(profile, Arc::new(Empty), Config::default()).is_err());
        assert_eq!(fs::read_to_string(&socket).unwrap(), "sentinel");
        fs::remove_file(socket).unwrap();
    }
    #[test]
    fn cleanup_never_unlinks_a_replaced_socket() {
        let server = Server::bind(
            IsolatedProfile::create().unwrap(),
            Arc::new(Empty),
            Config::default(),
        )
        .unwrap();
        let socket = server.socket_path().to_path_buf();
        fs::remove_file(&socket).unwrap();
        fs::write(&socket, "replacement").unwrap();
        server.shutdown().unwrap();
        drop(server);
        assert_eq!(fs::read_to_string(&socket).unwrap(), "replacement");
        fs::remove_file(socket).unwrap();
    }
    #[test]
    fn failed_shutdown_preserves_listener_for_explicit_retry() {
        struct Recover {
            fail: AtomicBool,
        }
        impl Handler for Recover {
            fn methods(&self) -> Vec<String> {
                vec![]
            }
            fn invoke(&self, _: &str, _: &[Value], _: &ClientContext) -> RpcResult {
                Ok(Value::Null)
            }
            fn snapshot(&self, _: &ClientContext) -> RpcResult {
                Ok(json!({}))
            }
            fn shutdown(&self) -> RpcResult {
                if self.fail.swap(false, Ordering::AcqRel) {
                    Err(RpcError::new("SAVE_FAILED", "Fixture save failed"))
                } else {
                    Ok(Value::Null)
                }
            }
        }
        let server = Server::bind(
            IsolatedProfile::create().unwrap(),
            Arc::new(Recover {
                fail: AtomicBool::new(true),
            }),
            Config::default(),
        )
        .unwrap();
        assert_eq!(server.shutdown().unwrap_err().code, "SAVE_FAILED");
        assert!(!server.is_stopped());
        assert!(UnixStream::connect(server.socket_path()).is_ok());
        server.shutdown().unwrap();
        assert!(server.is_stopped());
    }
    #[test]
    fn stalled_client_is_disconnected_at_the_write_budget() {
        let server = Server::bind(
            IsolatedProfile::create().unwrap(),
            Arc::new(Empty),
            Config {
                max_frame_bytes: 1024,
                ..Config::default()
            },
        )
        .unwrap();
        let _unread = UnixStream::connect(server.socket_path()).unwrap();
        let until = Instant::now() + Duration::from_secs(2);
        let client = loop {
            if let Some(client) = server
                .inner
                .clients
                .lock()
                .unwrap()
                .values()
                .next()
                .cloned()
            {
                break client;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(2));
        };
        for _ in 0..10000 {
            server
                .events()
                .emit("fixture:backpressure", json!({"text":"x".repeat(700)}))
                .unwrap();
            if client.closed.load(Ordering::Acquire) {
                break;
            }
        }
        assert!(
            client.closed.load(Ordering::Acquire),
            "a client that never reads must not accumulate unbounded output"
        );
        assert!(client.queued_bytes.load(Ordering::Acquire) <= 2048);
        server.shutdown().unwrap();
    }
}
