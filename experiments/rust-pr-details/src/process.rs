//! Bounded, retained subprocess ownership adapted from Milagre's changed_files
//! NOWAIT runner. No unowned process-group signalling or detached pipe readers.
use std::{
    io::{Read, Write},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

static LIVE: AtomicUsize = AtomicUsize::new(0);
#[derive(Default)]
pub struct ReadMonitor {
    active: AtomicUsize,
    retained: AtomicBool,
}
impl ReadMonitor {
    pub fn active_children(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
    pub fn cleanup_retained(&self) -> bool {
        self.retained.load(Ordering::Acquire)
    }
}
struct Credit(Arc<ReadMonitor>);
impl Credit {
    fn acquire(monitor: Arc<ReadMonitor>) -> Result<Self, String> {
        LIVE.try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 8).then_some(n + 1)
        })
        .map(|_| {
            monitor.active.fetch_add(1, Ordering::AcqRel);
            Self(monitor)
        })
        .map_err(|_| "GitHub read capacity is full".into())
    }
}
impl Drop for Credit {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::AcqRel);
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Retained {
    _child: Child,
    _credit: Credit,
    _lease: Arc<dyn Send + Sync>,
}
struct Owned {
    child: Option<Child>,
    pid: rustix::process::Pid,
    credit: Option<Credit>,
    lease: Arc<dyn Send + Sync>,
    lost: bool,
}
impl Owned {
    fn probe(&mut self) -> Result<bool, String> {
        if self.lost || self.child.is_none() {
            return Err("GitHub child ownership is unknown".into());
        }
        loop {
            match rustix::process::waitid(
                rustix::process::WaitId::Pid(self.pid),
                rustix::process::WaitIdOptions::EXITED
                    | rustix::process::WaitIdOptions::NOHANG
                    | rustix::process::WaitIdOptions::NOWAIT,
            ) {
                Ok(v) => return Ok(v.is_some()),
                Err(rustix::io::Errno::INTR) => continue,
                Err(_) => {
                    self.lost = true;
                    return Err("GitHub child wait ownership was lost".into());
                }
            }
        }
    }
    fn finish(&mut self) -> Result<ExitStatus, String> {
        self.probe()?; // Still unreaped, so its process-group id cannot be reused.
        let _ = rustix::process::kill_process_group(self.pid, rustix::process::Signal::KILL);
        let _ = rustix::process::kill_process(self.pid, rustix::process::Signal::KILL);
        let by = Instant::now() + Duration::from_secs(3);
        while !self.probe()? {
            if Instant::now() >= by {
                return Err("GitHub child cleanup is unconfirmed".into());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        match self.child.as_mut().unwrap().wait() {
            Ok(status) => {
                self.child.take();
                self.credit.take();
                Ok(status)
            }
            Err(_) => {
                self.lost = true;
                Err("GitHub child reap is unconfirmed".into())
            }
        }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        let _ = self.finish();
        if let (Some(child), Some(credit)) = (self.child.take(), self.credit.take()) {
            credit.0.retained.store(true, Ordering::Release);
            // Capacity and owner lifetime stay retained forever on an unknown wait.
            // There are at most eight entries, bounded by Credit admission.
            static RETAINED: OnceLock<Mutex<Vec<Retained>>> = OnceLock::new();
            let item = Retained {
                _child: child,
                _credit: credit,
                _lease: self.lease.clone(),
            };
            match RETAINED.get_or_init(|| Mutex::new(Vec::new())).lock() {
                Ok(mut parked) => parked.push(item),
                Err(_) => {
                    let _ = writeln!(
                        std::io::stderr(),
                        "GitHub read cleanup retained after poisoned storage"
                    );
                    std::mem::forget(item);
                }
            }
        }
    }
}

pub(crate) struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
pub(crate) fn run(
    mut command: Command,
    deadline: Instant,
    limit: usize,
    lease: Arc<dyn Send + Sync>,
    monitor: Arc<ReadMonitor>,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<Output, String> {
    use std::os::unix::process::CommandExt;
    check()?;
    let credit = Credit::acquire(monitor)?;
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|_| "The explicitly configured GitHub CLI could not be started".to_owned())?;
    let pid = rustix::process::Pid::from_child(&child);
    let mut owned = Owned {
        child: Some(child),
        pid,
        credit: Some(credit),
        lease,
        lost: false,
    };
    let mut stdout = owned
        .child
        .as_mut()
        .unwrap()
        .stdout
        .take()
        .ok_or("Missing GitHub stdout")?;
    let mut stderr = owned
        .child
        .as_mut()
        .unwrap()
        .stderr
        .take()
        .ok_or("Missing GitHub stderr")?;
    for pipe in [
        std::os::fd::AsFd::as_fd(&stdout),
        std::os::fd::AsFd::as_fd(&stderr),
    ] {
        let flags = rustix::fs::fcntl_getfl(pipe).map_err(|_| "Cannot configure GitHub pipe")?;
        rustix::fs::fcntl_setfl(pipe, flags | rustix::fs::OFlags::NONBLOCK)
            .map_err(|_| "Cannot configure GitHub pipe")?;
    }
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let (mut out_open, mut err_open) = (true, true);
    let mut exited_at = None;
    let mut buf = [0u8; 8192];
    loop {
        check()?;
        for (pipe, bytes, open) in [
            (&mut stdout as &mut dyn Read, &mut out, &mut out_open),
            (&mut stderr as &mut dyn Read, &mut err, &mut err_open),
        ] {
            if !*open {
                continue;
            }
            match pipe.read(&mut buf) {
                Ok(0) => *open = false,
                Ok(n) => {
                    if n > limit.saturating_sub(bytes.len()) {
                        return Err("GitHub response exceeded the output bound".into());
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err("GitHub response pipe failed".into()),
            }
        }
        if owned.probe()? && exited_at.is_none() {
            exited_at = Some(Instant::now());
        }
        if exited_at.is_some() && !out_open && !err_open {
            break;
        }
        if Instant::now() >= deadline {
            return Err("GitHub read timed out".into());
        }
        if exited_at.is_some_and(|at| at.elapsed() >= Duration::from_millis(250)) {
            return Err("GitHub descendants kept the response pipes open".into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let status = owned.finish()?;
    check()?;
    Ok(Output {
        status,
        stdout: out,
        stderr: err,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_owned_children_reap_on_timeout_overflow_and_authority_loss() {
        for case in ["timeout", "overflow", "authority"] {
            let root = tempfile::tempdir().unwrap();
            let pidfile = root.path().join("pid");
            let mut command = Command::new("/bin/sh");
            command.current_dir(root.path()).arg("-c").arg(match case {
                "overflow" => "echo $$ > pid; printf 123456789; exec /bin/sleep 30",
                _ => "echo $$ > pid; exec /bin/sleep 30",
            });
            let check = || {
                if case == "authority" && pidfile.exists() {
                    Err("Owner revoked".into())
                } else {
                    Ok(())
                }
            };
            let started = Instant::now();
            let monitor = Arc::new(ReadMonitor::default());
            let result = run(
                command,
                Instant::now() + Duration::from_millis(100),
                4,
                Arc::new(()),
                monitor.clone(),
                &check,
            );
            let error = result
                .err()
                .expect("The rejected child must not return output");
            assert_eq!(monitor.active_children(), 0);
            assert!(!monitor.cleanup_retained());
            match case {
                "timeout" => assert!(error.contains("timed out")),
                "overflow" => assert!(error.contains("bound")),
                _ => assert_eq!(error, "Owner revoked"),
            }
            assert!(started.elapsed() < Duration::from_secs(4));
            let pid = std::fs::read_to_string(&pidfile).unwrap();
            let present = Command::new("/bin/ps")
                .args(["-p", pid.trim(), "-o", "pid="])
                .output()
                .unwrap();
            assert!(
                !present.status.success(),
                "Only this retained child should already be reaped"
            );
        }
    }
}
