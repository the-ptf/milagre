#![cfg(unix)]
use milagre_owner_store::{jsjson, Isolation, Policy};
use milagre_registry::writer::{Fault, RegistryCopy, Seeds};
use serde_json::{json, Value};
use std::{
    os::unix::fs::MetadataExt,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
fn clock(count: Arc<AtomicUsize>) -> Arc<dyn Fn() -> String + Send + Sync> {
    Arc::new(move || {
        format!(
            "2026-01-01T00:00:{:02}.000Z",
            count.fetch_add(1, Ordering::SeqCst)
        )
    })
}
fn bytes(path: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(path.join(file)).ok()
}
fn inode(path: &Path, file: &str) -> Option<u64> {
    std::fs::metadata(path.join(file)).ok().map(|m| m.ino())
}
#[tokio::test]
async fn real_node_mutations_match_results_bytes_ordering_and_noop_writes() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let root = isolation.root();
    let (a, b, c) = (root.join("a"), root.join("b"), root.join("c"));
    for p in [&a, &b, &c] {
        std::fs::create_dir(p).unwrap();
    }
    let group = "00000000-0000-0000-0000-000000000009";
    let seed=json!({"scanned":true,"unknownTop":"Node drops this on mutation","projects":[{"id":b,"path":b,"name":"b","git":false,"unknown":"kept"},{"id":a,"path":a,"name":"a","git":false,"position":{"x":8,"y":9},"unknown":"replaced"}],"links":[],"projectGroups":[{"id":group,"name":"Existing","projectIds":[a,c],"createdAt":"before","hidden":true,"unknown":"kept"},{"id":group,"name":"Duplicate saved id","projectIds":[b,c],"createdAt":"before"}],"worktreePositions":{}}).to_string();
    let recent=json!([{"path":b,"name":"Custom","openedAt":"before","unknown":"drop"},{"path":a,"openedAt":"before"}]).to_string();
    let id1 = "00000000-0000-0000-0000-000000000001";
    let id2 = "00000000-0000-0000-0000-000000000003";
    let mut operations = vec![
        json!({"method":"register","args":{"path":a}}),
        json!({"method":"register","args":{"path":a}}),
        json!({"method":"position","args":{"id":a,"position":{"x":"bad","y":2}}}),
        json!({"method":"position","args":{"id":a,"position":{"x":1.25,"y":-2}}}),
        json!({"method":"position","args":{"id":a,"position":{"x":1.25,"y":-2}}}),
        json!({"method":"register","args":{"path":c}}),
        json!({"method":"worktree-position","args":{"id":a,"path":a,"position":{"x":3,"y":4}}}),
        json!({"method":"group:create","args":{"name":"  Pair  ","projectIds":[a,b],"hidden":true}}),
        json!({"method":"group:create","args":{"name":"Duplicate","projectIds":[b,a]}}),
        json!({"method":"group:update","args":{"id":id1,"name":"Reordered","projectIds":[b,a],"hidden":false}}),
        json!({"method":"group:update","args":{"id":id1,"name":"\u{0001}","projectIds":[a,b]}}),
        json!({"method":"group:update","args":{"id":group,"name":"Duplicate member set","projectIds":[b,c]}}),
        json!({"method":"group:update","args":{"id":group,"name":"Keep fields","projectIds":[c,a]}}),
        json!({"method":"group:delete","args":{"id":id1}}),
        json!({"method":"group:delete","args":{"id":id1}}),
        json!({"method":"link:add","args":{"a":{"project_id":a,"extra":"preserve"},"b":{"project_id":b}}}),
        json!({"method":"link:add","args":{"a":{"project_id":b},"b":{"project_id":a}}}),
        json!({"method":"link:remove","args":{"id":id2}}),
        json!({"method":"link:restore","args":{"link":{"id":"restored","a":{"project_id":a,"extra":"drop"},"b":{"project_id":b},"created_at":"old","extra":"drop"}}}),
        json!({"method":"link:prune","args":{}}),
        json!({"method":"link:remove","args":{"id":"missing"}}),
        json!({"method":"recent:add","args":{"path":a}}),
        json!({"method":"recent:add","args":{"path":a}}),
        json!({"method":"recent:add","args":{"path":"relative"}}),
        json!({"method":"recent:forget","args":{"path":"relative"}}),
        json!({"method":"recent:forget","args":{"path":b}}),
        json!({"method":"recent:forget","args":{"path":b}}),
    ];
    for n in 0..12 {
        let path = root.join(format!("recent-{n}"));
        std::fs::create_dir(&path).unwrap();
        operations.push(json!({"method":"recent:add","args":{"path":path}}));
    }
    operations.extend([
        json!({"method":"group:create","args":{"name":"Invalid objects","projectIds":[{},{}]}}),
        json!({"method":"group:create","args":{"name":"Duplicate primitives","projectIds":[null,null]}}),
        json!({"method":"group:create","args":{"name":"Unknown member","projectIds":[a,"unknown"]}}),
    ]);
    let request = json!({"profile":root.join("node-profile"),"registry":seed,"recent":recent,"operations":operations,"output":root.join("results.json")});
    std::fs::write(root.join("request.json"), request.to_string()).unwrap();
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/writer.cjs"))
        .arg(root.join("request.json"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value =
        jsjson::parse_bytes(&std::fs::read(root.join("results.json")).unwrap()).unwrap();
    let copy = RegistryCopy::create(
        isolation,
        Seeds {
            registry: Some(seed.into_bytes()),
            recent: Some(recent.into_bytes()),
        },
    )
    .unwrap();
    let ticks = Arc::new(AtomicUsize::new(0));
    let ids = Arc::new(AtomicUsize::new(0));
    let make_ids: Arc<dyn Fn() -> String + Send + Sync> = Arc::new({
        let ids = ids.clone();
        move || {
            format!(
                "00000000-0000-0000-0000-{:012}",
                ids.fetch_add(1, Ordering::SeqCst) + 1
            )
        }
    });
    let mut writer = copy
        .writer_with_ids(Arc::new(|| Ok(())), clock(ticks.clone()), make_ids.clone())
        .unwrap();
    for (index, operation) in operations.iter().enumerate() {
        let before = [
            inode(copy.path(), "project-registry.json"),
            inode(copy.path(), "recent-projects.json"),
        ];
        let answer = writer
            .call(operation["method"].as_str().unwrap(), &operation["args"])
            .await;
        let exp = &expected[index];
        match answer {
            Ok(value) => assert_eq!(
                if jsjson::is_undefined(&value) {
                    json!({"fixtureUndefined":true})
                } else {
                    value
                },
                exp["result"],
                "result step {index}"
            ),
            Err(e) => {
                assert!(!e.committed);
                assert_eq!(json!(e.message), exp["error"], "error step {index}");
            }
        }
        for (file, key) in [
            ("project-registry.json", "registry"),
            ("recent-projects.json", "recent"),
        ] {
            assert_eq!(
                json!(bytes(copy.path(), file)),
                exp[key],
                "bytes step {index} {file}"
            );
        }
        let after = [
            inode(copy.path(), "project-registry.json"),
            inode(copy.path(), "recent-projects.json"),
        ];
        assert_eq!(
            json!([before[0] != after[0], before[1] != after[1]]),
            exp["changed"],
            "rewrite step {index}"
        );
        assert_eq!(
            json!(ticks.load(Ordering::SeqCst)),
            exp["clock"],
            "clock step {index}"
        );
        assert_eq!(
            json!(ids.load(Ordering::SeqCst)),
            exp["ids"],
            "id step {index}"
        );
        if index == 12 {
            drop(writer);
            writer = copy
                .writer_with_ids(Arc::new(|| Ok(())), clock(ticks.clone()), make_ids.clone())
                .unwrap();
        }
    }
    println!("{} actual Node writer steps", operations.len());
}

fn simple_copy() -> (tempfile::TempDir, RegistryCopy, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let project = isolation.root().join("project");
    std::fs::create_dir(&project).unwrap();
    let copy = RegistryCopy::create(isolation, Seeds::default()).unwrap();
    (temp, copy, project)
}
#[tokio::test]
async fn failures_distinguish_unchanged_and_committed_uncertain_then_restart() {
    let (_temp, copy, project) = simple_copy();
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut writer = copy
        .writer(Arc::new(|| Ok(())), clock(ticks.clone()))
        .unwrap();
    writer
        .call("register", &json!({"path":project}))
        .await
        .unwrap();
    let before = bytes(copy.path(), "project-registry.json");
    let reader = copy.reader(Arc::new(|| Ok(()))).unwrap();
    let retained = reader.snapshot().unwrap().project(&project).await.unwrap();
    for fault in [Fault::BeforeStage, Fault::BeforeRename] {
        writer.fault_once(fault);
        let error = writer
            .call("position", &json!({"id":project,"position":{"x":1,"y":2}}))
            .await
            .unwrap_err();
        assert!(!error.committed);
        assert_eq!(before, bytes(copy.path(), "project-registry.json"));
        assert!(!std::fs::read_dir(copy.path()).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
    writer.fault_once(Fault::AfterRename);
    let error = writer
        .call("position", &json!({"id":project,"position":{"x":1,"y":2}}))
        .await
        .unwrap_err();
    assert!(error.committed);
    assert!(error.message.contains("Do not replay"));
    let committed = bytes(copy.path(), "project-registry.json");
    assert_ne!(before, committed);
    assert!(retained.contains_folder(&project).await.is_err());
    reader.snapshot().unwrap().project(&project).await.unwrap();
    drop(writer);
    let mut reopened = copy.writer(Arc::new(|| Ok(())), clock(ticks)).unwrap();
    let inode_before = inode(copy.path(), "project-registry.json");
    reopened
        .call("position", &json!({"id":project,"position":{"x":1,"y":2}}))
        .await
        .unwrap();
    assert_eq!(inode_before, inode(copy.path(), "project-registry.json"));
    assert_eq!(committed, bytes(copy.path(), "project-registry.json"));
}
#[tokio::test]
async fn ownership_loss_at_staging_and_lock_replacement_refuse_writes() {
    let (_temp, copy, project) = simple_copy();
    let mut writer = copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    writer
        .call("register", &json!({"path":project}))
        .await
        .unwrap();
    drop(writer);
    let before = bytes(copy.path(), "project-registry.json");
    let active = Arc::new(AtomicBool::new(true));
    let check: milagre_registry::Active = Arc::new({
        let active = active.clone();
        let path = copy.path().to_owned();
        move || {
            if std::fs::read_dir(&path)
                .unwrap()
                .any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            {
                active.store(false, Ordering::SeqCst);
            }
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("Copy lease lost".into())
            }
        }
    });
    let mut writer = copy
        .writer(check, clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    let error = writer
        .call("position", &json!({"id":project,"position":{"x":2,"y":3}}))
        .await
        .unwrap_err();
    assert!(!error.committed);
    assert_eq!(before, bytes(copy.path(), "project-registry.json"));
    drop(writer);
    let mut writer = copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    std::fs::rename(
        copy.path().join(".registry-writer.lock"),
        copy.path().join("old-lock"),
    )
    .unwrap();
    std::fs::write(
        copy.path().join(".registry-writer.lock"),
        "replacement-owner",
    )
    .unwrap();
    assert!(writer
        .call("position", &json!({"id":project,"position":{"x":2,"y":3}}))
        .await
        .is_err());
    assert_eq!(before, bytes(copy.path(), "project-registry.json"));
    drop(writer);
    assert_eq!(
        std::fs::read_to_string(copy.path().join(".registry-writer.lock")).unwrap(),
        "replacement-owner"
    );
    assert!(copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .is_err());
}
#[test]
fn same_and_second_process_writers_are_excluded_without_lock_takeover() {
    let (_temp, copy, _project) = simple_copy();
    let writer = copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    assert!(copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .is_err());
    let result=Command::new("python3").args(["-c","import os,fcntl,sys\nf=os.open(sys.argv[1],os.O_RDONLY)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(0)\nsys.exit(1)"]).arg(copy.path()).output().unwrap();
    assert!(
        result.status.success(),
        "Another process acquired the pinned directory"
    );
    drop(writer);
    assert!(copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .is_ok());
}
#[tokio::test]
async fn invalid_change_does_not_persist_stale_cleanup_and_paths_never_escape_copy() {
    let (temp, copy, project) = simple_copy();
    let missing = temp.path().join("missing");
    let seed=json!({"scanned":true,"projects":[{"id":project,"path":project,"name":"project","git":false},{"id":missing,"path":missing,"name":"missing","git":false}],"links":[{"id":"gone","a":{"project_id":project},"b":{"project_id":missing}}],"projectGroups":[],"worktreePositions":{}}).to_string();
    std::fs::write(copy.path().join("project-registry.json"), &seed).unwrap();
    let mut writer = copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    assert!(writer
        .call(
            "position",
            &json!({"id":project,"position":{"x":"invalid","y":2}})
        )
        .await
        .is_err());
    assert_eq!(Some(seed), bytes(copy.path(), "project-registry.json"));
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("sentinel"), "same").unwrap();
    assert!(writer
        .call("register", &json!({"path":outside.path()}))
        .await
        .is_err());
    assert!(writer
        .call("recent:add", &json!({"path":outside.path()}))
        .await
        .is_err());
    std::fs::create_dir(project.join("child")).unwrap();
    assert!(writer
        .call(
            "worktree-position",
            &json!({"id":project,"path":project.join("child"),"position":{"x":1,"y":2}})
        )
        .await
        .is_err());
    assert_eq!(
        std::fs::read_to_string(outside.path().join("sentinel")).unwrap(),
        "same"
    );
}

#[test]
fn sigkill_after_staging_preserves_old_bytes_releases_locks_and_reopens() {
    let temp = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_registry-crash-fixture"))
        .arg(temp.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        result,
        json!({"killedBeforeRename":true,"oldBytesIntact":true,"lockReleasedByExit":true,"reopened":true,"orphanNotAdoptedOrRemoved":true})
    );
}

#[tokio::test]
async fn replaced_paths_and_aliased_targets_refuse_without_touching_outside_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (_temp, copy, project) = simple_copy();
    let ticks = || clock(Arc::new(AtomicUsize::new(0)));
    let mut writer = copy.writer(Arc::new(|| Ok(())), ticks()).unwrap();
    writer
        .call("register", &json!({"path":project}))
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(copy.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for file in [
        "project-registry.json",
        "MILAGRE-REGISTRY-COPY",
        ".registry-writer.lock",
    ] {
        assert_eq!(
            std::fs::metadata(copy.path().join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("sentinel");
    std::fs::write(&sentinel, "outside sentinel").unwrap();
    let target = copy.path().join("project-registry.json");
    let saved = std::fs::read(&target).unwrap();
    std::fs::remove_file(&target).unwrap();
    symlink(&sentinel, &target).unwrap();
    assert!(writer
        .call("register", &json!({"path":project}))
        .await
        .is_err());
    std::fs::remove_file(&target).unwrap();
    std::fs::hard_link(&sentinel, &target).unwrap();
    assert!(writer
        .call("register", &json!({"path":project}))
        .await
        .is_err());
    std::fs::remove_file(&target).unwrap();
    std::fs::write(&target, &saved).unwrap();
    let moved = copy.path().with_extension("moved");
    std::fs::rename(copy.path(), &moved).unwrap();
    symlink(outside.path(), copy.path()).unwrap();
    assert!(writer
        .call("register", &json!({"path":project}))
        .await
        .is_err());
    assert!(copy.writer(Arc::new(|| Ok(())), ticks()).is_err());
    drop(writer);
    assert_eq!(
        std::fs::read(moved.join("project-registry.json")).unwrap(),
        saved
    );
    assert_eq!(
        std::fs::read_to_string(&sentinel).unwrap(),
        "outside sentinel"
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
    std::fs::remove_file(copy.path()).unwrap();
    std::fs::rename(&moved, copy.path()).unwrap();
    let mut writer = copy.writer(Arc::new(|| Ok(())), ticks()).unwrap();
    std::fs::remove_file(copy.path().join(".registry-writer.lock")).unwrap();
    assert!(writer
        .call("register", &json!({"path":project}))
        .await
        .is_err());
    drop(writer);
    assert!(copy.writer(Arc::new(|| Ok(())), ticks()).is_err());
    assert!(!copy.path().join(".registry-writer.lock").exists());
}

#[tokio::test]
async fn mutation_cannot_create_a_registry_its_bounded_reader_will_refuse() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let a = isolation.root().join("a");
    let b = isolation.root().join("b");
    let missing = isolation.root().join("missing");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let groups = (0..4096).map(|id| json!({"id":format!("00000000-0000-0000-0000-{id:012}"),"name":"Existing","projectIds":[a,missing]})).collect::<Vec<_>>();
    let seed = json!({"scanned":true,"projects":[{"id":a,"path":a},{"id":b,"path":b}],"links":[],"projectGroups":groups}).to_string();
    let copy = RegistryCopy::create(
        isolation,
        Seeds {
            registry: Some(seed.as_bytes().to_vec()),
            recent: None,
        },
    )
    .unwrap();
    let mut writer = copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    let error = writer
        .call("group:create", &json!({"name":"New","projectIds":[a,b]}))
        .await
        .unwrap_err();
    assert!(!error.committed);
    assert_eq!(error.message, "Registry output entry limit exceeded.");
    assert_eq!(bytes(copy.path(), "project-registry.json"), Some(seed));
    assert!(copy.reader(Arc::new(|| Ok(()))).unwrap().snapshot().is_ok());
}

#[tokio::test]
async fn unverifiable_git_project_aborts_cleanup_instead_of_pruning_saved_state() {
    let (_temp, copy, project) = simple_copy();
    let output = Command::new("/usr/bin/git")
        .current_dir(&project)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &project)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["init", "-b", "main"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let healthy = project.parent().unwrap().join("healthy");
    std::fs::create_dir(&healthy).unwrap();
    let mut writer = copy
        .writer(Arc::new(|| Ok(())), clock(Arc::new(AtomicUsize::new(0))))
        .unwrap();
    writer
        .call("register", &json!({"path":project}))
        .await
        .unwrap();
    let before = bytes(copy.path(), "project-registry.json");
    let huge = project.join(".git/too-many");
    std::fs::create_dir(&huge).unwrap();
    for n in 0..4097 {
        std::fs::write(huge.join(n.to_string()), "").unwrap();
    }
    for (method, args) in [
        ("register", json!({"path":healthy})),
        (
            "position",
            json!({"id":project.join(".git"),"position":{"x":1,"y":2}}),
        ),
        ("link:prune", json!({})),
    ] {
        let error = writer.call(method, &args).await.unwrap_err();
        assert!(!error.committed);
        assert!(error.message.contains("inspection limit"), "{error}");
        assert_eq!(before, bytes(copy.path(), "project-registry.json"));
    }
    std::fs::remove_dir_all(&huge).unwrap();
    let config = project.join(".git/config");
    let original = std::fs::read_to_string(&config).unwrap();
    std::fs::write(
        &config,
        format!("{original}\n[include]\npath = never-read\n"),
    )
    .unwrap();
    let error = writer
        .call("register", &json!({"path":healthy}))
        .await
        .unwrap_err();
    assert!(error.message.contains("includes"));
    assert_eq!(before, bytes(copy.path(), "project-registry.json"));
}
