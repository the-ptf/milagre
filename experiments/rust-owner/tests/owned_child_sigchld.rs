//! With `SIGCHLD` ignored (children reaped by the kernel, as a global reaper would), the bounded runner's wait fails
//! with `ECHILD` once the child exits: the child is lost, the run gives no output, and nothing is signalled (its pid
//! may already be another process's). Its own binary: the disposition is process-wide.

use std::time::Duration;

use milagre_owner_store::changed_files::test_hooks::{
    lost_children, run_bounded, take_process_log,
};

#[test]
fn an_ignored_sigchld_loses_the_child_without_signalling_it() {
    // SAFETY: this binary has this one test; the disposition is put back below.
    let previous = unsafe { libc::signal(libc::SIGCHLD, libc::SIG_IGN) };
    take_process_log();
    let before = lost_children();
    let output = run_bounded("/bin/sh", &["-c", "echo ok"], Duration::from_secs(5), 1024);
    let again = run_bounded("/bin/sh", &["-c", "echo ok"], Duration::from_secs(5), 1024);
    let log = take_process_log();
    // SAFETY: as above.
    unsafe { libc::signal(libc::SIGCHLD, previous) };
    assert_eq!((output, again), (None, None));
    let kinds: Vec<&str> = log.iter().map(|(what, _)| *what).collect();
    assert_eq!(kinds, vec!["lost", "lost"], "{log:?}");
    // Both counted (the first one reported once on stderr).
    assert_eq!(lost_children() - before, 2);
}
