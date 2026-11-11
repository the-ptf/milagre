use milagre_usage::{
    accounts::{AccountSnapshot, Selection, UsageAccounts, UsageAccountsOptions},
    limits::provider_result,
    store::UsageStore,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
const NOW: i64 = 1793361600000;
struct Harness {
    model: Arc<Mutex<Value>>,
    now: Arc<AtomicI64>,
    reads: Arc<Mutex<Vec<Value>>>,
    events: Arc<Mutex<Vec<Value>>>,
    ready: Arc<AtomicUsize>,
}
impl Harness {
    fn new(model: Value) -> Self {
        Self {
            model: Arc::new(Mutex::new(model)),
            now: Arc::new(AtomicI64::new(NOW)),
            reads: Arc::new(Mutex::new(vec![])),
            events: Arc::new(Mutex::new(vec![])),
            ready: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn options(&self) -> UsageAccountsOptions {
        UsageAccountsOptions {
            scopes: {
                let m = self.model.clone();
                Arc::new(move || {
                    let v = m.lock().unwrap()["scopes"].clone();
                    Box::pin(async move { Ok(serde_json::from_value(v).unwrap()) })
                })
            },
            selected: {
                let m = self.model.clone();
                Arc::new(move |_| serde_json::from_value(m.lock().unwrap()["selection"].clone()).unwrap())
            },
            list: {
                let m = self.model.clone();
                Arc::new(move || {
                    let snapshot: AccountSnapshot = serde_json::from_value(m.lock().unwrap()["identities"].clone()).unwrap();
                    Box::pin(async move { Ok(snapshot) })
                })
            },
            read: {
                let reads = self.reads.clone();
                let m = self.model.clone();
                let now = self.now.clone();
                Arc::new(move |provider, id| {
                    reads.lock().unwrap().push(json!([provider, id]));
                    let status = m.lock().unwrap()["status"].as_str().unwrap_or("ok").to_owned();
                    let now = now.load(Ordering::SeqCst);
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
                })
            },
            ready: {
                let ready = self.ready.clone();
                Arc::new(move || {
                    ready.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async {})
                })
            },
            now: {
                let now = self.now.clone();
                Arc::new(move || now.load(Ordering::SeqCst))
            },
            emit: {
                let events = self.events.clone();
                Arc::new(move |name, payload| events.lock().unwrap().push(json!([name, payload])))
            },
            read_usage_override: None,
        }
    }
}
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/accounts.json")).unwrap()
}
#[tokio::test]
async fn owner_envelopes_reads_and_events_match_original_node_commands() {
    let f = fixture();
    let h = Harness::new(f["initial"].clone());
    let owner = UsageAccounts::new(h.options(), HashMap::new());
    for (i, trace) in f["traces"].as_array().unwrap().iter().enumerate() {
        let input = &trace["input"];
        if let Some(patch) = input["set"].as_object() {
            for (k, v) in patch {
                h.model.lock().unwrap()[k] = v.clone();
            }
        }
        h.now.store(input["now"].as_i64().unwrap(), Ordering::SeqCst);
        h.reads.lock().unwrap().clear();
        h.events.lock().unwrap().clear();
        let result = owner.handle(input["command"].as_str().unwrap(), &input["scope"]).await;
        let (result, error) = match result {
            Ok(v) => (v, Value::Null),
            Err(e) => (Value::Null, json!(e)),
        };
        let mut reads = h.reads.lock().unwrap().clone();
        reads.sort_by_key(Value::to_string);
        let got = json!({"result":result,"error":error,"reads":reads,"events":h.events.lock().unwrap().clone()});
        assert_eq!(got, trace["expected"], "trace {i}");
    }
    assert_eq!(h.ready.load(Ordering::SeqCst), 1);
    owner.shutdown().await;
    assert_eq!(owner.in_flight(), 0);
}
#[tokio::test]
async fn selection_is_pinned_during_read_and_removed_accounts_keep_the_original_id() {
    let h = Harness::new(fixture()["initial"].clone());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let mut options = h.options();
    let original = options.read.clone();
    options.read = {
        let gate = gate.clone();
        let started = started.clone();
        Arc::new(move |p, id| {
            let future = original(p, id);
            let gate = gate.clone();
            let started = started.clone();
            Box::pin(async move {
                started.add_permits(1);
                gate.acquire().await.unwrap().forget();
                future.await
            })
        })
    };
    let owner = UsageAccounts::new(options, HashMap::new());
    let reading = {
        let owner = owner.clone();
        tokio::spawn(async move { owner.handle("usage:read", &json!("/project")).await })
    };
    started.acquire_many(4).await.unwrap().forget();
    {
        let mut m = h.model.lock().unwrap();
        m["selection"] = json!(Selection::default());
        m["identities"]["providers"][0]["accounts"].as_array_mut().unwrap().retain(|a| a["id"] != "work");
    }
    gate.add_permits(4);
    let result = reading.await.unwrap().unwrap();
    assert_eq!(result["accountKey"], "work-default");
    assert_eq!(result["providers"][0]["account"], json!({"id":"work","label":"Removed account"}));
    assert_eq!(result["providers"][0]["windows"][0]["usedPercent"], 22);
    let cache = owner.handle("usage:cached", &json!("/project")).await.unwrap();
    assert_eq!(cache, json!({"providers":[],"accountKey":"default-default"}));
    owner.shutdown().await;
}
#[tokio::test]
async fn all_accounts_pins_unrelated_providers_and_keeps_read_start_metadata() {
    let h = Harness::new(fixture()["initial"].clone());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let mut options = h.options();
    let original = options.read.clone();
    options.selected = Arc::new(|_| panic!("all-accounts must not consult computer defaults"));
    options.read = {
        let gate = gate.clone();
        let started = started.clone();
        Arc::new(move |p, id| {
            let future = original(p, id);
            let gate = gate.clone();
            let started = started.clone();
            Box::pin(async move {
                started.add_permits(1);
                gate.acquire().await.unwrap().forget();
                future.await
            })
        })
    };
    let owner = UsageAccounts::new(options, HashMap::new());
    let reading = {
        let owner = owner.clone();
        tokio::spawn(async move { owner.handle("usage:accounts:read", &Value::Null).await })
    };
    started.acquire_many(5).await.unwrap().forget();
    h.model.lock().unwrap()["identities"]["providers"] = json!([]);
    gate.add_permits(5);
    let result = reading.await.unwrap().unwrap();
    assert_eq!(result["providers"].as_array().unwrap().len(), 7);
    assert_eq!(result["providers"][1]["account"]["default"], true);
    let mut selections: Vec<_> = owner.stores().into_iter().map(|(s, _)| s.account_key()).collect();
    selections.sort();
    assert_eq!(selections, vec!["default-default", "default-spare", "signed-out-default", "unknown-default", "work-default"]);
    owner.shutdown().await;
}
#[tokio::test]
async fn cached_commands_do_not_wait_for_readiness_and_scoped_cache_uses_only_last_good() {
    let h = Harness::new(fixture()["initial"].clone());
    let mut options = h.options();
    options.ready = Arc::new(|| Box::pin(std::future::pending()));
    let mut seed = UsageStore::default();
    seed.set_last("claude",&json!({"windows":[{"id":"session","label":"Session","shortLabel":"5h","usedPercent":42,"resetsAt":null}],"updatedAt":"2026-10-30T11:00:00Z"}));
    let selection: Selection = serde_json::from_value(h.model.lock().unwrap()["selection"].clone()).unwrap();
    let owner = UsageAccounts::new(options, HashMap::from([(selection, seed)]));
    let result =
        tokio::time::timeout(std::time::Duration::from_secs(1), owner.handle("usage:cached", &json!("/project"))).await.unwrap().unwrap();
    assert_eq!(result["providers"][0]["windows"][0]["usedPercent"], 42);
    assert!(h.reads.lock().unwrap().is_empty());
    assert!(h.events.lock().unwrap().is_empty());
    owner.shutdown().await;
}
#[tokio::test]
async fn override_still_validates_scope_but_skips_environment_and_events() {
    let h = Harness::new(fixture()["initial"].clone());
    let mut options = h.options();
    options.ready = Arc::new(|| Box::pin(std::future::pending()));
    options.read_usage_override = Some(Arc::new(|| Box::pin(async { Ok(json!({"fixture":true})) })));
    let owner = UsageAccounts::new(options, HashMap::new());
    assert!(owner.handle("usage:read", &json!("/missing")).await.is_err());
    assert_eq!(owner.handle("usage:read", &Value::Null).await.unwrap(), json!({"fixture":true}));
    assert!(h.events.lock().unwrap().is_empty());
    owner.shutdown().await;
}
#[tokio::test]
async fn account_owner_shutdown_cancels_callbacks_and_rejects_new_commands() {
    let h = Harness::new(fixture()["initial"].clone());
    let mut options = h.options();
    let started = Arc::new(tokio::sync::Semaphore::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    struct DropCount(Arc<AtomicUsize>);
    impl Drop for DropCount {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    options.read = {
        let started = started.clone();
        let dropped = dropped.clone();
        Arc::new(move |_, _| {
            let started = started.clone();
            let guard = DropCount(dropped.clone());
            Box::pin(async move {
                let _guard = guard;
                started.add_permits(1);
                std::future::pending().await
            })
        })
    };
    let owner = UsageAccounts::new(options, HashMap::new());
    let reading = {
        let owner = owner.clone();
        tokio::spawn(async move { owner.handle("usage:read", &Value::Null).await })
    };
    started.acquire_many(4).await.unwrap().forget();
    owner.shutdown().await;
    assert_eq!(reading.await.unwrap().unwrap_err(), "Usage owner stopped");
    assert_eq!(dropped.load(Ordering::SeqCst), 4);
    assert_eq!(owner.in_flight(), 0);
    assert!(h.events.lock().unwrap().is_empty());
    assert_eq!(owner.handle("usage:cached", &Value::Null).await.unwrap_err(), "Usage owner stopped");
}
#[tokio::test]
async fn account_metadata_and_emitter_panics_do_not_strand_owner() {
    let h = Harness::new(fixture()["initial"].clone());
    let mut options = h.options();
    let list = options.list.clone();
    let count = Arc::new(AtomicUsize::new(0));
    options.list = Arc::new(move || {
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            panic!("fixture metadata panic");
        }
        list()
    });
    options.emit = Arc::new(|_, _| panic!("fixture emitter panic"));
    let owner = UsageAccounts::new(options, HashMap::new());
    assert_eq!(owner.handle("usage:accounts:cached", &Value::Null).await.unwrap_err(), "Couldn't read usage.");
    assert!(owner.handle("usage:read", &Value::Null).await.is_ok());
    owner.shutdown().await;
    assert_eq!(owner.in_flight(), 0);
}

#[tokio::test]
async fn structural_selection_keys_isolate_legacy_collisions_and_export_unused_seeds() {
    let h = Harness::new(fixture()["initial"].clone());
    let first = Selection { claude: "a-b".into(), codex: "c".into(), ..Selection::default() };
    let second = Selection { claude: "a".into(), codex: "b-c".into(), ..Selection::default() };
    assert_eq!(first.account_key(), second.account_key());
    let mut seed = UsageStore::default();
    seed.set_last(
        "claude",
        &provider_result(
            "claude",
            NOW,
            "ok",
            json!([{ "id": "session", "label": "Session", "shortLabel": "5h", "usedPercent": 42, "resetsAt": null }]),
            None,
        ),
    );
    let expected = seed.to_json();
    let owner = UsageAccounts::new(h.options(), HashMap::from([(first.clone(), seed)]));
    assert_eq!(owner.stores(), vec![(first.clone(), expected.clone())]);
    h.model.lock().unwrap()["selection"] = json!(second);
    assert_eq!(owner.handle("usage:cached", &Value::Null).await.unwrap()["providers"], json!([]));
    h.model.lock().unwrap()["selection"] = json!(first);
    assert_eq!(owner.handle("usage:cached", &Value::Null).await.unwrap()["providers"].as_array().unwrap().len(), 1);
    assert_eq!(owner.stores().len(), 2);
    assert_eq!(owner.stores().into_iter().find(|(s, _)| s == &first).unwrap().1, expected);
    owner.shutdown().await;
}
