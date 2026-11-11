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
    cleaned: AtomicBool,
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

fn waiter(shared: Arc<Shared>, mut child: Box<dyn Child + Send + Sync>, output: Arc<dyn PtyOutput>, drain: Duration) {
    let info = match child.wait() {
        Ok(status) => ExitInfo { exit_code: status.exit_code(), signal: status.signal().map(str::to_owned) },
        Err(_) => ExitInfo { exit_code: 1, signal: None },
    };
    shared.reaped.store(true, Ordering::SeqCst);
    // The last output arrives after the exit; give the reader time to hand it over, unless a background job keeps
    // the PTY open.
    {
        let (lock, signal) = &shared.reader_done;
        let done = lock.lock().unwrap();
        let _ = signal.wait_timeout_while(done, drain, |done| !*done).unwrap();
    }
    output.exit(info);
    if !shared.killed.load(Ordering::SeqCst) {
        shared.shutdown();
        shared.cleaned.store(true, Ordering::SeqCst);
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
        let (master, child) = {
            // openpty(3) is not thread-safe on macOS (concurrent calls fail with "Unknown error: -6"); node-pty never
            // meets this because Node opens PTYs on one thread. One open-and-spawn at a time.
            static OPEN: Mutex<()> = Mutex::new(());
            let _open = OPEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let pair = native_pty_system().openpty(size).map_err(|error| error.to_string())?;
            let child = pair.slave.spawn_command(command).map_err(|error| error.to_string())?;
            drop(pair.slave);
            (pair.master, child)
        };
        let pid = child.process_id();
        let master_fd = master.as_raw_fd().ok_or("The PTY has no descriptor.")?;
        let raw = unsafe { libc::fcntl(master_fd, libc::F_DUPFD_CLOEXEC, 0) };
        if raw < 0 {
            let mut child = child;
            let _ = child.kill();
            return Err(std::io::Error::last_os_error().to_string());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        unsafe {
            let flags = libc::fcntl(raw, libc::F_GETFL);
            libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
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
            cleaned: AtomicBool::new(false),
            reader_done: (Mutex::new(false), Condvar::new()),
        });
        let read_thread = {
            let (shared, output) = (shared.clone(), output.clone());
            std::thread::Builder::new().name("milagre-pty-read".into()).spawn(move || reader(shared, output)).map_err(|e| e.to_string())?
        };
        let write_thread = {
            let shared = shared.clone();
            std::thread::Builder::new().name("milagre-pty-write".into()).spawn(move || writer(shared, rx)).map_err(|e| e.to_string())?
        };
        shared.threads.lock().unwrap().extend([read_thread, write_thread]);
        {
            let (shared, drain) = (shared.clone(), self.exit_drain);
            std::thread::Builder::new()
                .name("milagre-pty-wait".into())
                .spawn(move || waiter(shared, child, output, drain))
                .map_err(|e| e.to_string())?;
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
        let started = std::thread::Builder::new().name("milagre-pty-kill".into()).spawn(move || {
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
            shared.cleaned.store(true, Ordering::SeqCst);
        });
        if started.is_err() {
            // No thread to wait in: hang up and stop now rather than leave the shell running.
            if let Some(pid) = self.shared.pid.filter(|_| !self.shared.reaped.load(Ordering::SeqCst)) {
                Target::Group(pid as i32).signal(libc::SIGKILL);
            }
            self.shared.cleaned.store(true, Ordering::SeqCst);
        }
    }

    fn cleaned(&self) -> bool {
        self.shared.cleaned.load(Ordering::SeqCst)
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
