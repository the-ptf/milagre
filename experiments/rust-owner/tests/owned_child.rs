//! The bounded runner owns its child from right after spawn: on every path (success, a descendant holding a pipe, a
//! timeout, a setup failure) its whole process group is killed before it is reaped, exactly once. A descendant that
//! left the group isn't owned and isn't signalled.

use std::path::Path;
use std::time::{Duration, Instant};

use milagre_owner_store::changed_files::test_hooks::{before_setup, run_bounded, take_reaps};

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks the process exists (a zombie still does).
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Waits up to 3 s for `pid` to be gone (a killed orphan is reaped by launchd).
fn gone(pid: i32) -> bool {
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn pid_in(file: &Path) -> i32 {
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = std::fs::read_to_string(file) {
            if let Ok(pid) = text.trim().parse() {
                return pid;
            }
        }
        assert!(Instant::now() < until, "no pid written");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Exited normally: a descendant still holding stdout is killed with the group (no output, no 30 s wait), and one
/// that closed its pipes (a daemon) is killed too while the output is kept. The child is reaped once each time.
#[test]
fn descendants_in_the_group_die_with_it_after_a_normal_exit() {
    let base = tempfile::tempdir().unwrap();
    take_reaps();
    for (name, script, expected) in [
        ("holding", "sleep 30 & echo $! > {pid}; echo hi", None),
        (
            "daemon",
            "sleep 30 </dev/null >/dev/null 2>&1 & echo $! > {pid}; echo ok",
            Some("ok\n"),
        ),
    ] {
        let pidfile = base.path().join(name);
        let script = script.replace("{pid}", &pidfile.display().to_string());
        let started = Instant::now();
        let output = run_bounded("/bin/sh", &["-c", &script], Duration::from_secs(5), 1024);
        assert_eq!(output.as_deref(), expected, "{name}");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{name}: {:?}",
            started.elapsed()
        );
        let descendant = pid_in(&pidfile);
        assert!(
            gone(descendant),
            "{name}: a descendant in the group outlived the run"
        );
        let reaps = take_reaps();
        assert_eq!(reaps.len(), 1, "{name}: reaped {reaps:?}");
        assert!(!alive(reaps[0] as i32), "{name}: the child wasn't reaped");
    }
}

/// A setup failure right after spawn (injected once the child has started a descendant): the run gives nothing, the
/// child is reaped exactly once and its descendant is killed; the same for a timeout.
#[test]
fn a_setup_failure_or_timeout_kills_the_group_and_reaps_once() {
    let base = tempfile::tempdir().unwrap();
    take_reaps();
    let pidfile = base.path().join("setup");
    let watched = pidfile.clone();
    let child = std::rc::Rc::new(std::cell::Cell::new(0u32));
    let seen = child.clone();
    before_setup(move |pid| {
        seen.set(pid);
        pid_in(&watched);
        true
    });
    let script = format!("sleep 30 & echo $! > {}; wait", pidfile.display());
    assert_eq!(
        run_bounded("/bin/sh", &["-c", &script], Duration::from_secs(5), 1024),
        None
    );
    assert_eq!(take_reaps(), vec![child.get()], "not reaped exactly once");
    assert!(!alive(child.get() as i32));
    assert!(
        gone(pid_in(&pidfile)),
        "the descendant outlived a setup failure"
    );
    // A timeout.
    let pidfile = base.path().join("timeout");
    let script = format!("sleep 30 & echo $! > {}; wait", pidfile.display());
    assert_eq!(
        run_bounded(
            "/bin/sh",
            &["-c", &script],
            Duration::from_millis(300),
            1024
        ),
        None
    );
    assert_eq!(take_reaps().len(), 1);
    assert!(gone(pid_in(&pidfile)));
}

/// A descendant that left the group (its own session) isn't owned: it isn't signalled, and with its output redirected
/// the run's output is kept. (Cleaned up here.)
#[test]
fn a_descendant_that_left_the_group_is_not_owned() {
    if !Path::new("/usr/bin/perl").exists() {
        return;
    }
    let base = tempfile::tempdir().unwrap();
    take_reaps();
    let pidfile = base.path().join("escaped");
    let script = format!(
        "/usr/bin/perl -e 'use POSIX; POSIX::setsid(); open(my $f, \">\", \"{0}\"); print $f $$; close $f; sleep 30' </dev/null >/dev/null 2>&1 & while [ ! -s {0} ]; do sleep 0.01; done; echo ok",
        pidfile.display()
    );
    assert_eq!(
        run_bounded("/bin/sh", &["-c", &script], Duration::from_secs(5), 1024).as_deref(),
        Some("ok\n")
    );
    let escaped = pid_in(&pidfile);
    std::thread::sleep(Duration::from_millis(100));
    let survived = alive(escaped);
    // SAFETY: cleaning up the test's own process.
    unsafe { libc::kill(escaped, libc::SIGKILL) };
    assert!(survived, "a descendant outside the group was signalled");
    assert_eq!(take_reaps().len(), 1);
}

/// A wait that fails loses the child: `ECHILD` (something else reaped it) or another error gives no output and the
/// child is never signalled or waited on again (it is still running here, so it was untouched; cleaned up by the
/// test). An interrupted wait is retried and the run finishes normally.
#[test]
fn a_failed_wait_loses_the_child_and_never_signals_it() {
    use milagre_owner_store::changed_files::test_hooks::{fail_next_wait, take_process_log};
    take_process_log();
    for errno in [libc::ECHILD, libc::EINVAL] {
        fail_next_wait(errno);
        assert_eq!(
            run_bounded("/bin/sleep", &["30"], Duration::from_secs(5), 1024),
            None
        );
        let log = take_process_log();
        assert_eq!(log.len(), 1, "errno {errno}: {log:?}");
        assert_eq!(log[0].0, "lost");
        let pid = log[0].1 as i32;
        assert!(alive(pid), "errno {errno}: a lost child was signalled");
        // SAFETY: cleaning up the test's own child.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
    }
    // The check right before signalling: a setup failure whose cleanup wait says the child is gone signals nothing.
    before_setup(|_| {
        fail_next_wait(libc::ECHILD);
        true
    });
    assert_eq!(
        run_bounded("/bin/sleep", &["30"], Duration::from_secs(5), 1024),
        None
    );
    let log = take_process_log();
    assert_eq!(
        log.iter().map(|(what, _)| *what).collect::<Vec<_>>(),
        vec!["lost"]
    );
    let pid = log[0].1 as i32;
    assert!(alive(pid), "signalled although its wait said it was gone");
    // SAFETY: cleaning up the test's own child.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
        libc::waitpid(pid, std::ptr::null_mut(), 0);
    }
    fail_next_wait(libc::EINTR);
    assert_eq!(
        run_bounded("/bin/sh", &["-c", "echo ok"], Duration::from_secs(5), 1024).as_deref(),
        Some("ok\n")
    );
    let log = take_process_log();
    assert_eq!(
        log.iter().map(|(what, _)| *what).collect::<Vec<_>>(),
        vec!["signal", "reap"]
    );
}

