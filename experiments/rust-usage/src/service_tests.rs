use super::*;
use crate::accounts::{AccountSnapshot, Selection};
use std::collections::HashMap;
use std::{
    fs,
    sync::atomic::{AtomicI64, AtomicUsize},
    time::Duration,
};
const NOW: i64 = 1793361600000;
fn fixture() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/accounts.json")).unwrap()
}
struct Harness {
    model: Arc<Mutex<Value>>,
    now: Arc<AtomicI64>,
    calls: Arc<Mutex<Vec<Value>>>,
    events: Arc<Mutex<Vec<Value>>>,
    ready: Arc<AtomicUsize>,
    fetches: Arc<AtomicUsize>,
}
impl Harness {
    fn new() -> Self {
        Self {
            model: Arc::new(Mutex::new(fixture()["initial"].clone())),
            now: Arc::new(AtomicI64::new(NOW)),
            calls: Arc::new(Mutex::new(vec![])),
            events: Arc::new(Mutex::new(vec![])),
            ready: Arc::new(AtomicUsize::new(0)),
            fetches: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn options(&self) -> ServiceOptions {
        let scopes = self.model.clone();
        let selection = self.model.clone();
        let list = self.model.clone();
        let read = self.model.clone();
        let calls = self.calls.clone();
        let clock = self.now.clone();
        let read_clock = self.now.clone();
        let ready = self.ready.clone();
        let events = self.events.clone();
        let fetches = self.fetches.clone();
        ServiceOptions {
            accounts: UsageAccountsOptions {
                scopes: Arc::new(move || {
                    let value = serde_json::from_value(scopes.lock().unwrap()["scopes"].clone()).unwrap();
                    Box::pin(async move { Ok(value) })
                }),
                selected: Arc::new(move |_| serde_json::from_value(selection.lock().unwrap()["selection"].clone()).unwrap()),
                list: Arc::new(move || {
                    let value: AccountSnapshot = serde_json::from_value(list.lock().unwrap()["identities"].clone()).unwrap();
                    Box::pin(async move { Ok(value) })
                }),
                read: Arc::new(move |provider, id| {
                    calls.lock().unwrap().push(json!([provider, id]));
                    let status = read.lock().unwrap()["status"].as_str().unwrap_or("ok").to_owned();
                    let now = read_clock.load(Ordering::SeqCst);
                    Box::pin(async move {
                        Ok(provider_result(
                            &provider,
                            now,
                            &status,
                            if status == "ok" {
                                json!([{"id":"session","label":"Session","shortLabel":"5h","usedPercent":if id=="work"{22}else{11},"resetsAt":null}])
                            } else {
                                json!([])
                            },
                            (status == "error").then_some("fixture failure"),
                        ))
                    })
                }),
                ready: Arc::new(move || {
                    ready.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async {})
                }),
                now: Arc::new(move || clock.load(Ordering::SeqCst)),
                emit: Arc::new(move |name, v| events.lock().unwrap().push(json!([name, v]))),
                read_usage_override: None,
            },
            roots: vec![],
            projects: Arc::new(|| Box::pin(async { Ok(json!([])) })),
            fetch_catalog: Arc::new(move || {
                fetches.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(json!({"claude-fixture":{"input_cost_per_token":1,"output_cost_per_token":2}})) })
            }),
            home: "/fixture".into(),
            worktree_root: "/fixture/worktrees".into(),
            default_time_zone: "UTC".into(),
        }
    }
}
async fn stop(s: &Arc<UsageService>) {
    assert_eq!(tokio::time::timeout(Duration::from_secs(3), s.shutdown()).await.unwrap(), ShutdownReport::Complete(Ok(())));
}
async fn token_settled(s: &Arc<UsageService>) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let value = s.handle("token-usage:read", &Value::Null).await.unwrap();
            if value["refreshing"] == false && value["pricing"]["status"] != "loading" {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn facade_preserves_first_sixteen_node_command_traces_for_existing_accounts() {
    let f = fixture();
    let h = Harness::new();
    let cap = TempCache::fresh().unwrap();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    for (i, trace) in f["traces"].as_array().unwrap().iter().take(16).enumerate() {
        let input = &trace["input"];
        if let Some(patch) = input["set"].as_object() {
            for (k, v) in patch {
                h.model.lock().unwrap()[k] = v.clone();
            }
        }
        h.now.store(input["now"].as_i64().unwrap(), Ordering::SeqCst);
        h.calls.lock().unwrap().clear();
        h.events.lock().unwrap().clear();
        let result = service.handle(input["command"].as_str().unwrap(), &input["scope"]).await;
        let (result, error) = match result {
            Ok(v) => (v, Value::Null),
            Err(e) => (Value::Null, json!(e)),
        };
        let mut reads = h.calls.lock().unwrap().clone();
        reads.sort_by_key(Value::to_string);
        assert_eq!(
            json!({"result":result,"error":error,"reads":reads,"events":h.events.lock().unwrap().clone()}),
            trace["expected"],
            "trace {i}"
        );
    }
    stop(&service).await;
}
#[tokio::test]
async fn startup_rehydrates_quota_scan_and_prices_without_readiness_or_catalog_callbacks() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let copy = tempfile::tempdir().unwrap();
    let scan_fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/persistence.json")).unwrap();
    fs::write(copy.path().join("fixture.jsonl"), scan_fixture["line"].as_str().unwrap()).unwrap();
    let root = CopiedRoot::new("claude", fs::canonicalize(copy.path()).unwrap()).unwrap();
    let mut options = h.options();
    options.roots = vec![root.clone()];
    let service = UsageService::open(&cap, options).await.unwrap();
    let before = service.handle("usage:read", &Value::Null).await.unwrap();
    let tokens = token_settled(&service).await;
    assert_eq!(tokens["firstScan"], false);
    stop(&service).await;
    let h2 = Harness::new();
    let mut options = h2.options();
    options.roots = vec![root];
    options.accounts.ready = Arc::new(|| Box::pin(std::future::pending()));
    let reopened = UsageService::open(&cap, options).await.unwrap();
    assert_eq!(h2.ready.load(Ordering::SeqCst), 0);
    assert_eq!(h2.fetches.load(Ordering::SeqCst), 0);
    assert!(h2.calls.lock().unwrap().is_empty());
    let cached = reopened.handle("usage:cached", &Value::Null).await.unwrap();
    for provider in before["providers"].as_array().unwrap() {
        let cached_provider = cached["providers"].as_array().unwrap().iter().find(|p| p["provider"] == provider["provider"]).unwrap();
        assert_eq!(cached_provider["windows"], provider["windows"]);
    }
    let restored = token_settled(&reopened).await;
    assert_eq!(restored["firstScan"], false);
    assert_eq!(restored["totals"], tokens["totals"]);
    assert_eq!(h2.fetches.load(Ordering::SeqCst), 0);
    stop(&reopened).await;
}
#[tokio::test]
async fn per_account_changes_removal_and_failed_readiness_never_fall_back_to_another_id() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let mut options = h.options();
    options.accounts.ready = Arc::new(|| panic!("fixture failed environment readiness"));
    let service = UsageService::open(&cap, options).await.unwrap();
    service.handle("usage:read", &Value::Null).await.unwrap();
    h.model.lock().unwrap()["selection"] = json!(Selection::default());
    service.handle("usage:read", &Value::Null).await.unwrap();
    h.model.lock().unwrap()["selection"]["claude"] = json!("work");
    h.model.lock().unwrap()["identities"]["providers"][0]["accounts"].as_array_mut().unwrap().retain(|a| a["id"] != "work");
    h.calls.lock().unwrap().clear();
    let removed = service.handle("usage:read", &Value::Null).await.unwrap();
    assert!(!h.calls.lock().unwrap().iter().any(|v| v[0] == "claude"));
    assert_eq!(removed["providers"][0]["account"], json!({"id":"work","label":"Removed account"}));
    let cached = service.handle("usage:cached", &Value::Null).await.unwrap();
    assert_eq!(
        cached["providers"].as_array().unwrap().iter().find(|v| v["provider"] == "claude").unwrap()["windows"][0]["usedPercent"],
        22
    );
    h.model.lock().unwrap()["identities"]["providers"][0]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"provider":"claude","id":"work","label":"Work","state":"unknown"}));
    service.handle("usage:read", &Value::Null).await.unwrap();
    assert!(!h.calls.lock().unwrap().iter().any(|v| v[0] == "claude"));
    h.model.lock().unwrap()["identities"]["providers"][0]["accounts"].as_array_mut().unwrap().last_mut().unwrap()["state"] = json!("ready");
    h.model.lock().unwrap()["status"] = json!("error");
    service.handle("usage:read", &Value::Null).await.unwrap();
    h.model.lock().unwrap()["status"] = json!("ok");
    let recovered = service.handle("usage:read", &Value::Null).await.unwrap();
    assert_eq!(recovered["providers"][0]["status"], "ok");
    assert!(h.calls.lock().unwrap().iter().any(|v| v == &json!(["claude", "work"])));
    stop(&service).await;
}
#[tokio::test]
async fn lazy_account_loading_does_not_depend_on_the_startup_selection() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    service.handle("usage:read", &Value::Null).await.unwrap();
    stop(&service).await;
    h.model.lock().unwrap()["selection"] = json!(Selection::default());
    let reopened = UsageService::open(&cap, h.options()).await.unwrap();
    assert_eq!(reopened.handle("usage:cached", &Value::Null).await.unwrap()["providers"], json!([]));
    h.model.lock().unwrap()["selection"]["claude"] = json!("work");
    assert_eq!(reopened.handle("usage:cached", &Value::Null).await.unwrap()["providers"].as_array().unwrap().len(), 4);
    stop(&reopened).await;
}
#[tokio::test]
async fn shutdown_cancels_callbacks_exports_completed_reads_and_survives_an_unpolled_waiter() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let mut options = h.options();
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    struct Count(Arc<AtomicUsize>);
    impl Drop for Count {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let original = options.accounts.read.clone();
    let entered = started.clone();
    let count = dropped.clone();
    options.accounts.read = Arc::new(move |p, id| {
        if p == "claude" {
            return original(p, id);
        }
        let entered = entered.clone();
        let guard = Count(count.clone());
        Box::pin(async move {
            let _guard = guard;
            entered.add_permits(1);
            std::future::pending().await
        })
    });
    let entered = started.clone();
    let count = dropped.clone();
    options.fetch_catalog = Arc::new(move || {
        let entered = entered.clone();
        let guard = Count(count.clone());
        Box::pin(async move {
            let _guard = guard;
            entered.add_permits(1);
            std::future::pending().await
        })
    });
    let service = UsageService::open(&cap, options).await.unwrap();
    let read = {
        let s = service.clone();
        tokio::spawn(async move { s.handle("usage:read", &Value::Null).await })
    };
    let prices = {
        let s = service.clone();
        tokio::spawn(async move { s.refresh_prices().await })
    };
    started.acquire_many(4).await.unwrap().forget();
    drop(service.shutdown());
    stop(&service).await;
    assert!(read.await.unwrap().is_err());
    assert!(prices.await.unwrap().is_err());
    assert_eq!(dropped.load(Ordering::SeqCst), 4);
    assert!(h.events.lock().unwrap().is_empty());
    assert!(service.handle("usage:cached", &Value::Null).await.is_err());
    let reopened = UsageService::open(&cap, h.options()).await.unwrap();
    let cached = reopened.handle("usage:cached", &Value::Null).await.unwrap();
    assert_eq!(cached["providers"].as_array().unwrap().len(), 1);
    assert_eq!(cached["providers"][0]["provider"], "claude");
    assert!(reopened.refresh_prices().await.unwrap());
    stop(&reopened).await;
}
#[tokio::test]
async fn shutdown_waits_for_scan_before_final_export_and_disk_lease_release() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    let (tx, entered) = std::sync::mpsc::channel();
    let (resume, rx) = std::sync::mpsc::channel();
    *service.scan.gate.lock().unwrap() = Some((tx, rx));
    service.handle("token-usage:read", &Value::Null).await.unwrap();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let mut stopping = Box::pin(service.shutdown());
    h.events.lock().unwrap().clear();
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut stopping).await.is_err());
    assert!(cap.open().is_err());
    resume.send(()).unwrap();
    assert_eq!(stopping.await, ShutdownReport::Complete(Ok(())));
    assert!(h.events.lock().unwrap().iter().all(|e| e[0] != "token-usage:changed"));
    let reopened = cap.open().unwrap();
    assert!(reopened.load_scan().unwrap().finished_at.is_none());
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn failed_final_save_retains_data_for_reopen_and_retry() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    service.handle("usage:read", &Value::Null).await.unwrap();
    let obstruction = cap.test_directory().join("token-usage.json");
    fs::create_dir(&obstruction).unwrap();
    assert!(matches!(service.shutdown().await, ShutdownReport::Complete(Err(_))));
    assert!(service.dirty_count() > 0);
    fs::remove_dir(obstruction).unwrap();
    let reopened = UsageService::open(&cap, h.options()).await.unwrap();
    assert!(reopened.scan.scanner.lock().unwrap().cache().files.is_empty());
    assert_eq!(reopened.handle("usage:cached", &Value::Null).await.unwrap()["providers"].as_array().unwrap().len(), 4);
    stop(&reopened).await;
    let cache = cap.open().unwrap();
    assert_eq!(cache.dirty_count(), 0);
    cache.shutdown().await.unwrap();
}
#[tokio::test]
async fn pricing_failure_or_panic_retries_after_backoff_and_persists_success() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let mut options = h.options();
    let original = options.fetch_catalog.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let attempts = count.clone();
    options.fetch_catalog = Arc::new(move || {
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            panic!("fixture catalog panic");
        }
        original()
    });
    let service = UsageService::open(&cap, options).await.unwrap();
    assert!(!service.refresh_prices().await.unwrap());
    assert!(!service.refresh_prices().await.unwrap());
    assert_eq!(count.load(Ordering::SeqCst), 1);
    h.now.store(NOW + 900_000, Ordering::SeqCst);
    assert!(service.refresh_prices().await.unwrap());
    stop(&service).await;
    let reopened = UsageService::open(&cap, h.options()).await.unwrap();
    assert!(!reopened.refresh_prices().await.unwrap());
    assert_eq!(count.load(Ordering::SeqCst), 2);
    stop(&reopened).await;
}

