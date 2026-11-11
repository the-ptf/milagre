//! Exclusive synthetic coordinator. Public reports never release service ownership.
use crate::{native_core as native, service_owner as service};
use milagre_owner_store::chat_host::Notice;
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::{mpsc, Arc, Mutex},
    task::{Context, Poll, Wake},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    Service(service::Error),
    Native(native::Error),
    Busy,
    Bounds,
    Closed,
    Worker,
    CleanupUncertain,
}
type Result<T> = std::result::Result<T, Error>;
impl From<service::Error> for Error {
    fn from(v: service::Error) -> Self {
        Self::Service(v)
    }
}
impl From<service::DeliveryError> for Error {
    fn from(v: service::DeliveryError) -> Self {
        match v {
            service::DeliveryError::Rejected(e) | service::DeliveryError::Retained(e) => Self::Service(e),
        }
    }
}
impl From<native::Error> for Error {
    fn from(v: native::Error) -> Self {
        Self::Native(v)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Terminal {
    Completed,
    Cancelled,
    Failed,
}
#[derive(Clone, Debug, Default)]
pub(super) struct Snapshot {
    pub(super) evidence: Option<service::Evidence>,
    pub(super) receipt: Option<native::Execution>,
    pub(super) report: Option<native::Report>,
    pub(super) disposal: Option<native::Disposal>,
    pub(super) terminal: Option<Terminal>,
    pub(super) decision: Option<Terminal>,
    pub(super) error: Option<Error>,
    pub(super) close_error: Option<service::Error>,
    pub(super) closing: bool,
    pub(super) closed: bool,
    pub(super) project_closed: bool,
    pub(super) resources_removed: bool,
}
#[derive(Default)]
struct Route {
    cancelled: bool,
    decision: Option<Terminal>,
    epoch: u64,
    native: Option<native::CancelHandle>,
}
impl Route {
    fn cancel(&mut self) -> bool {
        let accepted = self.decision.is_none();
        if accepted {
            self.cancelled = true;
            self.epoch = self.epoch.saturating_add(1);
        }
        if let Some(native) = &self.native {
            native.cancel();
        }
        accepted
    }
}
#[derive(Clone)]
pub(super) struct Cancel(Arc<Mutex<Route>>);
impl Cancel {
    pub(super) fn cancel(&self) -> bool {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).cancel()
    }
}
#[derive(Clone)]
pub(super) struct Watch(Arc<Mutex<Snapshot>>);
impl Watch {
    pub(super) fn snapshot(&self) -> Snapshot {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AdmissionPoint {
    BeforeActivation,
    BeforeStamp,
}
enum Command {
    Send(String, Option<native::TestPoint>),
    Close(service::Close, bool),
    Mutate(service::Mutation),
    Notices,
    State,
    Locks,
    Panic,
    BlockRelease,
    RecordRetention,
    PauseTerminal,
    PauseAdmission(AdmissionPoint),
    PanicActivation,
}
enum Reply {
    Unit,
    Pause(native::TestPause),
    Notices(Vec<Notice>),
    State(serde_json::Value),
    Locks(service::Locks),
}
struct Envelope {
    command: Command,
    reply: mpsc::SyncSender<Result<Reply>>,
}
pub(super) struct Fixture {
    sender: Option<mpsc::SyncSender<Envelope>>,
    route: Cancel,
    watch: Watch,
}
impl Fixture {
    pub(super) fn create(case: native::FixtureCase) -> Result<Self> {
        Self::create_fault(case, native::TestFault::None)
    }
    pub(super) fn create_fault(case: native::FixtureCase, fault: native::TestFault) -> Result<Self> {
        let route = Cancel(Arc::new(Mutex::new(Route::default())));
        let watch = Watch(Arc::new(Mutex::new(Snapshot::default())));
        let (sender, receiver) = mpsc::sync_channel::<Envelope>(1);
        let (started, startup) = mpsc::sync_channel(1);
        let actor_route = route.clone();
        let actor_watch = watch.clone();
        thread::Builder::new()
            .name("synthetic-acp-composed-owner".into())
            .spawn(move || {
                let services = match service::ServiceOwner::for_composition(service::Scenario::Ready) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = started.send(Err(Error::Service(error)));
                        return;
                    }
                };
                let mut actor = Actor {
                    services: Some(services),
                    flight: None,
                    pending: None,
                    case,
                    fault,
                    close_target: service::Close::All,
                    terminal_pause: None,
                    admission_pause: None,
                    panic_activation: false,
                    route: actor_route,
                    watch: actor_watch,
                    snapshot: Snapshot::default(),
                    sent: false,
                    closing: false,
                    close_attempted: false,
                    disconnected: false,
                    seen_cancel: 0,
                    started_at: Instant::now(),
                };
                let _ = started.send(Ok(()));
                let waker = Arc::new(ThreadWake(thread::current())).into();
                let mut context = Context::from_waker(&waker);
                loop {
                    let envelope = if actor.disconnected {
                        None
                    } else {
                        match receiver.recv_timeout(Duration::from_millis(20)) {
                            Ok(envelope) => Some(envelope),
                            Err(mpsc::RecvTimeoutError::Timeout) => None,
                            Err(mpsc::RecvTimeoutError::Disconnected) => {
                                actor.disconnected = true;
                                actor.request_close(service::Close::All);
                                None
                            }
                        }
                    };
                    if let Some(envelope) = envelope {
                        let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| actor.command(envelope.command)));
                        let response = match response {
                            Ok(value) => value,
                            Err(_) => {
                                actor.fail(Error::Worker);
                                actor.request_close(service::Close::All);
                                Err(Error::Worker)
                            }
                        };
                        let _ = envelope.reply.send(response);
                    }
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| actor.advance(&mut context))).is_err() {
                        actor.fail(Error::Worker);
                        actor.request_close(service::Close::All);
                    }
                    actor.publish();
                    if actor.snapshot.closed
                        || actor.disconnected
                            && (actor.flight.as_ref().is_some_and(|f| f.join_failed)
                                || actor.close_attempted && actor.snapshot.error.is_some())
                    {
                        break;
                    }
                    if actor.disconnected {
                        thread::park_timeout(Duration::from_millis(20));
                    }
                }
            })
            .map_err(|_| Error::Worker)?;
        startup.recv().map_err(|_| Error::Worker)??;
        Ok(Self { sender: Some(sender), route, watch })
    }
    fn request(&mut self, command: Command) -> Result<Reply> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender.as_ref().ok_or(Error::Closed)?.send(Envelope { command, reply }).map_err(|_| Error::Closed)?;
        receiver.recv().map_err(|_| Error::Worker)?
    }
    pub(super) fn send(&mut self, text: &str) -> Result<()> {
        if text.len() > 64 * 1024 {
            return Err(Error::Bounds);
        }
        self.request(Command::Send(text.into(), None)).map(|_| ())
    }
    pub(super) fn close(&mut self, force: bool) -> Result<()> {
        self.request(Command::Close(service::Close::All, force)).map(|_| ())
    }
    pub(super) fn close_project(&mut self, force: bool) -> Result<()> {
        self.request(Command::Close(service::Close::Project, force)).map(|_| ())
    }
    pub(super) fn send_paused(&mut self, text: &str, point: native::TestPoint) -> Result<native::TestPause> {
        if text.len() > 64 * 1024 {
            return Err(Error::Bounds);
        }
        match self.request(Command::Send(text.into(), Some(point)))? {
            Reply::Pause(p) => Ok(p),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn mutate(&mut self, mutation: service::Mutation) -> Result<()> {
        self.request(Command::Mutate(mutation)).map(|_| ())
    }
    pub(super) fn panic_activation(&mut self) -> Result<()> {
        self.request(Command::PanicActivation).map(|_| ())
    }
    pub(super) fn pause_admission(&mut self, point: AdmissionPoint) -> Result<native::TestPause> {
        match self.request(Command::PauseAdmission(point))? {
            Reply::Pause(p) => Ok(p),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn pause_terminal(&mut self) -> Result<native::TestPause> {
        match self.request(Command::PauseTerminal)? {
            Reply::Pause(p) => Ok(p),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn block_release(&mut self) -> Result<()> {
        self.request(Command::BlockRelease).map(|_| ())
    }
    pub(super) fn record_retention(&mut self) -> Result<()> {
        self.request(Command::RecordRetention).map(|_| ())
    }
    pub(super) fn panic_actor(&mut self) -> Result<()> {
        self.request(Command::Panic).map(|_| ())
    }
    pub(super) fn notices(&mut self) -> Result<Vec<Notice>> {
        match self.request(Command::Notices)? {
            Reply::Notices(v) => Ok(v),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn state(&mut self) -> Result<serde_json::Value> {
        match self.request(Command::State)? {
            Reply::State(v) => Ok(v),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn locks(&mut self) -> Result<service::Locks> {
        match self.request(Command::Locks)? {
            Reply::Locks(v) => Ok(v),
            _ => Err(Error::Worker),
        }
    }
    pub(super) fn cancel_handle(&self) -> Cancel {
        self.route.clone()
    }
    pub(super) fn watch(&self) -> Watch {
        self.watch.clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.route.cancel();
        self.sender.take();
    }
}
struct ThreadWake(thread::Thread);
impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}
struct Flight {
    id: service::AdmissionId,
    control: native::Control,
    observer: native::Observer,
    reservation: Option<native::Reservation>,
    running: Option<native::Running>,
    expected_digest: String,
    expected_cwd: (u64, u64),
    stamped: bool,
    started: bool,
    terminal: bool,
    exited: bool,
    disposal: Option<native::Disposal>,
    join_failed: bool,
}
struct Actor {
    services: Option<service::ServiceOwner>,
    flight: Option<Flight>,
    pending: Option<service::AdmissionId>,
    case: native::FixtureCase,
    fault: native::TestFault,
    close_target: service::Close,
    terminal_pause: Option<native::TestWait>,
    admission_pause: Option<(AdmissionPoint, native::TestWait)>,
    panic_activation: bool,
    route: Cancel,
    watch: Watch,
    snapshot: Snapshot,
    sent: bool,
    closing: bool,
    close_attempted: bool,
    disconnected: bool,
    seen_cancel: u64,
    started_at: Instant,
}
impl Actor {
    fn services(&mut self) -> Result<&mut service::ServiceOwner> {
        self.services.as_mut().ok_or(Error::Closed)
    }
    fn now(&self) -> i64 {
        self.started_at.elapsed().as_millis().min(i64::MAX as u128) as i64
    }
    fn fail(&mut self, error: Error) {
        self.snapshot.error.get_or_insert(error);
    }
    fn publish(&self) {
        *self.watch.0.lock().unwrap_or_else(|p| p.into_inner()) = self.snapshot.clone();
    }
    fn request_close(&mut self, target: service::Close) {
        if !self.closing || matches!(target, service::Close::All) {
            self.close_target = target;
        }
        self.closing = true;
        self.close_attempted = false;
        self.snapshot.closing = true;
        self.route.cancel();
    }
    fn begin(&mut self, text: String, point: Option<native::TestPoint>) -> Result<Option<native::TestPause>> {
        if self.sent || self.closing {
            return Err(Error::Busy);
        }
        if self.route.0.lock().unwrap_or_else(|p| p.into_inner()).cancelled {
            return Err(Error::Closed);
        }
        self.sent = true;
        let deadline = Instant::now() + Duration::from_secs(5);
        let id = self.services()?.send_until(text, deadline)?;
        self.pending = Some(id.clone());
        let start = self.services()?.native_start(&id)?;
        self.snapshot.evidence = Some(start.evidence.clone());
        let expected_digest = format!("{:x}", Sha256::digest(start.prompt.as_bytes()));
        let [project, home, tmp] = start.directories;
        let workspace = native::RegisteredWorkspace::from_descriptors(project, home, tmp)?;
        let (control, observer, reservation) = native::reserve(self.case, &start.prompt, Some(workspace), deadline)?;
        let pause = point.map(|point| control.test_pause(point));
        {
            let mut route = self.route.0.lock().unwrap_or_else(|p| p.into_inner());
            route.native = Some(observer.cancel_handle());
            if route.cancelled {
                control.invalidate();
            }
        }
        self.flight = Some(Flight {
            id,
            control,
            observer,
            reservation: Some(reservation),
            running: None,
            expected_digest,
            expected_cwd: start.evidence.cwd,
            stamped: false,
            started: false,
            terminal: false,
            exited: false,
            disposal: None,
            join_failed: false,
        });
        assert!(!self.panic_activation, "fixed actor panic with retained unactivated reservation");
        self.admission_barrier(AdmissionPoint::BeforeActivation);
        let flight = self.flight.as_mut().unwrap();
        flight.running = Some(flight.reservation.take().unwrap().activate_test(self.fault));
        Ok(pause)
    }
    fn admission_barrier(&mut self, point: AdmissionPoint) {
        if self.admission_pause.as_ref().is_some_and(|(p, _)| *p == point) {
            self.admission_pause.take().unwrap().1.wait();
        }
    }
    fn command(&mut self, command: Command) -> Result<Reply> {
        match command {
            Command::Send(text, point) => {
                let old = self.sent;
                let result = self.begin(text, point);
                if let Err(error) = &result {
                    if !old {
                        self.fail(*error);
                        self.route.cancel();
                        if self.flight.is_none() {
                            if let Some(id) = self.pending.clone() {
                                let now = self.now();
                                self.services()?.native_signals(&id, vec![service::Signal::StartFailed], now)?;
                            }
                            self.snapshot.terminal = Some(Terminal::Failed);
                        }
                    }
                }
                result.map(|pause| pause.map(Reply::Pause).unwrap_or(Reply::Unit))
            }
            Command::Close(target, force) => {
                if !force && self.flight.as_ref().is_some_and(|f| f.disposal.is_none() || !f.terminal) {
                    return Err(Error::Busy);
                }
                self.request_close(target);
                Ok(Reply::Unit)
            }
            Command::Mutate(mutation) => {
                self.route.cancel(); // Same core gate is revoked before exclusive service mutation.
                if matches!(mutation, service::Mutation::ReopenAccount) && self.flight.as_ref().is_some_and(|f| f.disposal.is_none()) {
                    // Reopen consumes the current account writer. Hold it until the
                    // same exact native cleanup authority required by close exists.
                    return Err(Error::Busy);
                }
                self.services()?.mutate(mutation)?;
                Ok(Reply::Unit)
            }
            Command::Notices => Ok(Reply::Notices(self.services()?.native_notices()?)),
            Command::State => Ok(Reply::State(self.services()?.native_state()?)),
            Command::Locks => Ok(Reply::Locks(self.services()?.native_locks()?)),
            Command::Panic => panic!("fixed composed actor panic"),
            Command::PanicActivation => {
                if self.sent {
                    return Err(Error::Busy);
                }
                self.panic_activation = true;
                Ok(Reply::Unit)
            }
            Command::PauseAdmission(point) => {
                if self.sent {
                    return Err(Error::Busy);
                }
                let (pause, wait) = native::TestPause::pair();
                self.admission_pause = Some((point, wait));
                Ok(Reply::Pause(pause))
            }
            Command::PauseTerminal => {
                if self.sent {
                    return Err(Error::Busy);
                }
                let (pause, wait) = native::TestPause::pair();
                self.terminal_pause = Some(wait);
                Ok(Reply::Pause(pause))
            }
            Command::BlockRelease => {
                self.services()?.block_release_for_test()?;
                Ok(Reply::Unit)
            }
            Command::RecordRetention => {
                self.services()?.record_retained_roots();
                Ok(Reply::Unit)
            }
        }
    }
    fn advance(&mut self, context: &mut Context<'_>) {
        let cancelled = {
            let route = self.route.0.lock().unwrap_or_else(|p| p.into_inner());
            if route.epoch != self.seen_cancel {
                Some(route.epoch)
            } else {
                None
            }
        };
        if let Some(epoch) = cancelled {
            self.seen_cancel = epoch;
            if let Some(services) = self.services.as_mut() {
                if let Err(error) = services.invalidate_native_admission() {
                    self.fail(error.into());
                }
            }
        }
        if let Some(mut flight) = self.flight.take() {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.drive_flight(&mut flight, context)));
            self.flight = Some(flight); // Restore ownership before handling any operation error/panic.
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    self.fail(error);
                    self.route.cancel();
                }
                Err(_) => {
                    self.fail(Error::Worker);
                    self.request_close(service::Close::All);
                }
            }
        }
        if self.closing && !self.close_attempted && self.flight.as_ref().is_none_or(|f| f.disposal.is_some()) {
            self.close_attempted = true;
            if let Some(services) = self.services.as_mut() {
                if let Err(error) = services.close(self.close_target, true) {
                    self.snapshot.close_error = Some(error);
                    self.fail(error.into());
                    return;
                }
            }
            self.snapshot.project_closed = true;
            if matches!(self.close_target, service::Close::Project) {
                return;
            }
            if let Some(services) = self.services.take() {
                match services.finish() {
                    Ok(report) => {
                        self.snapshot.closed = report.host_closed && report.accounts_closed;
                        self.snapshot.resources_removed = report.resources_removed;
                    }
                    Err(error) => {
                        self.fail(error.into()); /* finish retains uncertain owners itself. */
                    }
                }
            }
        }
    }
    fn drive_flight(&mut self, flight: &mut Flight, context: &mut Context<'_>) -> Result<()> {
        // A caught actor panic may leave the installed reservation unactivated.
        // Its native owner must dispose the inputs and mint NoChild, never the actor.
        if flight.running.is_none() {
            if let Some(reservation) = flight.reservation.take() {
                let disposition = flight.control.accept_cleanup(reservation.abandon()).map_err(|_| Error::CleanupUncertain)?;
                flight.disposal = Some(disposition);
                self.snapshot.disposal = Some(disposition);
            }
        }
        let update = {
            let mut next = std::pin::pin!(flight.observer.next());
            match next.as_mut().poll(context) {
                Poll::Ready(value) => value,
                Poll::Pending => None,
            }
        };
        if let Some(update) = update {
            if update.prepared && !flight.stamped && !update.finished && update.report.is_none() {
                let capture = flight.control.capture()?;
                self.services()?.validate(&flight.id)?; // I/O outside both route/native locks.
                self.admission_barrier(AdmissionPoint::BeforeStamp);
                let route = self.route.0.lock().unwrap_or_else(|p| p.into_inner());
                if route.cancelled {
                    return Err(Error::Native(native::Error::Revoked));
                }
                flight.control.stamp(capture)?;
                flight.stamped = true;
            }
            if let Some(receipt) = update.consumed {
                if receipt.text_sha256 != flight.expected_digest || (receipt.cwd_device, receipt.cwd_inode) != flight.expected_cwd {
                    return Err(Error::Native(native::Error::Protocol));
                }
                self.snapshot.receipt = Some(receipt.clone());
                if !flight.started {
                    let now = self.now();
                    let delivery = self.services()?.native_started(&flight.id, format!("fixture-{}", receipt.nonce), now);
                    mark_delivery(delivery, &mut flight.started)?;
                }
            }
            if let Some(report) = update.report {
                if let Err(error) = report.result {
                    self.fail(Error::Native(error));
                }
                let uncertain = report.result == Err(native::Error::CleanupUncertain);
                self.snapshot.report = Some(report);
                if uncertain && !flight.terminal {
                    self.terminal(flight, Terminal::Failed)?;
                }
            }
        }
        if !flight.join_failed && flight.disposal.is_none() {
            if let Some(running) = flight.running.as_mut() {
                match running.try_join() {
                    Ok(Some(ack)) => {
                        let disposition = flight.control.accept_cleanup(ack).map_err(|_| Error::CleanupUncertain)?;
                        flight.disposal = Some(disposition);
                        self.snapshot.disposal = Some(disposition);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        flight.join_failed = true;
                        self.fail(error.into());
                        if !flight.terminal {
                            self.terminal(flight, Terminal::Failed)?;
                        }
                    }
                }
            }
        }
        if let Some(disposition) = flight.disposal {
            if !flight.terminal {
                let normal = matches!(disposition, native::Disposal::Reaped { natural_zero: true, exit_code: Some(0), .. });
                let terminal = if normal && self.snapshot.error.is_none() {
                    Terminal::Completed
                } else if self.snapshot.error == Some(Error::Native(native::Error::Revoked))
                    && self.snapshot.report.as_ref().is_some_and(|r| r.result == Err(native::Error::Revoked))
                {
                    Terminal::Cancelled
                } else {
                    Terminal::Failed
                };
                self.terminal(flight, terminal)?;
            }
            if !flight.exited && flight.started && matches!(disposition, native::Disposal::Reaped { .. }) {
                let now = self.now();
                let delivery = self.services()?.native_signals(&flight.id, vec![service::Signal::Exited], now);
                mark_delivery(delivery, &mut flight.exited)?;
            }
        }
        Ok(())
    }
    fn terminal(&mut self, flight: &mut Flight, terminal: Terminal) -> Result<()> {
        let terminal = {
            let mut route = self.route.0.lock().unwrap_or_else(|p| p.into_inner());
            let chosen = if !flight.started {
                Terminal::Failed
            } else if terminal == Terminal::Completed && route.cancelled {
                Terminal::Cancelled
            } else {
                terminal
            };
            *route.decision.get_or_insert(chosen)
        };
        self.snapshot.decision = Some(terminal);
        if let Some(pause) = self.terminal_pause.take() {
            self.publish();
            pause.wait();
        }
        let signal = if !flight.started {
            service::Signal::StartFailed
        } else {
            match terminal {
                Terminal::Completed => service::Signal::Completed,
                Terminal::Cancelled => service::Signal::Cancelled,
                Terminal::Failed => service::Signal::Failed,
            }
        };
        let now = self.now();
        match self.services()?.native_signals(&flight.id, vec![signal], now) {
            Ok(()) => {
                flight.terminal = true;
                self.snapshot.terminal = Some(terminal);
                Ok(())
            }
            Err(service::DeliveryError::Retained(error)) => {
                flight.terminal = true;
                Err(error.into())
            }
            Err(service::DeliveryError::Rejected(error)) => Err(error.into()),
        }
    }
}
fn mark_delivery(delivery: std::result::Result<(), service::DeliveryError>, delivered: &mut bool) -> Result<()> {
    match delivery {
        Ok(()) => {
            *delivered = true;
            Ok(())
        }
        Err(service::DeliveryError::Retained(error)) => {
            *delivered = true;
            Err(error.into())
        }
        Err(service::DeliveryError::Rejected(error)) => Err(error.into()),
    }
}
impl Drop for Actor {
    fn drop(&mut self) {
        self.route.cancel();
        if self.flight.as_ref().is_some_and(|f| f.disposal.is_none()) {
            // No accepted exact joined Ack: never invoke ServiceOwner's close Drop.
            std::mem::forget(self.services.take());
        }
    }
}
