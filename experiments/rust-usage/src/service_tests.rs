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
    tokio::time::timeout(Duration::from_secs(3), s.shutdown()).await.unwrap().unwrap();
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
    stopping.await.unwrap();
    assert!(h.events.lock().unwrap().iter().all(|e| e[0] != "token-usage:changed"));
    let reopened = cap.open().unwrap();
    assert!(reopened.load_scan().unwrap().finished_at.is_some());
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
    assert!(service.shutdown().await.is_err());
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
    shutdown.await.unwrap();
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
    assert!(service.handle("usage:cached", &Value::Null).await.is_err());
    assert_eq!(service.loaded_cache_bytes(), charged);
    assert!(!service.cache_diagnostics().is_empty());
    stop(&service).await;
}