#[tokio::test]
async fn facade_retries_retained_disk_failure_and_stops_retry_scheduler_before_close() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    let obstruction = cap.test_directory().join("token-usage.json");
    fs::create_dir(&obstruction).unwrap();
    token_settled(&service).await;
    assert!(service.flush().await.is_err());
    assert!(service.dirty_count() > 0);
    fs::remove_dir(obstruction).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while service.dirty_count() > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    stop(&service).await;
    assert_eq!(service.retry.active(), 0);
    let reopened = cap.open().unwrap();
    assert!(reopened.load_scan().unwrap().finished_at.is_some());
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn failed_lazy_loader_and_corrupt_startup_are_visible_and_retryable() {
    let cap = TempCache::fresh().unwrap();
    fs::write(cap.test_directory().join("token-usage.json"), b"{").unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    assert_eq!(service.cache_diagnostics().len(), 1);
    stop(&service).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let accounts = UsageAccounts::with_store_loader(
        h.options().accounts,
        HashMap::new(),
        Some(Arc::new(move |_| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                panic!("fixture cache loader panic");
            }
            Ok(crate::store::UsageStore::default())
        })),
    );
    assert_eq!(accounts.handle("usage:cached", &Value::Null).await.unwrap_err(), "Usage cache loader panicked");
    assert!(accounts.handle("usage:cached", &Value::Null).await.is_ok());
    accounts.shutdown().await;
}
#[tokio::test]
async fn service_keeps_original_selection_during_concurrent_selection_change() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let mut options = h.options();
    let original = options.accounts.read.clone();
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let e = started.clone();
    let g = gate.clone();
    options.accounts.read = Arc::new(move |p, id| {
        let result = original(p, id);
        let e = e.clone();
        let g = g.clone();
        Box::pin(async move {
            e.add_permits(1);
            g.acquire().await.unwrap().forget();
            result.await
        })
    });
    let service = UsageService::open(&cap, options).await.unwrap();
    let reading = {
        let s = service.clone();
        tokio::spawn(async move { s.handle("usage:read", &Value::Null).await })
    };
    started.acquire_many(4).await.unwrap().forget();
    h.model.lock().unwrap()["selection"] = json!(Selection::default());
    gate.add_permits(4);
    let result = reading.await.unwrap().unwrap();
    assert_eq!(result["accountKey"], "work-default");
    assert_eq!(result["providers"][0]["account"]["id"], "work");
    assert_eq!(service.handle("usage:cached", &Value::Null).await.unwrap()["providers"], json!([]));
    stop(&service).await;
}