/// On every path the group is signalled before the one reap, and nothing after it: success, a descendant holding a
/// pipe, a timeout, too much output.
#[test]
fn nothing_is_signalled_after_the_reap() {
    use milagre_owner_store::changed_files::test_hooks::take_process_log;
    take_process_log();
    for (script, timeout) in [
        ("echo ok", Duration::from_secs(5)),
        ("sleep 30 & echo hi", Duration::from_secs(5)),
        ("sleep 30", Duration::from_millis(200)),
        ("head -c 4096 /dev/zero", Duration::from_secs(5)),
    ] {
        run_bounded("/bin/sh", &["-c", script], timeout, 1024);
        let log = take_process_log();
        let kinds: Vec<&str> = log.iter().map(|(what, _)| *what).collect();
        assert_eq!(kinds, vec!["signal", "reap"], "{script}");
        assert_eq!(log[0].1, log[1].1);
    }
}

/// A panic while the run holds the child (here in the setup hook, once a descendant started): unwinding kills the
/// group and reaps the child once.
#[test]
fn a_panic_kills_the_group_and_reaps_once() {
    use milagre_owner_store::changed_files::test_hooks::take_process_log;
    let base = tempfile::tempdir().unwrap();
    take_process_log();
    let pidfile = base.path().join("panic");
    let watched = pidfile.clone();
    before_setup(move |_| {
        pid_in(&watched);
        panic!("injected");
    });
    let script = format!("sleep 30 & echo $! > {}; wait", pidfile.display());
    let unwound = std::panic::catch_unwind(|| {
        run_bounded("/bin/sh", &["-c", &script], Duration::from_secs(5), 1024)
    });
    assert!(unwound.is_err());
    let log = take_process_log();
    let kinds: Vec<&str> = log.iter().map(|(what, _)| *what).collect();
    assert_eq!(kinds, vec!["signal", "reap"]);
    assert!(!alive(log[1].1 as i32));
    assert!(gone(pid_in(&pidfile)), "the descendant outlived the panic");
}
