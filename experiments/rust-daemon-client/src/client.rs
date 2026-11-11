use crate::{
    notify::{Notifications, Queue},
    protocol,
    protocol::{safe_integer, Engine},
    reply, ChatPage, ChatPageOptions, ChatRuns, ClientOptions, Error, FixtureEndpoint, Hello,
    Result, RuntimeSnapshot, SnapshotReceipt, StateRead,
};
use serde_json::{json, Map, Value};
use std::{
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

struct Handle {
    sender: mpsc::SyncSender<Job>,
    pending: Arc<AtomicUsize>,
    maximum: usize,
    stop: Arc<AtomicBool>,
    socket: Arc<Mutex<Option<UnixStream>>>,
    project: String,
    timeout: Duration,
}
impl Handle {
    fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(socket) = self
            .socket
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Cloneable async read facade. Its private I/O thread needs no runtime on the caller thread.
#[derive(Clone)]
pub struct Client {
    handle: Arc<Handle>,
}

// Always seal notices and the socket, including unwinding after a caller waker panics.
// Normal errors close first; Queue::close preserves that first cause.
struct WorkerExit {
    notices: Arc<Queue>,
    stop: Arc<AtomicBool>,
    socket: Arc<Mutex<Option<UnixStream>>>,
}
impl Drop for WorkerExit {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(socket) = self.socket.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        self.notices.close(Error::Disconnected);
    }
}

struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Job {
    // Release admission before a dropped reply sender wakes its waiter too.
    _permit: Permit,
    kind: Kind,
    expires: Instant,
}
enum Kind {
    Read {
        method: &'static str,
        args: Value,
        reply: reply::Sender<Value>,
    },
    Snapshot(reply::Sender<RuntimeSnapshot>),
    Accept(SnapshotReceipt, reply::Sender<()>),
}

impl Client {
    pub async fn connect(
        endpoint: FixtureEndpoint,
        options: ClientOptions,
    ) -> Result<(Self, Hello, Notifications)> {
        options.validate()?;
        let connection = NEXT_CONNECTION
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .map_err(|_| protocol("connection identities exhausted"))?;
        let (sender, receiver) = mpsc::sync_channel(options.max_pending);
        let stop = Arc::new(AtomicBool::new(false));
        let socket = Arc::new(Mutex::new(None));
        let notices = Queue::new(&options);
        let client = Self {
            handle: Arc::new(Handle {
                sender,
                pending: Arc::new(AtomicUsize::new(0)),
                maximum: options.max_pending,
                stop: stop.clone(),
                socket: socket.clone(),
                project: endpoint.authority.project.clone(),
                timeout: options.request_timeout,
            }),
        };
        let (ready, ready_wait) = reply::channel();
        thread::Builder::new()
            .name("milagre-daemon-client".into())
            .spawn(move || {
                let _exit = WorkerExit {
                    notices: notices.clone(),
                    stop: stop.clone(),
                    socket: socket.clone(),
                };
                let result = (endpoint.authority.connect)().and_then(|stream| {
                    *socket.lock().unwrap_or_else(|p| p.into_inner()) =
                        Some(stream.try_clone().map_err(|_| Error::Disconnected)?);
                    Engine::new(
                        stream,
                        endpoint.authority,
                        options,
                        notices.clone(),
                        connection,
                    )
                });
                let mut engine = match result {
                    Ok(engine) => engine,
                    Err(error) => {
                        notices.close(error.clone());
                        ready.send(Err(error));
                        return;
                    }
                };
                match engine.handshake() {
                    Ok(hello) => ready.send(Ok((
                        client,
                        hello,
                        Notifications {
                            queue: notices.clone(),
                        },
                    ))),
                    Err(error) => {
                        notices.close(error.clone());
                        ready.send(Err(error));
                        return;
                    }
                }
                let reason = run(&mut engine, &receiver, &stop);
                stop.store(true, Ordering::Release);
                notices.close(reason.clone());
                while let Ok(job) = receiver.try_recv() {
                    let Job {
                        kind,
                        _permit: permit,
                        ..
                    } = job;
                    drop(permit);
                    reject(kind, reason.clone());
                }
                // WorkerExit closes the socket without a tail-expression mutex guard.
                // Engine retains exact authority until the socket worker has stopped.
            })
            .map_err(|_| protocol("could not start the client I/O thread"))?;
        ready_wait.await
    }

    fn submit(&self, kind: Kind) -> Result<()> {
        if self.handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        self.handle
            .pending
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < self.handle.maximum).then_some(n + 1)
            })
            .map_err(|_| Error::Busy)?;
        let job = Job {
            kind,
            expires: Instant::now() + self.handle.timeout,
            _permit: Permit(self.handle.pending.clone()),
        };
        self.handle
            .sender
            .try_send(job)
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::Disconnected,
            })
    }
    async fn read(&self, method: &'static str, args: Value) -> Result<Value> {
        let (reply, wait) = reply::channel();
        self.submit(Kind::Read {
            method,
            args,
            reply,
        })?;
        wait.await
    }
    fn scope(&self, path: &str) -> Result<()> {
        if path == self.handle.project {
            Ok(())
        } else {
            Err(Error::InvalidScope)
        }
    }
    fn project_result(&self, value: Value) -> Result<Value> {
        if value["path"].as_str() != Some(&self.handle.project) {
            return Err(protocol("owner returned a foreign Project"));
        }
        Ok(value)
    }
    pub async fn project_current(&self) -> Result<Value> {
        self.project_result(self.read("project:current", json!([])).await?)
    }
    pub async fn project_read(&self, path: &str, with_state: bool) -> Result<Value> {
        self.scope(path)?;
        self.project_result(
            self.read("project:read", json!([path, {"state":with_state}]))
                .await?,
        )
    }
    pub async fn state_read(&self, scope: &str) -> Result<StateRead> {
        self.scope(scope)?;
        let body = self.read("state:read", json!([scope])).await?;
        if !body["state"].is_object() || !body["version"].is_u64() || !body["epoch"].is_string() {
            return Err(protocol("invalid state read envelope"));
        }
        Ok(StateRead {
            state: body["state"].clone(),
            version: body["version"].clone(),
            epoch: body["epoch"].clone(),
        })
    }
    pub async fn chat_runs(&self) -> Result<ChatRuns> {
        let body = self.read("chat:runs", json!([])).await?;
        if !body["runs"].is_object() {
            return Err(protocol("invalid runs envelope"));
        }
        Ok(ChatRuns {
            runs: body["runs"].clone(),
            seq: safe_integer(&body["seq"], "run sequence")?,
        })
    }
    pub async fn chat_messages(
        &self,
        scope: &str,
        id: u64,
        options: ChatPageOptions,
    ) -> Result<ChatPage> {
        self.scope(scope)?;
        safe_integer(&json!(id), "chat id")?;
        let mut page = Map::new();
        for (name, value) in [
            ("before", options.before),
            ("turns", options.turns),
            ("limit", options.limit),
        ] {
            if let Some(value) = value {
                safe_integer(&json!(value), name)?;
                page.insert(name.into(), json!(value));
            }
        }
        self.read("chat:messages", json!([scope, id, page])).await
    }
    /// Explicitly opens this generated Project. The owner may recover and persist state.
    pub async fn open_view(&self, path: &str) -> Result<Value> {
        self.scope(path)?;
        self.project_result(self.read("project:open", json!([path])).await?)
    }
    pub async fn runtime_snapshot(&self) -> Result<RuntimeSnapshot> {
        let (reply, wait) = reply::channel();
        self.submit(Kind::Snapshot(reply))?;
        wait.await
    }
    /// Call only after applying the returned snapshot. This acknowledges a local barrier, not a wire command.
    pub async fn accept_snapshot(&self, snapshot: &RuntimeSnapshot) -> Result<()> {
        if snapshot.event_seq != snapshot.receipt.watermark
            || snapshot.body["eventSeq"].as_u64() != Some(snapshot.receipt.watermark)
        {
            return Err(Error::StaleSnapshot);
        }
        let (reply, wait) = reply::channel();
        self.submit(Kind::Accept(snapshot.receipt.clone(), reply))?;
        wait.await
    }
    /// Seals this connection only. It never stops, restarts or replaces the fixture owner.
    pub fn disconnect(&self) {
        self.handle.stop();
    }
}