async fn entered_async(rx: std::sync::mpsc::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match rx.try_recv() {
                Ok(()) => return,
                Err(std::sync::mpsc::TryRecvError::Empty) => tokio::time::sleep(Duration::from_millis(1)).await,
                Err(e) => panic!("{e}"),
            }
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn background_loads_leave_runtime_live_and_shutdown_owns_cancelled_quota_load() {
    let cap = TempCache::fresh().unwrap();
    let seed = cap.open().unwrap();
    let selection = Selection { claude: "work".into(), ..Selection::default() };
    let store = crate::store::UsageStore::from_json(&json!({"claude":{"blocked":{"until":NOW+1000,"message":"fixture"}}}));
    seed.save_quota(&selection, &store).unwrap();
    seed.shutdown().await.unwrap();
    let h = Harness::new();
    let (entered, resume) = cap.test_block_load();
    let c = cap.clone();
    let options = h.options();
    let opening = tokio::spawn(async move { UsageService::open(&c, options).await });
    entered_async(entered).await;
    assert!(!opening.is_finished());
    resume.send(()).unwrap();
    let service = opening.await.unwrap().unwrap();
    let (entered, resume) = cap.test_block_load();
    let s = service.clone();
    let read = tokio::spawn(async move { s.handle("usage:cached", &Value::Null).await });
    entered_async(entered).await;
    let mut shutdown = Box::pin(service.shutdown());
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut shutdown).await.is_err());
    assert!(cap.open().is_err());
    resume.send(()).unwrap();
    assert_eq!(shutdown.await, ShutdownReport::Complete(Ok(())));
    assert_eq!(service.loaded_cache_bytes(), 0, "abandoned loaded quota result released its charge");
    assert!(read.await.unwrap().is_err());
    let reopened = cap.open().unwrap();
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn service_aggregate_load_budget_is_shared_across_account_selections() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    service.handle("usage:read", &Value::Null).await.unwrap();
    h.model.lock().unwrap()["selection"] = json!(Selection::default());
    service.handle("usage:read", &Value::Null).await.unwrap();
    stop(&service).await;
    let first = cap.open().unwrap();
    let work = Selection { claude: "work".into(), ..Selection::default() };
    let bytes = serde_json::to_vec(&first.load_quota(&work).unwrap().to_json()).unwrap().len() as u64;
    first.shutdown().await.unwrap();
    h.model.lock().unwrap()["selection"] = json!(work);
    let service = UsageService::open_with_limits(&cap, h.options(), ServiceLimits { cache_load_bytes: bytes + 100 }).await.unwrap();
    assert!(service.handle("usage:cached", &Value::Null).await.is_ok());
    let charged = service.loaded_cache_bytes();
    h.model.lock().unwrap()["selection"] = json!(Selection::default());
    assert!(service.handle("usage:cached", &Value::Null).await.unwrap_err().contains("load byte limit"));
    assert_eq!(service.loaded_cache_bytes(), charged);
    h.model.lock().unwrap()["selection"] = json!(work);
    assert!(service.handle("usage:cached", &Value::Null).await.is_ok());
    assert!(!service.cache_diagnostics().is_empty());
    stop(&service).await;
}

