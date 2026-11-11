use super::snapshot::{Device, Kind};
use super::*;
use rand_core::OsRng;
use std::io::BufRead;
use std::process::{Command, Stdio};
struct TestProfile(SyntheticProfile);
impl std::ops::Deref for TestProfile {
    type Target = SyntheticProfile;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for TestProfile {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for TestProfile {
    fn drop(&mut self) {
        let _ = self.0.destroy();
    }
}
fn profile() -> TestProfile {
    TestProfile(SyntheticProfile::create(StoreLimits::default(), &mut OsRng).unwrap())
}
fn saved(p: &SyntheticProfile) -> Vec<u8> {
    let mut f = File::from(fs::openat(&p.core.root, SNAPSHOT, FILE_FLAGS, Mode::empty()).unwrap());
    let mut b = Vec::new();
    f.read_to_end(&mut b).unwrap();
    b
}
#[test]
fn explicit_commit_receipt_restarts_but_drop_never_cleans() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let mut w = p.acquire_writer().unwrap();
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    assert!(matches!(p.destroy(), Err(StoreFault::Busy)));
    let mut state = w.load().unwrap();
    state.revision += 1;
    state.boot += 1;
    state.running = true;
    w.commit(&state).unwrap();
    state.revision += 1;
    state.running = false;
    let receipt = w.commit(&state).unwrap();
    w.acknowledge(receipt)
        .unwrap_or_else(|_| panic!("clean acknowledgment"));
    let w = p.acquire_writer().unwrap();
    assert_eq!(w.diagnostics().fault, None);
    let before = saved(&p);
    drop(w);
    assert_eq!(saved(&p), before);
    let w = p.acquire_writer().unwrap();
    assert_eq!(w.diagnostics().fault, Some(StoreFault::DirtyRun));
    drop(w);
    p.destroy().unwrap();
}
#[test]
fn faults_never_issue_clean_receipt_and_retain_exclusive_ownership() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for stage in [
        IoStage::WriteTransaction,
        IoStage::SyncFile,
        IoStage::Rename,
        IoStage::SyncDirectory,
    ] {
        let mut p = profile();
        let mut w = p.acquire_writer().unwrap();
        let mut state = w.load().unwrap();
        state.revision += 1;
        state.running = true;
        state.boot += 1;
        w.commit(&state).unwrap();
        state.revision += 1;
        state.running = false;
        assert!(w.commit_at(&state, Some(stage)).is_err());
        assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
        assert!(matches!(w.commit(&state), Err(StoreFault::DirtyRun)));
        drop(w);
        let w = p.acquire_writer().unwrap();
        assert!(w.diagnostics().fault.is_some());
        drop(w);
        // Known transaction inode is tracked and is the only extra cleanup name accepted.
        p.destroy().unwrap();
    }
}
#[test]
fn wrong_receipt_retains_writer_and_no_implicit_retry() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let mut w = p.acquire_writer().unwrap();
    let mut state = w.load().unwrap();
    state.revision += 1;
    state.running = true;
    state.boot += 1;
    let receipt = w.commit(&state).unwrap();
    let (fault, w) = w.acknowledge(receipt).err().unwrap();
    assert_eq!(fault, StoreFault::DirtyRun);
    assert!(matches!(p.acquire_writer(), Err(StoreFault::Busy)));
    drop(w);
    let w = p.acquire_writer().unwrap();
    assert_eq!(w.diagnostics().fault, Some(StoreFault::DirtyRun));
    drop(w);
    p.destroy().unwrap();
}
#[test]
fn schema_and_allocation_shapes_are_strict_and_redacted() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let w = p.acquire_writer().unwrap();
    let state = w.load().unwrap();
    let encoded = String::from_utf8(state.encode(p.core.limits).unwrap()).unwrap();
    for text in [
        encoded.replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
        encoded.replacen("\"version\":1", "\"unknown\":\"PRIVATE_SENTINEL\"", 1),
        encoded.replacen("\"revision\":1", "\"revision\":18446744073709551616", 1),
        encoded.replacen("\"devices\":[]", "\"devices\":[[[[[[]]]]]]", 1),
        encoded.replacen(
            "\"devices\":[]",
            &format!("\"devices\":[\"{}\"]", "x".repeat(200)),
            1,
        ),
    ] {
        let fault = Snapshot::decode(text.as_bytes(), p.core.limits)
            .err()
            .unwrap();
        assert!(!format!("{fault:?} {fault}").contains("PRIVATE_SENTINEL"));
    }
    let mut state = state;
    state.devices = (0..128u16)
        .map(|i| {
            let mut key = [0; 32];
            key[..2].copy_from_slice(&i.to_be_bytes());
            Device {
                key,
                kind: Kind::Phone,
                epoch: 1,
                removed: Some(1),
                last_removed: Some(1),
            }
        })
        .collect();
    state.policy = 1;
    state.boot = 1;
    state.revision = 2;
    let bytes = state.encode(p.core.limits).unwrap();
    let decoded = Snapshot::decode(&bytes, p.core.limits).unwrap();
    assert_eq!(decoded.devices.len(), 128);
    let canonical = String::from_utf8(bytes.clone()).unwrap();
    for invalid in [
        canonical.replacen(
            "\"identity_status\":\"current\"",
            "\"identity_status\":\"other\"",
            1,
        ),
        canonical.replacen("\"run_state\":\"clean\"", "\"run_state\":\"other\"", 1),
        canonical.replacen(",\"removal_generation\":1", "", 1),
        canonical.replacen("\"state\":\"removed\"", "\"state\":\"other\"", 1),
    ] {
        assert!(Snapshot::decode(invalid.as_bytes(), p.core.limits).is_err());
    }
    assert!(Snapshot::decode(
        &bytes,
        StoreLimits {
            history_slots: 127,
            ..p.core.limits
        }
    )
    .is_err());
    state.devices.swap(0, 1);
    assert!(state.encode(p.core.limits).is_err());
    drop(w);
    p.destroy().unwrap();
}
#[test]
fn replaced_names_permissions_and_unexpected_entries_fail_before_reads_or_sweeps() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    fs::renameat(&p.core.root, LOCK, &p.core.root, "original.lock").unwrap();
    let replacement = new_file(&p.core.root, LOCK).unwrap();
    assert!(matches!(
        p.acquire_writer(),
        Err(StoreFault::IdentityChanged)
    ));
    assert!(matches!(p.destroy(), Err(StoreFault::IdentityChanged)));
    assert!(!saved(&p).is_empty());
    drop(replacement);
    fs::unlinkat(&p.core.root, LOCK, AtFlags::empty()).unwrap();
    fs::renameat(&p.core.root, "original.lock", &p.core.root, LOCK).unwrap();
    let unexpected = new_file(&p.core.root, "unowned").unwrap();
    assert!(matches!(p.destroy(), Err(StoreFault::UnexpectedEntry)));
    assert!(!saved(&p).is_empty());
    drop(unexpected);
    fs::unlinkat(&p.core.root, "unowned", AtFlags::empty()).unwrap();
    p.destroy().unwrap();
}
// The helper is inside the test binary only; there is no arbitrary public FD importer.
fn child(p: &SyntheticProfile, root: &File, mode: &str) -> std::process::Child {
    let ids = [
        p.core.pid as u64,
        p.core.root_id.dev,
        p.core.root_id.ino,
        p.core.marker_id.dev,
        p.core.marker_id.ino,
        p.core.lock_id.dev,
        p.core.lock_id.ino,
    ];
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "synthetic_store::tests::process_child",
            "--nocapture",
        ])
        .env("MILAGRE_REMOTE_STORE_CHILD", mode)
        .env("MILAGRE_REMOTE_STORE_PROFILE", snapshot::hex(&p.core.id))
        .env("MILAGRE_REMOTE_STORE_ACK", {
            let l = p.core.ledger();
            let s = l.ack.unwrap_or(Stamp {
                revision: 0,
                boot: 0,
                retired: false,
            });
            format!(
                "{},{},{},{}",
                s.revision,
                s.boot,
                u8::from(s.retired),
                l.attempt
            )
        })
        .env(
            "MILAGRE_REMOTE_STORE_IDS",
            ids.map(|n| n.to_string()).join(","),
        )
        .stdin(Stdio::from(File::from(rustix::io::dup(root).unwrap())))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}
