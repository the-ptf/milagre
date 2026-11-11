//! Disposable single-threaded fork fixture. No provider or production profile.
use milagre_content_store::{design::DesignKits, ArtifactStore, Result, SystemRuntime};
use milagre_owner_store::{Isolation, Policy};
use serde_json::json;
use std::{path::Path, sync::Arc};

fn wait(child: libc::pid_t) {
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(child, &mut status, 0) }, child);
    assert!(libc::WIFEXITED(status));
    assert_eq!(libc::WEXITSTATUS(status), 0);
}
fn check<T>(open: impl Fn() -> Result<T>) {
    // No runtime or background thread exists before either fork.
    let owner = open().unwrap();
    let child = unsafe { libc::fork() };
    assert!(child >= 0);
    if child == 0 {
        drop(owner);
        unsafe { libc::_exit(0) };
    }
    wait(child);
    assert_eq!(
        open().err().unwrap().code,
        "STORE_OWNED",
        "Child Drop must not unlock its parent"
    );
    drop(owner);

    let owner = open().unwrap();
    let mut pipe = [0; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    let child = unsafe { libc::fork() };
    assert!(child >= 0);
    if child == 0 {
        unsafe { libc::close(pipe[1]) };
        let mut byte = 0u8;
        let received = unsafe { libc::read(pipe[0], (&mut byte as *mut u8).cast(), 1) };
        drop(owner);
        unsafe { libc::_exit(if received == 1 { 0 } else { 2 }) };
    }
    unsafe { libc::close(pipe[0]) };
    drop(owner);
    // The child retains its inherited store until the explicit pipe rendezvous.
    // Capture acquisition before signalling it; no sleeps or retry loop.
    let successor = open();
    let exactly_one = successor.as_ref().is_ok_and(|_| {
        open()
            .err()
            .is_some_and(|error| error.code == "STORE_OWNED")
    });
    let byte = 1u8;
    assert_eq!(
        unsafe { libc::write(pipe[1], (&byte as *const u8).cast(), 1) },
        1
    );
    unsafe { libc::close(pipe[1]) };
    wait(child);
    let successor = successor.expect("Owner shutdown must release before inherited fd closes");
    assert!(exactly_one);
    assert_eq!(
        open().err().unwrap().code,
        "STORE_OWNED",
        "Old child Drop must not unlock the successor"
    );
    drop(successor);
    open().unwrap();
}
fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("fresh empty isolated fixture root");
    let isolation = Isolation::create(Path::new(&root), &Policy::default()).unwrap();
    check(|| {
        ArtifactStore::open(
            isolation.clone(),
            Path::new("artifacts"),
            Arc::new(|_| Ok(())),
            Arc::new(|| Ok(())),
            Arc::new(SystemRuntime),
        )
    });
    check(|| {
        DesignKits::open(
            isolation.clone(),
            Path::new("kits"),
            Arc::new(|_| Ok("fixture-project".into())),
            Arc::new(|| Ok(())),
        )
    });
    println!(
        "{}",
        json!({"artifactStore":true,"designKits":true,"childDropPreservesParentLock":true,"releaseBeforeChildExit":true,"exactlyOneSuccessor":true,"lateChildDropPreservesSuccessorLock":true})
    );
}