#[tokio::test]
async fn successful_provider_result_survives_staging_failure_with_diagnostic() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    cap.test_fail_stage(true);
    let result = service.handle("usage:read", &Value::Null).await.unwrap();
    assert_eq!(result["providers"][0]["status"], "ok");
    assert!(service.cache_diagnostics().iter().any(|d| d.slot == "accounts" && d.issue.contains("staging failure")));
    cap.test_fail_stage(false);
    stop(&service).await;
    let reopened = UsageService::open(&cap, h.options()).await.unwrap();
    assert_eq!(reopened.handle("usage:cached", &Value::Null).await.unwrap()["providers"].as_array().unwrap().len(), 4);
    stop(&reopened).await;
}
#[tokio::test]
async fn pricing_event_arrives_once_after_failed_flush_is_retried() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    let obstruction = cap.test_directory().join("token-prices.json");
    fs::create_dir(&obstruction).unwrap();
    assert!(service.refresh_prices().await.unwrap());
    assert!(h.events.lock().unwrap().is_empty());
    assert_eq!(h.fetches.load(Ordering::SeqCst), 1);
    fs::remove_dir(obstruction).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while h.events.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(*h.events.lock().unwrap(), vec![json!(["token-usage:changed", {}])]);
    service.flush().await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(h.events.lock().unwrap().len(), 1);
    assert_eq!(h.fetches.load(Ordering::SeqCst), 1);
    stop(&service).await;
}
#[tokio::test]
async fn retry_is_idle_when_clean_and_bounds_failed_write_attempts_over_sixty_seconds() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    tokio::task::yield_now().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_eq!(cap.test_write_attempts(), 0);
    tokio::time::resume();
    let obstruction = cap.test_directory().join("token-prices.json");
    fs::create_dir(&obstruction).unwrap();
    service.refresh_prices().await.unwrap();
    let before = cap.test_write_attempts();
    tokio::time::pause();
    for _ in 0..60 {
        tokio::time::advance(Duration::from_secs(1)).await;
        std::thread::sleep(Duration::from_millis(2));
        for _ in 0..5 {
            tokio::task::yield_now().await;
        }
    }
    let attempts = cap.test_write_attempts() - before;
    assert!((1..=8).contains(&attempts), "{attempts} writes in 60 seconds");
    tokio::time::resume();
    fs::remove_dir(obstruction).unwrap();
    stop(&service).await;
}

