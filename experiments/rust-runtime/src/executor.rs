use std::time::Duration;

/// Called outside a spawned task, after the owner worker has closed its session. The
/// deadline bounds the success claim, never the lifetime of supervisors still reaping.
/// The caller retains its profile and worker permit until this returns.
pub(crate) async fn drain(
    runtime: &tokio::runtime::Runtime,
    deadline: Duration,
    failed: impl FnOnce(),
) {
    let until = tokio::time::Instant::now() + deadline;
    let mut failed = Some(failed);
    while runtime.metrics().num_alive_tasks() != 0 {
        if tokio::time::Instant::now() >= until {
            if let Some(failed) = failed.take() {
                failed();
            }
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };

    #[test]
    fn deadline_reports_failure_but_retains_worker_until_supervisor_exits() {
        let retained = Arc::new(AtomicBool::new(true));
        let worker_retained = retained.clone();
        let (release, blocked) = tokio::sync::oneshot::channel::<()>();
        let (failure, observed) = mpsc::channel();
        let join = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                tokio::spawn(async {
                    let _ = blocked.await;
                });
                drain(&runtime, Duration::from_millis(20), || {
                    failure.send(()).unwrap();
                })
                .await;
            });
            worker_retained.store(false, Ordering::Release);
        });
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(retained.load(Ordering::Acquire));
        assert!(!join.is_finished());
        release.send(()).unwrap();
        join.join().unwrap();
        assert!(!retained.load(Ordering::Acquire));
        assert!(observed.try_recv().is_err());
    }
}
