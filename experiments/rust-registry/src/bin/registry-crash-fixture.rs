//! A disposable test process. Fork happens before any Tokio runtime or thread.
#[cfg(unix)]
fn main() {
    use milagre_owner_store::{Isolation, Policy};
    use milagre_registry::writer::{RegistryCopy, Seeds};
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };
    let root = PathBuf::from(std::env::args().nth(1).expect("fresh empty fixture root"));
    let isolation = Isolation::create(&root, &Policy::default()).unwrap();
    let project = isolation.root().join("project");
    std::fs::create_dir(&project).unwrap();
    let seed = b"{\"scanned\":true,\"projects\":[],\"links\":[],\"worktreePositions\":{}}".to_vec();
    let copy = RegistryCopy::create(
        isolation,
        Seeds {
            registry: Some(seed.clone()),
            recent: None,
        },
    )
    .unwrap();
    // This binary is single-threaded until after fork. Each process creates its
    // own runtime afterwards; no parent runtime mutex or worker can be inherited.
    let child = unsafe { libc::fork() };
    assert!(child >= 0);
    if child == 0 {
        let guard: milagre_registry::Active = Arc::new({
            let path = copy.path().to_owned();
            move || {
                if std::fs::read_dir(&path).unwrap().any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".tmp")
                }) {
                    unsafe { libc::raise(libc::SIGSTOP) };
                }
                Ok(())
            }
        });
        let mut writer = copy
            .writer(guard, Arc::new(|| "2026-01-01T00:00:00.000Z".into()))
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ = runtime.block_on(writer.call("register", &json!({"path":project})));
        std::process::exit(4);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut status = 0;
    loop {
        let found = unsafe { libc::waitpid(child, &mut status, libc::WNOHANG | libc::WUNTRACED) };
        if found == child {
            break;
        }
        if Instant::now() >= deadline {
            unsafe {
                libc::kill(child, libc::SIGKILL);
                libc::waitpid(child, &mut status, 0);
            }
            panic!("Fixture did not reach pre-rename checkpoint");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(libc::WIFSTOPPED(status));
    unsafe {
        libc::kill(child, libc::SIGKILL);
        libc::waitpid(child, &mut status, 0);
    }
    assert!(libc::WIFSIGNALED(status));
    assert_eq!(
        std::fs::read(copy.path().join("project-registry.json")).unwrap(),
        seed
    );
    let orphan = std::fs::read_dir(copy.path())
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .unwrap()
        .path();
    let staged = std::fs::read(&orphan).unwrap();
    let mut writer = copy
        .writer(
            Arc::new(|| Ok(())),
            Arc::new(|| "2026-01-01T00:00:01.000Z".into()),
        )
        .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime
        .block_on(writer.call("register", &json!({"path":project})))
        .unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(copy.path().join("project-registry.json")).unwrap())
            .unwrap();
    assert_eq!(saved["projects"][0]["openedAt"], "2026-01-01T00:00:01.000Z");
    assert_eq!(std::fs::read(orphan).unwrap(), staged);
    println!(
        "{}",
        json!({"killedBeforeRename":true,"oldBytesIntact":true,"lockReleasedByExit":true,"reopened":true,"orphanNotAdoptedOrRemoved":true})
    );
}
#[cfg(not(unix))]
fn main() {
    panic!("This isolated writer fixture requires Unix");
}