#[tokio::test]
async fn concurrent_bounded_shutdown_reports_retain_quota_scan_and_price_ownership() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let mut options = h.options();
    let pending = Arc::new(AtomicBool::new(false));
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    struct Count(Arc<AtomicUsize>);
    impl Drop for Count {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let original = options.accounts.read.clone();
    let p = pending.clone();
    let e = started.clone();
    let d = dropped.clone();
    options.accounts.read = Arc::new(move |provider, id| {
        if !p.load(Ordering::SeqCst) {
            return original(provider, id);
        }
        let e = e.clone();
        let guard = Count(d.clone());
        Box::pin(async move {
            let _guard = guard;
            e.add_permits(1);
            std::future::pending().await
        })
    });
    let e = started.clone();
    let d = dropped.clone();
    options.fetch_catalog = Arc::new(move || {
        let e = e.clone();
        let guard = Count(d.clone());
        Box::pin(async move {
            let _guard = guard;
            e.add_permits(1);
            std::future::pending().await
        })
    });
    let service = UsageService::open(&cap, options).await.unwrap();
    let before = service.handle("usage:read", &Value::Null).await.unwrap();
    pending.store(true, Ordering::SeqCst);
    h.events.lock().unwrap().clear();
    let (tx, entered) = std::sync::mpsc::channel();
    let (resume, rx) = std::sync::mpsc::channel();
    *service.scan.gate.lock().unwrap() = Some((tx, rx));
    let s = service.clone();
    let quota = tokio::spawn(async move { s.handle("usage:read", &Value::Null).await });
    service.handle("token-usage:read", &Value::Null).await.unwrap();
    entered_async(entered).await;
    started.acquire_many(5).await.unwrap().forget();
    let a = service.clone();
    let b = service.clone();
    let first = tokio::spawn(async move { a.shutdown_report(Duration::from_millis(20)).await });
    let second = tokio::spawn(async move { b.shutdown_report(Duration::from_millis(20)).await });
    assert_eq!(first.await.unwrap(), ShutdownReport::Pending);
    assert_eq!(second.await.unwrap(), ShutdownReport::Pending);
    assert_eq!(dropped.load(Ordering::SeqCst), 5);
    assert!(quota.await.unwrap().is_err());
    assert!(cap.open().is_err());
    resume.send(()).unwrap();
    assert_eq!(service.shutdown_report(Duration::from_secs(2)).await, ShutdownReport::Complete(Ok(())));
    assert!(h.events.lock().unwrap().is_empty());
    let reopened = UsageService::open(&cap, h.options()).await.unwrap();
    let cached = reopened.handle("usage:cached", &Value::Null).await.unwrap();
    for provider in before["providers"].as_array().unwrap() {
        assert_eq!(
            cached["providers"].as_array().unwrap().iter().find(|p| p["provider"] == provider["provider"]).unwrap()["windows"],
            provider["windows"]
        );
    }
    assert!(!reopened.scan.scanner.lock().unwrap().finished());
    assert!(reopened.prices.pricing.lock().unwrap().current().is_none());
    stop(&reopened).await;
}
#[tokio::test]
async fn dropped_service_requests_cleanup_and_keeps_capability_until_scan_exits() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    let (tx, entered) = std::sync::mpsc::channel();
    let (resume, rx) = std::sync::mpsc::channel();
    *service.scan.gate.lock().unwrap() = Some((tx, rx));
    service.handle("token-usage:read", &Value::Null).await.unwrap();
    entered_async(entered).await;
    drop(service);
    assert!(cap.open().is_err());
    resume.send(()).unwrap();
    let cache = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match cap.open() {
                Ok(c) => return c,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => tokio::time::sleep(Duration::from_millis(1)).await,
                Err(e) => panic!("{e}"),
            }
        }
    })
    .await
    .unwrap();
    cache.shutdown().await.unwrap();
}
#[test]
fn cooperative_scan_cancellation_keeps_only_complete_line_offsets_and_resumes() {
    let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/persistence.json")).unwrap();
    let copy = tempfile::tempdir().unwrap();
    let bytes = fixture["line"].as_str().unwrap().repeat(25_000);
    fs::write(copy.path().join("fixture.jsonl"), bytes.as_bytes()).unwrap();
    let root = CopiedRoot::new("claude", fs::canonicalize(copy.path()).unwrap()).unwrap();
    let mut scanner = Scanner::new(vec![root], crate::scan::ScanCache::default());
    let cancel = ScanCancellation::default();
    cancel.test_cancel_after_chunks(1);
    assert_eq!(scanner.scan_cancellable(NOW, &cancel).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
    let entry = scanner.cache().files.values().next().unwrap();
    assert!(entry.offset > 0 && entry.offset < bytes.len() as u64);
    assert!(!scanner.finished());
    assert!(scanner.scan(NOW).unwrap());
    assert!(scanner.finished());
    assert_eq!(scanner.rows()[0]["requests"], 1.0);
}

#[tokio::test]
async fn final_export_recovers_scanner_and_pricing_poison_independently() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    service.handle("usage:read", &Value::Null).await.unwrap();
    service.refresh_prices().await.unwrap();
    service.scan.start(NOW).unwrap().await.unwrap();
    let expected_quota = service.accounts.stores();
    assert!(service.prices.pricing.lock().unwrap().current().is_some());
    service.flush().await.unwrap();
    let scan_bytes = fs::read(cap.test_directory().join("token-usage.json")).unwrap();
    let price_bytes = fs::read(cap.test_directory().join("token-prices.json")).unwrap();
    for poison_scan in [true, false] {
        assert!(guarded_sync(|| {
            if poison_scan {
                let _guard = service.scan.scanner.lock().unwrap();
                panic!("fixture scanner poison");
            } else {
                let _guard = service.prices.pricing.lock().unwrap();
                panic!("fixture pricing poison");
            }
        })
        .is_err());
    }
    assert_eq!(service.shutdown().await, ShutdownReport::Complete(Ok(())));
    assert_eq!(service.cache_diagnostics().iter().filter(|d| d.issue.contains("poisoned") && d.issue.contains("discarded")).count(), 2);
    let cache = cap.open().unwrap();
    for (selection, value) in expected_quota {
        assert_eq!(cache.load_quota(&selection).unwrap().to_json(), value);
    }
    assert_eq!(fs::read(cap.test_directory().join("token-usage.json")).unwrap(), scan_bytes);
    assert_eq!(fs::read(cap.test_directory().join("token-prices.json")).unwrap(), price_bytes);
    assert_eq!(cache.load_scan().unwrap().finished_at, Some(NOW));
    assert!(cache.load_pricing().unwrap().current().is_some());
    cache.shutdown().await.unwrap();
}

