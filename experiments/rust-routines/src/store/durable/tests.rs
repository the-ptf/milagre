use super::*;
use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    process::{Command as Process, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

fn root() -> PathBuf {
    let root = std::fs::canonicalize("/tmp")
        .unwrap()
        .join(format!("milagre-durable-routines-{}", uuid::Uuid::new_v4()));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    fs::write(root.join("rust-chat-runtime.json"),json!({"schema":1,"kind":"milagre-rust-chat","root":root,"fixture":true,"launch":{"model":"fixture"}}).to_string()).unwrap();
    fs::set_permissions(
        root.join("rust-chat-runtime.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    root
}
fn owner() -> OwnerCheck {
    Arc::new(|| Ok(()))
}
fn input(name: &str) -> Value {
    json!({"name":name,"prompt":"Do the retained task","trigger":{"kind":"schedule","cron":"*/15 * * * *","timezone":"UTC"},"target":{"kind":"chat","chatId":"/dedicated/project#1"},"createdBy":{"kind":"user"},"provider":"claude","model":"sonnet","permissionMode":"ask"})
}
fn file(root: &Path) -> PathBuf {
    root.join("routines/routines.json")
}

#[test]
fn durable_crud_is_real_single_writer_and_reopens_saved_bytes() {
    let root = root();
    let mut store = RoutineStore::open(&root, owner(), 1_790_000_000_000).unwrap();
    assert!(matches!(
        RoutineStore::open(&root, owner(), 1_790_000_000_000),
        Err(Error::Busy)
    ));
    assert!(store
        .execute(Command::List, 1_790_000_000_000)
        .unwrap()
        .value
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!file(&root).exists());
    let result = store
        .execute(Command::Create(input("Persisted")), 1_790_000_000_000)
        .unwrap();
    assert!(result.changed);
    let id = result.value["id"].as_str().unwrap().to_owned();
    assert_eq!(id.len(), 8);
    assert!(id
        .bytes()
        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    let saved = fs::read(file(&root)).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&saved).unwrap()["routines"][0],
        result.value
    );
    store.close().unwrap();
    let mut reopened = RoutineStore::open(&root, owner(), 1_790_000_000_001).unwrap();
    assert_eq!(
        reopened
            .execute(Command::Get(id.clone()), 1_790_000_000_001)
            .unwrap()
            .value,
        result.value
    );
    assert_eq!(fs::read(file(&root)).unwrap(), saved);
    assert_eq!(
        reopened
            .execute(
                Command::Update {
                    id: id.clone(),
                    patch: json!({"enabled":false,"name":"Changed"})
                },
                1_790_000_000_002
            )
            .unwrap()
            .value["name"],
        "Changed"
    );
    reopened
        .execute(Command::Remove(id), 1_790_000_000_003)
        .unwrap();
    assert!(reopened
        .execute(Command::List, 1_790_000_000_003)
        .unwrap()
        .value
        .as_array()
        .unwrap()
        .is_empty());
    reopened.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn before_rename_failure_keeps_old_file_and_after_rename_withholds_publication() {
    let root = root();
    let at = 1_790_000_000_000;
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    let created = store
        .execute(Command::Create(input("Original")), at)
        .unwrap()
        .value;
    let id = created["id"].as_str().unwrap().to_owned();
    let original = fs::read(file(&root)).unwrap();
    for fault in [disk::Fault::BeforeWrite, disk::Fault::BeforeRename] {
        store.inner.as_mut().unwrap().disk.fault = fault;
        let failure = store
            .execute(
                Command::Update {
                    id: id.clone(),
                    patch: json!({"name":"Must not publish"}),
                },
                at + 1,
            )
            .err()
            .unwrap();
        assert!(matches!(failure, Error::Io { .. }));
        assert_eq!(fs::read(file(&root)).unwrap(), original);
        assert_eq!(
            store
                .execute(Command::Get(id.clone()), at + 1)
                .unwrap()
                .value["name"],
            "Original"
        );
    }
    let before_saves = store.inner.as_ref().unwrap().model.saves;
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::AfterRename;
    let error = store
        .execute(
            Command::Update {
                id: id.clone(),
                patch: json!({"name":"Committed but unacknowledged"}),
            },
            at + 2,
        )
        .err()
        .unwrap();
    assert!(matches!(error, Error::Uncertain { .. }));
    assert!(error.to_string().contains("after rename"));
    assert_eq!(store.inner.as_ref().unwrap().model.saves, before_saves);
    assert_eq!(
        store.inner.as_ref().unwrap().model.data["routines"][0]["name"],
        "Original"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(file(&root)).unwrap()).unwrap()["routines"][0]
            ["name"],
        "Committed but unacknowledged"
    );
    assert!(matches!(
        store.execute(Command::List, at + 2),
        Err(Error::Uncertain { .. })
    ));
    assert!(matches!(
        RoutineStore::open(&root, owner(), at + 2),
        Err(Error::Busy)
    ));
    store.close().unwrap();
    let mut reopened = RoutineStore::open(&root, owner(), at + 3).unwrap();
    assert_eq!(
        reopened.execute(Command::Get(id), at + 3).unwrap().value["name"],
        "Committed but unacknowledged"
    );
    reopened.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_failure_retains_writer_until_verified_close() {
    let root = root();
    let at = 1_790_000_000_000;
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::BeforeRenameAndCleanup;
    let error = store
        .execute(Command::Create(input("Refused")), at)
        .err()
        .unwrap();
    assert!(matches!(error, Error::Uncertain { .. }));
    assert!(
        error.to_string().contains("before rename") && error.to_string().contains("cleanup failed")
    );
    assert!(!file(&root).exists());
    assert!(matches!(
        RoutineStore::open(&root, owner(), at),
        Err(Error::Busy)
    ));
    store.close().unwrap();
    let mut next = RoutineStore::open(&root, owner(), at).unwrap();
    assert!(next
        .execute(Command::List, at)
        .unwrap()
        .value
        .as_array()
        .unwrap()
        .is_empty());
    next.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replaced_store_directory_and_files_are_never_modified() {
    let root = root();
    let at = 1_790_000_000_000;
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    store
        .execute(Command::Create(input("Original")), at)
        .unwrap();
    let directory = root.join("routines");
    let old = root.join("retained-routines");
    fs::rename(&directory, &old).unwrap();
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    fs::write(file(&root), b"foreign data").unwrap();
    assert!(store
        .execute(Command::Create(input("Refused")), at + 1)
        .is_err());
    assert!(store.close().is_err());
    assert_eq!(fs::read(file(&root)).unwrap(), b"foreign data");
    fs::remove_dir_all(&directory).unwrap();
    fs::rename(old, &directory).unwrap();
    store.close().unwrap();
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    let original = fs::read(file(&root)).unwrap();
    fs::rename(file(&root), root.join("saved-original")).unwrap();
    fs::write(file(&root), &original).unwrap();
    fs::set_permissions(file(&root), fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store.execute(Command::List, at).is_err());
    assert!(
        store.close().is_err(),
        "equal bytes cannot replace the pinned inode"
    );
    fs::remove_file(file(&root)).unwrap();
    fs::rename(root.join("saved-original"), file(&root)).unwrap();
    store.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn final_owner_recheck_denies_before_rename_and_after_rename_retains_uncertainty() {
    use std::sync::atomic::AtomicUsize;
    for deny_at in [4, 5] {
        let root = root();
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let counted = calls.clone();
        let gate = revoked.clone();
        let check: OwnerCheck = Arc::new(move || {
            let count = counted.fetch_add(1, Ordering::AcqRel) + 1;
            if count == deny_at {
                gate.store(true, Ordering::Release);
            }
            if gate.load(Ordering::Acquire) {
                Err("late owner revocation".into())
            } else {
                Ok(())
            }
        });
        let mut store = RoutineStore::open(&root, check, 1_790_000_000_000).unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 2);
        let error = store
            .execute(Command::Create(input("Withheld")), 1_790_000_000_001)
            .err()
            .unwrap();
        assert!(error.to_string().contains("late owner revocation"));
        if deny_at == 4 {
            assert!(matches!(error, Error::Owner(_)));
            assert!(!file(&root).exists());
        } else {
            assert!(matches!(error, Error::Uncertain { .. }));
            assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(file(&root)).unwrap()).unwrap()
                    ["routines"][0]["name"],
                "Withheld"
            );
        }
        assert!(store.inner.as_ref().unwrap().model.data["routines"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(matches!(
            RoutineStore::open(&root, owner(), 1_790_000_000_001),
            Err(Error::Busy)
        ));
        assert!(store.close().is_err());
        revoked.store(false, Ordering::Release);
        store.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn final_read_owner_revocation_discards_candidate_but_permanently_fences_store() {
    use std::sync::atomic::AtomicUsize;
    for command in [
        Command::List,
        Command::Get("missing".into()),
        Command::Runs("missing".into()),
    ] {
        let root = root();
        let at = 1_790_000_000_000;
        let calls = Arc::new(AtomicUsize::new(0));
        let revoked = Arc::new(AtomicBool::new(false));
        let counted = calls.clone();
        let gate = revoked.clone();
        let mut store = RoutineStore::open(
            &root,
            Arc::new(move || {
                if counted.fetch_add(1, Ordering::AcqRel) + 1 == 4 {
                    gate.store(true, Ordering::Release);
                }
                if gate.load(Ordering::Acquire) {
                    Err("final read owner revoked".into())
                } else {
                    Ok(())
                }
            }),
            at,
        )
        .unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 2);
        let error = store.execute(command, at).err().unwrap();
        assert!(matches!(error, Error::Owner(_)));
        assert!(error.to_string().contains("final read owner revoked"));
        let state = store.inner.as_ref().unwrap();
        assert!(matches!(state.model.phase, super::super::Phase::Ready));
        assert_eq!(state.model.saves, 0);
        assert!(!file(&root).exists());
        revoked.store(false, Ordering::Release);
        for _ in 0..2 {
            let error = store.execute(Command::List, at).err().unwrap();
            assert!(matches!(error, Error::Uncertain { .. }));
            assert!(error.to_string().contains("final read owner revoked"));
        }
        assert!(matches!(
            RoutineStore::open(&root, owner(), at),
            Err(Error::Busy)
        ));
        store.close().unwrap();
        let mut reopened = RoutineStore::open(&root, owner(), at).unwrap();
        assert_eq!(
            reopened.execute(Command::List, at).unwrap().value,
            json!([])
        );
        reopened.close().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn final_read_disk_pin_failure_stays_fenced_after_manifest_restoration() {
    use std::sync::atomic::AtomicUsize;
    let root = root();
    let at = 1_790_000_000_000;
    let manifest = root.join("rust-chat-runtime.json");
    let original = fs::read(&manifest).unwrap();
    let changed = manifest.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let mut store = RoutineStore::open(
        &root,
        Arc::new(move || {
            if counted.fetch_add(1, Ordering::AcqRel) + 1 == 4 {
                fs::write(&changed, b"{}").unwrap();
            }
            Ok(())
        }),
        at,
    )
    .unwrap();
    assert!(matches!(
        store.execute(Command::List, at),
        Err(Error::Ownership)
    ));
    let state = store.inner.as_ref().unwrap();
    assert!(matches!(state.model.phase, super::super::Phase::Ready));
    assert_eq!(state.model.saves, 0);
    assert!(!file(&root).exists());
    fs::write(&manifest, original).unwrap();
    assert!(matches!(
        store.execute(Command::List, at),
        Err(Error::Uncertain { .. })
    ));
    assert!(matches!(
        RoutineStore::open(&root, owner(), at),
        Err(Error::Busy)
    ));
    store.close().unwrap();
    let mut reopened = RoutineStore::open(&root, owner(), at).unwrap();
    assert_eq!(
        reopened.execute(Command::List, at).unwrap().value,
        json!([])
    );
    reopened.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn root_manifest_and_owner_changes_refuse_without_repairing_foreign_files() {
    let root = root();
    let at = 1_790_000_000_000;
    let allowed = Arc::new(AtomicBool::new(true));
    let check = allowed.clone();
    let mut store = RoutineStore::open(
        &root,
        Arc::new(move || {
            if check.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err("captured owner revoked".into())
            }
        }),
        at,
    )
    .unwrap();
    store.execute(Command::Create(input("Saved")), at).unwrap();
    let saved = fs::read(file(&root)).unwrap();
    allowed.store(false, Ordering::Release);
    assert!(matches!(
        store.execute(Command::List, at),
        Err(Error::Owner(_))
    ));
    assert!(store.close().is_err());
    allowed.store(true, Ordering::Release);
    assert!(
        matches!(
            store.execute(Command::List, at),
            Err(Error::Uncertain { .. })
        ),
        "revoked service cannot silently revive"
    );
    store.close().unwrap();
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    let manifest = root.join("rust-chat-runtime.json");
    let original = fs::read(&manifest).unwrap();
    fs::write(&manifest, b"{}").unwrap();
    assert!(store.execute(Command::List, at).is_err());
    assert!(store.close().is_err());
    assert_eq!(fs::read(file(&root)).unwrap(), saved);
    fs::write(&manifest, original).unwrap();
    store.close().unwrap();
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    let moved = root.with_file_name(format!(
        "{}-moved",
        root.file_name().unwrap().to_string_lossy()
    ));
    fs::rename(&root, &moved).unwrap();
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let foreign = root.join("untouched");
    fs::write(&foreign, b"foreign bytes").unwrap();
    assert!(store.execute(Command::List, at).is_err());
    assert!(store.close().is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign bytes");
    fs::remove_dir_all(&root).unwrap();
    fs::rename(moved, &root).unwrap();
    store.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn actual_node_crud_outputs_and_saved_file_bytes_match() {
    // A concurrent fork inherits other tests' flock descriptions until exec.
    // Share the copied writer's lifecycle guard so its nonblocking cleanup
    // probes do not mistake that transient child ownership for a live writer.
    let _serial = super::super::PROCESS_TEST_SERIAL.lock().unwrap();
    let root = root();
    let at = 1_790_000_000_000;
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    store
        .inner
        .as_mut()
        .unwrap()
        .ids
        .extend(["routine-a".into(), "routine-b".into()]);
    let mut operations = Vec::new();
    let mut observations = Vec::new();
    let mut perform = |method: &str, args: Vec<Value>, now: i64, command: Command| {
        let value = match store.execute(command, now) {
            Ok(reply) => json!({"ok":reply.value}),
            Err(error) => json!({"error":error.to_string()}),
        };
        let saved = fs::read_to_string(file(&root)).ok();
        observations.push(json!({"result":value,"file":saved}));
        operations.push(json!({"method":method,"args":args,"now":now}));
    };
    perform("list", vec![], at, Command::List);
    let one = input("Unicode 😀 \u{10fffe}");
    perform("create", vec![one.clone()], at, Command::Create(one));
    perform(
        "get",
        vec![json!("routine-a")],
        at,
        Command::Get("routine-a".into()),
    );
    let patch =
        json!({"name":"Changed","prompt":"Keep \r\n Unicode λ","enabled":false,"maxRuns":3});
    perform(
        "update",
        vec![json!("routine-a"), patch.clone()],
        at + 1,
        Command::Update {
            id: "routine-a".into(),
            patch,
        },
    );
    let bad = json!({"enabled":"wrong"});
    perform(
        "update",
        vec![json!("routine-a"), bad.clone()],
        at + 2,
        Command::Update {
            id: "routine-a".into(),
            patch: bad,
        },
    );
    perform(
        "runs",
        vec![json!("routine-a")],
        at + 2,
        Command::Runs("routine-a".into()),
    );
    let two = input("Second");
    perform("create", vec![two.clone()], at + 3, Command::Create(two));
    perform("list", vec![], at + 3, Command::List);
    perform(
        "remove",
        vec![json!("missing")],
        at + 4,
        Command::Remove("missing".into()),
    );
    perform(
        "remove",
        vec![json!("routine-a")],
        at + 4,
        Command::Remove("routine-a".into()),
    );
    perform(
        "get",
        vec![json!("routine-a")],
        at + 5,
        Command::Get("routine-a".into()),
    );
    perform("list", vec![], at + 5, Command::List);
    drop(perform);
    store.close().unwrap();
    let mut node = Process::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/durable-crud-node.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(
        node.stdin.as_mut().unwrap(),
        &json!({"now":at,"ids":["routine-a","routine-b"],"operations":operations}),
    )
    .unwrap();
    node.stdin.take();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(actual["observations"], json!(observations));
    assert_eq!(actual["rootRemoved"], true);
    assert_eq!(actual["idCalls"], 2);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn process_worker() {
    let Some(root) = std::env::var_os("MILAGRE_ROUTINE_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let at = 1_790_000_000_000;
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    if std::env::var("MILAGRE_ROUTINE_TEST_PHASE").unwrap() == "create" {
        let value = store
            .execute(Command::Create(input("Across process restart")), at)
            .unwrap()
            .value;
        assert!(file(&root).exists());
        println!("created {}", value["id"]);
    } else {
        let list = store.execute(Command::List, at).unwrap().value;
        assert_eq!(list.as_array().unwrap().len(), 1);
        assert_eq!(list[0]["name"], "Across process restart");
        store
            .execute(
                Command::Update {
                    id: list[0]["id"].as_str().unwrap().into(),
                    patch: json!({"enabled":false}),
                },
                at + 1,
            )
            .unwrap();
    }
    store.close().unwrap();
}
#[test]
fn graceful_process_restart_reopens_the_canonical_store() {
    let _serial = super::super::PROCESS_TEST_SERIAL.lock().unwrap();
    let root = root();
    let exe = std::env::current_exe().unwrap();
    for phase in ["create", "read"] {
        let result = Process::new(&exe)
            .args([
                "--exact",
                "store::durable::tests::process_worker",
                "--nocapture",
            ])
            .env("MILAGRE_ROUTINE_TEST_ROOT", &root)
            .env("MILAGRE_ROUTINE_TEST_PHASE", phase)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let value: Value = serde_json::from_slice(&fs::read(file(&root)).unwrap()).unwrap();
    assert_eq!(value["routines"][0]["enabled"], false);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn paused_create_matches_real_node_create_then_disable_and_has_no_enabled_disk_image() {
    let _serial = super::super::PROCESS_TEST_SERIAL.lock().unwrap();
    let root = root();
    let at = 1_790_000_000_000;
    let mut store = RoutineStore::open(&root, owner(), at).unwrap();
    store
        .inner
        .as_mut()
        .unwrap()
        .ids
        .extend(["paused-a".into(), "paused-b".into()]);
    let input = input("Paused 😀 draft");
    let created = store
        .execute(Command::CreatePaused(input.clone()), at)
        .unwrap();
    assert_eq!(created.value["enabled"], false);
    assert_eq!(
        store.inner.as_ref().unwrap().model.saves,
        1,
        "one actual persisted image"
    );
    let saved = fs::read_to_string(file(&root)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap()["routines"][0]["enabled"],
        false
    );
    let mut node = Process::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/durable-crud-node.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    serde_json::to_writer(node.stdin.as_mut().unwrap(),&json!({"now":at,"ids":["paused-a"],"operations":[{"method":"createPaused","args":[input.clone()],"now":at}]})).unwrap();
    node.stdin.take();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        oracle["observations"][0],
        json!({"result":{"ok":created.value},"file":saved})
    );
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::AfterRename;
    let error = store
        .execute(Command::CreatePaused(input), at + 1)
        .err()
        .unwrap();
    assert!(matches!(error, Error::Uncertain { .. }));
    assert_eq!(store.inner.as_ref().unwrap().model.saves, 1);
    assert_eq!(
        store.inner.as_ref().unwrap().model.data["routines"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let actual: Value = serde_json::from_slice(&fs::read(file(&root)).unwrap()).unwrap();
    assert_eq!(actual["routines"].as_array().unwrap().len(), 2);
    assert!(actual["routines"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["enabled"] == false));
    store.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}
