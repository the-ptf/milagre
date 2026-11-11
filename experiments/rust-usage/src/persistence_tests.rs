use super::*;
use crate::{
    scan::{CopiedRoot, Scanner},
    transcript::rows,
};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    sync::mpsc,
};
fn fixture() -> Value {
    serde_json::from_str(include_str!("../tests/fixtures/persistence.json")).unwrap()
}
fn saved_quota(f: &Value, amount: i64) -> UsageStore {
    let mut last = f["last"].clone();
    last["windows"][0]["usedPercent"] = json!(amount);
    let mut store = UsageStore::default();
    store.set_last("claude", &last);
    store.set_blocked("claude", &f["blocked"]);
    store
}
fn amount(store: &UsageStore) -> i64 {
    store.get("claude")["last"]["windows"][0]["usedPercent"].as_i64().unwrap()
}
fn quota_path(cap: &TempCache, selection: &Selection) -> std::path::PathBuf {
    cap.0.disk._temp.path().join(Key::quota(selection).unwrap().name())
}
fn gate(cap: &TempCache) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    *cap.0.disk.gate.lock().unwrap() = Some((entered_tx, resume_rx));
    (entered_rx, resume_tx)
}
fn entered(rx: mpsc::Receiver<()>) {
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
}
fn numeric_equal(a: &Value, b: &Value) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64()),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len());
            for (a, b) in a.iter().zip(b) {
                numeric_equal(a, b);
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len());
            for (k, a) in a {
                numeric_equal(a, &b[k]);
            }
        }
        _ => assert_eq!(a, b),
    }
}
#[tokio::test]
async fn original_node_cache_outputs_rehydrate_with_private_modes() {
    let f = fixture();
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let selection = Selection::default();
    let store = saved_quota(&f, 42);
    let scan = ScanCache::from_json(f["saved"]["scan"].clone());
    let mut pricing = Pricing::default();
    assert!(pricing.begin_refresh(f["now"].as_i64().unwrap()));
    assert!(pricing.complete(Some(&f["catalog"]), f["now"].as_i64().unwrap()));
    owner.save_quota(&selection, &store).unwrap();
    owner.save_scan(&scan).unwrap();
    owner.save_pricing(&pricing).unwrap();
    owner.shutdown().await.unwrap();
    assert_eq!(owner.dirty_count(), 0);
    for (kind, path) in [
        ("quota", quota_path(&cap, &selection)),
        ("scan", cap.0.disk._temp.path().join("token-usage.json")),
        ("pricing", cap.0.disk._temp.path().join("token-prices.json")),
    ] {
        let bytes = fs::read(&path).unwrap();
        assert!(!bytes.ends_with(b"\n"));
        numeric_equal(&serde_json::from_slice(&bytes).unwrap(), &f["saved"][kind]);
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert_eq!(fs::metadata(cap.0.disk._temp.path()).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(f["modes"][0]["files"], json!([0o644, 0o644, 0o644]));
    assert_eq!(f["modes"][1]["files"], json!([0o600, 0o600, 0o600]));
    let reopened = cap.open().unwrap();
    numeric_equal(&reopened.load_quota(&selection).unwrap().snapshot(f["now"].as_i64().unwrap()), &f["reopened"]["quota"]);
    numeric_equal(&rows(&reopened.load_scan().unwrap().files), &f["reopened"]["scanRows"]);
    numeric_equal(reopened.load_pricing().unwrap().current().unwrap(), &f["reopened"]["pricing"]);
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_and_missing_caches_match_node_defaults_and_never_discover_paths() {
    let f = fixture();
    let cap = TempCache::fresh().unwrap();
    let selection = Selection::default();
    for case in std::iter::once(json!({"contents":null,"quota":{"providers":[]},"scanRows":[],"pricingStatus":{"status":"unavailable"}}))
        .chain(f["malformed"].as_array().unwrap().iter().cloned())
    {
        let owner = cap.open().unwrap();
        for path in [
            quota_path(&cap, &selection),
            cap.0.disk._temp.path().join("token-usage.json"),
            cap.0.disk._temp.path().join("token-prices.json"),
        ] {
            if let Some(body) = case["contents"].as_str() {
                fs::write(path, body).unwrap();
            }
        }
        assert_eq!(owner.load_quota(&selection).unwrap().snapshot(0), case["quota"]);
        assert_eq!(rows(&owner.load_scan().unwrap().files), case["scanRows"]);
        assert_eq!(owner.load_pricing().unwrap().status(0), case["pricingStatus"]);
        owner.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn single_writer_coalesces_newer_saves_without_clearing_them_after_an_older_commit() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let f = fixture();
    let selection = Selection::default();
    assert_eq!(cap.open().err().unwrap().kind(), io::ErrorKind::AlreadyExists);
    let (started, resume) = gate(&cap);
    owner.save_quota(&selection, &saved_quota(&f, 1)).unwrap();
    let first = owner.flush();
    entered(started);
    for amount in 2..=100 {
        owner.save_quota(&selection, &saved_quota(&f, amount)).unwrap();
    }
    assert_eq!(owner.dirty_count(), 1);
    assert_eq!(amount(&owner.load_quota(&selection).unwrap()), 100);
    let latest = owner.flush();
    resume.send(()).unwrap();
    first.await.unwrap();
    latest.await.unwrap();
    assert_eq!(cap.0.disk.attempts.load(Ordering::SeqCst), 2);
    owner.shutdown().await.unwrap();
    let reopened = cap.open().unwrap();
    assert_eq!(amount(&reopened.load_quota(&selection).unwrap()), 100);
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn actual_disk_failure_preserves_previous_file_and_latest_dirty_snapshot_for_retry() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let f = fixture();
    let selection = Selection::default();
    owner.save_quota(&selection, &saved_quota(&f, 1)).unwrap();
    owner.flush().await.unwrap();
    let path = quota_path(&cap, &selection);
    let old = fs::read(&path).unwrap();
    let obstruction = cap.0.disk._temp.path().join(format!(".tmp.{}", Key::quota(&selection).unwrap().name()));
    fs::create_dir(&obstruction).unwrap();
    owner.save_quota(&selection, &saved_quota(&f, 2)).unwrap();
    assert!(owner.flush().await.is_err());
    assert_eq!(fs::read(&path).unwrap(), old);
    assert_eq!(owner.dirty_count(), 1);
    owner.save_quota(&selection, &saved_quota(&f, 3)).unwrap();
    assert!(owner.shutdown().await.is_err());
    assert!(owner.save_scan(&ScanCache::default()).is_err());
    fs::remove_dir(obstruction).unwrap();
    let reopened = cap.open().unwrap();
    assert_eq!(amount(&reopened.load_quota(&selection).unwrap()), 3);
    assert_eq!(reopened.dirty_count(), 1);
    reopened.flush().await.unwrap();
    assert_eq!(reopened.dirty_count(), 0);
    reopened.shutdown().await.unwrap();
    let disk = cap.open().unwrap();
    assert_eq!(amount(&disk.load_quota(&selection).unwrap()), 3);
    disk.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancelled_flush_and_unpolled_shutdown_keep_single_writer_until_final_commit() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let f = fixture();
    let selection = Selection::default();
    let (started, resume) = gate(&cap);
    owner.save_quota(&selection, &saved_quota(&f, 7)).unwrap();
    drop(owner.flush());
    entered(started);
    drop(owner.shutdown());
    assert_eq!(cap.open().err().unwrap().kind(), io::ErrorKind::AlreadyExists);
    assert!(owner.save_quota(&selection, &saved_quota(&f, 9)).is_err());
    resume.send(()).unwrap();
    owner.shutdown().await.unwrap();
    let reopened = cap.open().unwrap();
    assert_eq!(amount(&reopened.load_quota(&selection).unwrap()), 7);
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn dropped_owner_finishes_and_keeps_the_capability_alive_for_cleanup() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let path = cap.0.disk._temp.path().to_owned();
    let (started, resume) = gate(&cap);
    owner.save_scan(&ScanCache::default()).unwrap();
    let flush = owner.flush();
    entered(started);
    let closed = owner.shutdown();
    drop(owner);
    drop(cap);
    assert!(path.exists());
    resume.send(()).unwrap();
    flush.await.unwrap();
    closed.await.unwrap();
    // Closed notification precedes the last worker Arc drop by a few instructions.
    for _ in 0..100 {
        if !path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    panic!("temporary capability was not cleaned up");
}
#[tokio::test]
async fn file_links_are_not_followed_and_replacement_does_not_truncate_a_link_target() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let target = tempfile::NamedTempFile::new().unwrap();
    fs::write(target.path(), b"fixture unchanged").unwrap();
    let path = cap.0.disk._temp.path().join("token-usage.json");
    symlink(target.path(), &path).unwrap();
    assert!(owner.load_scan().is_err());
    symlink(target.path(), cap.0.disk._temp.path().join(".tmp.token-usage.json")).unwrap();
    owner.save_scan(&ScanCache::default()).unwrap();
    owner.flush().await.unwrap();
    assert_eq!(fs::read(target.path()).unwrap(), b"fixture unchanged");
    fs::remove_file(&path).unwrap();
    fs::hard_link(target.path(), &path).unwrap();
    owner.save_scan(&ScanCache::default()).unwrap();
    owner.flush().await.unwrap();
    assert_eq!(fs::read(target.path()).unwrap(), b"fixture unchanged");
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn account_slots_are_structural_and_exported_seeds_roundtrip() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let f = fixture();
    let a = Selection { claude: "a-b".into(), codex: "c".into(), ..Selection::default() };
    let b = Selection { claude: "a".into(), codex: "b-c".into(), ..Selection::default() };
    assert_eq!(a.account_key(), b.account_key());
    owner.save_accounts(&[(a.clone(), saved_quota(&f, 1).to_json()), (b.clone(), saved_quota(&f, 2).to_json())]).unwrap();
    owner.shutdown().await.unwrap();
    let reopened = cap.open().unwrap();
    assert_eq!(amount(&reopened.load_quota(&a).unwrap()), 1);
    assert_eq!(amount(&reopened.load_quota(&b).unwrap()), 2);
    let invalid = Selection { claude: "x".repeat(256), ..Selection::default() };
    assert!(reopened.save_accounts(&[(a.clone(), saved_quota(&f, 9).to_json()), (invalid, json!({}))]).is_err());
    assert_eq!(reopened.dirty_count(), 0);
    reopened.shutdown().await.unwrap();
}
#[tokio::test]
async fn scanner_restart_keeps_offsets_and_dedup_across_appends_in_synthetic_copy() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let f = fixture();
    let copy = tempfile::tempdir().unwrap();
    let path = copy.path().join("fixture.jsonl");
    let line = f["line"].as_str().unwrap();
    fs::write(&path, line).unwrap();
    let root = CopiedRoot::new("claude", fs::canonicalize(copy.path()).unwrap()).unwrap();
    let now = f["now"].as_i64().unwrap();
    let mut scanner = Scanner::new(vec![root.clone()], owner.load_scan().unwrap());
    assert!(scanner.scan(now).unwrap());
    owner.save_scan(scanner.cache()).unwrap();
    owner.shutdown().await.unwrap();
    let reopened = cap.open().unwrap();
    let mut resumed = Scanner::new(vec![root], reopened.load_scan().unwrap());
    assert!(resumed.finished());
    assert!(!resumed.scan(now).unwrap());
    numeric_equal(&resumed.rows(), &f["reopened"]["scanRows"]);
    fs::write(path, format!("{line}{line}")).unwrap();
    assert!(resumed.scan(now + 1).unwrap());
    numeric_equal(&resumed.rows(), &f["reopened"]["scanRows"]);
    reopened.save_scan(resumed.cache()).unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_automatic_save_stays_dirty_without_spinning_and_other_slots_still_commit() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let obstruction = cap.0.disk._temp.path().join("token-usage.json");
    fs::create_dir(&obstruction).unwrap();
    owner.save_scan(&ScanCache::default()).unwrap();
    owner.save_quota(&Selection::default(), &saved_quota(&fixture(), 4)).unwrap();
    assert!(owner.flush().await.is_err());
    assert_eq!(owner.dirty_count(), 1);
    let attempts = cap.0.disk.attempts.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(cap.0.disk.attempts.load(Ordering::SeqCst), attempts);
    assert!(quota_path(&cap, &Selection::default()).is_file());
    assert!(!cap.0.disk._temp.path().join(".tmp.token-usage.json").exists());
    fs::remove_dir(obstruction).unwrap();
    owner.flush().await.unwrap();
    assert_eq!(owner.dirty_count(), 0);
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn unexpected_writer_panic_releases_lease_and_retains_dirty_data() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let (started, resume) = gate(&cap);
    owner.save_scan(&ScanCache::default()).unwrap();
    let flush = owner.flush();
    entered(started);
    drop(resume);
    assert!(flush.await.is_err());
    assert_eq!(owner.shutdown().await.unwrap_err(), "cache writer panicked");
    let reopened = cap.open().unwrap();
    assert_eq!(reopened.dirty_count(), 1);
    reopened.flush().await.unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn oversized_corrupt_and_invalid_shape_caches_are_bounded_and_diagnosed() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let path = cap.test_directory().join("token-usage.json");
    fs::File::create(&path).unwrap().set_len(MAX_CACHE_BYTES + 1).unwrap();
    assert_eq!(owner.load_scan().err().unwrap().kind(), io::ErrorKind::InvalidData);
    fs::write(&path, b"{").unwrap();
    assert!(owner.load_scan().unwrap().files.is_empty());
    fs::write(&path, b"{\"version\":2,\"files\":{}}").unwrap();
    assert!(owner.load_scan().unwrap().files.is_empty());
    assert_eq!(owner.diagnostics().len(), 3);
    assert!(owner.diagnostics()[0].issue.contains("32 MiB"));
    for _ in 0..40 {
        owner.load_scan().unwrap();
    }
    assert_eq!(owner.diagnostics().len(), 3);
    fs::write(&path, b"{\"version\":3,\"files\":{},\"finishedAt\":\"bad\"}").unwrap();
    assert!(owner.load_scan().unwrap().finished_at.is_none());
    let large = Pricing::from_json(json!({"fetchedAt":"2026-10-30T12:00:00Z","models":{"fixture":"x".repeat(MAX_CACHE_BYTES as usize)}}));
    assert!(owner.save_pricing(&large).is_err());
    assert_eq!(owner.dirty_count(), 0);
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn cache_load_releases_state_lock_and_rechecks_latest_pending_value() {
    let cap = TempCache::fresh().unwrap();
    let owner = Arc::new(cap.open().unwrap());
    let (tx, entered) = mpsc::channel();
    let (resume, rx) = mpsc::channel();
    *cap.0.disk.load_gate.lock().unwrap() = Some((tx, rx));
    let reader = owner.clone();
    let reading = std::thread::spawn(move || reader.load_scan());
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let scan = ScanCache { finished_at: Some(123), ..ScanCache::default() };
    owner.save_scan(&scan).unwrap();
    resume.send(()).unwrap();
    assert_eq!(reading.join().unwrap().unwrap().finished_at, Some(123));
    owner.shutdown().await.unwrap();
}
#[tokio::test]
async fn persistence_poison_recovery_allows_flush_close_and_reopen_without_losing_pending_values() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let (started, resume) = gate(&cap);
    owner.save_scan(&ScanCache::default()).unwrap();
    let flush = owner.flush();
    entered(started);
    let shared = owner.shared.clone();
    let _ = std::panic::catch_unwind(move || {
        let _state = shared.state.lock().unwrap();
        panic!("fixture state poison");
    });
    assert_eq!(owner.dirty_count(), 1);
    resume.send(()).unwrap();
    flush.await.unwrap();
    owner.shutdown().await.unwrap();
    assert_eq!(owner.dirty_count(), 0);
    assert!(owner.save_scan(&ScanCache::default()).is_err());
    let next = cap.open().unwrap();
    assert_eq!(next.load_scan().unwrap().version, 3);
    next.shutdown().await.unwrap();
}

#[tokio::test]
async fn quota_budget_charges_file_bytes_and_releases_with_last_store_owner() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let a = Selection::default();
    let b = Selection { claude: "other".into(), ..Selection::default() };
    let bytes = format!("{}{}", " ".repeat(500), serde_json::to_string(&saved_quota(&fixture(), 27).to_json()).unwrap());
    fs::write(quota_path(&cap, &a), &bytes).unwrap();
    fs::write(quota_path(&cap, &b), &bytes).unwrap();
    let budget = LoadBudget::new(bytes.len() as u64);
    let loaded = owner.load_quota_budgeted(&a, &budget).unwrap();
    let cloned = loaded.clone();
    let again = owner.load_quota_budgeted(&a, &budget).unwrap();
    assert_eq!(budget.used_bytes(), bytes.len() as u64);
    assert_eq!(amount(&loaded), 27);
    assert!(owner.load_quota_budgeted(&b, &budget).is_err());
    drop(loaded);
    drop(cloned);
    assert_eq!(budget.used_bytes(), bytes.len() as u64);
    drop(again);
    assert_eq!(budget.used_bytes(), 0);
    let next = owner.load_quota_budgeted(&b, &budget).unwrap();
    assert_eq!(amount(&next), 27);
    drop(next);
    assert_eq!(budget.used_bytes(), 0);
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_corrupt_and_rejected_pending_caches_do_not_consume_load_budget() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let selection = Selection::default();
    let budget = LoadBudget::new(16);
    let missing = owner.load_quota_budgeted(&selection, &budget).unwrap();
    assert_eq!(budget.used_bytes(), 0);
    fs::write(quota_path(&cap, &selection), b"bad json").unwrap();
    let malformed = owner.load_quota_budgeted(&selection, &budget).unwrap();
    assert_eq!(budget.used_bytes(), 0);
    let (entered, resume) = gate(&cap);
    owner.save_quota(&selection, &saved_quota(&fixture(), 8)).unwrap();
    let flush = owner.flush();
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(owner.load_quota_budgeted(&selection, &budget).is_err());
    assert_eq!(budget.used_bytes(), 0);
    assert!(owner.diagnostics().iter().any(|d| d.issue.contains("rehydration failed")));
    resume.send(()).unwrap();
    flush.await.unwrap();
    drop((missing, malformed));
    owner.shutdown().await.unwrap();
}

#[tokio::test]
async fn paused_load_does_not_block_store_drop_and_settles_against_current_owners() {
    for same_slot in [false, true] {
        let cap = TempCache::fresh().unwrap();
        let owner = Arc::new(cap.open().unwrap());
        let a = Selection::default();
        let b = if same_slot { a.clone() } else { Selection { claude: "other".into(), ..Selection::default() } };
        fs::write(quota_path(&cap, &a), b"{}").unwrap();
        let budget = Arc::new(LoadBudget::new(2048));
        let store = owner.load_quota_budgeted(&a, &budget).unwrap();
        let next_bytes = format!("{}{{}}", " ".repeat(1000));
        fs::write(quota_path(&cap, &b), &next_bytes).unwrap();
        let (entered, resume) = cap.test_block_load();
        let reading = {
            let owner = owner.clone();
            let budget = budget.clone();
            std::thread::spawn(move || owner.load_quota_budgeted(&b, &budget))
        };
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        let (dropped, observed) = mpsc::channel();
        let b = budget.clone();
        let dropping = std::thread::spawn(move || {
            drop(store);
            dropped.send(b.used_bytes()).unwrap();
        });
        let during_read = observed.recv_timeout(Duration::from_secs(1));
        // Always release the fixture worker, including when the assertion would fail.
        resume.send(()).unwrap();
        let next = reading.join().unwrap().unwrap();
        dropping.join().unwrap();
        assert_eq!(during_read.unwrap(), if same_slot { 2048 } else { 2046 });
        assert_eq!(budget.used_bytes(), next_bytes.len() as u64);
        drop(next);
        assert_eq!(budget.used_bytes(), 0);
        assert!(lock(&budget.state).slots.is_empty());
        owner.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn load_reservation_rolls_back_on_failure_and_panic_and_missing_slots_do_not_accumulate() {
    let cap = TempCache::fresh().unwrap();
    let owner = cap.open().unwrap();
    let budget = LoadBudget::new(8);
    let selection = Selection::default();
    fs::write(quota_path(&cap, &selection), b"          {}").unwrap();
    let error = owner.load_quota_budgeted(&selection, &budget).unwrap_err();
    assert!(error.to_string().contains("8 bytes"));
    assert_eq!(budget.used_bytes(), 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _reservation = budget.reserve("fixture");
        assert_eq!(budget.used_bytes(), 8);
        panic!("fixture load panic");
    }))
    .is_err());
    assert_eq!(budget.used_bytes(), 0);
    for i in 0..1000 {
        let selection = Selection { claude: format!("missing-{i}"), ..Selection::default() };
        drop(owner.load_quota_budgeted(&selection, &budget).unwrap());
    }
    {
        let state = lock(&budget.state);
        assert!(state.slots.is_empty());
        assert!(state.reservation.is_none());
    }
    owner.shutdown().await.unwrap();
}

#[test]
fn settlement_enforces_capacity_in_release_and_rolls_back_without_charging() {
    let budget = LoadBudget::new(8);
    let reservation = budget.reserve("fixture");
    assert_eq!(reservation.settle(9, true).unwrap_err().kind(), io::ErrorKind::InvalidData);
    assert!(lock(&budget.state).slots.is_empty());
    assert_eq!(budget.used_bytes(), 8);
    drop(reservation);
    assert_eq!(budget.used_bytes(), 0);
    let reservation = budget.reserve("fixture");
    let charge = reservation.settle(8, true).unwrap().unwrap();
    drop(reservation);
    assert_eq!(budget.used_bytes(), 8);
    drop(charge);
    assert_eq!(budget.used_bytes(), 0);
}