#[tokio::test]
async fn export_panic_does_not_prevent_other_state_exports() {
    let cap = TempCache::fresh().unwrap();
    let cache = cap.open().unwrap();
    let mut errors = Vec::new();
    export_state(&cache, "accounts", &mut errors, || panic!("fixture export panic"));
    export_state(&cache, "scanner", &mut errors, || {
        cache.save_scan(&crate::scan::ScanCache { finished_at: Some(NOW), ..Default::default() })
    });
    assert_eq!(errors, ["accounts: export panicked"]);
    cache.shutdown().await.unwrap();
    let next = cap.open().unwrap();
    assert_eq!(next.load_scan().unwrap().finished_at, Some(NOW));
    assert!(next.diagnostics().iter().any(|d| d.slot == "accounts" && d.issue == "export panicked"));
    next.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_scan_reports_stopped_without_fault_diagnostic() {
    let cap = TempCache::fresh().unwrap();
    let service = UsageService::open(&cap, Harness::new().options()).await.unwrap();
    service.scan.cancel.cancel();
    assert_eq!(service.scan.start(NOW).unwrap().await.unwrap_err(), "Scanner stopped");
    assert!(service.cache_diagnostics().is_empty());
    stop(&service).await;
    assert_eq!(service.handle("token-usage:read", &Value::Null).await.unwrap_err(), "Usage service stopped");
}

#[test]
fn drop_without_runtime_leaves_diagnostic_for_next_owner() {
    let cap = TempCache::fresh().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let service = runtime.block_on(UsageService::open(&cap, Harness::new().options())).unwrap();
    drop(runtime);
    drop(service);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let cache = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match cap.open() {
                    Ok(cache) => break cache,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => tokio::time::sleep(Duration::from_millis(1)).await,
                    Err(error) => panic!("{error}"),
                }
            }
        })
        .await
        .unwrap();
        assert!(cache.diagnostics().iter().any(|d| d.issue.contains("dropped_without_export")));
        cache.shutdown().await.unwrap();
    });
}

