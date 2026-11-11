//! Exactly one source inclusion. No milagre-acp dependency or second ACTIVE gate.
//! Actual owner/accounts/registry composition is deliberately deferred.
#[path = "../../src/private_copy/core.rs"]
mod native_core;

#[cfg(target_os = "macos")]
#[test]
#[ignore = "Only the fixed native staging checker provides the sibling executable"]
fn independent_runtime_progress_wait_and_cancel() {
    use std::{
        future::Future,
        sync::Arc,
        task::{Context, Poll, Wake},
        time::{Duration, Instant},
    };
    struct ThreadWake(std::thread::Thread);
    impl Wake for ThreadWake {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    fn block<T>(future: impl Future<Output = T>) -> T {
        let waker = Arc::new(ThreadWake(std::thread::current())).into();
        let mut context = Context::from_waker(&waker);
        let mut future = std::pin::pin!(future);
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
            assert!(Instant::now() < until, "bounded fixture future");
            std::thread::park_timeout(Duration::from_millis(20));
        }
    }
    let (control, mut observer) = native_core::prepare(native_core::FixtureCase::IgnoreCancel, "standalone core input").unwrap();
    let first = block(observer.next()).unwrap();
    assert!(first.prepared && first.consumed.is_none() && first.report.is_none());
    assert!(matches!(native_core::automatic(native_core::FixtureCase::Ready, "same process"), Err(native_core::Error::Busy)));
    control.stamp(control.capture().unwrap()).unwrap();
    let consumed = block(observer.next()).unwrap();
    assert!(consumed.consumed.is_some() && consumed.report.is_none());
    let cancel = observer.cancel_handle();
    let waiting = observer.wait();
    cancel.cancel();
    let report = block(waiting);
    assert_eq!(report.result, Err(native_core::Error::Revoked));
    assert!(report.reaped && report.resources_removed);
    let final_progress = block(observer.next()).unwrap();
    assert!(final_progress.finished && final_progress.revision > consumed.revision);
    assert!(block(observer.next()).is_none());
    println!("PRIVATE_COPY_STANDALONE_EVIDENCE oneCore=true callerTokio=false consumption=true independentCancel=true reaped=true");
}
