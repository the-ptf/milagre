use milagre_usage::{
    limits,
    scan::{CopiedRoot, ScanCache, Scanner},
    store::{UsageReader, UsageStore},
    transcript::Entry,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
const NOW: i64 = 1793361600000;
fn line(id: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"assistant","timestamp":"2026-10-30T11:00:00Z","sessionId":"s","requestId":id,"message":{"id":id,"model":"model","usage":{"input_tokens":10}}})
    )
}
#[tokio::test]
async fn concurrent_provider_reads_share_readiness_and_survive_caller_cancellation() {
    let ready_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let reader = UsageReader::new(
        UsageStore::default(),
        {
            let gate = gate.clone();
            let calls = calls.clone();
            Arc::new(move |p| {
                let gate = gate.clone();
                let calls = calls.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let permit = gate.acquire().await.unwrap();
                    permit.forget();
                    Ok(limits::provider_result(&p, NOW, "unavailable", json!([]), None))
                })
            })
        },
        Arc::new(|| NOW),
        {
            let ready_calls = ready_calls.clone();
            Arc::new(move || {
                ready_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {})
            })
        },
    );
    let first = {
        let r = reader.clone();
        tokio::spawn(async move { r.provider("claude").await })
    };
    while calls.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    first.abort();
    let second = {
        let r = reader.clone();
        tokio::spawn(async move { r.provider("claude").await })
    };
    tokio::task::yield_now().await;
    gate.add_permits(1);
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), second).await.unwrap().unwrap().unwrap();
    assert_eq!(result["status"], "unavailable");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(ready_calls.load(Ordering::SeqCst), 1);
    assert_eq!(reader.provider("unknown").await.unwrap_err(), "Unknown usage provider");
    assert!(reader.checked_at("claude").is_some());
}
#[tokio::test]
async fn a_failed_provider_does_not_discard_others() {
    let reader = UsageReader::new(
        UsageStore::default(),
        Arc::new(|p| {
            Box::pin(async move {
                if p == "claude" {
                    Err(())
                } else {
                    Ok(limits::provider_result(&p, NOW, "unavailable", json!([]), None))
                }
            })
        }),
        Arc::new(|| NOW),
        Arc::new(|| Box::pin(async {})),
    );
    let result = reader.read().await;
    assert_eq!(result["providers"][0]["message"], "Couldn't read usage.");
    assert_eq!(result["providers"].as_array().unwrap().len(), 4);
    assert_eq!(result["providers"][1]["status"], "unavailable");
}
#[test]
fn malformed_cache_starts_empty_and_stored_paths_cannot_authorize_reads() {
    for value in [
        Value::Null,
        json!({"version":2,"files":{}}),
        json!({"version":3,"files":{"x":{"provider":"claude","offset":0,"carry":[],"rows":{},"sessions":{}}}}),
    ] {
        assert_eq!(ScanCache::from_json(value).to_json(), json!({"version":3,"files":{}}));
    }
    let cache = ScanCache::from_json(
        json!({"version":3,"files":{"x":{"provider":"claude","offset":0,"file":"/never-authorized/profile.jsonl","carry":{},"sessions":{},"rows":{}}}}),
    );
    let mut scanner = Scanner::new(vec![], cache);
    scanner.scan(NOW).unwrap();
    assert_eq!(scanner.rows(), json!([]));
    assert!(CopiedRoot::new("claude", "relative").is_err());
    assert!(CopiedRoot::new("claude", "/copy/../profile").is_err());
    assert!(CopiedRoot::new("unknown", "/copy").is_err());
}
#[cfg(unix)]
#[test]
fn symlink_files_directories_roots_and_ancestors_are_not_followed() {
    use std::{fs, os::unix::fs::symlink};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let copy = root.join("copy");
    let outside = root.join("outside");
    fs::create_dir_all(&copy).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.jsonl"), line("escape")).unwrap();
    symlink(&outside, copy.join("nested")).unwrap();
    symlink(outside.join("secret.jsonl"), copy.join("file.jsonl")).unwrap();
    symlink(&outside, root.join("root-link")).unwrap();
    symlink(&root, root.join("ancestor-link")).unwrap();
    fs::write(copy.join("good.jsonl"), line("allowed")).unwrap();
    let roots = vec![
        CopiedRoot::new("claude", copy).unwrap(),
        CopiedRoot::new("claude", root.join("root-link")).unwrap(),
        CopiedRoot::new("claude", root.join("ancestor-link/outside")).unwrap(),
    ];
    let mut scanner = Scanner::new(roots, ScanCache::default());
    scanner.scan(NOW).unwrap();
    assert_eq!(scanner.rows().as_array().unwrap().len(), 1);
    assert_eq!(scanner.rows()[0]["requests"], json!(1.));
    // Scanner performs no persistence or transcript writes.
    assert_eq!(fs::read_to_string(outside.join("secret.jsonl")).unwrap(), line("escape"));
}
#[cfg(unix)]
#[test]
fn chunks_partial_utf8_duplicate_roots_and_retained_deleted_rows() {
    use std::{fs, io::Write};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let file = root.join("s.jsonl");
    let mut body = vec![b'x'; 4 * 1024 * 1024 - 10];
    body.push(b'\n');
    body.extend_from_slice(line("one").as_bytes());
    let title = format!("{}\n", json!({"type":"custom-title","sessionId":"s","customTitle":"café"}));
    let split = title.find('é').unwrap() + 1;
    body.extend_from_slice(&title.as_bytes()[..split]);
    fs::write(&file, &body).unwrap();
    let copied = CopiedRoot::new("claude", root.clone()).unwrap();
    let mut scanner = Scanner::new(vec![copied.clone(), copied], ScanCache::default());
    scanner.scan(NOW).unwrap();
    assert_eq!(scanner.rows()[0]["requests"], json!(1.));
    assert_eq!(scanner.rows()[0]["title"], "");
    fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(&title.as_bytes()[split..]).unwrap();
    scanner.scan(NOW).unwrap();
    assert_eq!(scanner.rows()[0]["title"], "café");
    assert!(!scanner.scan(NOW).unwrap());
    fs::remove_file(file).unwrap();
    assert!(!scanner.scan(NOW).unwrap());
    assert_eq!(scanner.rows()[0]["requests"], json!(1.));
}
#[test]
fn bounded_recent_dedup_and_retention_match_node_rules() {
    let mut e = Entry::new("claude");
    for i in 0..17 {
        e.feed(line(&i.to_string()).as_bytes());
    }
    e.feed(line("0").as_bytes());
    assert_eq!(e.rows.values().next().unwrap()[5], 18.);
    assert_eq!(e.carry["recent"].as_array().unwrap().len(), 16);
    e.prune(NOW + 401 * 24 * 3_600_000);
    assert!(e.rows.is_empty());
}
#[test]
fn codex_terminal_errors_and_finished_state_are_stable() {
    for kind in ["missing", "spawn", "error", "timeout", "close"] {
        let mut p = limits::CodexUsage::new();
        p.fail(kind, NOW);
        let result = p.result().unwrap().clone();
        p.feed(b"{\"id\":3,\"result\":{}}\n", NOW);
        p.fail("close", NOW);
        assert_eq!(p.result(), Some(&result));
    }
    let mut p = limits::CodexUsage::new();
    p.feed(b"{\"id\":2,\"error\":{\"message\":\"private upstream detail\"}}\n", NOW);
    assert_eq!(p.result().unwrap()["message"], "Codex couldn't read usage.");
    assert!(!p.result().unwrap().to_string().contains("private upstream"));
}

