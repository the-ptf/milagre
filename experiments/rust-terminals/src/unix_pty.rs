//! The real PTY layer on macOS and Linux, standing in for node-pty 1.1.0.
//!
//! portable-pty 0.9 (wezterm) opens the PTY and starts the shell: it resets signal dispositions and the signal mask,
//! makes the shell a session leader with the PTY as its controlling terminal, and closes inherited descriptors before
//! exec. Everything after that is here, on our own close-on-exec, non-blocking copy of the master descriptor:
//!
//! - one reader thread decodes output as node-pty does (StringDecoder rules, see [`crate::utf8`]);
//! - one writer thread delivers input in call order without ever blocking the caller on a full PTY;
//! - one waiter thread reaps the shell and reports a single exit once output has drained (or `exit_drain` passed,
//!   when a background job keeps the PTY open);
//! - [`PtyProcess::kill`] hangs up and, after `kill_grace`, SIGKILLs what is left (see [`Cleanup`]).
//!
//! portable-pty's own writer is not used: dropping it types a newline and EOF into the shell, which would run a
//! half-typed command line as the Terminal closes.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::spawn::{ExitInfo, PtyOutput, PtyProcess, PtySpawner, SpawnRequest};
use crate::utf8::Utf8Stream;

const POLL_MS: i32 = 100;
const READ_CHUNK: usize = 64 * 1024;

/// What closing a Terminal stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cleanup {
    /// What closing a terminal window does, as node-pty's `kill()` (SIGHUP) but to the shell's whole process group
    /// and the foreground job's group, then SIGKILL to both once `kill_grace` passes. Jobs the user put in the
    /// background with `nohup`/`disown` keep running, as they do after closing a window of the user's terminal app.
    Hangup,
    /// `Hangup`, plus every process below the shell at close time, found by parent pid before anything is signalled
    /// (process-tree.cjs `killTree(..., { descendants: true })`). Background and `nohup` jobs end too.
    Tree,
}

#[derive(Clone, Debug)]
pub struct UnixPtySpawner {
    pub cleanup: Cleanup,
    pub kill_grace: Duration,
    pub exit_drain: Duration,
}

impl Default for UnixPtySpawner {
    fn default() -> Self {
        UnixPtySpawner { cleanup: Cleanup::Hangup, kill_grace: Duration::from_millis(2000), exit_drain: Duration::from_millis(250) }
    }
}

struct Shared {
    pid: Option<u32>,
    shell_file: String,
    raw: RawFd,
    fd: Mutex<Option<OwnedFd>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
    stop: AtomicBool,
    reaped: AtomicBool,
    killed: AtomicBool,
    shut: AtomicBool,
    io_drained: AtomicBool,
    waiter_done: AtomicBool,
    kill_done: AtomicBool,
    lost_child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    reader_done: (Mutex<bool>, Condvar),
}

impl Shared {
    /// Stops the reader and writer, then closes every master descriptor. Never called from those two threads.
    fn shutdown(&self) {
        if self.shut.swap(true, Ordering::SeqCst) {
            return;
        }
        self.stop.store(true, Ordering::SeqCst);
        self.writer.lock().unwrap().take();
        let threads = std::mem::take(&mut *self.threads.lock().unwrap());
        for thread in threads {
            let _ = thread.join();
        }
        self.master.lock().unwrap().take();
        self.fd.lock().unwrap().take();
        self.io_drained.store(true, Ordering::SeqCst);
    }

    fn foreground_group(&self) -> Option<i32> {
        let fd = self.fd.lock().unwrap();
        let fd = fd.as_ref()?;
        match unsafe { libc::tcgetpgrp(fd.as_raw_fd()) } {
            pgid if pgid > 0 => Some(pgid),
            _ => None,
        }
    }
}

