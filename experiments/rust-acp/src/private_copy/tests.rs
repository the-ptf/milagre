use super::*;
#[test]
fn public_text_limit_and_error_contract() {
    assert!(matches!(MacOsPrivateCopyFixture::start(FixtureCase::Ready, &"x".repeat(64 * 1024 + 1)), Err(Error::Bounds)));
    assert_eq!(format!("{}", Error::Identity), "Identity");
}

#[test]
#[ignore = "Only the staging checker provides the fixed native sibling"]
fn public_observer_progress_and_independent_cancel() {
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
    let waker = Arc::new(ThreadWake(std::thread::current())).into();
    let mut context = Context::from_waker(&waker);
    fn block<T>(future: impl Future<Output = T>, context: &mut Context<'_>) -> T {
        let mut future = std::pin::pin!(future);
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(context) {
                return value;
            }
            assert!(Instant::now() < until);
            std::thread::park_timeout(Duration::from_millis(20));
        }
    }
    let mut fixture = MacOsPrivateCopyFixture::start(FixtureCase::IgnoreCancel, "public wrapper consumption").unwrap();
    let cancel = fixture.cancel_handle();
    let mut last_revision = 0;
    loop {
        let update = block(fixture.next_progress(), &mut context).unwrap();
        assert!(update.revision > last_revision);
        last_revision = update.revision;
        if update.consumed.is_some() {
            assert!(update.report.is_none());
            break;
        }
    }
    let mut waiting = Box::pin(fixture.wait());
    assert!(waiting.as_mut().poll(&mut context).is_pending());
    cancel.cancel();
    let report = block(waiting, &mut context);
    assert_eq!(report.result, Err(Error::Revoked));
    assert!(report.reaped && report.resources_removed);
    let done = block(fixture.next_progress(), &mut context).unwrap();
    assert!(done.finished && done.revision > last_revision && done.consumed.is_some());
    assert!(block(fixture.next_progress(), &mut context).is_none());
    println!("PRIVATE_COPY_PUBLIC_PROGRESS_EVIDENCE retainedConsumption=true independentCancel=true singleWaiter=true reaped=true");
}
