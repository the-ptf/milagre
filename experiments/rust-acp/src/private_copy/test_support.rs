//! Closed test-only scheduling/failure hooks. No path, callback or grant input.
use super::*;
use std::sync::Condvar;
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TestPoint {
    BeforeCommit,
    AfterCommit,
    BeforeReturn,
    Cleanup,
}
#[allow(dead_code)]
#[derive(Clone, Copy, Default)]
pub(crate) enum TestFault {
    #[default]
    None,
    WorkerPanic,
    Spawn,
    ThreadSpawn,
    MalformedFrame,
    PartialPreparation,
}
#[derive(Default)]
struct State {
    entered: bool,
    released: bool,
}
#[derive(Default)]
pub(crate) struct PauseState {
    state: Mutex<State>,
    changed: Condvar,
}
pub(crate) struct TestPause(Arc<PauseState>);
pub(crate) struct TestWait(Arc<PauseState>);
#[allow(dead_code)]
impl TestPause {
    pub(crate) fn pair() -> (Self, TestWait) {
        let state = Arc::new(PauseState::default());
        (Self(state.clone()), TestWait(state))
    }
    pub(crate) fn entered(&self) -> bool {
        self.0.state.lock().unwrap().entered
    }
    pub(crate) fn release(&self) {
        self.0.state.lock().unwrap().released = true;
        self.0.changed.notify_all();
    }
}
impl Drop for TestPause {
    fn drop(&mut self) {
        self.release();
    }
}
#[allow(dead_code)]
impl TestWait {
    pub(crate) fn wait(&self) {
        let mut state = self.0.state.lock().unwrap();
        state.entered = true;
        self.0.changed.notify_all();
        // A failed test cannot strand a worker indefinitely.
        let until = Instant::now() + Duration::from_secs(10);
        while !state.released {
            let remaining = until.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            state = self.0.changed.wait_timeout(state, remaining).unwrap().0;
        }
    }
}
impl Shared {
    pub(crate) fn has_pause(&self, point: TestPoint) -> bool {
        self.pause.lock().unwrap().as_ref().is_some_and(|(p, _)| *p == point)
    }
    pub(crate) fn pause_at(&self, point: TestPoint) {
        let pause = {
            let mut slot = self.pause.lock().unwrap();
            if slot.as_ref().is_none_or(|(p, _)| *p != point) {
                return;
            }
            slot.take().unwrap().1
        };
        TestWait(pause).wait();
    }
}
#[allow(dead_code)]
impl Control {
    pub(crate) fn test_pause(&self, point: TestPoint) -> TestPause {
        let state = Arc::new(PauseState::default());
        assert!(self.shared.pause.lock().unwrap().replace((point, state.clone())).is_none());
        TestPause(state)
    }
}
#[allow(dead_code)]
impl Reservation {
    pub(crate) fn activate_test(self, fault: TestFault) -> Running {
        let fault = match fault {
            TestFault::None => worker::Fault::None,
            TestFault::WorkerPanic => worker::Fault::PanicAfterSpawn,
            TestFault::Spawn => worker::Fault::SpawnFailure,
            TestFault::ThreadSpawn => worker::Fault::ThreadSpawnFailure,
            TestFault::MalformedFrame => worker::Fault::MalformedFrame,
            TestFault::PartialPreparation => worker::Fault::PartialPreparation,
        };
        self.activate_with(None, fault)
    }
}
