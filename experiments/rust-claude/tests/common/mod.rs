#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use milagre_claude::{ClaudeEvent, EventStream, LaunchOptions, Limits};
use serde_json::Value;

static NEXT: AtomicU64 = AtomicU64::new(0);

pub fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("milagre-claude-{}-{}-{}", std::process::id(), name, NEXT.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// LaunchOptions for the scripted fake, with a clean environment.
pub fn fake(name: &str, script: Value) -> (LaunchOptions, PathBuf) {
    let dir = scratch(name);
    let path = dir.join("script.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&script).unwrap()).unwrap();
    let mut options = LaunchOptions::new(env!("CARGO_BIN_EXE_fake-claude"));
    options.env = Some(vec![
        ("FAKE_CLAUDE_SCRIPT".into(), path.clone().into_os_string()),
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
        ("CLAUDECODE".into(), "1".into()),
    ]);
    options.cwd = Some(dir.clone());
    (options, dir)
}

pub fn quick_limits() -> Limits {
    Limits {
        request_timeout: Some(Duration::from_secs(10)),
        initialize_timeout: Duration::from_secs(10),
        drain_grace: Duration::from_millis(300),
        close_grace: Duration::from_millis(500),
        kill_grace: Duration::from_millis(500),
        ..Limits::default()
    }
}

/// The next Message event, skipping diagnostics. Panics on exit or after 10 s.
pub async fn next_message(events: &mut EventStream) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), events.recv()).await.expect("timed out waiting for a message") {
            Some(ClaudeEvent::Message(value)) => return value,
            Some(ClaudeEvent::Diagnostic(_)) => continue,
            other => panic!("expected a message, got {other:?}"),
        }
    }
}

/// Collect everything until Exit (inclusive).
pub async fn drain(events: &mut EventStream) -> Vec<ClaudeEvent> {
    let mut out = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(15), events.recv()).await.expect("timed out draining") {
            Some(event @ ClaudeEvent::Exit(_)) => {
                out.push(event);
                return out;
            }
            Some(event) => out.push(event),
            None => return out,
        }
    }
}

#[cfg(unix)]
pub fn pid_alive(pid: i32) -> bool {
    // SAFETY: signal 0 checks existence only.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Wait until the pid is gone (reaped by init once its parent died), up to 3 s.
pub async fn wait_dead(pid: i32) -> bool {
    for _ in 0..60 {
        if !pid_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}
