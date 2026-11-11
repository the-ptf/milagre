//! Every lost Git child counts once: a wait that fails (before any signal) and a reap that fails (after the signal)
//! each move it from held to lost once, and a later drop doesn't count it again. Its own binary: the count is
//! process-wide.

use std::time::Duration;

use milagre_owner_store::changed_files::test_hooks::{
    fail_next_reap, fail_next_wait, lost_children, run_bounded, take_process_log,
};

#[test]
fn each_lost_child_counts_exactly_once() {
    take_process_log();
    let before = lost_children();
    // Lost at a wait: never signalled (still running, cleaned up below).
    fail_next_wait(libc::ECHILD);
    assert_eq!(
        run_bounded("/bin/sleep", &["30"], Duration::from_secs(5), 1024),
        None
    );
    // Lost at the reap, after its group was signalled (left unreaped, cleaned up below).
    fail_next_reap();
    assert_eq!(
        run_bounded("/bin/sh", &["-c", "echo ok"], Duration::from_secs(5), 1024),
        None
    );
    let log = take_process_log();
    let kinds: Vec<&str> = log.iter().map(|(what, _)| *what).collect();
    assert_eq!(kinds, vec!["lost", "signal", "lost"], "{log:?}");
    assert_eq!(lost_children() - before, 2);
    for (what, pid) in log {
        if what == "lost" {
            // SAFETY: cleaning up the test's own children.
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
                libc::waitpid(pid as i32, std::ptr::null_mut(), 0);
            }
        }
    }
}
