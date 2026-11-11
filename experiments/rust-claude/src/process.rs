//! Process-group signalling and the stderr tail.
//!
//! The CLI starts in its own process group (`process_group(0)`, the equivalent of Node's
//! `detached: true` in claude-provider.cjs), so one signal reaches the CLI and every command it started
//! (Bash tool shells, background tasks, MCP stdio servers) that stayed in the group.

use std::sync::{Arc, Mutex};

use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

/// Send `signal` to the whole group. A group that is already gone is not an error.
#[cfg(unix)]
pub fn signal_group(pgid: u32, signal: Signal) {
    let number = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // SAFETY: killpg only sends a signal; a stale group id fails with ESRCH, which is ignored.
    unsafe {
        libc::killpg(pgid as libc::pid_t, number);
    }
}

/// Whether any process is still in the group.
#[cfg(unix)]
pub fn group_alive(pgid: u32) -> bool {
    // SAFETY: signal 0 only checks existence and permission.
    unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
pub fn signal_group(_pgid: u32, _signal: Signal) {}

#[cfg(not(unix))]
pub fn group_alive(_pgid: u32) -> bool {
    false
}

/// The last `limit` bytes of stderr, shared with the supervisor. stderr is never parsed as protocol.
#[derive(Clone, Default)]
pub struct StderrTail(Arc<Mutex<Vec<u8>>>);

impl StderrTail {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }

    pub async fn drain(self, mut stderr: impl AsyncRead + Unpin, limit: usize) {
        let mut chunk = vec![0u8; 8192];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    let mut tail = self.0.lock().unwrap();
                    tail.extend_from_slice(&chunk[..read]);
                    if tail.len() > limit {
                        let excess = tail.len() - limit;
                        tail.drain(..excess);
                    }
                }
            }
        }
    }
}