#[tokio::test]
async fn default_shutdown_reports_pending_and_retains_lease_until_worker_exits() {
    let cap = TempCache::fresh().unwrap();
    let service = UsageService::open(&cap, Harness::new().options()).await.unwrap();
    let (tx, entered) = std::sync::mpsc::channel();
    let (resume, rx) = std::sync::mpsc::channel();
    *service.scan.gate.lock().unwrap() = Some((tx, rx));
    let scanning = service.scan.start(NOW).unwrap();
    entered_async(entered).await;
    assert_eq!(service.shutdown().await, ShutdownReport::Pending);
    assert_eq!(cap.open().err().unwrap().kind(), std::io::ErrorKind::AlreadyExists);
    resume.send(()).unwrap();
    assert_eq!(scanning.await.unwrap_err(), "Scanner stopped");
    assert_eq!(service.shutdown().await, ShutdownReport::Complete(Ok(())));
    cap.open().unwrap().shutdown().await.unwrap();
}

#[tokio::test]
async fn scanner_recovers_after_caught_panic_by_rescanning_only_supplied_roots() {
    let cap = TempCache::fresh().unwrap();
    let copy = tempfile::tempdir().unwrap();
    let transcript = copy.path().join("fixture.jsonl");
    let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/persistence.json")).unwrap();
    fs::write(&transcript, fixture["line"].as_str().unwrap()).unwrap();
    let mut options = Harness::new().options();
    options.roots = vec![CopiedRoot::new("claude", fs::canonicalize(copy.path()).unwrap()).unwrap()];
    let service = UsageService::open(&cap, options).await.unwrap();
    let (before, _) = service.scan.start(NOW).unwrap().await.unwrap();
    assert_eq!(before.as_array().unwrap().len(), 1);
    assert!(guarded_sync(|| {
        let _guard = service.scan.scanner.lock().unwrap();
        panic!("fixture interrupted scanner mutation");
    })
    .is_err());
    fs::remove_file(&transcript).unwrap();
    let (after, changed) = service.scan.start(NOW + 1).unwrap().await.unwrap();
    assert!(changed, "restoration must update the token owner's rows");
    assert_eq!(after, before, "recovery must retain known history after the source file was deleted");
    assert!(!service.scan.scanner.is_poisoned());
    assert!(service.cache_diagnostics().iter().any(|d| d.slot == "scanner" && d.issue.contains("discarded")));
    fs::write(&transcript, fixture["line"].as_str().unwrap()).unwrap();
    let (rescanned, _) = service.scan.start(NOW + 2).unwrap().await.unwrap();
    assert_eq!(rescanned, before, "recovery keeps the explicitly supplied root");
    stop(&service).await;
}

#[tokio::test]
async fn pricing_reads_and_start_recover_poison_without_serving_partial_catalog() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let service = UsageService::open(&cap, h.options()).await.unwrap();
    assert!(service.refresh_prices().await.unwrap());
    for access in ["models", "status", "start"] {
        let models = service.prices.models();
        let status = service.prices.status();
        assert!(guarded_sync(|| {
            let mut pricing = service.prices.pricing.lock().unwrap();
            pricing.complete(Some(&json!({"claude-partial":{"input_cost_per_token":999,"output_cost_per_token":999}})), NOW);
            panic!("fixture interrupted pricing mutation");
        })
        .is_err());
        match access {
            "models" => assert_eq!(service.prices.models(), models),
            "status" => assert_eq!(service.prices.status(), status),
            _ => {}
        }
        h.now.fetch_add(25 * 60 * 60 * 1000, Ordering::SeqCst);
        assert!(service.refresh_prices().await.unwrap(), "restored catalogs refresh on their normal TTL");
        assert!(!service.prices.pricing.is_poisoned());
        assert!(service.prices.models().get("claude-partial").is_none());
        assert!(service.prices.models().get("claude-fixture").is_some());
    }
    assert_eq!(h.fetches.load(Ordering::SeqCst), 4);
    assert!(service.cache_diagnostics().iter().any(|d| d.slot == "pricing" && d.issue.contains("discarded")));
    stop(&service).await;
}

#[tokio::test]
async fn cancelling_pending_price_callback_recovers_poison_in_reset_guard() {
    let cap = TempCache::fresh().unwrap();
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let signal = started.clone();
    let mut options = Harness::new().options();
    options.fetch_catalog = Arc::new(move || {
        let signal = signal.clone();
        Box::pin(async move {
            signal.add_permits(1);
            std::future::pending().await
        })
    });
    let service = UsageService::open(&cap, options).await.unwrap();
    let s = service.clone();
    let refreshing = tokio::spawn(async move { s.refresh_prices().await });
    started.acquire().await.unwrap().forget();
    assert!(guarded_sync(|| {
        let _guard = service.prices.pricing.lock().unwrap();
        panic!("fixture poisoned pending price state");
    })
    .is_err());
    stop(&service).await;
    assert!(refreshing.await.unwrap().is_err());
    assert!(!service.prices.pricing.is_poisoned());
    assert!(service.cache_diagnostics().iter().any(|d| d.slot == "pricing" && d.issue.contains("discarded")));
    cap.open().unwrap().shutdown().await.unwrap();
}