fn child_core(pid: u32, ids: &[u64]) -> Arc<Core> {
    let root = File::from(rustix::io::dup(std::io::stdin()).unwrap());
    let parent = File::from(rustix::io::dup(&root).unwrap());
    Arc::new(Core {
        root,
        parent,
        name: String::new(),
        id: {
            let text = std::env::var("MILAGRE_REMOTE_STORE_PROFILE").unwrap();
            let mut id = [0; 16];
            for (i, part) in text.as_bytes().as_chunks::<2>().0.iter().enumerate() {
                id[i] = u8::from_str_radix(std::str::from_utf8(part).unwrap(), 16).unwrap();
            }
            id
        },
        root_id: Identity {
            dev: ids[1],
            ino: ids[2],
        },
        marker_id: Identity {
            dev: ids[3],
            ino: ids[4],
        },
        lock_id: Identity {
            dev: ids[5],
            ino: ids[6],
        },
        pid,
        limits: StoreLimits::default(),
        ledger: Mutex::new(Ledger {
            active: false,
            attempt: 0,
            ack: None,
            destroyed: false,
            transaction: None,
        }),
        global: GlobalBudget::new(256 * 1024 * 1024).unwrap(),
        _budget: Some(
            GlobalBudget::new(1)
                .unwrap()
                .connection(1)
                .unwrap()
                .reserve(1)
                .unwrap(),
        ),
    })
}
#[test]
fn process_child() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let Ok(mode) = std::env::var("MILAGRE_REMOTE_STORE_CHILD") else {
        return;
    };
    let ids: Vec<u64> = std::env::var("MILAGRE_REMOTE_STORE_IDS")
        .unwrap()
        .split(',')
        .map(|s| s.parse().unwrap())
        .collect();
    if mode == "inherited" {
        let c = child_core(ids[0] as u32, &ids);
        let w = WriterLease {
            _not_sync: std::marker::PhantomData,
            locks: Some(Locks {
                root: File::from(rustix::io::dup(std::io::stdin()).unwrap()),
                _file: File::from(rustix::io::dup(std::io::stdin()).unwrap()),
                pid: ids[0] as u32,
            }),
            core: c,
            prior: None,
            attempt: 1,
            finished: false,
            poisoned: false,
            fail_next: None,
            last: None,
        };
        assert_eq!(w.diagnostics().fault, Some(StoreFault::WrongProcess));
        drop(w);
    }
    let c = child_core(process::getpid().as_raw_nonzero().get() as u32, &ids);
    if mode.starts_with("worker-") {
        let ack: Vec<u64> = std::env::var("MILAGRE_REMOTE_STORE_ACK")
            .unwrap()
            .split(',')
            .map(|n| n.parse().unwrap())
            .collect();
        let prior = Stamp {
            revision: ack[0],
            boot: ack[1],
            retired: ack[2] != 0,
        };
        let attempt = ack[3];
        c.ledger().attempt = attempt;
        c.ledger().active = true;
        let locks = Locks::acquire(&c).unwrap();
        let mut writer = WriterLease {
            _not_sync: std::marker::PhantomData,
            core: c,
            locks: Some(locks),
            prior: Some(prior),
            attempt,
            finished: false,
            poisoned: false,
            fail_next: None,
            last: Some(prior),
        };
        if mode.starts_with("worker-authority-") {
            crate::policy::persistent::tests::worker(writer, &mode, attempt);
            return;
        }
        let mut state = writer.load().unwrap();
        state.revision += 1;
        state.boot += 1;
        state.running = true;
        writer.commit(&state).unwrap();
        if mode == "worker-running" {
            return;
        }
        state.revision += 1;
        state.running = false;
        if mode == "worker-ambiguous" {
            assert!(writer
                .commit_at(&state, Some(IoStage::SyncDirectory))
                .is_err());
            return;
        }
        let receipt = writer.commit(&state).unwrap();
        if mode == "worker-no-ack" {
            return;
        }
        writer
            .acknowledge(receipt)
            .unwrap_or_else(|_| panic!("acknowledgment failed"));
        println!("CLEAN {attempt} {} {}", state.revision, state.boot);
        return;
    }
    match mode.as_str() {
        "busy" | "inherited" => assert!(matches!(Locks::acquire(&c), Err(StoreFault::Busy))),
        "changed" => assert!(matches!(
            Locks::acquire(&c),
            Err(StoreFault::IdentityChanged)
        )),
        "free" => {
            drop(Locks::acquire(&c).unwrap());
        }
        "hold" => {
            let _locks = Locks::acquire(&c).unwrap();
            println!("LOCKED");
            std::io::stdout().flush().unwrap();
            std::thread::sleep(std::time::Duration::from_secs(10));
        }
        _ => panic!("unknown synthetic helper mode"),
    }
}
#[test]
fn subprocess_independent_locks_replacement_inheritance_and_kill_release() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let w = p.acquire_writer().unwrap();
    for mode in ["busy", "inherited"] {
        assert!(child(&p, &w.locks.as_ref().unwrap().root, mode)
            .wait()
            .unwrap()
            .success());
    }
    drop(w);
    assert!(child(&p, &p.core.root, "free").wait().unwrap().success());
    let mut holder = child(&p, &p.core.root, "hold");
    let stdout = holder.stdout.take().unwrap();
    let mut reader = std::io::BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line.trim() == "LOCKED" {
            break;
        }
    }
    fs::renameat(&p.core.root, LOCK, &p.core.root, "old.lock").unwrap();
    drop(new_file(&p.core.root, LOCK).unwrap());
    let blocked = child(&p, &p.core.root, "busy").wait().unwrap().success();
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(blocked);
    assert!(child(&p, &p.core.root, "changed").wait().unwrap().success());
    fs::unlinkat(&p.core.root, LOCK, AtFlags::empty()).unwrap();
    fs::renameat(&p.core.root, "old.lock", &p.core.root, LOCK).unwrap();
    assert!(child(&p, &p.core.root, "free").wait().unwrap().success());
    p.destroy().unwrap();
}

