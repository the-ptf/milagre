use super::*;
use milagre_usage::limits::provider_result;
const NOW: i64 = 1793361600000;
const ACCOUNT: &str = "12345678-1234-1234-1234-123456789abc";
const LINK: &str = "22345678-1234-1234-1234-123456789abc";
fn seed() -> SyntheticSeed {
    let mut quotas = Vec::new();
    let mut observations = Vec::new();
    for (provider, id) in READ_ORDER.into_iter().map(|p| (p, "default")).chain(std::iter::once(("claude", ACCOUNT))) {
        quotas.push(SyntheticQuota {
            provider: provider.into(),
            account: id.into(),
            result: provider_result(
                provider,
                NOW,
                "ok",
                json!([{"id":"session","label":"Session","shortLabel":"5h","usedPercent":if id==ACCOUNT{22}else{11},"resetsAt":null}]),
                None,
            ),
        });
        observations.push((provider.into(), id.into(), IdentityState::Ready));
    }
    SyntheticSeed {
        accounts: Some(json!({"accounts":[{"provider":"claude","id":ACCOUNT,"label":"Saved"}],"selected":{},"scopes":{}}).to_string()),
        projects: vec!["one".into(), "two".into()],
        links: vec![(LINK.into(), vec!["one".into(), "two".into()])],
        quotas,
        observations,
        now: NOW,
    }
}
async fn inspect(owner: &FixtureOwner) -> (Vec<Value>, HashMap<Selection, Value>) {
    let (tx, rx) = oneshot::channel();
    owner.tx.send(Request::Inspect(tx)).await.unwrap();
    rx.await.unwrap()
}
async fn paths(owner: &FixtureOwner) -> (PathBuf, PathBuf) {
    let (tx, rx) = oneshot::channel();
    owner.tx.send(Request::Paths(tx)).await.unwrap();
    rx.await.unwrap()
}
async fn pause(owner: &FixtureOwner, provider: &str) -> Arc<Pause> {
    let pause = Arc::new(Pause { entered: Semaphore::new(0), resume: Semaphore::new(0) });
    let (tx, rx) = oneshot::channel();
    owner.tx.send(Request::Pause(provider.into(), pause.clone(), tx)).await.unwrap();
    rx.await.unwrap();
    pause
}
async fn entered(pause: &Pause) {
    tokio::time::timeout(std::time::Duration::from_secs(3), pause.entered.acquire()).await.unwrap().unwrap().forget();
}
async fn persisted(owner: &FixtureOwner) -> Value {
    owner.close().await.unwrap();
    let disk = owner._cache.open().unwrap();
    let value = disk.load_quota(&Selection::default()).unwrap().to_json();
    disk.shutdown().await.unwrap();
    value
}
#[tokio::test]
async fn commands_cache_and_account_selection_are_isolated() {
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let session = owner.capture(FixtureScope::Computer).await.unwrap();
    assert_eq!(session.handle(QuotaCommand::Cached).await.unwrap()["providers"], json!([]));
    let first = session.handle(QuotaCommand::Read).await.unwrap();
    assert_eq!(first["accountKey"], "default-default");
    assert_eq!(first["providers"].as_array().unwrap().len(), 4);
    assert_eq!(session.handle(QuotaCommand::Cached).await.unwrap()["providers"].as_array().unwrap().len(), 4);
    let all = session.handle(QuotaCommand::AccountsRead).await.unwrap();
    assert_eq!(all["providers"].as_array().unwrap().len(), 5);
    assert_eq!(session.handle(QuotaCommand::AccountsCached).await.unwrap(), all);
    owner.mutate(FixtureMutation::Select { provider: "claude".into(), account: ACCOUNT.into() }).await.unwrap();
    assert!(session.handle(QuotaCommand::Cached).await.is_err());
    let selected = owner.capture(FixtureScope::Computer).await.unwrap();
    let value = selected.handle(QuotaCommand::Read).await.unwrap();
    assert_eq!(value["providers"][0]["windows"][0]["usedPercent"], 22);
    assert_eq!(value["accountKey"], format!("{ACCOUNT}-default"));
    assert_eq!(persisted(&owner).await["claude"]["last"]["windows"][0]["usedPercent"], 11);
}
#[tokio::test]
async fn readiness_is_required_and_aba_revokes_old_capture() {
    let mut input = seed();
    input.observations.clear();
    let owner = FixtureOwner::create(input).await.unwrap();
    let session = owner.capture(FixtureScope::Computer).await.unwrap();
    for command in [QuotaCommand::Read, QuotaCommand::Cached, QuotaCommand::AccountsRead, QuotaCommand::AccountsCached] {
        assert!(session.handle(command).await.unwrap_err().contains("not ready"));
    }
    assert!(owner.mutate(FixtureMutation::Select { provider: "claude".into(), account: ACCOUNT.into() }).await.is_err());
    assert!(inspect(&owner).await.0.is_empty());
    owner.close().await.unwrap();
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let old = owner.capture(FixtureScope::Computer).await.unwrap();
    old.handle(QuotaCommand::Read).await.unwrap();
    for state in [IdentityState::SignedOut, IdentityState::Ready] {
        owner.mutate(FixtureMutation::Observe { provider: "claude".into(), account: "default".into(), state }).await.unwrap();
    }
    assert!(old.handle(QuotaCommand::Cached).await.unwrap_err().contains("revoked"));
    let fresh = owner.capture(FixtureScope::Computer).await.unwrap();
    assert_eq!(fresh.handle(QuotaCommand::Cached).await.unwrap()["providers"].as_array().unwrap().len(), 4);
    owner.close().await.unwrap();
}
#[tokio::test]
async fn removal_during_read_rejects_late_result_and_event_retains_history() {
    let mut input = seed();
    input.accounts = Some(
        json!({"accounts":[{"provider":"claude","id":ACCOUNT,"label":"Saved"}],"selected":{"claude":ACCOUNT},"scopes":{}}).to_string(),
    );
    let owner = FixtureOwner::create(input).await.unwrap();
    // Seed an older success different from the real file's late response (22%).
    let selection = Selection { claude: ACCOUNT.into(), ..Selection::default() };
    let mut history = UsageStore::default();
    for quota in seed().quotas {
        if quota.account == selection.id(&quota.provider) {
            let mut result = quota.result;
            if quota.provider == "claude" {
                result["windows"][0]["usedPercent"] = json!(1);
            }
            history.set_last(&quota.provider, &result);
        }
    }
    let (tx, rx) = oneshot::channel();
    owner.tx.send(Request::SeedHistory(selection.clone(), history.to_json(), tx)).await.unwrap();
    rx.await.unwrap().unwrap();
    let session = Arc::new(owner.capture(FixtureScope::Computer).await.unwrap());
    assert_eq!(
        session.handle(QuotaCommand::Cached).await.unwrap()["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["provider"] == "claude")
            .unwrap()["windows"][0]["usedPercent"],
        1
    );
    let before = inspect(&owner).await;
    let gate = pause(&owner, "claude").await;
    let pending = {
        let session = session.clone();
        tokio::spawn(async move { session.handle(QuotaCommand::Read).await })
    };
    entered(&gate).await;
    owner.mutate(FixtureMutation::Remove { provider: "claude".into(), account: ACCOUNT.into() }).await.unwrap();
    gate.resume.add_permits(1);
    assert!(pending.await.unwrap().is_err());
    assert!(session.handle(QuotaCommand::Cached).await.is_err());
    let after = inspect(&owner).await;
    assert_eq!(after.0, before.0);
    assert_eq!(after.1, before.1);
    owner.close().await.unwrap();
    let disk = owner._cache.open().unwrap();
    let selection = Selection { claude: ACCOUNT.into(), ..Selection::default() };
    assert_eq!(disk.load_quota(&selection).unwrap().to_json(), before.1[&selection]);
    disk.shutdown().await.unwrap();
}
#[tokio::test]
async fn real_registry_mutations_and_account_assignment_revoke_captures() {
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let project = owner.capture(FixtureScope::Project("one".into())).await.unwrap();
    project.handle(QuotaCommand::Read).await.unwrap();
    owner
        .mutate(FixtureMutation::Assign {
            scope: FixtureScope::Project("one".into()),
            provider: "claude".into(),
            account: Some(ACCOUNT.into()),
        })
        .await
        .unwrap();
    assert!(project.handle(QuotaCommand::Cached).await.is_err());
    let fresh = owner.capture(FixtureScope::Project("one".into())).await.unwrap();
    assert_eq!(fresh.handle(QuotaCommand::Read).await.unwrap()["accountKey"], format!("{ACCOUNT}-default"));
    owner.mutate(FixtureMutation::Position { project: "one".into(), x: 12, y: 34 }).await.unwrap();
    assert!(fresh.handle(QuotaCommand::Cached).await.is_err());
    let link = owner.capture(FixtureScope::Link(LINK.into())).await.unwrap();
    link.handle(QuotaCommand::Read).await.unwrap();
    owner.mutate(FixtureMutation::DeleteLink(LINK.into())).await.unwrap();
    assert!(link.handle(QuotaCommand::Cached).await.is_err());
    assert!(owner.capture(FixtureScope::Link(LINK.into())).await.is_err());
    owner.close().await.unwrap();
}
#[tokio::test]
async fn descriptor_replacement_rejects_cached_and_late_results() {
    for ancestor in [false, true] {
        let owner = FixtureOwner::create(seed()).await.unwrap();
        let session = Arc::new(owner.capture(FixtureScope::Computer).await.unwrap());
        session.handle(QuotaCommand::Read).await.unwrap();
        let before = inspect(&owner).await;
        let gate = pause(&owner, "claude").await;
        let pending = {
            let session = session.clone();
            tokio::spawn(async move { session.handle(QuotaCommand::Read).await })
        };
        entered(&gate).await;
        let (home, _) = paths(&owner).await;
        let path = if ancestor { home } else { home.join(".claude") };
        let moved = path.with_extension("old");
        fs::rename(&path, &moved).unwrap();
        fs::create_dir(&path).unwrap();
        gate.resume.add_permits(1);
        assert!(pending.await.unwrap().is_err());
        assert!(session.handle(QuotaCommand::Cached).await.is_err());
        assert_eq!(inspect(&owner).await.0, before.0);
        assert_eq!(persisted(&owner).await, before.1[&Selection::default()]);
    }
}
#[tokio::test]
async fn concurrent_close_cancels_paused_callback_and_keeps_history() {
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let session = Arc::new(owner.capture(FixtureScope::Computer).await.unwrap());
    session.handle(QuotaCommand::Read).await.unwrap();
    let before = inspect(&owner).await;
    let gate = pause(&owner, "claude").await;
    let pending = {
        let session = session.clone();
        tokio::spawn(async move { session.handle(QuotaCommand::Read).await })
    };
    entered(&gate).await;
    let (a, b) =
        tokio::time::timeout(std::time::Duration::from_secs(3), async { tokio::join!(owner.close(), owner.close()) }).await.unwrap();
    a.unwrap();
    b.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(session.handle(QuotaCommand::Cached).await.is_err());
    assert_eq!(persisted(&owner).await, before.1[&Selection::default()]);
}
#[tokio::test]
async fn closed_real_account_owner_refuses_cached_data() {
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let session = owner.capture(FixtureScope::Computer).await.unwrap();
    session.handle(QuotaCommand::Read).await.unwrap();
    owner.mutate(FixtureMutation::CloseAccounts).await.unwrap();
    assert!(session.handle(QuotaCommand::Cached).await.is_err());
    owner.close().await.unwrap();
}
#[tokio::test]
async fn original_node_command_traces_match_through_real_adapter() {
    let fixture: Value = serde_json::from_str(include_str!("../../node-commands.json")).unwrap();
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let computer = owner.capture(FixtureScope::Computer).await.unwrap();
    let mut link = None;
    for trace in fixture["traces"].as_array().unwrap() {
        let input = &trace["input"];
        let session = if input["scope"].is_string() {
            if link.is_none() {
                link = Some(owner.capture(FixtureScope::Link(LINK.into())).await.unwrap());
            }
            link.as_ref().unwrap()
        } else {
            &computer
        };
        let command = match input["command"].as_str().unwrap() {
            "usage:read" => QuotaCommand::Read,
            "usage:cached" => QuotaCommand::Cached,
            "usage:accounts:read" => QuotaCommand::AccountsRead,
            "usage:accounts:cached" => QuotaCommand::AccountsCached,
            _ => panic!("unknown fixture command"),
        };
        let result = session.handle(command).await.unwrap();
        let (tx, rx) = oneshot::channel();
        owner.tx.send(Request::Trace(tx)).await.unwrap();
        let (events, mut reads) = rx.await.unwrap();
        reads.sort_by_key(Value::to_string);
        assert_eq!(json!({"result":result,"error":null,"reads":reads,"events":events}), trace["expected"], "{input}");
    }
    owner.close().await.unwrap();
}
#[tokio::test]
async fn registry_and_readiness_changes_during_read_deny_delivery() {
    for registry in [false, true] {
        let owner = FixtureOwner::create(seed()).await.unwrap();
        let session = Arc::new(owner.capture(FixtureScope::Project("one".into())).await.unwrap());
        let gate = pause(&owner, "claude").await;
        let pending = {
            let session = session.clone();
            tokio::spawn(async move { session.handle(QuotaCommand::Read).await })
        };
        entered(&gate).await;
        let mutation = if registry {
            FixtureMutation::Position { project: "one".into(), x: 7, y: 8 }
        } else {
            FixtureMutation::Observe { provider: "claude".into(), account: "default".into(), state: IdentityState::SignedOut }
        };
        owner.mutate(mutation).await.unwrap();
        gate.resume.add_permits(1);
        assert!(pending.await.unwrap().is_err());
        assert!(inspect(&owner).await.0.is_empty());
        assert!(inspect(&owner).await.1[&Selection::default()]["claude"]["last"].is_null());
        owner.close().await.unwrap();
    }
}
#[tokio::test]
async fn cancelled_close_retains_ownership_until_blocking_reader_exits() {
    let owner = FixtureOwner::create(seed()).await.unwrap();
    let session = Arc::new(owner.capture(FixtureScope::Computer).await.unwrap());
    let gate = Arc::new(BlockingPause { entered: Semaphore::new(0), released: Mutex::new(false), wake: std::sync::Condvar::new() });
    // Release even if an assertion fails so the test cannot strand its own worker.
    struct Release(Arc<BlockingPause>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    let _release = Release(gate.clone());
    let (tx, rx) = oneshot::channel();
    owner.tx.send(Request::Block("claude".into(), gate.clone(), tx)).await.unwrap();
    rx.await.unwrap();
    let pending = {
        let session = session.clone();
        tokio::spawn(async move { session.handle(QuotaCommand::Read).await })
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), gate.entered.acquire()).await.unwrap().unwrap().forget();
    assert!(tokio::time::timeout(std::time::Duration::from_millis(20), owner.close()).await.is_err());
    assert!(pending.await.unwrap().is_err());
    assert!(owner._cache.open().is_err());
    gate.release();
    tokio::time::timeout(std::time::Duration::from_secs(3), owner.close()).await.unwrap().unwrap();
    assert!(session.handle(QuotaCommand::Cached).await.is_err());
    let disk = owner._cache.open().unwrap();
    assert!(disk.load_quota(&Selection::default()).unwrap().get("claude")["last"].is_null());
    disk.shutdown().await.unwrap();
}