fn terminal(error: &Error) -> bool {
    matches!(
        error,
        Error::Disconnected | Error::Protocol { .. } | Error::StateTooLarge { .. }
    )
}
fn reject(kind: Kind, error: Error) {
    match kind {
        Kind::Read { reply, .. } => reply.send(Err(error)),
        Kind::Snapshot(reply) => reply.send(Err(error)),
        Kind::Accept(_, reply) => reply.send(Err(error)),
    }
}
fn run(engine: &mut Engine, receiver: &mpsc::Receiver<Job>, stop: &AtomicBool) -> Error {
    loop {
        if stop.load(Ordering::Acquire) {
            return Error::Disconnected;
        }
        // One batch, then one caller operation, so even a sustained event stream
        // cannot starve a queued explicit snapshot or its acknowledgment.
        if let Err(error) = engine.hydrate() {
            return error;
        }
        match receiver.try_recv() {
            Ok(job) => {
                let Job {
                    kind,
                    expires,
                    _permit: permit,
                } = job;
                if Instant::now() >= expires {
                    drop(permit);
                    reject(kind, Error::TimedOut { submitted: false });
                    continue;
                }
                let failure = match kind {
                    Kind::Read {
                        method,
                        args,
                        reply,
                    } => {
                        let result = engine.request(method, args, expires);
                        let failure = result
                            .as_ref()
                            .err()
                            .filter(|error| terminal(error))
                            .cloned();
                        drop(permit);
                        reply.send(result);
                        failure
                    }
                    Kind::Snapshot(reply) => {
                        let result = engine.snapshot(expires);
                        let failure = result
                            .as_ref()
                            .err()
                            .filter(|error| terminal(error))
                            .cloned();
                        drop(permit);
                        reply.send(result);
                        failure
                    }
                    Kind::Accept(receipt, reply) => {
                        let result = engine.accept(receipt);
                        drop(permit);
                        reply.send(result);
                        None
                    }
                };
                if let Some(error) = failure {
                    return error;
                }
            }
            Err(mpsc::TryRecvError::Disconnected) => return Error::Disconnected,
            Err(mpsc::TryRecvError::Empty) => {
                if let Err(error) = engine.idle() {
                    return error;
                }
            }
        }
    }
}