#[test]
fn partial_destroy_retains_lock_and_retries_only_owned_remaining_names() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for step in [1, 2, 3] {
        let mut p = profile();
        assert!(p.destroy_at(Some(step)).is_err());
        assert!(matches!(p.acquire_writer(), Err(StoreFault::DirtyRun)));
        // Its independently opened root lock remains held across the cleanup error.
        let root = File::from(fs::openat(&p.core.root, ".", DIR_FLAGS, Mode::empty()).unwrap());
        assert_eq!(
            fs::flock(&root, FlockOperation::NonBlockingLockExclusive),
            Err(rustix::io::Errno::WOULDBLOCK)
        );
        p.destroy().unwrap();
    }
}
#[test]
fn root_spelling_substitution_never_sweeps_the_replacement_or_original() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let original = saved(&p);
    let moved = format!("{}-moved", p.core.name);
    fs::renameat(&p.core.parent, &p.core.name, &p.core.parent, &moved).unwrap();
    fs::mkdirat(&p.core.parent, &p.core.name, Mode::from_raw_mode(0o700)).unwrap();
    assert!(matches!(p.destroy(), Err(StoreFault::IdentityChanged)));
    assert_eq!(saved(&p), original);
    fs::unlinkat(&p.core.parent, &p.core.name, AtFlags::REMOVEDIR).unwrap();
    fs::renameat(&p.core.parent, &moved, &p.core.parent, &p.core.name).unwrap();
    p.destroy().unwrap();
}
#[test]
fn exhausted_revisions_poison_without_wrapping_or_rewriting() {
    let _disk_test = crate::synthetic_store::testing_lock();
    let mut p = profile();
    let mut w = p.acquire_writer().unwrap();
    let mut state = w.load().unwrap();
    w.last = Some(Stamp {
        revision: u64::MAX,
        boot: 0,
        retired: false,
    });
    state.revision = 0;
    let before = saved(&p);
    assert!(matches!(w.commit(&state), Err(StoreFault::Exhausted)));
    assert_eq!(saved(&p), before);
    drop(w);
    p.destroy().unwrap();
}

