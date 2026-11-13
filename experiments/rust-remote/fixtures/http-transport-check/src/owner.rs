//! The owner keeps all backing and the real JoinHandle through join, including
//! panic and owner-unwind paths. Cancellation alone never disposes the backing.
use crate::transport::{self, Outcome, Report, RequestStorage, ResponseStorage, Script, Stats};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Wake, Waker};
use std::thread::{self, JoinHandle, Thread};
use std::time::{Duration, Instant};

#[derive(Default)]
struct WakeState {
    thread: Mutex<Option<Thread>>,
}
impl Wake for WakeState {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        if let Some(thread) = self.thread.lock().unwrap().as_ref() {
            thread.unpark();
        }
    }
}
#[derive(Default)]
struct State {
    dormant: bool,
    started: bool,
    exit_open: bool,
    registration_open: bool,
    registered: bool,
    stalled: bool,
    parking: bool,
    report: Option<Report>,
}
pub struct Control {
    cancelled: AtomicBool,
    wake: Arc<WakeState>,
    registered_waker: Mutex<Option<Waker>>,
    state: Mutex<State>,
    changed: Condvar,
    park_calls: AtomicUsize,
    cancel_wakes: AtomicUsize,
}
impl Control {
    fn new(pause_registration: bool, pause_exit: bool) -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            wake: Arc::new(WakeState::default()),
            registered_waker: Mutex::new(None),
            state: Mutex::new(State {
                exit_open: !pause_exit,
                registration_open: !pause_registration,
                ..State::default()
            }),
            changed: Condvar::new(),
            park_calls: AtomicUsize::new(0),
            cancel_wakes: AtomicUsize::new(0),
        }
    }
    pub fn waker(&self) -> Waker {
        Waker::from(self.wake.clone())
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let wake = self.registered_waker.lock().unwrap().clone();
        if let Some(wake) = wake {
            self.cancel_wakes.fetch_add(1, Ordering::Relaxed);
            wake.wake();
        } else {
            self.wake.clone().wake();
        }
        self.changed.notify_all();
    }
    pub fn register_and_cancelled(&self, cx: &Context<'_>) -> bool {
        *self.registered_waker.lock().unwrap() = Some(cx.waker().clone());
        let mut state = self.state.lock().unwrap();
        state.registered = true;
        self.changed.notify_all();
        while !state.registration_open {
            state = self.changed.wait(state).unwrap();
        }
        drop(state);
        // A cancellation between registration and this load must be observed.
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn stalled(&self) {
        self.state.lock().unwrap().stalled = true;
        self.changed.notify_all();
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn is_stalled(&self) -> bool {
        self.state.lock().unwrap().stalled
    }
    pub fn park_until_cancelled(&self) {
        // Permanent scripted Pending has no data-ready event or timer. The
        // retained cancellation waker must release this real OS-thread park.
        // A cancel between this load and park leaves the persistent unpark token.
        while !self.is_cancelled() {
            self.park_calls.fetch_add(1, Ordering::Relaxed);
            self.state.lock().unwrap().parking = true;
            self.changed.notify_all();
            thread::park();
        }
    }
    pub fn wake_counts(&self) -> (usize, usize) {
        (
            self.park_calls.load(Ordering::Relaxed),
            self.cancel_wakes.load(Ordering::Relaxed),
        )
    }
    pub fn start(&self) {
        self.state.lock().unwrap().started = true;
        self.changed.notify_all();
    }
    pub fn release_registration(&self) {
        self.state.lock().unwrap().registration_open = true;
        self.changed.notify_all();
    }
    pub fn release_exit(&self) {
        self.state.lock().unwrap().exit_open = true;
        self.changed.notify_all();
    }
    fn wait_for(&self, predicate: impl Fn(&State) -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        let mut state = self.state.lock().unwrap();
        while !predicate(&state) {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                drop(state);
                panic!("offline worker barrier timed out");
            }
            state = self.changed.wait_timeout(state, left).unwrap().0;
        }
    }
    pub fn wait_registered(&self) {
        self.wait_for(|s| s.registered);
    }
    pub fn wait_stalled(&self) {
        self.wait_for(|s| s.stalled);
    }
    pub fn wait_parking(&self) {
        self.wait_for(|s| s.parking);
    }
    pub fn wait_report(&self) {
        self.wait_for(|s| s.report.is_some());
    }
    fn clear_after_join(&self) {
        self.registered_waker.lock().unwrap().take();
        self.wake.thread.lock().unwrap().take();
    }
}
pub struct OwnedRun {
    pub request: Arc<RequestStorage>,
    pub response: Arc<Mutex<ResponseStorage>>,
    pub control: Arc<Control>,
    handle: Option<JoinHandle<Report>>,
}
impl OwnedRun {
    pub fn spawn(
        script: Script,
        upload: usize,
        pause_registration: bool,
        pause_exit: bool,
    ) -> Self {
        Self::spawn_inner(script, upload, pause_registration, pause_exit, false)
    }
    pub fn spawn_then_unwind(script: Script) -> Self {
        Self::spawn_inner(script, 0, false, false, true)
    }
    fn spawn_inner(
        script: Script,
        upload: usize,
        pause_registration: bool,
        pause_exit: bool,
        fail_after_spawn: bool,
    ) -> Self {
        let request = Arc::new(RequestStorage {
            bytes: vec![7; upload].into_boxed_slice(),
        });
        let response = Arc::new(Mutex::new(ResponseStorage::new()));
        let control = Arc::new(Control::new(pause_registration, pause_exit));
        let worker_request = request.clone();
        let worker_response = response.clone();
        let worker_control = control.clone();
        let handle = thread::Builder::new()
            .name("offline-http".into())
            .stack_size(transport::STACK)
            .spawn(move || {
                *worker_control.wake.thread.lock().unwrap() = Some(thread::current());
                worker_control.state.lock().unwrap().dormant = true;
                worker_control.changed.notify_all();
                worker_control.wait_for(|s| s.started);
                let report = transport::run(
                    script,
                    worker_request,
                    worker_response,
                    worker_control.clone(),
                );
                worker_control.state.lock().unwrap().report = Some(report);
                worker_control.changed.notify_all();
                worker_control.wait_for(|s| s.exit_open);
                report
            })
            .unwrap();
        let owner = Self {
            request,
            response,
            control,
            handle: Some(handle),
        };
        if fail_after_spawn {
            panic!("offline post-spawn unwind");
        }
        owner.control.wait_for(|s| s.dormant);
        owner
    }
    pub fn finished(&self) -> bool {
        self.handle.as_ref().unwrap().is_finished()
    }
    pub fn join(&mut self) -> Report {
        let report = self
            .handle
            .take()
            .expect("join exactly once")
            .join()
            .unwrap_or(Report {
                outcome: Outcome::Panic,
                status: 0,
                stats: Stats::default(),
            });
        self.control.clear_after_join();
        report
    }
}
impl Drop for OwnedRun {
    fn drop(&mut self) {
        if self.handle.is_some() {
            self.control.cancel();
            self.control.release_registration();
            self.control.release_exit();
            self.control.start();
            self.join();
        }
    }
}
