//! `PortWatcher` from ports.cjs: polls while any Chat has an agent or Terminal running, or a group it has seen.
//! `ps` runs every poll; `lsof` (the costly one) only when the Chats' pids changed, on a fresh read, or once its last
//! read is `lsof_max_age` old. Every change of any Chat's ports is published once.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use crate::exec::{self, BoxFuture, Exec};
use crate::identity::{system_identity, ReadIdentity};
use crate::owner::{chat_ports, chat_processes, ChatPorts, Groups, Port, Roots};
use crate::parse::{parse_lsof, parse_ps, parse_task_outputs, Listener, ProcessRow};

pub const POLL: Duration = Duration::from_millis(3000);
pub const IDLE_POLL: Duration = Duration::from_millis(15_000);
pub const LSOF_MAX_AGE_MS: i64 = 10_000;
pub const GRACE: Duration = Duration::from_millis(2000);

pub const PS_ARGS: [&str; 2] = ["-axo", "pid=,ppid=,pgid=,comm="];

/// The signals `stop_port` sends; `Probe` is signal 0 (is it still there?).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
    Probe,
}

impl Signal {
    /// The name Node passes to `process.kill`, for fixtures and logs.
    pub fn node_name(self) -> serde_json::Value {
        match self {
            Signal::Term => "SIGTERM".into(),
            Signal::Kill => "SIGKILL".into(),
            Signal::Probe => 0.into(),
        }
    }
}

/// `kill(target, signal)`: a negative target is a process group. False where Node's `process.kill` throws.
pub type Kill = Arc<dyn Fn(i64, Signal) -> bool + Send + Sync>;
/// process-tree.cjs `killWindowsTree(pid, _, { expectedStartTime })`.
/// The injected implementation must check start time immediately before signalling and return false on failure.
pub type StopWindowsTree = Arc<dyn Fn(i64, String) -> BoxFuture<bool> + Send + Sync>;

#[derive(Clone)]
pub struct PortWatcherOptions {
    /// `process.platform === "win32"`: Windows process identities and tree stops.
    pub windows: bool,
    pub roots: Arc<dyn Fn() -> Roots + Send + Sync>,
    /// Gets every Chat's ports whenever they change (the daemon emits it as `agent:ports`).
    pub publish: Arc<dyn Fn(&ChatPorts) + Send + Sync>,
    pub poll: Duration,
    pub idle_poll: Duration,
    /// True while an agent turn, a Terminal or an execution agent runs: polls every `poll`, else every `idle_poll`.
    pub is_running: Arc<dyn Fn() -> bool + Send + Sync>,
    pub exec: Exec,
    pub kill: Kill,
    pub stop_windows_tree: Option<StopWindowsTree>,
    /// Unix kernel identity lookup, also injectable for disposable tests.
    pub identity: ReadIdentity,
    pub grace: Duration,
    /// Milliseconds, for the lsof cache age.
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub lsof_max_age_ms: i64,
}

impl PortWatcherOptions {
    /// This computer's `ps`/`lsof` (or PowerShell on Windows) and real signals.
    pub fn new(roots: Arc<dyn Fn() -> Roots + Send + Sync>, publish: Arc<dyn Fn(&ChatPorts) + Send + Sync>) -> Self {
        let windows = cfg!(windows);
        PortWatcherOptions {
            windows,
            roots,
            publish,
            poll: POLL,
            idle_poll: IDLE_POLL,
            is_running: Arc::new(|| true),
            exec: exec::system_exec(windows),
            kill: Arc::new(system_kill),
            stop_windows_tree: None,
            identity: Arc::new(system_identity),
            grace: GRACE,
            now: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)),
            lsof_max_age_ms: LSOF_MAX_AGE_MS,
        }
    }
}