#[test]
fn subprocess_clean_ack_is_required_even_when_clean_snapshot_is_visible() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for mode in [
        "worker-clean",
        "worker-running",
        "worker-ambiguous",
        "worker-no-ack",
    ] {
        let mut p = profile();
        for _ in 0..if mode == "worker-clean" { 2 } else { 1 } {
            // Test-only retained broker: exact attempt + inherited private control pipe.
            // No public API adopts a descriptor or trusts an arbitrary acknowledgment.
            let (prior, attempt) = {
                let mut l = p.core.ledger();
                assert!(!l.active);
                l.attempt += 1;
                l.active = true;
                (l.ack.unwrap(), l.attempt)
            };
            let worker = child(&p, &p.core.root, mode);
            let pid = worker.id();
            let result = worker.wait_with_output().unwrap();
            assert!(result.status.success());
            assert!(result.stdout.len() < 4096);
            assert_ne!(pid, p.core.pid);
            let receipt = String::from_utf8(result.stdout)
                .unwrap()
                .lines()
                .find_map(|line| line.strip_prefix("CLEAN ").map(str::to_owned));
            let mut ledger = p.core.ledger();
            ledger.active = false;
            ledger.ack = None;
            if let Some(receipt) = receipt {
                let values: Vec<u64> = receipt.split(' ').map(|s| s.parse().unwrap()).collect();
                assert_eq!(values, [attempt, prior.revision + 2, prior.boot + 1]);
                ledger.ack = Some(Stamp {
                    revision: values[1],
                    boot: values[2],
                    retired: false,
                });
            }
        }
        let writer = p.acquire_writer().unwrap();
        if mode == "worker-clean" {
            assert_eq!(writer.diagnostics().fault, None);
            assert_eq!(writer.diagnostics().boot, Some(2));
        } else {
            assert_eq!(writer.diagnostics().fault, Some(StoreFault::DirtyRun));
        }
        drop(writer);
        p.destroy().unwrap();
    }
}
#[test]
fn subprocess_authority_clean_restart_and_crash_after_removal_revocation() {
    let _disk_test = crate::synthetic_store::testing_lock();
    for mode in [
        "worker-authority-clean",
        "worker-authority-drop",
        "worker-authority-ambiguous",
        "worker-authority-no-ack",
        "worker-authority-exit-removal",
    ] {
        let mut p = profile();
        for run in 0..2 {
            let (prior, attempt) = {
                let mut l = p.core.ledger();
                assert!(!l.active);
                l.attempt += 1;
                l.active = true;
                (l.ack.take().unwrap(), l.attempt)
            };
            // The private launch reads the expected prior from the retained broker.
            p.core.ledger().ack = Some(prior);
            let selected = if run == 0 {
                "worker-authority-clean"
            } else {
                mode
            };
            let worker = child(&p, &p.core.root, selected);
            let pid = worker.id();
            let output = worker.wait_with_output().unwrap();
            assert_ne!(pid, p.core.pid);
            assert_eq!(
                output.status.code(),
                Some(if selected == "worker-authority-exit-removal" {
                    23
                } else {
                    0
                }),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(output.stdout.len() < 4096);
            let receipt = String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .find_map(|l| l.strip_prefix("CLEAN ").map(str::to_owned));
            let mut ledger = p.core.ledger();
            ledger.active = false;
            ledger.ack = None;
            if let Some(receipt) = receipt {
                let values: Vec<u64> = receipt.split(' ').map(|v| v.parse().unwrap()).collect();
                assert_eq!(
                    values,
                    [
                        attempt,
                        prior.revision + if run == 0 { 4 } else { 2 },
                        prior.boot + 1
                    ]
                );
                ledger.ack = Some(Stamp {
                    revision: values[1],
                    boot: values[2],
                    retired: false,
                });
            }
        }
        let writer = p.acquire_writer().unwrap();
        if mode == "worker-authority-clean" {
            let s = writer.load().unwrap();
            assert_eq!(s.boot, 2);
            assert_eq!(s.devices.len(), 1);
            assert_eq!(s.devices[0].epoch, 0);
            assert!(s.devices[0].removed.is_none());
        } else {
            assert_eq!(writer.diagnostics().fault, Some(StoreFault::DirtyRun));
        }
        drop(writer);
        p.destroy().unwrap();
    }
}
