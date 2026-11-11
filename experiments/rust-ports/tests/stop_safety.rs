//! All PIDs and signals in this suite are mocked. No host processes are signalled.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use milagre_ports::{parse_ps, wire, PortWatcher, PortWatcherOptions, ProcessIdentity, Root, Roots, Signal};
use serde_json::json;

const PS: &str = "100 50 100 claude\n101 100 100 mcp\n110 100 110 sh\n111 110 110 node\n112 110 110 worker\n";
const LSOF: &str = "p111\ncnode\nn127.0.0.1:5173\n";

type Hook = Box<dyn FnOnce(&mut Model) + Send>;
struct Model {
    ps: String,
    lsof: String,
    roots: Roots,
    epochs: HashMap<i64, String>,
    missing: Vec<i64>,
    kills: Vec<(i64, Signal)>,
    execs: Vec<(String, Vec<String>)>,
    after_term: Option<Hook>,
    after_probe: Option<Hook>,
    after_tasks: Option<Hook>,
    reads: Vec<i64>,
}

impl Model {
    fn new() -> Self {
        Self {
            ps: PS.into(),
            lsof: LSOF.into(),
            roots: HashMap::from([("a".into(), Root { pid: Some(100), ..Default::default() })]),
            epochs: HashMap::new(),
            missing: vec![],
            kills: vec![],
            execs: vec![],
            after_term: None,
            after_probe: None,
            after_tasks: None,
            reads: vec![],
        }
    }
    fn remove(&mut self, pid: i64) {
        self.ps = self.ps.lines().filter(|line| !line.starts_with(&format!("{pid} "))).collect::<Vec<_>>().join("\n");
    }
    fn identity(&self, pid: i64) -> Option<ProcessIdentity> {
        if self.missing.contains(&pid) {
            return None;
        }
        parse_ps(&self.ps).into_iter().find(|r| r.pid == pid).map(|r| ProcessIdentity {
            ppid: r.ppid,
            pgid: r.pgid,
            started_at: self.epochs.get(&pid).cloned().unwrap_or_else(|| format!("birth-{pid}")),
        })
    }
}

fn options(model: &Arc<Mutex<Model>>) -> PortWatcherOptions {
    let m = model.clone();
    let mut o = PortWatcherOptions::new(Arc::new(move || m.lock().unwrap().roots.clone()), Arc::new(|_| {}));
    o.windows = false;
    o.poll = Duration::from_secs(3600);
    o.grace = Duration::ZERO;
    let m = model.clone();
    o.identity = Arc::new(move |pid| {
        let mut m = m.lock().unwrap();
        m.reads.push(pid);
        m.identity(pid)
    });
    let m = model.clone();
    o.exec = Arc::new(move |command, args| {
        let mut m = m.lock().unwrap();
        m.execs.push((command.clone(), args.clone()));
        let output = if command == "ps" {
            m.ps.clone()
        } else if args.iter().any(|a| a == "-d") {
            if let Some(hook) = m.after_tasks.take() {
                hook(&mut m);
            }
            String::new()
        } else {
            m.lsof.clone()
        };
        Box::pin(async move { output })
    });
    let m = model.clone();
    o.kill = Arc::new(move |target, signal| {
        let mut m = m.lock().unwrap();
        m.kills.push((target, signal));
        let hook = match signal {
            Signal::Term => m.after_term.take(),
            Signal::Probe => m.after_probe.take(),
            Signal::Kill => None,
        };
        if let Some(hook) = hook {
            hook(&mut m);
        }
        true
    });
    o
}

async fn setup() -> (Arc<Mutex<Model>>, PortWatcher) {
    let model = Arc::new(Mutex::new(Model::new()));
    let watcher = PortWatcher::new(options(&model));
    watcher.poll(true).await;
    assert_eq!(watcher.chat_ports("a").len(), 1);
    model.lock().unwrap().execs.clear();
    (model, watcher)
}