pub struct UnixPty {
    shared: Arc<Shared>,
    cleanup: Cleanup,
    kill_grace: Duration,
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn poll_fd(fd: RawFd, events: libc::c_short) -> (i32, libc::c_short) {
    let mut pfd = libc::pollfd { fd, events, revents: 0 };
    let result = unsafe { libc::poll(&mut pfd, 1, POLL_MS) };
    (result, pfd.revents)
}

fn reader(shared: Arc<Shared>, output: Arc<dyn PtyOutput>) {
    let mut decoder = Utf8Stream::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    let fd = shared.raw;
    loop {
        if shared.stop.load(Ordering::SeqCst) {
            break;
        }
        let (ready, revents) = poll_fd(fd, libc::POLLIN);
        if ready < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            break;
        }
        if ready == 0 {
            continue;
        }
        let n = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
        if n > 0 {
            let text = decoder.decode(&buffer[..n as usize]);
            if !text.is_empty() {
                output.data(&text);
            }
            continue;
        }
        if n < 0 {
            let error = errno();
            if (error == libc::EAGAIN || error == libc::EINTR) && revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) == 0 {
                continue;
            }
        }
        // EOF, EIO (the slave side closed) or a hangup with nothing left to read.
        break;
    }
    let tail = decoder.finish();
    if !tail.is_empty() && !shared.stop.load(Ordering::SeqCst) {
        output.data(&tail);
    }
    let (lock, signal) = &shared.reader_done;
    *lock.lock().unwrap() = true;
    signal.notify_all();
}

fn writer(shared: Arc<Shared>, queue: mpsc::Receiver<Vec<u8>>) {
    let fd = shared.raw;
    'queue: loop {
        let chunk = match queue.recv_timeout(Duration::from_millis(POLL_MS as u64)) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if shared.stop.load(Ordering::SeqCst) {
                    break;
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut written = 0;
        while written < chunk.len() {
            if shared.stop.load(Ordering::SeqCst) {
                break 'queue;
            }
            let n = unsafe { libc::write(fd, chunk[written..].as_ptr().cast(), chunk.len() - written) };
            if n > 0 {
                written += n as usize;
                continue;
            }
            match errno() {
                libc::EINTR => {}
                libc::EAGAIN => {
                    poll_fd(fd, libc::POLLOUT);
                }
                // The shell is gone: what is still queued can't be delivered.
                _ => continue 'queue,
            }
        }
    }
}

// A wait error or unwind retains the actual handle and never authorizes PID reuse/signalling.
struct WaitingChild {
    shared: Arc<Shared>,
    child: Option<Box<dyn Child + Send + Sync>>,
}
impl Drop for WaitingChild {
    fn drop(&mut self) {
        if let Some(child) = self.child.take() {
            if !self.shared.reaped.load(Ordering::SeqCst) {
                *self.shared.lost_child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
            }
        }
    }
}
fn waiter(shared: Arc<Shared>, child: Box<dyn Child + Send + Sync>, output: Arc<dyn PtyOutput>, drain: Duration) {
    let mut owned = WaitingChild { shared: shared.clone(), child: Some(child) };
    let info = match owned.child.as_mut().unwrap().wait() {
        Ok(status) => {
            shared.reaped.store(true, Ordering::SeqCst);
            ExitInfo { exit_code: status.exit_code(), signal: status.signal().map(str::to_owned) }
        }
        Err(_) => {
            *shared.lost_child.lock().unwrap_or_else(|p| p.into_inner()) = owned.child.take();
            ExitInfo { exit_code: 1, signal: None }
        }
    };
    {
        let (lock, signal) = &shared.reader_done;
        let done = lock.lock().unwrap();
        let _ = signal.wait_timeout_while(done, drain, |done| !*done).unwrap();
    }
    output.exit(info);
    // Whichever path starts shutdown first owns its joins. io_drained is set only
    // after those joins and descriptor closes; `shut` alone is not completion.
    shared.shutdown();
    shared.waiter_done.store(true, Ordering::SeqCst);
}

