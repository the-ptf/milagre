use milagre_usage::{
    limits::provider_result,
    owner::{ScanResult, TokenUsage, TokenUsageOptions},
    store::{UsageReader, UsageStore},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
const NOW: i64 = 1793361600000;
#[tokio::test]
async fn synchronous_and_polled_reader_panics_are_generic_errors_and_retryable() {
    for polled in [false, true] {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let reader = UsageReader::new(
            UsageStore::default(),
            Arc::new(move |p| {
                let first = c.fetch_add(1, Ordering::SeqCst) == 0;
                if first && !polled {
                    panic!("fixture synchronous panic");
                }
                Box::pin(async move {
                    if first {
                        tokio::task::yield_now().await;
                        panic!("fixture polled panic");
                    }
                    Ok(provider_result(&p, NOW, "unavailable", json!([]), None))
                })
            }),
            Arc::new(|| NOW),
            Arc::new(|| Box::pin(async {})),
        );
        let failed = reader.provider("claude").await.unwrap();
        assert_eq!(failed["message"], "Couldn't read usage.");
        assert!(!failed.to_string().contains("fixture"));
        assert_eq!(reader.provider("claude").await.unwrap()["status"], "unavailable");
        reader.shutdown().await;
        assert_eq!(reader.in_flight(), 0);
    }
}
#[tokio::test]
async fn readiness_panic_is_contained_once_and_shutdown_during_readiness_wakes_waiters() {
    let count = Arc::new(AtomicUsize::new(0));
    let c = count.clone();
    let reader = UsageReader::new(
        UsageStore::default(),
        Arc::new(|p| Box::pin(async move { Ok(provider_result(&p, NOW, "unavailable", json!([]), None)) })),
        Arc::new(|| NOW),
        Arc::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
            panic!("fixture ready panic");
        }),
    );
    assert_eq!(reader.read().await["providers"].as_array().unwrap().len(), 4);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    reader.shutdown().await;
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let e = entered.clone();
    let reader = UsageReader::new(
        UsageStore::default(),
        Arc::new(|_| panic!("should not read before readiness")),
        Arc::new(|| NOW),
        Arc::new(move || {
            e.add_permits(1);
            Box::pin(std::future::pending())
        }),
    );
    let waiting = {
        let r = reader.clone();
        tokio::spawn(async move { r.provider("claude").await })
    };
    entered.acquire().await.unwrap().forget();
    reader.shutdown().await;
    assert_eq!(waiting.await.unwrap().unwrap_err(), "Usage reader stopped");
    assert_eq!(reader.in_flight(), 0);
    assert!(reader.provider("claude").await.is_err());
}
fn options() -> TokenUsageOptions {
    TokenUsageOptions {
        scan: Arc::new(|| Box::pin(async { Ok(ScanResult { rows: json!([]), changed: false }) })),
        projects: Arc::new(|| Box::pin(async { Ok(json!([])) })),
        prices: Arc::new(|| Value::Null),
        pricing_status: Arc::new(|| json!({"status":"unavailable"})),
        emit: Arc::new(|_, _| {}),
        now: Arc::new(|| NOW),
        home: "/fixture".into(),
        worktree_root: "/fixture/worktrees".into(),
        default_time_zone: "UTC".into(),
    }
}
#[tokio::test]
async fn scan_and_project_panics_do_not_leave_scanning_or_metadata_stuck() {
    let count = Arc::new(AtomicUsize::new(0));
    let c = count.clone();
    let events = Arc::new(Mutex::new(vec![]));
    let mut o = options();
    o.scan = Arc::new(move || {
        let first = c.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            tokio::task::yield_now().await;
            if first {
                panic!("fixture scan panic");
            }
            Ok(ScanResult { rows: json!([]), changed: true })
        })
    });
    o.projects = Arc::new(|| panic!("fixture project metadata panic"));
    o.prices = Arc::new(|| panic!("fixture pricing panic"));
    o.pricing_status = Arc::new(|| panic!("fixture status panic"));
    let e = events.clone();
    o.emit = Arc::new(move |name, _| e.lock().unwrap().push(name.to_owned()));
    let owner = TokenUsage::new(o, json!([]), false);
    owner.read(&Value::Null).await.unwrap();
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
    assert_eq!(owner.in_flight(), 0);
    owner.read(&Value::Null).await.unwrap();
    for _ in 0..30 {
        tokio::task::yield_now().await;
    }
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_eq!(*events.lock().unwrap(), vec!["token-usage:changed"]);
    assert_eq!(owner.read(&Value::Null).await.unwrap()["firstScan"], false);
    owner.shutdown().await;
}
#[tokio::test]
async fn token_owner_shutdown_drops_scan_and_metadata_futures_and_suppresses_events() {
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    struct Count(Arc<AtomicUsize>);
    impl Drop for Count {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let mut o = options();
    let e = entered.clone();
    let d = dropped.clone();
    o.scan = Arc::new(move || {
        let guard = Count(d.clone());
        let e = e.clone();
        Box::pin(async move {
            let _guard = guard;
            e.add_permits(1);
            std::future::pending().await
        })
    });
    let e = entered.clone();
    let d = dropped.clone();
    o.projects = Arc::new(move || {
        let guard = Count(d.clone());
        let e = e.clone();
        Box::pin(async move {
            let _guard = guard;
            e.add_permits(1);
            std::future::pending().await
        })
    });
    o.emit = Arc::new(|_, _| panic!("should never emit after cancelled scan"));
    let owner = TokenUsage::new(o, json!([]), false);
    let waiting = {
        let o = owner.clone();
        tokio::spawn(async move { o.read(&Value::Null).await })
    };
    entered.acquire_many(2).await.unwrap().forget();
    owner.shutdown().await;
    assert!(waiting.await.unwrap().is_err());
    assert_eq!(owner.in_flight(), 0);
    assert_eq!(dropped.load(Ordering::SeqCst), 2);
    assert!(owner.read(&Value::Null).await.is_err());
}