#[tokio::test]
async fn fresh_poll_rejects_stale_listener_reused_pid_and_changed_group() {
    for change in 0..4 {
        let (model, watcher) = setup().await;
        {
            let mut m = model.lock().unwrap();
            match change {
                0 => m.lsof.clear(),
                1 => {
                    m.epochs.insert(111, "new-process".into());
                }
                2 => m.ps = m.ps.replace("111 110 110", "111 110 111"),
                _ => m.missing.push(111),
            }
        }
        assert!(!watcher.stop_port("a", 111).await, "case {change}");
        let m = model.lock().unwrap();
        assert_eq!(m.execs[0].0, "ps");
        assert!(m.execs.iter().any(|(cmd, args)| cmd == "lsof" && args.contains(&"-iTCP".into())));
        assert!(m.kills.is_empty());
        watcher.close();
    }
}

#[tokio::test]
async fn identity_is_rechecked_after_listeners_and_before_term() {
    let (model, watcher) = setup().await;
    model.lock().unwrap().after_tasks = Some(Box::new(|m| {
        m.epochs.insert(111, "reused-during-lsof".into());
    }));
    assert!(!watcher.stop_port("a", 111).await);
    assert!(model.lock().unwrap().kills.is_empty());
    watcher.close();
}

#[tokio::test]
async fn each_signal_rechecks_listener_and_group_leader_identity() {
    for change in 0..5 {
        for during_probe in [false, true] {
            let (model, watcher) = setup().await;
            let hook: Hook = Box::new(move |m| match change {
                0 => {
                    m.epochs.insert(111, "new-listener".into());
                }
                1 => {
                    m.epochs.insert(110, "new-leader".into());
                }
                2 => m.remove(110),
                3 => m.remove(111),
                _ => m.ps = m.ps.replace("111 110 110", "111 110 999"),
            });
            if during_probe {
                model.lock().unwrap().after_probe = Some(hook);
            } else {
                model.lock().unwrap().after_term = Some(hook);
            }
            assert!(watcher.stop_port("a", 111).await);
            let expected = if during_probe { vec![(-110, Signal::Term), (-110, Signal::Probe)] } else { vec![(-110, Signal::Term)] };
            assert_eq!(model.lock().unwrap().kills, expected, "change {change}, during_probe {during_probe}");
            watcher.close();
        }
    }
}

#[tokio::test]
async fn unchanged_identity_escalates_after_grace() {
    let (model, watcher) = setup().await;
    assert!(watcher.stop_port("a", 111).await);
    assert_eq!(model.lock().unwrap().kills, vec![(-110, Signal::Term), (-110, Signal::Probe), (-110, Signal::Kill)]);
    watcher.close();
}

#[tokio::test]
async fn shared_agent_advisor_or_terminal_group_stops_only_listener() {
    for kind in 0..3 {
        let model = Arc::new(Mutex::new(Model::new()));
        {
            let mut m = model.lock().unwrap();
            m.ps = m.ps.replace("110 100 110", "110 100 100").replace("111 110 110", "111 110 100").replace("112 110 110", "112 110 100");
            m.roots = HashMap::from([(
                "a".into(),
                match kind {
                    0 => Root { pid: Some(100), ..Default::default() },
                    1 => Root { agents: vec![100], ..Default::default() },
                    _ => Root { shells: vec![100], ..Default::default() },
                },
            )]);
        }
        let watcher = PortWatcher::new(options(&model));
        watcher.poll(true).await;
        assert!(watcher.stop_port("a", 111).await);
        assert!(model.lock().unwrap().kills.iter().all(|(target, _)| *target == 111));
        assert!(!watcher.chat_ports("a").iter().any(|port| port.pid == 101));
        watcher.close();
    }
}

#[tokio::test]
async fn a_group_that_becomes_shared_during_grace_gets_no_more_signals() {
    let (model, watcher) = setup().await;
    model.lock().unwrap().after_term = Some(Box::new(|m| {
        m.roots.insert("b".into(), Root { pid: Some(110), ..Default::default() });
    }));
    assert!(watcher.stop_port("a", 111).await);
    assert_eq!(model.lock().unwrap().kills, vec![(-110, Signal::Term)]);
    watcher.close();
}

