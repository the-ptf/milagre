//! The timing parts of ports.test.cjs on a paused Tokio clock, plus the wire surface and the Terminal-shell merge.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use milagre_ports::{wire, with_terminal_shells, ChatPorts, PortWatcher, PortWatcherOptions, Root, Roots, Signal};
use serde_json::json;

const PS: &str = "    1     0     1 /sbin/launchd\n  100    50   100 /Users/me/.local/bin/claude\n  101   100   100 node\n  110   100   110 /bin/zsh\n  111   110   110 node\n  112   111   110 esbuild\n";
const LSOF: &str = "p101\ncnode\nn127.0.0.1:4545\np111\ncnode\nn*:5173\nn127.0.0.1:24678\n";

fn agent_roots() -> Roots {
    HashMap::from([("/a#1".to_owned(), Root { pid: Some(100), ..Default::default() })])
}

struct Counting {
    ps_calls: Arc<AtomicUsize>,
    published: Arc<Mutex<Vec<ChatPorts>>>,
}

fn options(running: Arc<AtomicBool>) -> (PortWatcherOptions, Counting) {
    let published = Arc::new(Mutex::new(Vec::new()));
    let ps_calls = Arc::new(AtomicUsize::new(0));
    let sink = published.clone();
    let mut o = PortWatcherOptions::new(Arc::new(agent_roots), Arc::new(move |ports: &ChatPorts| sink.lock().unwrap().push(ports.clone())));
    o.is_running = Arc::new(move || running.load(Ordering::SeqCst));
    let calls = ps_calls.clone();
    o.exec = Arc::new(move |command: String, _args| {
        let calls = calls.clone();
        Box::pin(async move {
            if command == "ps" {
                calls.fetch_add(1, Ordering::SeqCst);
                PS.to_owned()
            } else {
                LSOF.to_owned()
            }
        })
    });
    o.kill = Arc::new(|_, _| false);
    (o, Counting { ps_calls, published })
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn idle_ports_poll_every_15_seconds_and_wake_at_once_for_a_new_turn() {
    let running = Arc::new(AtomicBool::new(false));
    let (o, count) = options(running.clone());
    let watcher = PortWatcher::new(o);
    watcher.poll(false).await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 1);
    assert!(watcher.scheduled());
    tokio::time::advance(Duration::from_millis(14_999)).await;
    settle().await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 2);
    running.store(true, Ordering::SeqCst);
    watcher.wake();
    tokio::time::advance(Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 3);
    tokio::time::advance(Duration::from_millis(3000)).await;
    settle().await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 4);
    assert_eq!(count.published.lock().unwrap().len(), 1, "unchanged polls publish nothing");
    watcher.close();
    assert!(!watcher.scheduled());
    tokio::time::advance(Duration::from_secs(60)).await;
    settle().await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 4, "a closed watcher polls no more");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn nothing_to_watch_schedules_nothing() {
    let (mut o, count) = options(Arc::new(AtomicBool::new(true)));
    o.roots = Arc::new(Roots::new);
    let watcher = PortWatcher::new(o);
    watcher.poll(false).await;
    assert_eq!(count.ps_calls.load(Ordering::SeqCst), 0);
    assert!(!watcher.scheduled());
    assert!(count.published.lock().unwrap().is_empty(), "an empty list equal to the last one isn't published");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_during_a_poll_neither_publishes_nor_polls_again() {
    let (mut o, count) = options(Arc::new(AtomicBool::new(true)));
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let wait = Arc::new(tokio::sync::Mutex::new(Some(wait)));
    o.exec = Arc::new(move |command: String, _| {
        let wait = wait.clone();
        Box::pin(async move {
            if command == "ps" {
                if let Some(wait) = wait.lock().await.take() {
                    let _ = wait.await;
                }
                PS.to_owned()
            } else {
                LSOF.to_owned()
            }
        })
    });
    let watcher = PortWatcher::new(o);
    let polling = {
        let watcher = watcher.clone();
        tokio::spawn(async move { watcher.poll(false).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    watcher.close();
    release.send(()).unwrap();
    polling.await.unwrap();
    assert!(!watcher.scheduled());
    assert!(count.published.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_during_a_poll_waits_for_it_and_reads_again() {
    let alive = Arc::new(AtomicBool::new(true));
    let (mut o, count) = options(Arc::new(AtomicBool::new(true)));
    o.poll = Duration::from_secs(3600);
    o.grace = Duration::from_millis(200);
    let hold: Arc<Mutex<Option<tokio::sync::oneshot::Receiver<()>>>> = Arc::new(Mutex::new(None));
    let (a, h) = (alive.clone(), hold.clone());
    o.exec = Arc::new(move |command: String, args: Vec<String>| {
        let (alive, hold) = (a.clone(), h.clone());
        Box::pin(async move {
            let up = alive.load(Ordering::SeqCst);
            let listing = if command == "ps" {
                if up {
                    PS.to_owned()
                } else {
                    PS.lines().filter(|l| !l.contains(" 11")).collect::<Vec<_>>().join("\n")
                }
            } else if up && !args.iter().any(|a| a == "-d") {
                LSOF.to_owned()
            } else {
                String::new()
            };
            // The poll already under way read the listeners before the server died and hasn't published yet.
            let gate = if command == "lsof" { hold.lock().unwrap().take() } else { None };
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            listing
        })
    });
    let a = alive.clone();
    o.kill = Arc::new(move |_, signal| {
        if signal == Signal::Term {
            a.store(false, Ordering::SeqCst);
        }
        signal != Signal::Probe || a.load(Ordering::SeqCst)
    });
    let watcher = PortWatcher::new(o);
    watcher.poll(false).await;
    assert_eq!(watcher.chat_ports("/a#1").len(), 2);
    let (release, gate) = tokio::sync::oneshot::channel();
    *hold.lock().unwrap() = Some(gate);
    let running = {
        let watcher = watcher.clone();
        tokio::spawn(async move { watcher.poll(true).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    let stopped = {
        let watcher = watcher.clone();
        tokio::spawn(async move { watcher.stop_port("/a#1", 111).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    release.send(()).unwrap();
    assert!(stopped.await.unwrap());
    running.await.unwrap();
    assert!(watcher.snapshot().is_empty(), "the stale read in flight doesn't stand as the list Stop resolves with");
    assert_eq!(count.published.lock().unwrap().last().unwrap(), &ChatPorts::new());
    watcher.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wake_works_from_any_thread() {
    let (o, count) = options(Arc::new(AtomicBool::new(true)));
    let watcher = PortWatcher::new(o);
    // A Terminal's PTY thread reports changed shells (TerminalEvent::ShellsChanged) outside the runtime.
    let from_thread = watcher.clone();
    std::thread::spawn(move || from_thread.wake()).join().unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while count.ps_calls.load(Ordering::SeqCst) == 0 {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    watcher.close();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_wire_surface_matches_runtime_cjs() {
    let (o, _count) = options(Arc::new(AtomicBool::new(true)));
    let watcher = PortWatcher::new(o);
    watcher.poll(false).await;
    let all = wire::handle(&watcher, "agent:ports", &[]).await.unwrap();
    assert_eq!(all["/a#1"][0], json!({ "port": 5173, "pid": 111, "command": "node", "address": "*" }));
    assert_eq!(wire::handle(&watcher, "chat:ports", &[json!("/a#1")]).await.unwrap()["ports"].as_array().unwrap().len(), 2);
    assert_eq!(wire::handle(&watcher, "chat:ports", &[json!("/none")]).await.unwrap(), json!({ "chatId": "/none", "ports": [] }));
    for bad in [vec![], vec![json!("")], vec![json!(5)]] {
        assert_eq!(wire::handle(&watcher, "chat:ports", &bad).await.unwrap_err(), "A Chat is required to list ports.");
    }
    for bad in [vec![json!("/a#1")], vec![json!("/a#1"), json!("111")], vec![json!("/a#1"), json!(111.5)], vec![json!(1), json!(111)]] {
        assert_eq!(wire::handle(&watcher, "agent:stop-port", &bad).await.unwrap(), json!(false), "{bad:?}");
    }
    let (name, payload) = wire::event(&watcher.snapshot());
    assert_eq!((name, payload), ("agent:ports", all));
    watcher.close();
}

#[test]
fn terminal_shells_merge_into_agent_roots_as_runtime_cjs_does() {
    let roots = with_terminal_shells(agent_roots(), [("/a#1".to_owned(), vec![300]), ("/c#3".to_owned(), vec![400, 401])]);
    assert_eq!(roots["/a#1"], Root { pid: Some(100), shells: vec![300], ..Default::default() });
    assert_eq!(roots["/c#3"], Root { shells: vec![400, 401], ..Default::default() });
}