#[tokio::test]
async fn token_owner_answers_cached_rows_coalesces_scan_and_obeys_thirty_second_boundaries() {
    use milagre_usage::owner::{ScanResult, TokenUsage, TokenUsageOptions};
    use std::sync::{atomic::AtomicI64, Mutex};
    let now = Arc::new(AtomicI64::new(NOW));
    let scans = Arc::new(AtomicUsize::new(0));
    let metadata = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let events = Arc::new(Mutex::new(vec![]));
    let owner = TokenUsage::new(
        TokenUsageOptions {
            scan: {
                let scans = scans.clone();
                let gate = gate.clone();
                Arc::new(move || {
                    let scans = scans.clone();
                    let gate = gate.clone();
                    Box::pin(async move {
                        scans.fetch_add(1, Ordering::SeqCst);
                        gate.acquire().await.unwrap().forget();
                        Ok(ScanResult { rows: json!([]), changed: true })
                    })
                })
            },
            projects: {
                let metadata = metadata.clone();
                Arc::new(move || {
                    metadata.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Ok(json!([])) })
                })
            },
            prices: Arc::new(|| Value::Null),
            pricing_status: Arc::new(|| json!({"status":"unavailable"})),
            emit: {
                let events = events.clone();
                Arc::new(move |name, payload| events.lock().unwrap().push((name.to_owned(), payload)))
            },
            now: {
                let now = now.clone();
                Arc::new(move || now.load(Ordering::SeqCst))
            },
            home: "/fixture".into(),
            worktree_root: "/fixture/worktrees".into(),
            default_time_zone: "UTC".into(),
        },
        json!([]),
        false,
    );
    let first = owner.read(&json!({"range":"24h"})).await.unwrap();
    assert_eq!(first["refreshing"], true);
    assert_eq!(first["firstScan"], true);
    assert_eq!(first["series"].as_array().unwrap().len(), 24);
    owner.read(&Value::Null).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(scans.load(Ordering::SeqCst), 1);
    assert_eq!(metadata.load(Ordering::SeqCst), 1);
    gate.add_permits(1);
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert_eq!(*events.lock().unwrap(), vec![("token-usage:changed".into(), json!({}))]);
    now.store(NOW + 29_999, Ordering::SeqCst);
    let next = owner.read(&Value::Null).await.unwrap();
    assert_eq!(next["refreshing"], false);
    assert_eq!(next["firstScan"], false);
    assert_eq!(scans.load(Ordering::SeqCst), 1);
    now.store(NOW + 30_000, Ordering::SeqCst);
    owner.read(&Value::Null).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(scans.load(Ordering::SeqCst), 2);
    assert_eq!(metadata.load(Ordering::SeqCst), 2);
    gate.add_permits(1);
}
