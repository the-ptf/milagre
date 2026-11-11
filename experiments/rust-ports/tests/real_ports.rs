//! Real `ps` and `lsof` on this computer, read-only except for processes these tests start. Every listener is the
//! crate's test helper bound to 127.0.0.1 on a free port; every process tree is started here, in a temporary folder,
//! and stopped by the test (a guard SIGKILLs whatever is left).
#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use milagre_ports::{ChatPorts, PortWatcher, PortWatcherOptions, Root, Roots};

const LISTENER: &str = env!("CARGO_BIN_EXE_milagre-ports-test-listener");

/// SIGKILLs every pid and group it was given, when the test ends however it ends.
#[derive(Default)]
struct Cleanup(Mutex<Vec<(i32, milagre_ports::ProcessIdentity)>>);

impl Cleanup {
    fn track(&self, target: i32) {
        assert!(target.unsigned_abs() > 1);
        if let Some(identity) = milagre_ports::identity::system_identity(i64::from(target.unsigned_abs())) {
            self.0.lock().unwrap().push((target, identity));
        }
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for (target, expected) in self.0.lock().unwrap().iter() {
            let current = milagre_ports::identity::system_identity(i64::from(target.unsigned_abs()));
            if current.is_some_and(|id| id.started_at == expected.started_at && id.pgid == expected.pgid) {
                unsafe { libc::kill(*target, libc::SIGKILL) };
            }
        }
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn until<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn tagged(text: &str, tag: &str) -> Option<i64> {
    let start = text.find(tag)? + tag.len();
    text[start..].chars().take_while(char::is_ascii_digit).collect::<String>().parse().ok()
}

async fn port_in(file: &Path) -> i64 {
    until("the listener's port", || tagged(&std::fs::read_to_string(file).unwrap_or_default(), "PORT:")).await
}

/// A shell that leads its own process group, like an agent CLI or a Terminal's shell; its stdout is a file.
fn spawn_shell(script: &str, folder: &Path, cleanup: &Cleanup) -> (i32, PathBuf) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let log = folder.join(format!("shell-{}.log", NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let child = Command::new("/bin/sh")
        .args(["-c", script])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("L", LISTENER)
        .env("DIR", folder)
        .current_dir(folder)
        .stdin(Stdio::null())
        .stdout(std::fs::File::create(&log).unwrap())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id() as i32;
    cleanup.track(-pid);
    cleanup.track(pid);
    // Reaped by a thread so a killed shell doesn't linger as a zombie.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    (pid, log)
}

fn watcher(roots: Arc<Mutex<Roots>>, published: Arc<Mutex<Vec<ChatPorts>>>) -> PortWatcher {
    let r = roots.clone();
    let mut options = PortWatcherOptions::new(
        Arc::new(move || r.lock().unwrap().clone()),
        Arc::new(move |ports: &ChatPorts| published.lock().unwrap().push(ports.clone())),
    );
    options.poll = Duration::from_millis(150);
    options.idle_poll = Duration::from_millis(150);
    options.grace = Duration::from_millis(500);
    PortWatcher::new(options)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_owns_its_command_shells_listeners_not_its_agents_own_children() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().canonicalize().unwrap();
    std::fs::create_dir(folder.join("tasks")).unwrap();
    let cleanup = Cleanup::default();
    // The "agent" leads its group. With job control on, its first job leads a group of its own, as an agent's command
    // shell does; with it off, the second shares the agent's group, as its MCP servers do.
    let (agent, log) = spawn_shell(
        "set -m; \"$L\" 30 > \"$DIR/tasks/t1.output\" & echo A:$!; set +m; \"$L\" 30 > \"$DIR/mcp.out\" & echo M:$!; wait",
        &folder,
        &cleanup,
    );
    let (job, mcp) = until("the job pids", || {
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        Some((tagged(&text, "A:")?, tagged(&text, "M:")?))
    })
    .await;
    cleanup.track(job as i32);
    cleanup.track(mcp as i32);
    let job_port = port_in(&folder.join("tasks/t1.output")).await;
    let mcp_port = port_in(&folder.join("mcp.out")).await;

    let roots = Arc::new(Mutex::new(HashMap::from([("/real#1".to_owned(), Root { pid: Some(agent as i64), ..Default::default() })])));
    let published = Arc::new(Mutex::new(Vec::new()));
    let watcher = watcher(roots.clone(), published.clone());
    watcher.poll(false).await;
    let ports = watcher.chat_ports("/real#1");
    assert_eq!(ports.len(), 1, "only the command shell's listener: {ports:?}");
    let port = &ports[0];
    assert_eq!((port.port, port.pid, port.address.as_str(), port.task_id.as_deref()), (job_port, job, "127.0.0.1", Some("t1")));
    assert!(port.command.starts_with("milagre"), "{:?}", port.command);
    assert!(!watcher.snapshot().values().flatten().any(|p| p.port == mcp_port), "the agent's own child is not the Chat's");

    // The agent exits and its session closes: the job lives on in its own group, so the Chat keeps its port.
    unsafe { libc::kill(agent, libc::SIGKILL) };
    until("the agent to exit", || (!alive(agent)).then_some(())).await;
    roots.lock().unwrap().clear();
    watcher.poll(true).await;
    assert_eq!(watcher.chat_ports("/real#1").iter().map(|p| p.pid).collect::<Vec<_>>(), vec![job]);

    // Stop: the job's whole group goes, and the list is fresh when it resolves.
    assert!(!watcher.stop_port("/real#1", mcp).await, "a pid the Chat doesn't list is never stopped");
    assert!(alive(mcp as i32));
    assert!(watcher.stop_port("/real#1", job).await);
    until("the job to stop", || (!alive(job as i32)).then_some(())).await;
    assert!(watcher.snapshot().is_empty());
    assert!(watcher.groups().is_empty(), "a group is forgotten once nothing in it runs");
    assert_eq!(published.lock().unwrap().last().unwrap(), &ChatPorts::new());
    watcher.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_terminal_shells_port_is_sampled_periodically_and_stopping_it_keeps_the_shell() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().canonicalize().unwrap();
    let cleanup = Cleanup::default();
    // A Terminal's shell starts a server a moment after the watcher is already polling.
    let (shell, log) = spawn_shell("sleep 0.4; \"$L\" 30 > \"$DIR/server.out\" & echo S:$!; wait; sleep 30", &folder, &cleanup);
    let roots = Arc::new(Mutex::new(HashMap::from([("/term#1".to_owned(), Root { shells: vec![shell as i64], ..Default::default() })])));
    let published = Arc::new(Mutex::new(Vec::new()));
    let watcher = watcher(roots, published.clone());
    watcher.wake();
    let server = until("the server pid", || tagged(&std::fs::read_to_string(&log).unwrap_or_default(), "S:")).await;
    cleanup.track(server as i32);
    let port = port_in(&folder.join("server.out")).await;
    until("the periodic poll to publish the port", || {
        published.lock().unwrap().iter().any(|p| p.get("/term#1").is_some_and(|ports| ports[0].port == port)).then_some(())
    })
    .await;
    assert!(watcher.scheduled(), "polling continues while the Terminal runs");

    // Same group as the shell: only the server is stopped, the Terminal stays open.
    assert!(watcher.stop_port("/term#1", server).await);
    until("the server to stop", || (!alive(server as i32)).then_some(())).await;
    assert!(alive(shell), "the Terminal's shell keeps running");
    assert!(watcher.chat_ports("/term#1").is_empty());
    watcher.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_listener_that_dies_on_its_own_drops_out_on_the_next_poll() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().canonicalize().unwrap();
    let cleanup = Cleanup::default();
    let (shell, log) = spawn_shell("\"$L\" 30 > \"$DIR/server.out\" & echo S:$!; wait; sleep 30", &folder, &cleanup);
    let server = until("the server pid", || tagged(&std::fs::read_to_string(&log).unwrap_or_default(), "S:")).await;
    cleanup.track(server as i32);
    port_in(&folder.join("server.out")).await;
    let roots = Arc::new(Mutex::new(HashMap::from([("/term#2".to_owned(), Root { shells: vec![shell as i64], ..Default::default() })])));
    let published = Arc::new(Mutex::new(Vec::new()));
    let watcher = watcher(roots, published.clone());
    watcher.wake();
    until("the port", || published.lock().unwrap().last().is_some_and(|p| p.contains_key("/term#2")).then_some(())).await;
    unsafe { libc::kill(server as i32, libc::SIGKILL) };
    until("the empty list", || published.lock().unwrap().last().is_some_and(|p| p.is_empty()).then_some(())).await;
    watcher.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_in_the_agent_group_stops_only_its_listener_and_preserves_mcp() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().canonicalize().unwrap();
    let cleanup = Cleanup::default();
    let (agent, log) = spawn_shell(
        r#"set +m; /bin/sh -c '"$L" 30 > "$DIR/server.out" & echo S:$!; wait; sleep 30' & echo C:$!; "$L" 30 > "$DIR/mcp.out" & echo M:$!; wait"#,
        &folder,
        &cleanup,
    );
    let (server, shell, mcp) = until("shared group helpers", || {
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        Some((tagged(&text, "S:")?, tagged(&text, "C:")?, tagged(&text, "M:")?))
    })
    .await;
    for pid in [server, shell, mcp] {
        cleanup.track(pid as i32);
    }
    port_in(&folder.join("server.out")).await;
    port_in(&folder.join("mcp.out")).await;
    let identity = milagre_ports::identity::system_identity(server).unwrap();
    assert_eq!(identity.pgid, i64::from(agent));
    assert!(!identity.started_at.is_empty());
    let roots = Arc::new(Mutex::new(HashMap::from([("/shared#1".into(), Root { pid: Some(agent as i64), ..Default::default() })])));
    let watcher = watcher(roots, Arc::new(Mutex::new(vec![])));
    watcher.poll(true).await;
    assert_eq!(watcher.chat_ports("/shared#1").iter().map(|p| p.pid).collect::<Vec<_>>(), vec![server]);
    assert!(watcher.stop_port("/shared#1", server).await);
    until("the server to exit", || (!alive(server as i32)).then_some(())).await;
    assert!(alive(agent));
    assert!(alive(shell as i32));
    assert!(alive(mcp as i32));
    watcher.close();
}