#[tokio::test]
async fn orphan_survives_leader_exit_but_recycled_group_never_crosses_chats() {
    let (model, watcher) = setup().await;
    {
        let mut m = model.lock().unwrap();
        m.roots.clear();
        m.remove(110);
        m.ps = m.ps.replace("111 110 110", "111 1 110").replace("112 110 110", "112 1 110");
    }
    watcher.poll(true).await;
    assert_eq!(watcher.chat_ports("a").len(), 1);
    assert!(watcher.stop_port("a", 111).await);
    assert!(model.lock().unwrap().kills.iter().all(|(target, _)| *target == 111), "no leader: process-only stop");
    {
        let mut m = model.lock().unwrap();
        m.ps = PS.into();
        for pid in [110, 111, 112] {
            m.epochs.insert(pid, "new-chat-process".into());
        }
        m.roots.insert("b".into(), Root { pid: Some(100), ..Default::default() });
        m.kills.clear();
    }
    watcher.poll(true).await;
    assert!(watcher.chat_ports("a").is_empty());
    assert_eq!(watcher.chat_ports("b").len(), 1);
    assert!(!watcher.stop_port("a", 111).await);
    assert!(model.lock().unwrap().kills.is_empty());
    watcher.close();
}

#[tokio::test]
async fn shared_agent_group_is_never_remembered_after_agent_exits() {
    let (model, watcher) = setup().await;
    {
        let mut m = model.lock().unwrap();
        m.ps = m.ps.replace("110 100 110", "110 100 100").replace("111 110 110", "111 110 100");
    }
    watcher.poll(true).await;
    assert!(!watcher.groups().get("a").is_some_and(|g| g.contains(&100)));
    {
        let mut m = model.lock().unwrap();
        m.roots.clear();
        m.remove(100);
    }
    watcher.poll(true).await;
    assert!(watcher.chat_ports("a").is_empty());
    watcher.close();
}

#[tokio::test]
async fn invalid_ids_closed_watchers_and_protected_root_pids_never_signal() {
    let (model, watcher) = setup().await;
    for pid in [i64::MIN, -110, -1, 0, 1, i64::MAX] {
        assert!(!watcher.stop_port("a", pid).await);
    }
    // Listed Terminal shell itself is still protected.
    model.lock().unwrap().roots.get_mut("a").unwrap().shells.push(111);
    assert!(!watcher.stop_port("a", 111).await);
    watcher.close();
    assert!(!watcher.stop_port("a", 111).await);
    assert!(model.lock().unwrap().kills.is_empty());
    // Safe to exercise the real wrapper: these must return before entering libc::kill.
    for target in [-1, 0, 1, i64::MIN, i64::MAX] {
        assert!(!milagre_ports::watcher::system_kill(target, Signal::Term));
    }
}

#[tokio::test]
async fn pgid_one_is_never_a_group_signal() {
    let model = Arc::new(Mutex::new(Model::new()));
    {
        let mut m = model.lock().unwrap();
        m.ps = m.ps.replace("110 100 110", "110 100 1").replace("111 110 110", "111 110 1");
    }
    let watcher = PortWatcher::new(options(&model));
    watcher.poll(true).await;
    assert!(watcher.stop_port("a", 111).await);
    assert!(model.lock().unwrap().kills.iter().all(|(target, _)| *target == 111));
    watcher.close();
}

#[tokio::test]
async fn windows_default_is_explicitly_unsupported_and_injected_failure_is_false() {
    let model = Arc::new(Mutex::new(Model::new()));
    {
        let mut m = model.lock().unwrap();
        m.ps = "100 50 100 @100 claude.exe\n110 100 110 @110 pwsh.exe\n111 110 111 @111 node.exe\n".into();
    }
    let mut o = options(&model);
    o.windows = true;
    let watcher = PortWatcher::new(o.clone());
    watcher.poll(true).await;
    assert!(!watcher.supports_stop());
    assert!(!watcher.stop_port("a", 111).await);
    assert_eq!(
        wire::handle(&watcher, "agent:stop-port", &[json!("a"), json!(111)]).await.unwrap_err(),
        "Stopping ports on Windows is unsupported without a process-tree stopper."
    );
    watcher.close();
    o.stop_windows_tree = Some(Arc::new(|_, _| Box::pin(async { false })));
    let watcher = PortWatcher::new(o);
    watcher.poll(true).await;
    assert!(watcher.supports_stop());
    assert!(!watcher.stop_port("a", 111).await);
    assert!(model.lock().unwrap().kills.is_empty());
    watcher.close();
}
