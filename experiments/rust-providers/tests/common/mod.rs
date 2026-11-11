#![allow(dead_code)]

use milagre_providers::codex::{Limits, ServerEvent, SpawnOptions};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

pub const FAKE: &str = env!("CARGO_BIN_EXE_fake-codex-app-server");

/// The Rust fake app-server with a scenario, inheriting the environment.
pub fn fake(scenario: &str) -> SpawnOptions {
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().collect();
    env.push(("FAKE_SCENARIO".into(), scenario.into()));
    SpawnOptions::new(FAKE).args(Vec::<String>::new()).env(env).limits(fast_limits())
}

/// Shorter graces so failure paths finish quickly.
pub fn fast_limits() -> Limits {
    Limits { kill_grace: Duration::from_millis(500), drain_grace: Duration::from_millis(200), ..Limits::default() }
}

/// The repository's Node fake (packages/core/src/agents/fixtures/fake-app-server.cjs), or None
/// when node isn't installed.
pub fn node_fake(scenario: &str) -> Option<SpawnOptions> {
    let node = which("node")?;
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/agents/fixtures/fake-app-server.cjs");
    assert!(script.exists(), "missing {}", script.display());
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().collect();
    env.push(("FAKE_SCENARIO".into(), scenario.into()));
    Some(SpawnOptions::new(node).args([script.into_os_string()]).env(env).limits(fast_limits()))
}

pub fn which(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join(name)).find(|p| p.is_file()))
}

/// Next event matching `pick`, failing after 5 s.
pub async fn next_matching<T>(events: &mut UnboundedReceiver<ServerEvent>, mut pick: impl FnMut(&ServerEvent) -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.expect("event stream ended");
            if let Some(found) = pick(&event) {
                return found;
            }
        }
    })
    .await
    .expect("timed out waiting for an event")
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

pub async fn eventually(mut check: impl FnMut() -> bool, within: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    while tokio::time::Instant::now() < deadline {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    check()
}