// Prepared threads wait without owning a native child. Dropping partial preparation
// closes their channels and joins them before any spawn failure can return.
struct Prepared<T> {
    send: Option<mpsc::SyncSender<T>>,
    thread: Option<JoinHandle<()>>,
}
impl<T: Send + 'static> Prepared<T> {
    fn new(name: &'static str, run: impl FnOnce(T) + Send + 'static) -> Result<Self, String> {
        injected_failure(name)?;
        let (send, receive) = mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                if let Ok(task) = receive.recv() {
                    run(task);
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self { send: Some(send), thread: Some(thread) })
    }
    fn submit(mut self, task: T) -> Result<JoinHandle<()>, T> {
        match self.send.take().unwrap().send(task) {
            Ok(()) => Ok(self.thread.take().unwrap()),
            Err(error) => Err(error.0),
        }
    }
}
impl<T> Drop for Prepared<T> {
    fn drop(&mut self) {
        self.send.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn injected_failure(name: &str) -> Result<(), String> {
    #[cfg(test)]
    if TEST_FAILURE.with(|f| {
        if f.borrow().as_deref() == Some(name) {
            f.borrow_mut().take();
            true
        } else {
            false
        }
    }) {
        return Err(format!("injected {name} failure"));
    }
    let _ = name;
    Ok(())
}
#[cfg(test)]
thread_local! {
    static TEST_FAILURE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static TEST_SPAWN: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}
// This path owns the caller's spawn admission until exact native cleanup succeeds.
// An uncertain wait must retain that admission rather than return an untracked Err.
fn abort_spawn(mut child: Box<dyn Child + Send + Sync>, shared: &Arc<Shared>, why: String) -> String {
    let _ = child.kill();
    shared.shutdown();
    match child.wait() {
        Ok(_) => {
            shared.reaped.store(true, Ordering::SeqCst);
            why
        }
        Err(_) => {
            *shared.lost_child.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
            loop {
                std::thread::park();
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Target {
    Group(i32),
    Pid(i32),
}

impl Target {
    fn signal(self, signal: i32) {
        unsafe {
            match self {
                Target::Group(pgid) => libc::kill(-pgid, signal),
                Target::Pid(pid) => libc::kill(pid, signal),
            };
        }
    }

    fn alive(self) -> bool {
        let result = unsafe {
            match self {
                Target::Group(pgid) => libc::kill(-pgid, 0),
                Target::Pid(pid) => libc::kill(pid, 0),
            }
        };
        // EPERM: it exists but isn't ours to stop; waiting on it would only delay the rest.
        result == 0
    }
}

/// The processes below `pid` from one `ps` snapshot: (pid, pgid). Empty when ps fails.
pub fn descendants_of(pid: i32) -> Vec<(i32, i32)> {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid=,pgid="]).output() else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut children: std::collections::HashMap<i32, Vec<(i32, i32)>> = Default::default();
    for line in text.lines() {
        let fields: Vec<i32> = line.split_whitespace().filter_map(|f| f.parse().ok()).collect();
        if let [child, parent, pgid] = fields[..] {
            children.entry(parent).or_default().push((child, pgid));
        }
    }
    let mut found: Vec<(i32, i32)> = Vec::new();
    let mut queue = std::collections::VecDeque::from([pid]);
    while let Some(next) = queue.pop_front() {
        for entry in children.get(&next).cloned().unwrap_or_default() {
            if entry.0 == pid || found.iter().any(|other| other.0 == entry.0) {
                continue;
            }
            found.push(entry);
            queue.push_back(entry.0);
        }
    }
    found
}

/// The name node-pty reports for a process group leader.
fn process_name(pgid: i32) -> Option<String> {
    #[cfg(target_os = "macos")]
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        if libc::proc_pidinfo(pgid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) != size {
            return None;
        }
        let name = std::ffi::CStr::from_ptr(info.pbi_comm.as_ptr()).to_string_lossy().into_owned();
        (!name.is_empty()).then_some(name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let cmdline = std::fs::read(format!("/proc/{pgid}/cmdline")).ok()?;
        let first = cmdline.split(|b| *b == 0).next().unwrap_or(&[]);
        (!first.is_empty()).then(|| String::from_utf8_lossy(first).into_owned())
    }
}

fn own_name() -> Option<String> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| process_name(std::process::id() as i32)).clone()
}

impl PtySpawner for UnixPtySpawner {
    fn spawn(&self, request: SpawnRequest, output: Arc<dyn PtyOutput>) -> Result<Box<dyn PtyProcess>, String> {
        let size = PtySize { rows: request.rows, cols: request.cols, pixel_width: 0, pixel_height: 0 };
        let mut command = CommandBuilder::new(&request.file);
        command.args(&request.args);
        command.env_clear();
        for (key, value) in &request.env {
            command.env(key, value);
        }
        command.cwd(&request.cwd);
        static OPEN: Mutex<()> = Mutex::new(());
        let _open = OPEN.lock().unwrap_or_else(|p| p.into_inner());
        let pair = native_pty_system().openpty(size).map_err(|error| error.to_string())?;
        let master = pair.master;
        let master_fd = master.as_raw_fd().ok_or("The PTY has no descriptor.")?;
        injected_failure("duplicate-fd")?;
        let raw = unsafe { libc::fcntl(master_fd, libc::F_DUPFD_CLOEXEC, 0) };
        if raw < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        unsafe {
            let flags = libc::fcntl(raw, libc::F_GETFL);
            if flags < 0 || libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let read_thread = Prepared::new("milagre-pty-read", |(shared, output)| reader(shared, output))?;
        let write_thread = Prepared::new("milagre-pty-write", |(shared, queue)| writer(shared, queue))?;
        let wait_thread = Prepared::new("milagre-pty-wait", |(shared, child, output, drain)| waiter(shared, child, output, drain))?;
        // Every fallible fd/thread allocation is complete before child creation.
        let child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
        let pid = child.process_id();
        #[cfg(test)]
        TEST_SPAWN.with(|p| p.set(pid));
        drop(pair.slave);
        drop(_open);
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            pid,
            shell_file: request.file.clone(),
            raw,
            fd: Mutex::new(Some(fd)),
            master: Mutex::new(Some(master)),
            writer: Mutex::new(Some(tx)),
            threads: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
            reaped: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            shut: AtomicBool::new(false),
            io_drained: AtomicBool::new(false),
            waiter_done: AtomicBool::new(false),
            kill_done: AtomicBool::new(false),
            lost_child: Mutex::new(None),
            reader_done: (Mutex::new(false), Condvar::new()),
        });
        if let Err(error) = injected_failure("child-handoff") {
            return Err(abort_spawn(child, &shared, error));
        }
        match read_thread.submit((shared.clone(), output.clone())) {
            Ok(thread) => shared.threads.lock().unwrap().push(thread),
            Err(_) => return Err(abort_spawn(child, &shared, "PTY reader handoff failed".into())),
        }
        match write_thread.submit((shared.clone(), rx)) {
            Ok(thread) => shared.threads.lock().unwrap().push(thread),
            Err(_) => return Err(abort_spawn(child, &shared, "PTY writer handoff failed".into())),
        }
        if let Err((_, child, _, _)) = wait_thread.submit((shared.clone(), child, output, self.exit_drain)) {
            return Err(abort_spawn(child, &shared, "PTY waiter handoff failed".into()));
        }
        Ok(Box::new(UnixPty { shared, cleanup: self.cleanup, kill_grace: self.kill_grace }))
    }
}

impl PtyProcess for UnixPty {
    fn pid(&self) -> Option<u32> {
        self.shared.pid
    }

    fn process(&self) -> String {
        let foreground = self.shared.foreground_group();
        let name = foreground.and_then(process_name);
        // Between fork and exec the shell is still a copy of this process and carries its name; it is the shell.
        let pre_exec = foreground.is_some_and(|pgid| Some(pgid as u32) == self.shared.pid) && name.is_some() && name == own_name();
        match name {
            Some(name) if !pre_exec && !(cfg!(target_os = "macos") && name == "kernel_task") => name,
            _ => self.shared.shell_file.clone(),
        }
    }

    fn write(&self, data: &str) -> Result<(), String> {
        if let Some(queue) = self.shared.writer.lock().unwrap().as_ref() {
            let _ = queue.send(data.as_bytes().to_vec());
        }
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self.shared.master.lock().unwrap().as_ref() {
            Some(master) => master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|error| error.to_string()),
            None => Ok(()),
        }
    }

    fn kill(&self) {
        if self.shared.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        let shared = self.shared.clone();
        let (cleanup, grace) = (self.cleanup, self.kill_grace);
        let start = || {
            std::thread::Builder::new().name("milagre-pty-kill".into()).spawn(move || {
                if shared.lost_child.lock().unwrap().is_some() {
                    return;
                }
                let mut targets: Vec<Target> = Vec::new();
                let shell = shared.pid.map(|pid| pid as i32).filter(|_| !shared.reaped.load(Ordering::SeqCst));
                if cleanup == Cleanup::Tree {
                    if let Some(pid) = shell {
                        let others = descendants_of(pid);
                        let leaders: std::collections::HashSet<i32> = others.iter().filter(|(p, g)| p == g).map(|(p, _)| *p).collect();
                        for (child, pgid) in others.into_iter().filter(|(_, pgid)| *pgid != pid) {
                            targets.push(if leaders.contains(&pgid) { Target::Group(pgid) } else { Target::Pid(child) });
                        }
                    }
                }
                if let Some(pid) = shell {
                    targets.push(Target::Group(pid));
                }
                if let Some(foreground) = shared.foreground_group() {
                    targets.push(Target::Group(foreground));
                }
                let mut unique = Vec::new();
                for target in targets {
                    if !unique.contains(&target) {
                        unique.push(target);
                    }
                }
                for target in &unique {
                    target.signal(libc::SIGHUP);
                }
                let deadline = Instant::now() + grace;
                while Instant::now() < deadline && unique.iter().any(|target| target.alive()) {
                    std::thread::sleep(Duration::from_millis(25));
                }
                for target in unique.iter().filter(|target| target.alive()) {
                    target.signal(libc::SIGKILL);
                }
                shared.shutdown();
                shared.kill_done.store(true, Ordering::SeqCst);
            })
        };
        let started =
            if injected_failure("milagre-pty-kill").is_err() { Err(std::io::Error::other("cleanup worker unavailable")) } else { start() };
        if started.is_err() {
            // No thread to wait in: hang up and stop now rather than leave the shell running.
            if let Some(pid) =
                self.shared.pid.filter(|_| !self.shared.reaped.load(Ordering::SeqCst) && self.shared.lost_child.lock().unwrap().is_none())
            {
                Target::Group(pid as i32).signal(libc::SIGKILL);
            }
            // Signal submission is not cleanup evidence. Without a cleanup worker,
            // kill_done remains false and the caller must retain ownership.
        }
    }

    fn cleaned(&self) -> bool {
        self.shared.reaped.load(Ordering::SeqCst)
            && self.shared.waiter_done.load(Ordering::SeqCst)
            && self.shared.io_drained.load(Ordering::SeqCst)
            && (!self.shared.killed.load(Ordering::SeqCst) || self.shared.kill_done.load(Ordering::SeqCst))
    }
}

impl Drop for UnixPty {
    fn drop(&mut self) {
        // A PTY nobody holds any more must not leave its shell behind.
        if !self.shared.reaped.load(Ordering::SeqCst) {
            self.kill();
        }
    }
}

#[cfg(test)]
mod completion_tests {
    use super::*;
    use portable_pty::{ChildKiller, ExitStatus};
    use std::sync::atomic::AtomicUsize;
    #[derive(Debug, Default)]
    struct Gate {
        open: Mutex<bool>,
        wake: Condvar,
    }
    impl Gate {
        fn release(&self) {
            *self.open.lock().unwrap() = true;
            self.wake.notify_all();
        }
        fn wait(&self) -> std::io::Result<()> {
            let (_guard, result) = self.wake.wait_timeout_while(self.open.lock().unwrap(), Duration::from_secs(5), |open| !*open).unwrap();
            if result.timed_out() {
                Err(std::io::ErrorKind::TimedOut.into())
            } else {
                Ok(())
            }
        }
    }
    struct Release(Arc<Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    #[derive(Debug)]
    struct MockChild {
        gate: Arc<Gate>,
        entered: Arc<AtomicBool>,
        fail: bool,
        kills: Arc<AtomicUsize>,
    }
    impl ChildKiller for MockChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.kills.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(MockChild { gate: self.gate.clone(), entered: self.entered.clone(), fail: self.fail, kills: self.kills.clone() })
        }
    }
    impl Child for MockChild {
        fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            Ok(None)
        }
        fn wait(&mut self) -> std::io::Result<ExitStatus> {
            self.entered.store(true, Ordering::SeqCst);
            self.gate.wait()?;
            if self.fail {
                Err(std::io::Error::from_raw_os_error(libc::ECHILD))
            } else {
                Ok(ExitStatus::with_exit_code(0))
            }
        }
        fn process_id(&self) -> Option<u32> {
            None
        }
    }
    struct Output;
    impl PtyOutput for Output {
        fn data(&self, _: &str) {}
        fn exit(&self, _: ExitInfo) {}
    }
    fn shared() -> Arc<Shared> {
        Arc::new(Shared {
            pid: None,
            shell_file: "synthetic".into(),
            raw: -1,
            fd: Mutex::new(None),
            master: Mutex::new(None),
            writer: Mutex::new(None),
            threads: Mutex::new(vec![]),
            stop: AtomicBool::new(false),
            reaped: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            shut: AtomicBool::new(false),
            io_drained: AtomicBool::new(false),
            waiter_done: AtomicBool::new(false),
            kill_done: AtomicBool::new(false),
            lost_child: Mutex::new(None),
            reader_done: (Mutex::new(true), Condvar::new()),
        })
    }
    fn until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate() {
            assert!(Instant::now() < deadline, "completion barrier timed out");
            std::thread::yield_now();
        }
    }
    #[test]
    fn submitted_kill_and_joined_io_do_not_certify_a_delayed_reap() {
        let shared = shared();
        let gate = Arc::new(Gate::default());
        let _release = Release(gate.clone());
        let entered = Arc::new(AtomicBool::new(false));
        let child = MockChild { gate: gate.clone(), entered: entered.clone(), fail: false, kills: Arc::new(AtomicUsize::new(0)) };
        let waiter_thread = {
            let s = shared.clone();
            std::thread::spawn(move || waiter(s, Box::new(child), Arc::new(Output), Duration::ZERO))
        };
        until(|| entered.load(Ordering::SeqCst));
        let pty = UnixPty { shared: shared.clone(), cleanup: Cleanup::Tree, kill_grace: Duration::ZERO };
        pty.kill();
        until(|| shared.kill_done.load(Ordering::SeqCst) && shared.io_drained.load(Ordering::SeqCst));
        assert!(!shared.reaped.load(Ordering::SeqCst));
        assert!(!pty.cleaned(), "signal submission plus I/O joins is not a reap");
        gate.release();
        waiter_thread.join().unwrap();
        assert!(pty.cleaned());
    }
    #[test]
    fn reap_alone_does_not_certify_a_join_still_in_progress() {
        let shared = shared();
        let io_gate = Arc::new(Gate::default());
        let _release = Release(io_gate.clone());
        let io = {
            let g = io_gate.clone();
            std::thread::spawn(move || g.wait().unwrap())
        };
        shared.threads.lock().unwrap().push(io);
        let gate = Arc::new(Gate::default());
        gate.release();
        let child = MockChild { gate, entered: Arc::new(AtomicBool::new(false)), fail: false, kills: Arc::new(AtomicUsize::new(0)) };
        let waiter_thread = {
            let s = shared.clone();
            std::thread::spawn(move || waiter(s, Box::new(child), Arc::new(Output), Duration::ZERO))
        };
        until(|| shared.reaped.load(Ordering::SeqCst) && shared.shut.load(Ordering::SeqCst));
        let pty = UnixPty { shared: shared.clone(), cleanup: Cleanup::Tree, kill_grace: Duration::ZERO };
        pty.kill();
        until(|| shared.kill_done.load(Ordering::SeqCst));
        assert!(!shared.io_drained.load(Ordering::SeqCst));
        assert!(!pty.cleaned());
        io_gate.release();
        waiter_thread.join().unwrap();
        assert!(pty.cleaned());
    }
    #[test]
    fn failed_wait_retains_unknown_child_and_never_certifies_cleanup() {
        let shared = shared();
        let gate = Arc::new(Gate::default());
        gate.release();
        let kills = Arc::new(AtomicUsize::new(0));
        let child = MockChild { gate, entered: Arc::new(AtomicBool::new(false)), fail: true, kills: kills.clone() };
        waiter(shared.clone(), Box::new(child), Arc::new(Output), Duration::ZERO);
        assert!(shared.lost_child.lock().unwrap().is_some());
        assert!(!shared.reaped.load(Ordering::SeqCst));
        let pty = UnixPty { shared: shared.clone(), cleanup: Cleanup::Tree, kill_grace: Duration::ZERO };
        pty.kill();
        assert!(!pty.cleaned());
        assert_eq!(kills.load(Ordering::SeqCst), 0);
    }
    fn request(cwd: &std::path::Path) -> SpawnRequest {
        SpawnRequest {
            file: "/bin/sh".into(),
            args: vec!["-c".into(), "read pending".into()],
            cwd: cwd.into(),
            env: std::collections::BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            cols: 80,
            rows: 24,
            name: "xterm-256color".into(),
        }
    }
    #[test]
    fn failed_preparation_never_spawns_and_failed_handoff_reaps_before_error() {
        let folder = tempfile::tempdir().unwrap();
        for fault in ["duplicate-fd", "milagre-pty-read", "milagre-pty-write", "milagre-pty-wait"] {
            TEST_SPAWN.with(|p| p.set(None));
            TEST_FAILURE.with(|f| *f.borrow_mut() = Some(fault.into()));
            assert!(UnixPtySpawner::default().spawn(request(folder.path()), Arc::new(Output)).is_err());
            assert_eq!(TEST_SPAWN.with(|p| p.get()), None, "{fault} must occur before native spawn");
        }
        TEST_FAILURE.with(|f| *f.borrow_mut() = Some("child-handoff".into()));
        assert!(UnixPtySpawner::default().spawn(request(folder.path()), Arc::new(Output)).is_err());
        let pid = TEST_SPAWN.with(|p| p.get()).expect("a real child existed before refused handoff");
        let mut status = 0;
        let probe = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
        let error = errno();
        // If a mutation forgot the reap, clean only this test's exact child before failing.
        if probe == 0 {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            while unsafe { libc::waitpid(pid as i32, &mut status, 0) } < 0 && errno() == libc::EINTR {}
        }
        assert_eq!(probe, -1, "post-spawn Err requires a child already reaped");
        assert_eq!(error, libc::ECHILD);
        let pty = UnixPtySpawner { kill_grace: Duration::ZERO, ..UnixPtySpawner::default() }
            .spawn(request(folder.path()), Arc::new(Output))
            .unwrap();
        pty.kill();
        until(|| pty.cleaned());
    }
    #[test]
    fn failed_child_handoff_retains_admission_until_the_real_wait_returns() {
        let shared = shared();
        let gate = Arc::new(Gate::default());
        let _release = Release(gate.clone());
        let entered = Arc::new(AtomicBool::new(false));
        let kills = Arc::new(AtomicUsize::new(0));
        let child = MockChild { gate: gate.clone(), entered: entered.clone(), fail: false, kills: kills.clone() };
        let (send, receive) = mpsc::channel();
        let thread = {
            let shared = shared.clone();
            std::thread::spawn(move || {
                let why = abort_spawn(Box::new(child), &shared, "handoff refused".into());
                send.send(why).unwrap();
            })
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !entered.load(Ordering::SeqCst) {
            assert!(matches!(receive.try_recv(), Err(mpsc::TryRecvError::Empty)), "spawn admission returned before its wait");
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert_eq!(kills.load(Ordering::SeqCst), 1);
        assert!(matches!(receive.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(!shared.reaped.load(Ordering::SeqCst));
        gate.release();
        assert_eq!(receive.recv_timeout(Duration::from_secs(5)).unwrap(), "handoff refused");
        thread.join().unwrap();
        assert!(shared.reaped.load(Ordering::SeqCst));
        assert!(shared.io_drained.load(Ordering::SeqCst));
    }
    #[test]
    fn failed_cleanup_worker_cannot_turn_a_signal_into_a_cleanup_receipt() {
        let shared = shared();
        let pty = UnixPty { shared: shared.clone(), cleanup: Cleanup::Tree, kill_grace: Duration::ZERO };
        TEST_FAILURE.with(|f| *f.borrow_mut() = Some("milagre-pty-kill".into()));
        pty.kill();
        assert!(shared.killed.load(Ordering::SeqCst));
        assert!(!shared.kill_done.load(Ordering::SeqCst));
        assert!(!pty.cleaned());
        // Even if the waiter later proves reap + I/O completion, lost cleanup work is not proven complete.
        shared.reaped.store(true, Ordering::SeqCst);
        shared.waiter_done.store(true, Ordering::SeqCst);
        shared.io_drained.store(true, Ordering::SeqCst);
        assert!(!pty.cleaned());
    }
}
