//! The lost-child report never panics: with stderr a pipe whose reader is gone (`EPIPE`; Rust ignores `SIGPIPE`), a
//! lost child is still counted and the run still gives nothing. Run in a child process of this test binary.

use std::os::fd::{FromRawFd, OwnedFd};
use std::process::{Command, Stdio};
use std::time::Duration;

use milagre_owner_store::changed_files::test_hooks::{
    fail_next_wait, lost_children, run_bounded, take_process_log,
};

const CHILD: &str = "MILAGRE_LOST_CHILD_STDERR";

/// What the child process runs (nothing in the parent).
#[test]
fn child_mode() {
    if std::env::var_os(CHILD).is_none() {
        return;
    }
    use std::io::Write;
    let broken = std::io::stderr().write_all(b"probe\n").unwrap_err();
    assert_eq!(
        broken.kind(),
        std::io::ErrorKind::BrokenPipe,
        "stderr isn't a broken pipe"
    );
    fail_next_wait(libc::ECHILD);
    assert_eq!(
        run_bounded("/bin/sleep", &["30"], Duration::from_secs(5), 1024),
        None
    );
    assert_eq!(lost_children(), 1);
    for (what, pid) in take_process_log() {
        if what == "lost" {
            // SAFETY: cleaning up this process's own child.
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
                libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
            }
        }
    }
}

#[test]
fn a_lost_child_report_to_a_closed_stderr_does_not_panic() {
    let mut fds = [0; 2];
    // SAFETY: a fresh pipe; both ends are owned below.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: just created, owned once each.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    drop(read);
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_mode", "--nocapture", "--test-threads=1"])
        .env(CHILD, "1")
        .stdin(Stdio::null())
        .stderr(Stdio::from(write))
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("1 passed"), "{stdout}");
}
