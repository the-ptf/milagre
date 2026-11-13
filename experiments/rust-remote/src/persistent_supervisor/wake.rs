//! Checked progress hints. No wake contains execution, receipt or cleanup evidence.
use super::{Shared, WorkerFault};
use crate::budget::{fixed_backing_counter_allocation_bytes, Reservation};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, OnceLock, Weak,
    },
    thread::Thread,
};

pub(crate) struct WakeHub {
    generation: AtomicU64,
    overflow: AtomicBool,
    actor: OnceLock<Thread>,
    shared: Weak<Shared>,
}

impl WakeHub {
    pub(super) fn new(shared: &Arc<Shared>) -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            overflow: AtomicBool::new(false),
            actor: OnceLock::new(),
            shared: Arc::downgrade(shared),
        })
    }

    pub(crate) fn install_thread(&self, actor: Thread) -> Result<(), ()> {
        self.actor.set(actor).map_err(|_| ())
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub(crate) fn overflowed(&self) -> bool {
        self.overflow.load(Ordering::SeqCst)
    }

    /// The caller publishes its state or real receipt first. Only atomics and
    /// direct unpark follow, including when the caller already holds another lock.
    pub(crate) fn wake(&self) {
        if self.overflowed() {
            self.fail_overflow();
            return;
        }
        let mut generation = self.generation.load(Ordering::SeqCst);
        loop {
            let Some(next) = generation.checked_add(1) else {
                self.overflow.store(true, Ordering::SeqCst);
                self.fail_overflow();
                return;
            };
            match self.generation.compare_exchange_weak(
                generation,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(current) => generation = current,
            }
        }
        self.unpark();
    }

    fn fail_overflow(&self) {
        if let Some(shared) = self.shared.upgrade() {
            shared.fail_atomic(WorkerFault::WakeOverflow);
        }
        self.unpark();
    }

    fn unpark(&self) {
        if let Some(actor) = self.actor.get() {
            actor.unpark();
        }
    }

    pub(crate) fn token(self: &Arc<Self>) -> WakeToken {
        WakeToken(Arc::downgrade(self))
    }

    pub(super) fn shared_token(&self) -> Weak<Shared> {
        self.shared.clone()
    }

    #[cfg(test)]
    pub(crate) fn set_generation_for_test(&self, generation: u64) {
        self.generation.store(generation, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn latch_overflow_for_test(&self) {
        self.overflow.store(true, Ordering::SeqCst);
    }
}

/// Shared's immutable weak slot can outlive run drainage. Its reservation covers
/// the entire surviving Arc allocation and the split lease's local budget counter.
pub(super) struct WakeAccess {
    link: OnceLock<Weak<WakeHub>>,
    allocation: Reservation,
}

impl WakeAccess {
    pub(super) fn new(allocation: Reservation) -> Self {
        Self {
            link: OnceLock::new(),
            allocation,
        }
    }

    pub(super) fn install(&self, hub: &Arc<WakeHub>) -> Result<(), ()> {
        self.link.set(Arc::downgrade(hub)).map_err(|_| ())
    }

    pub(super) fn hub(&self) -> Option<Arc<WakeHub>> {
        self.link.get().and_then(Weak::upgrade)
    }

    pub(super) fn held_bytes(&self) -> usize {
        self.allocation.held_bytes()
    }
}

impl Drop for WakeAccess {
    fn drop(&mut self) {
        // Remove the weak reference before the allocation reservation is refunded.
        drop(self.link.take());
    }
}

/// Only internal workers/packets own these tokens, prepared before Begin. They
/// must be destroyed by actual join/packet drainage before the run drops its hub.
#[derive(Clone)]
pub(crate) struct WakeToken(Weak<WakeHub>);

impl WakeToken {
    pub(crate) fn wake(&self) {
        if let Some(hub) = self.0.upgrade() {
            hub.wake();
        }
    }
}

/// Stack-only worker-exit notification, including unwind. It is never join proof.
pub(crate) struct WakeGuard {
    token: Option<WakeToken>,
}

impl WakeGuard {
    pub(crate) fn new(token: Option<WakeToken>) -> Self {
        Self { token }
    }
}

impl Drop for WakeGuard {
    fn drop(&mut self) {
        if let Some(token) = &self.token {
            token.wake();
        }
    }
}

pub(super) fn wake_charge() -> Option<usize> {
    std::mem::size_of::<WakeHub>()
        .checked_add(2usize.checked_mul(std::mem::size_of::<usize>())?)?
        .checked_add(std::mem::align_of::<WakeHub>().checked_sub(1)?)?
        .checked_add(fixed_backing_counter_allocation_bytes()?)
}

pub(super) fn allocation_fits() -> bool {
    wake_charge()
        .and_then(|charge| charge.checked_add(std::mem::size_of::<Option<WakeAccess>>()))
        .is_some_and(|total| total <= 4096)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{budget::GlobalBudget, supervisor::Limits};
    use std::{
        panic::catch_unwind,
        thread,
        time::{Duration, Instant},
    };

    fn detached_hub() -> Arc<WakeHub> {
        Arc::new(WakeHub {
            generation: AtomicU64::new(0),
            overflow: AtomicBool::new(false),
            actor: OnceLock::new(),
            shared: Weak::new(),
        })
    }

    #[test]
    fn generation_survives_preinstallation_and_thread_installs_once() {
        let hub = detached_hub();
        hub.wake();
        hub.wake();
        assert_eq!(hub.generation(), 2);
        assert!(!hub.overflowed());
        assert_eq!(hub.install_thread(thread::current()), Ok(()));
        assert_eq!(hub.install_thread(thread::current()), Err(()));
        assert_eq!(hub.generation(), 2);
    }

    #[test]
    fn unpark_before_park_retains_its_token() {
        struct Cleanup {
            release: Arc<AtomicBool>,
            thread: Option<thread::JoinHandle<()>>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.release.store(true, Ordering::SeqCst);
                if let Some(thread) = self.thread.take() {
                    thread.thread().unpark();
                    let _ = thread.join();
                }
            }
        }
        fn wait(flag: &AtomicBool) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !flag.load(Ordering::SeqCst) {
                if Instant::now() >= deadline {
                    return false;
                }
                thread::yield_now();
            }
            true
        }

        let hub = detached_hub();
        let ready = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let worker = {
            let hub = hub.clone();
            let ready = ready.clone();
            let release = release.clone();
            let finished = finished.clone();
            thread::spawn(move || {
                hub.install_thread(thread::current()).unwrap();
                ready.store(true, Ordering::SeqCst);
                // No channel/Condvar wait here: such a wait might consume the
                // thread's unpark token before the park this test exercises.
                while !release.load(Ordering::SeqCst) {
                    thread::yield_now();
                }
                thread::park();
                finished.store(true, Ordering::SeqCst);
            })
        };
        let cleanup = Cleanup {
            release: release.clone(),
            thread: Some(worker),
        };
        assert!(wait(&ready), "worker never reached the pre-park gate");
        hub.wake();
        assert_eq!(hub.generation(), 1);
        release.store(true, Ordering::SeqCst);
        let woke = wait(&finished);
        // Cleanup always releases and unparks before joining, including failure.
        // Record the result first so cleanup cannot make a missing wake pass.
        drop(cleanup);
        assert!(woke, "the wake before park did not release the worker");
    }

    #[test]
    fn concurrent_wakes_keep_every_generation_without_wrapping() {
        let hub = detached_hub();
        thread::scope(|scope| {
            for _ in 0..4 {
                let hub = &hub;
                scope.spawn(move || {
                    for _ in 0..100 {
                        hub.wake();
                    }
                });
            }
        });
        assert_eq!(hub.generation(), 400);
        hub.set_generation_for_test(u64::MAX - 1);
        hub.wake();
        assert_eq!(hub.generation(), u64::MAX);
        assert!(!hub.overflowed());
        hub.wake();
        hub.wake();
        assert_eq!(hub.generation(), u64::MAX);
        assert!(hub.overflowed());
    }

    #[test]
    fn overflow_publishes_abort_without_relocking_held_queue() {
        for already_latched in [false, true] {
            let global = GlobalBudget::new(256 * 1024 * 1024).unwrap();
            let shared = Arc::new(
                Shared::new(
                    global,
                    Limits::default(),
                    crate::supervisor::Clock::monotonic(),
                    false,
                )
                .unwrap(),
            );
            let hub = WakeHub::new(&shared);
            let held = shared.queues();
            let generation = if already_latched { 17 } else { u64::MAX };
            hub.set_generation_for_test(generation);
            if already_latched {
                hub.latch_overflow_for_test();
            }
            hub.wake();
            assert!(hub.overflowed());
            assert_eq!(hub.generation(), generation);
            assert_eq!(shared.fault(), Some(WorkerFault::WakeOverflow));
            assert_eq!(shared.stop.load(Ordering::SeqCst), super::super::ABORT);
            drop(held);
            assert!(Arc::ptr_eq(&hub.shared_token().upgrade().unwrap(), &shared));
        }
    }

    #[test]
    fn worker_guard_wakes_on_return_and_unwind_then_drops_its_token() {
        let hub = detached_hub();
        drop(WakeGuard::new(None));
        drop(WakeGuard::new(Some(hub.token())));
        assert_eq!(hub.generation(), 1);
        assert_eq!(Arc::weak_count(&hub), 0);
        assert!(catch_unwind(|| {
            let _guard = WakeGuard::new(Some(hub.token()));
            panic!("synthetic guarded worker unwind");
        })
        .is_err());
        assert_eq!(hub.generation(), 2);
        assert_eq!(Arc::weak_count(&hub), 0);
    }

    #[test]
    fn access_retains_exact_charge_after_tokens_and_strong_hub_are_gone() {
        let charge = wake_charge().unwrap();
        assert!(allocation_fits());
        // These types have no test-only fields, so the same layout is admitted
        // in ordinary builds. Other platforms retain the checked slack ceiling.
        #[cfg(all(target_os = "macos", target_pointer_width = "64"))]
        {
            assert_eq!(std::mem::size_of::<WakeHub>(), 40);
            assert_eq!(std::mem::size_of::<Option<WakeAccess>>(), 48);
            assert_eq!(fixed_backing_counter_allocation_bytes(), Some(55));
            assert_eq!(charge, 118);
        }
        let pool = GlobalBudget::new(4096).unwrap();
        let mut backing = pool.connection(4096).unwrap().reserve(4096).unwrap();
        let access = WakeAccess::new(backing.split(charge).unwrap());
        let hub = detached_hub();
        assert_eq!(access.held_bytes(), charge);
        assert!(access.hub().is_none());
        assert_eq!(access.install(&hub), Ok(()));
        let other = detached_hub();
        assert_eq!(access.install(&other), Err(()));
        assert_eq!(Arc::weak_count(&other), 0);
        assert!(Arc::ptr_eq(&access.hub().unwrap(), &hub));
        let token = hub.token();
        let clone = token.clone();
        assert_eq!(Arc::weak_count(&hub), 3);
        drop(token);
        drop(clone);
        // Count while the hub is still strong; Weak::weak_count after final
        // strong release cannot establish that the internal tokens were drained.
        assert_eq!(Arc::weak_count(&hub), 1);
        drop(hub);
        drop(backing);
        assert!(access.hub().is_none());
        assert_eq!(pool.used(), charge);
        assert_eq!(other.generation(), 0);
        drop(access);
        assert_eq!(pool.used(), 0);
    }
}