/// `process.kill(target, signal)` on Unix.
pub fn system_kill(target: i64, signal: Signal) -> bool {
    // 0 targets our group; -1 broadcasts to every permitted process; 1 is init.
    if (-1..=1).contains(&target) {
        return false;
    }
    #[cfg(unix)]
    {
        let Ok(target) = i32::try_from(target) else { return false };
        let signal = match signal {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
            Signal::Probe => 0,
        };
        unsafe { libc::kill(target, signal) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = (target, signal);
        false
    }
}

struct ListenerCache {
    key: Option<String>,
    at: Option<i64>,
    rows: Vec<Listener>,
    tasks: HashMap<i64, String>,
}

impl ListenerCache {
    fn empty() -> Self {
        ListenerCache { key: None, at: None, rows: Vec::new(), tasks: HashMap::new() }
    }
}

struct State {
    listeners: ListenerCache,
    groups: Groups,
    processes: HashMap<i64, ProcessRow>,
    windows_identities: HashMap<i64, Option<String>>,
    ports: ChatPorts,
    closed: bool,
    polling: bool,
    timer: Option<(u64, tokio::task::JoinHandle<()>)>,
    timer_generation: u64,
}

struct Inner {
    options: PortWatcherOptions,
    state: Mutex<State>,
    /// One read at a time; a fresh poll waits its turn.
    poll_lock: tokio::sync::Mutex<()>,
    runtime: tokio::runtime::Handle,
}

/// The port watcher. Cloning shares it. Needs a Tokio runtime with timers; `wake` may be called from any thread.
#[derive(Clone)]
pub struct PortWatcher {
    inner: Arc<Inner>,
}

impl PortWatcher {
    /// Must be called inside a Tokio runtime; its handle runs the polls.
    pub fn new(options: PortWatcherOptions) -> Self {
        Self::with_runtime(options, tokio::runtime::Handle::current())
    }

    pub fn with_runtime(options: PortWatcherOptions, runtime: tokio::runtime::Handle) -> Self {
        PortWatcher {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(State {
                    listeners: ListenerCache::empty(),
                    groups: Groups::new(),
                    processes: HashMap::new(),
                    windows_identities: HashMap::new(),
                    ports: ChatPorts::new(),
                    closed: false,
                    polling: false,
                    timer: None,
                    timer_generation: 0,
                }),
                poll_lock: tokio::sync::Mutex::new(()),
                runtime,
            }),
        }
    }

    /// Every Chat's ports now.
    pub fn snapshot(&self) -> ChatPorts {
        self.inner.state.lock().unwrap().ports.clone()
    }

    /// One Chat's ports (`chat:ports`), empty when it has none.
    pub fn chat_ports(&self, chat_id: &str) -> Vec<Port> {
        self.inner.state.lock().unwrap().ports.get(chat_id).cloned().unwrap_or_default()
    }

    /// The groups each Chat has seen (what keeps orphaned servers listed).
    pub fn groups(&self) -> Groups {
        self.inner.state.lock().unwrap().groups.clone()
    }

    /// True while a poll is scheduled.
    pub fn scheduled(&self) -> bool {
        self.inner.state.lock().unwrap().timer.is_some()
    }

    /// Starts polling now, unless a poll is running or the watcher is closed; call when a turn starts or a Terminal's
    /// shells change.
    pub fn wake(&self) {
        Inner::schedule(&self.inner, Duration::ZERO, true);
    }

    pub fn close(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.closed = true;
        if let Some((_, timer)) = state.timer.take() {
            timer.abort();
        }
    }

    /// One poll. `fresh` re-reads the listeners even when the Chats' pids look the same (after stopping one); a fresh
    /// poll asked for during another waits for it and reads again, since that one may have read before the change.
    pub async fn poll(&self, fresh: bool) {
        Inner::poll(&self.inner, fresh).await
    }

    /// Windows tree stopping is unsupported until the runtime injects an implementation.
    pub fn supports_stop(&self) -> bool {
        !self.inner.options.windows || self.inner.options.stop_windows_tree.is_some()
    }

    /// Stops what listens on one of a Chat's ports: its command's whole process group (so `npm run dev` goes with its
    /// server), or the process alone when its group is the agent's own or a Terminal shell's. Only a pid the Chat's
    /// list shows is stopped, after a fresh poll. Every Unix signal (including probe) rechecks listener/leader birth
    /// time and group. Without a leader, only the listener is stopped. SIGKILL follows the grace only while those
    /// identities survive. On Windows the oldest owned ancestor's tree is stopped, checked by start time.
    /// Returns false for unsupported Windows stopping, stale identity, protected PID or initial signal failure.
    pub async fn stop_port(&self, chat_id: &str, pid: i64) -> bool {
        let inner = &self.inner;
        if !(2..=i32::MAX as i64).contains(&pid) || inner.state.lock().unwrap().closed || !self.supports_stop() {
            return false;
        }
        let listed =
            |inner: &Inner| inner.state.lock().unwrap().ports.get(chat_id).is_some_and(|ports| ports.iter().any(|port| port.pid == pid));
        if !listed(inner) {
            return false;
        }
        let original = inner.state.lock().unwrap().processes.get(&pid).cloned();
        Inner::poll(inner, true).await;
        if !listed(inner) || inner.state.lock().unwrap().closed {
            return false;
        }
        let Some(original) = original else { return false };
        {
            let state = inner.state.lock().unwrap();
            let Some(current) = state.processes.get(&pid) else { return false };
            if original.started_at.as_deref().is_none_or(str::is_empty)
                || current.started_at != original.started_at
                || current.pgid != original.pgid
            {
                return false;
            }
        }
        if inner.options.windows {
            let agent_pid = (inner.options.roots)().get(chat_id).and_then(|root| root.pid);
            let target = {
                let state = inner.state.lock().unwrap();
                let Some(owned) = state.groups.get(chat_id) else { return false };
                let identity = |pid: i64| state.windows_identities.get(&pid).cloned().flatten();
                let Some(mut target) = state.processes.get(&pid) else { return false };
                if !owned.contains(&pid) || target.started_at != identity(pid) {
                    return false;
                }
                let mut seen = HashSet::from([pid]);
                while let Some(parent) = state.processes.get(&target.ppid) {
                    if Some(parent.pid) == agent_pid
                        || !owned.contains(&parent.pid)
                        || seen.contains(&parent.pid)
                        || parent.started_at != identity(parent.pid)
                    {
                        break;
                    }
                    seen.insert(parent.pid);
                    target = parent;
                }
                match &target.started_at {
                    Some(started) if !started.is_empty() => (target.pid, started.clone()),
                    _ => return false,
                }
            };
            if target.0 <= 1 {
                return false;
            }
            let stopped = (inner.options.stop_windows_tree.as_ref().unwrap())(target.0, target.1).await;
            Inner::poll(inner, true).await;
            return stopped;
        }
        // Callbacks run outside the state lock: owners may call back into this watcher.
        let roots = (inner.options.roots)();
        let (target, leader) = {
            let state = inner.state.lock().unwrap();
            if protected_pid(&roots, pid) {
                return false;
            }
            let pgid = original.pgid;
            let leader = state.processes.get(&pgid).filter(|row| row.pgid == pgid && row.started_at.is_some()).cloned();
            if pgid > 1
                && pgid <= i32::MAX as i64
                && state.groups.get(chat_id).is_some_and(|groups| groups.contains(&pgid))
                && leader.is_some()
            {
                (-pgid, leader)
            } else {
                // An orphan without its original leader is stopped individually, never by a bare PGID.
                (pid, None)
            }
        };
        let (target, leader) =
            if target < 0 && protected_group(&roots, -target, &inner.options.identity) { (pid, None) } else { (target, leader) };
        let signal = |signal| {
            if inner.state.lock().unwrap().closed {
                return false;
            }
            let roots = (inner.options.roots)();
            if protected_pid(&roots, pid)
                || (target < 0 && protected_group(&roots, -target, &inner.options.identity))
                || !(inner.options.identity)(pid).is_some_and(|id| id.matches(&original))
                || leader.as_ref().is_some_and(|row| !(inner.options.identity)(row.pid).is_some_and(|id| id.matches(row)))
            {
                return false;
            }
            (inner.options.kill)(target, signal)
        };
        if !signal(Signal::Term) {
            return false;
        }
        let deadline = tokio::time::Instant::now() + inner.options.grace;
        while signal(Signal::Probe) {
            if tokio::time::Instant::now() >= deadline {
                signal(Signal::Kill);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Inner::poll(inner, true).await;
        true
    }
}

impl Inner {
    /// Replaces any scheduled poll with one after `delay`. `wake` skips while a poll runs.
    fn schedule(this: &Arc<Self>, delay: Duration, waking: bool) {
        let mut state = this.state.lock().unwrap();
        if state.closed || (waking && state.polling) {
            return;
        }
        if let Some((_, timer)) = state.timer.take() {
            timer.abort();
        }
        state.timer_generation += 1;
        let generation = state.timer_generation;
        let weak: Weak<Inner> = Arc::downgrade(this);
        // Counted from now, like setTimeout, not from whenever the task first runs.
        let deadline = tokio::time::Instant::now() + delay;
        let handle = this.runtime.spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let Some(inner) = weak.upgrade() else { return };
            {
                // Out of the slot before polling, so the poll's own clearTimeout can't abort this task.
                let mut state = inner.state.lock().unwrap();
                if state.timer.as_ref().is_some_and(|(mine, _)| *mine == generation) {
                    state.timer = None;
                }
            }
            Inner::poll(&inner, false).await;
        });
        state.timer = Some((generation, handle));
    }

    async fn poll(this: &Arc<Self>, fresh: bool) {
        if this.state.lock().unwrap().closed {
            return;
        }
        let guard = match this.poll_lock.try_lock() {
            Ok(guard) => guard,
            Err(_) if !fresh => return,
            Err(_) => this.poll_lock.lock().await,
        };
        {
            let mut state = this.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.polling = true;
            if let Some((_, timer)) = state.timer.take() {
                timer.abort();
            }
        }
        Inner::read(this, fresh).await;
        this.state.lock().unwrap().polling = false;
        drop(guard);
    }

    async fn read(this: &Arc<Self>, fresh: bool) {
        let options = &this.options;
        let mut roots = (options.roots)();
        let watching = !roots.is_empty() || !this.state.lock().unwrap().groups.is_empty();
        if watching {
            let mut processes = parse_ps(&(options.exec)("ps".into(), PS_ARGS.map(String::from).to_vec()).await);
            if !options.windows {
                // Join ps ancestry to a kernel identity; an exited/reparented process waits for the next poll.
                processes.retain_mut(|row| {
                    let Some(id) = (options.identity)(row.pid) else { return false };
                    if id.ppid != row.ppid || id.pgid != row.pgid || id.started_at.is_empty() {
                        return false;
                    }
                    row.started_at = Some(id.started_at);
                    true
                });
            }
            let still = if options.windows { Some((options.roots)()) } else { None };
            let (by_chat, pids) = {
                let mut state = this.state.lock().unwrap();
                if let Some(still) = still {
                    roots.retain(|chat_id, root| still.get(chat_id).and_then(|r| r.pid) == root.pid);
                    let current: HashMap<i64, Option<String>> = processes.iter().map(|row| (row.pid, row.started_at.clone())).collect();
                    let identities = std::mem::take(&mut state.windows_identities);
                    for known in state.groups.values_mut() {
                        known.retain(|pid| match current.get(pid).cloned().flatten() {
                            Some(started) if !started.is_empty() => {
                                identities.get(pid).cloned().flatten().as_deref() == Some(started.as_str())
                            }
                            _ => false,
                        });
                    }
                    state.windows_identities = current;
                }
                let agent_groups: HashSet<i64> = roots
                    .values()
                    .flat_map(|r| r.pid.into_iter().chain(r.agents.iter().copied()))
                    .filter_map(|pid| processes.iter().find(|r| r.pid == pid).map(|r| r.pgid))
                    .collect();
                if !options.windows {
                    // A continuous member anchors a group even after its leader exits. A reused numeric PGID
                    // with no surviving member never inherits another Chat's ownership.
                    let anchored: HashSet<i64> = processes
                        .iter()
                        .filter(|row| {
                            state
                                .processes
                                .get(&row.pid)
                                .is_some_and(|old| old.pgid == row.pgid && old.started_at.is_some() && old.started_at == row.started_at)
                        })
                        .map(|row| row.pgid)
                        .collect();
                    for groups in state.groups.values_mut() {
                        groups.retain(|pgid| *pgid > 1 && !agent_groups.contains(pgid) && anchored.contains(pgid));
                    }
                }
                state.processes = processes.iter().map(|row| (row.pid, row.clone())).collect();
                let by_chat = chat_processes(&processes, &roots, &mut state.groups);
                if !options.windows {
                    state.groups.retain(|_, groups| {
                        groups.retain(|pgid| *pgid > 1 && !agent_groups.contains(pgid));
                        !groups.is_empty()
                    });
                }
                let pids: Vec<i64> = by_chat.values().flatten().copied().collect::<HashSet<_>>().into_iter().collect();
                (by_chat, pids)
            };
            let listeners = Inner::listeners_of(this, pids, fresh).await;
            let ports = {
                let state = this.state.lock().unwrap();
                // A server writes to its task's output itself, or its command's shell (its group leader) does.
                let tasks = &state.listeners.tasks;
                chat_ports(&listeners, &by_chat, |pid| {
                    tasks.get(&pid).or_else(|| state.processes.get(&pid).and_then(|row| tasks.get(&row.pgid))).cloned()
                })
            };
            this.set(ports);
        } else {
            this.set(ChatPorts::new());
        }
        let roots_now = !(options.roots)().is_empty();
        let still_watching = roots_now || !this.state.lock().unwrap().groups.is_empty();
        if still_watching && !this.state.lock().unwrap().closed {
            let delay = if (options.is_running)() { options.poll } else { options.idle_poll };
            Inner::schedule(this, delay, false);
        }
    }

    async fn listeners_of(this: &Arc<Self>, mut pids: Vec<i64>, fresh: bool) -> Vec<Listener> {
        if pids.is_empty() {
            this.state.lock().unwrap().listeners = ListenerCache::empty();
            return Vec::new();
        }
        pids.sort_unstable();
        let key = pids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
        {
            let state = this.state.lock().unwrap();
            let cache = &state.listeners;
            let young = cache.at.is_some_and(|at| (this.options.now)() - at < this.options.lsof_max_age_ms);
            if !fresh && cache.key.as_deref() == Some(key.as_str()) && young {
                return cache.rows.clone();
            }
        }
        let args = ["-nP", "-a", "-p", &key, "-iTCP", "-sTCP:LISTEN", "-F", "pcn"].map(String::from).to_vec();
        let rows = parse_lsof(&(this.options.exec)("lsof".into(), args).await);
        let at = (this.options.now)();
        let asked: HashSet<i64> = pids.iter().copied().collect();
        let own: Vec<Listener> = rows.iter().filter(|row| asked.contains(&row.pid)).cloned().collect();
        let tasks = Inner::task_outputs_of(this, &own).await;
        this.state.lock().unwrap().listeners = ListenerCache { key: Some(key), at: Some(at), rows: rows.clone(), tasks };
        rows
    }

    /// Which background task each listener's command belongs to, read from where it and its group leader write stdout.
    async fn task_outputs_of(this: &Arc<Self>, rows: &[Listener]) -> HashMap<i64, String> {
        if rows.is_empty() || this.options.windows {
            return HashMap::new();
        }
        let key = {
            let state = this.state.lock().unwrap();
            let mut pids: Vec<i64> = rows
                .iter()
                .flat_map(|row| [Some(row.pid), state.processes.get(&row.pid).map(|p| p.pgid)])
                .flatten()
                .filter(|pid| *pid > 0)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            pids.sort_unstable();
            pids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
        };
        let args = ["-nP", "-a", "-p", &key, "-d", "1", "-F", "pn"].map(String::from).to_vec();
        parse_task_outputs(&(this.options.exec)("lsof".into(), args).await)
    }

    fn set(&self, ports: ChatPorts) {
        {
            let mut state = self.state.lock().unwrap();
            if state.closed || state.ports == ports {
                return;
            }
            state.ports = ports.clone();
        }
        (self.options.publish)(&ports);
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some((_, timer)) = self.state.get_mut().unwrap().timer.take() {
            timer.abort();
        }
    }
}

fn protected_pid(roots: &Roots, pid: i64) -> bool {
    pid == i64::from(std::process::id())
        || roots.values().any(|root| root.pid == Some(pid) || root.agents.contains(&pid) || root.shells.contains(&pid))
}

fn protected_group(roots: &Roots, pgid: i64, identity: &ReadIdentity) -> bool {
    // Protect the runtime too, even if it is absent from the Chat roots.
    #[cfg(unix)]
    if pgid == i64::from(unsafe { libc::getpgrp() }) {
        return true;
    }
    roots
        .values()
        .flat_map(|root| root.pid.into_iter().chain(root.agents.iter().copied()).chain(root.shells.iter().copied()))
        // An unreadable root cannot establish that the target group is isolated. Stop only the listener.
        .any(|pid| identity(pid).is_none_or(|id| id.pgid == pgid))
}