fn poison_usage_states(service: &UsageService) {
    assert!(guarded_sync(|| {
        let mut scanner = service.scan.scanner.lock().unwrap();
        scanner.restore_after_panic(ScanCache::default());
        panic!("fixture interrupted scan erased working state");
    })
    .is_err());
    assert!(guarded_sync(|| {
        let mut pricing = service.prices.pricing.lock().unwrap();
        *pricing = Pricing::default();
        panic!("fixture interrupted catalog erased working state");
    })
    .is_err());
}
fn history_options(h: &Harness, root: &std::path::Path) -> ServiceOptions {
    let mut options = h.options();
    options.roots = vec![CopiedRoot::new("claude", root.to_path_buf()).unwrap()];
    options
}
fn copied_history() -> (tempfile::TempDir, std::path::PathBuf) {
    let copy = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(copy.path()).unwrap().join("copied");
    fs::create_dir(&root).unwrap();
    let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/persistence.json")).unwrap();
    fs::write(root.join("fixture.jsonl"), fixture["line"].as_str().unwrap()).unwrap();
    (copy, root)
}

#[tokio::test]
async fn poisoned_shutdown_preserves_disk_bytes_and_rehydrated_deleted_history() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let (_copy, root) = copied_history();
    let seed = UsageService::open(&cap, history_options(&h, &root)).await.unwrap();
    let (rows, _) = seed.scan.start(NOW).unwrap().await.unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert!(seed.refresh_prices().await.unwrap());
    stop(&seed).await;
    let scan_bytes = fs::read(cap.test_directory().join("token-usage.json")).unwrap();
    let price_bytes = fs::read(cap.test_directory().join("token-prices.json")).unwrap();
    fs::remove_file(root.join("fixture.jsonl")).unwrap();
    let mut options = history_options(&h, &root);
    options.fetch_catalog = Arc::new(|| Box::pin(async { Err(()) }));
    let service = UsageService::open(&cap, options).await.unwrap();
    poison_usage_states(&service);
    h.now.fetch_add(25 * 60 * 60 * 1000, Ordering::SeqCst);
    assert!(service.prices.models().get("claude-fixture").is_some());
    assert!(!service.refresh_prices().await.unwrap());
    let attempts = cap.test_write_attempts();
    stop(&service).await;
    assert_eq!(cap.test_write_attempts(), attempts, "poisoned shutdown must not stage replacement files");
    assert_eq!(fs::read(cap.test_directory().join("token-usage.json")).unwrap(), scan_bytes);
    assert_eq!(fs::read(cap.test_directory().join("token-prices.json")).unwrap(), price_bytes);
    for slot in ["scanner", "pricing"] {
        assert!(service.cache_diagnostics().iter().any(|d| d.slot == slot && d.issue.contains("not exported")));
    }
    let next = UsageService::open(&cap, history_options(&h, &root)).await.unwrap();
    assert_eq!(next.scan.scanner.lock().unwrap().rows(), rows);
    assert!(next.prices.models().get("claude-fixture").is_some());
    stop(&next).await;
}

#[tokio::test]
async fn recovery_with_missing_roots_and_failed_refresh_preserves_last_good_snapshots() {
    let cap = TempCache::fresh().unwrap();
    let h = Harness::new();
    let (_copy, root) = copied_history();
    let fail = Arc::new(AtomicBool::new(false));
    let mut options = history_options(&h, &root);
    let original = options.fetch_catalog.clone();
    let failing = fail.clone();
    options.fetch_catalog = Arc::new(move || if failing.load(Ordering::SeqCst) { Box::pin(async { Err(()) }) } else { original() });
    let service = UsageService::open(&cap, options).await.unwrap();
    let (before, _) = service.scan.start(NOW).unwrap().await.unwrap();
    service.refresh_prices().await.unwrap();
    service.flush().await.unwrap();
    let price_bytes = fs::read(cap.test_directory().join("token-prices.json")).unwrap();
    let prices = service.prices.models();
    fs::remove_file(root.join("fixture.jsonl")).unwrap();
    fs::remove_dir(&root).unwrap();
    poison_usage_states(&service);
    h.now.fetch_add(25 * 60 * 60 * 1000, Ordering::SeqCst);
    fail.store(true, Ordering::SeqCst);
    let (after, _) = service.scan.start(h.now.load(Ordering::SeqCst)).unwrap().await.unwrap();
    assert_eq!(after, before, "an unreadable root cannot rebuild deleted history; restore it first");
    assert_eq!(service.prices.models(), prices);
    assert!(!service.refresh_prices().await.unwrap());
    service.flush().await.unwrap();
    assert_eq!(fs::read(cap.test_directory().join("token-prices.json")).unwrap(), price_bytes);
    assert_eq!(crate::transcript::rows(&service.cache.load_scan().unwrap().files), before);
    assert!(service.prices.recovered.load(Ordering::Acquire));
    fail.store(false, Ordering::SeqCst);
    h.now.fetch_add(900_001, Ordering::SeqCst);
    assert!(service.refresh_prices().await.unwrap());
    assert!(!service.prices.recovered.load(Ordering::Acquire));
    assert_ne!(fs::read(cap.test_directory().join("token-prices.json")).unwrap(), price_bytes);
    stop(&service).await;
    let next = cap.open().unwrap();
    assert_eq!(crate::transcript::rows(&next.load_scan().unwrap().files), before);
    next.shutdown().await.unwrap();
}
