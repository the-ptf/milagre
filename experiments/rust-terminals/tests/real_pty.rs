//! Real PTYs. Every shell is /bin/sh in a fresh temporary folder that is also its HOME, with no profile to read,
//! and runs only short commands typed by the test. Processes a test starts in the background are stopped by it.
#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{resolver, worktree, Events};
use milagre_terminals::shell::terminal_environment;
use milagre_terminals::{Cleanup, Limits, OpenRequest, ShellCommand, TerminalEvent, Terminals, TerminalsOptions, UnixPtySpawner};

struct Real {
    terminals: Terminals,
    events: Events,
    folder: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn real(shell: ShellCommand, limits: Limits, cleanup: Cleanup) -> Real {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().canonicalize().unwrap();
    let chats = HashMap::from([("/p#1".to_owned(), vec![worktree(&folder, Some("real"))])]);
    let events = Events::default();
    let mut options = TerminalsOptions::new(resolver(chats));
    options.spawner = Arc::new(UnixPtySpawner { cleanup, kill_grace: Duration::from_millis(1000), exit_drain: Duration::from_millis(250) });
    options.shell = Arc::new(move || shell.clone());
    let home = folder.to_string_lossy().into_owned();
    options.environment = Arc::new(move || {
        terminal_environment(
            BTreeMap::from([
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), home.clone()),
                ("PS1".to_owned(), "$ ".to_owned()),
            ]),
            false,
        )
    });
    options.on_event = events.sink();
    options.limits = limits;
    Real { terminals: Terminals::new(options).unwrap(), events, folder, _dir: dir }
}

fn sh() -> ShellCommand {
    ShellCommand { file: "/bin/sh".into(), args: vec![] }
}

fn limits() -> Limits {
    Limits { read_wait: Duration::from_millis(200), title_poll: Duration::from_millis(50), ..Limits::default() }
}

/// What a viewer shows: reads from `offset` on, replacing the screen on a reset.
struct Viewer {
    id: String,
    output: String,
    offset: u64,
    ended: bool,
}

impl Viewer {
    fn new(id: &str) -> Self {
        Viewer { id: id.into(), output: String::new(), offset: 0, ended: false }
    }

    async fn read_until(&mut self, terminals: &Terminals, done: impl Fn(&str) -> bool) -> &str {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !done(&self.output) && !self.ended {
            assert!(Instant::now() < deadline, "timed out; output so far: {:?}", self.output);
            let read = terminals.read(&self.id, self.offset, None).await.unwrap();
            if read.reset {
                self.output = read.data;
            } else {
                assert_eq!(read.offset, self.offset + read.data.encode_utf16().count() as u64, "offsets count UTF-16 units");
                self.output.push_str(&read.data);
            }
            self.offset = read.offset;
            self.ended = read.ended;
        }
        &self.output
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn gone_within(pid: i32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    !alive(pid)
}

fn tagged_pid(output: &str, tag: &str) -> Option<i32> {
    let start = output.rfind(tag)? + tag.len();
    let digits: String = output[start..].chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn open(cols: u64, rows: u64) -> OpenRequest {
    OpenRequest { chat_id: "/p#1".into(), cols: Some(cols), rows: Some(rows), cwd: None }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_pty_runs_the_shell_in_the_worktree_and_echoes_input() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let info = r.terminals.open(open(80, 24)).await.unwrap();
    assert_eq!((info.cwd.as_str(), info.label.as_str(), info.busy), (r.folder.to_str().unwrap(), "real", false));
    r.terminals.input(&info.id, "echo milagre-$((40+2)); pwd; echo \"S=$SHELL T=$TERM P=$TERM_PROGRAM C=$COLORTERM\"\r").await.unwrap();
    let mut viewer = Viewer::new(&info.id);
    let base = r.folder.file_name().unwrap().to_str().unwrap().to_owned();
    let output = viewer.read_until(&r.terminals, |o| o.contains("milagre-42") && o.contains("S=/bin/sh T=")).await;
    assert!(output.contains(&base), "{output:?}");
    assert!(output.contains("S=/bin/sh T=xterm-256color P=Milagre C=truecolor"), "{output:?}");
    let shells = r.terminals.shells();
    assert_eq!(shells.len(), 1);
    assert!(alive(shells[0].1[0] as i32));
    r.terminals.dispose(Duration::from_secs(3)).await;
    assert!(gone_within(shells[0].1[0] as i32, Duration::from_secs(2)).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resize_reaches_the_shell() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(100, 30)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "stty size\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains("30 100")).await;
    r.terminals.resize(&id, 132, 40).await.unwrap();
    r.terminals.input(&id, "stty size\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains("40 132")).await;
    let listed = &r.terminals.list("/p#1").await.unwrap().terminals[0];
    assert_eq!((listed.cols, listed.rows), (132, 40));
    r.terminals.dispose(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_exiting_shell_ends_its_terminal_with_its_exit_code() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let pid = r.terminals.shells()[0].1[0] as i32;
    r.terminals.input(&id, "echo last-$((1+1)); exit 3\r").await.unwrap();
    let mut viewer = Viewer::new(&id);
    viewer.read_until(&r.terminals, |_| false).await;
    assert!(viewer.ended);
    assert!(viewer.output.contains("last-2\r\n"), "output before the exit is delivered: {:?}", viewer.output);
    let deadline = Instant::now() + Duration::from_secs(2);
    let exit = loop {
        if let Some(exit) = r.events.take().into_iter().find_map(|e| match e {
            TerminalEvent::Exited { exit, terminal_id, .. } if terminal_id == id => Some(exit),
            _ => None,
        }) {
            break exit;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!((exit.exit_code, exit.signal), (3, None));
    assert!(r.terminals.list("/p#1").await.unwrap().terminals.is_empty());
    assert!(r.terminals.shells().is_empty());
    assert_eq!(r.terminals.input(&id, "x").await.unwrap_err().0, "This Terminal has ended.");
    assert!(gone_within(pid, Duration::from_secs(1)).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unicode_round_trips_and_offsets_count_utf16_units() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(120, 24)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    // Typed directly, and produced byte by byte by printf so characters cross read boundaries.
    r.terminals.input(&id, "echo \"U1:ação 😀 中文\"\r").await.unwrap();
    r.terminals.input(&id, "printf 'U2:\\303\\247\\360\\237\\230\\200\\344\\270\\255\\n'\r").await.unwrap();
    let output = viewer.read_until(&r.terminals, |o| o.contains("U1:ação 😀 中文\r\n") && o.contains("U2:ç😀中")).await;
    assert!(!output.contains('\u{fffd}'), "{output:?}");
    r.terminals.dispose(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_replay_buffer_stays_within_its_caps() {
    let r = real(sh(), Limits { max_buffer_chars: 2000, max_buffer_lines: 50, ..limits() }, Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "i=0; while [ $i -lt 1500 ]; do echo \"line$i 😀\"; i=$((i+1)); done; echo FLOOD-$((6*7))\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains("FLOOD-42\r\n")).await;
    // A viewer that opens the Terminal now gets only what is kept.
    let late = r.terminals.read(&id, 0, None).await.unwrap();
    assert!(late.reset);
    let units = late.data.encode_utf16().count();
    assert!(units <= 2000, "{units} units kept");
    assert!(late.data.matches('\n').count() <= 51, "{} lines kept", late.data.matches('\n').count());
    assert!(late.data.contains("line1499 😀"));
    let flood: u64 = (0..1500).map(|i| format!("line{i} 😀\r\n").encode_utf16().count() as u64).sum();
    assert!(late.offset >= flood, "the offset counts everything ever written: {} < {flood}", late.offset);
    let limited = r.terminals.read(&id, 0, Some(4096)).await.unwrap();
    assert!(limited.data.encode_utf16().count() <= 2000);
    r.terminals.dispose(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_reaches_the_shell_in_order() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(200, 24)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "read -r line; echo \"GOT:$line:E$((1+1))\"\r").await.unwrap();
    let mut expected = String::new();
    for round in 0..8 {
        for letter in 'a'..='z' {
            let piece = format!("{letter}{round}");
            expected.push_str(&piece);
            r.terminals.input(&id, &piece).await.unwrap();
        }
    }
    r.terminals.input(&id, "\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains(":E2\r\n")).await;
    assert!(viewer.output.contains(&format!("GOT:{expected}:E2")), "{:?}", viewer.output);
    r.terminals.dispose(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_owner_keeps_the_shell_when_its_viewer_goes_away() {
    let r = real(sh(), Limits { read_wait: Duration::from_secs(5), ..limits() }, Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let pid = r.terminals.shells()[0].1[0] as i32;
    let mut first = Viewer::new(&id);
    r.terminals.input(&id, "echo first-$((1+1))\r").await.unwrap();
    first.read_until(&r.terminals, |o| o.contains("first-2\r\n")).await;
    // The viewer waits for more, then disconnects mid-read: its window closed, or the phone lost its connection.
    let pending = {
        let (terminals, id, offset) = (r.terminals.clone(), id.clone(), first.offset);
        tokio::spawn(async move { terminals.read(&id, offset, None).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    pending.abort();
    let _ = pending.await;
    // Output written while nobody watches is kept for the next viewer.
    r.terminals.input(&id, "sleep 0.2; echo away-$((1+1))\r").await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(alive(pid));
    let mut second = Viewer::new(&id);
    let output = second.read_until(&r.terminals, |o| o.contains("away-2\r\n")).await;
    assert!(output.contains("first-2"), "the new viewer gets the kept output too: {output:?}");
    assert_eq!(r.terminals.list("/p#1").await.unwrap().terminals.len(), 1);
    r.terminals.dispose(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_in_front_makes_the_terminal_busy_and_titled_after_it() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "echo ready-$((1+1))\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains("ready-2\r\n")).await;
    let idle = &r.terminals.list("/p#1").await.unwrap().terminals[0];
    assert!(!idle.busy, "{idle:?}");
    r.terminals.input(&id, "sleep 30\r").await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let listed = r.terminals.list("/p#1").await.unwrap().terminals[0].clone();
        if listed.title == "sleep" {
            assert!(listed.busy);
            break;
        }
        assert!(Instant::now() < deadline, "{listed:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    r.terminals.input(&id, "\u{3}").await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while r.terminals.list("/p#1").await.unwrap().terminals[0].busy {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    r.terminals.dispose(Duration::from_secs(3)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_stops_the_command_in_front_and_the_shell() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let shell = r.terminals.shells()[0].1[0] as i32;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "sh -c 'echo CHILD:$$; exec sleep 1000'\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| tagged_pid(o, "CHILD:").is_some() && o.ends_with('\n')).await;
    let child = tagged_pid(&viewer.output, "CHILD:").unwrap();
    assert!(alive(child));
    r.terminals.close(&id).await.unwrap();
    assert!(r.terminals.list("/p#1").await.unwrap().terminals.is_empty(), "the Terminal ends at once");
    assert!(gone_within(child, Duration::from_secs(3)).await, "the foreground command outlived its Terminal");
    assert!(gone_within(shell, Duration::from_secs(3)).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_that_ignores_the_hangup_is_killed_after_the_grace() {
    let stubborn =
        ShellCommand { file: "/bin/sh".into(), args: vec!["-c".into(), "trap '' HUP; echo READY; while :; do sleep 1; done".into()] };
    let r = real(stubborn, limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let shell = r.terminals.shells()[0].1[0] as i32;
    Viewer::new(&id).read_until(&r.terminals, |o| o.contains("READY")).await;
    let started = Instant::now();
    r.terminals.close(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(alive(shell), "SIGHUP is ignored, so it is still there before the grace ends");
    assert!(gone_within(shell, Duration::from_secs(3)).await);
    assert!(started.elapsed() >= Duration::from_millis(900), "killed only after the grace");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hangup_leaves_nohup_jobs_and_tree_cleanup_stops_them() {
    for cleanup in [Cleanup::Hangup, Cleanup::Tree] {
        let r = real(sh(), limits(), cleanup);
        let id = r.terminals.open(open(80, 24)).await.unwrap().id;
        let mut viewer = Viewer::new(&id);
        r.terminals.input(&id, "nohup sleep 1000 >/dev/null 2>&1 & echo BG:$!\r").await.unwrap();
        viewer.read_until(&r.terminals, |o| tagged_pid(o, "BG:").is_some() && o.contains("BG:") && o.ends_with("$ ")).await;
        let job = tagged_pid(&viewer.output, "BG:").unwrap();
        assert!(alive(job));
        r.terminals.close(&id).await.unwrap();
        r.terminals.dispose(Duration::from_secs(3)).await;
        match cleanup {
            Cleanup::Tree => assert!(gone_within(job, Duration::from_secs(3)).await, "Tree cleanup stops background jobs"),
            Cleanup::Hangup => {
                // As after closing a window of the user's terminal app: nohup jobs keep running.
                assert!(alive(job), "Hangup cleanup leaves nohup jobs");
                unsafe { libc::kill(job, libc::SIGKILL) };
                assert!(gone_within(job, Duration::from_secs(2)).await);
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_job_holding_the_pty_does_not_hold_up_the_exit() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "set +H; sleep 30 & echo BG:$! ; exit\r").await.unwrap();
    let started = Instant::now();
    viewer.read_until(&r.terminals, |_| false).await;
    assert!(viewer.ended);
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    if let Some(job) = tagged_pid(&viewer.output, "BG:") {
        unsafe { libc::kill(job, libc::SIGKILL) };
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_never_submits_a_half_typed_command() {
    let r = real(sh(), limits(), Cleanup::Hangup);
    let id = r.terminals.open(open(80, 24)).await.unwrap().id;
    let mut viewer = Viewer::new(&id);
    r.terminals.input(&id, "echo ready-$((1+1))\r").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains("ready-2\r\n")).await;
    r.terminals.input(&id, "touch half-typed").await.unwrap();
    viewer.read_until(&r.terminals, |o| o.contains("touch half-typed")).await;
    r.terminals.close(&id).await.unwrap();
    r.terminals.dispose(Duration::from_secs(3)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!r.folder.join("half-typed").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_shell_fails_to_open() {
    let r = real(ShellCommand { file: "/nonexistent/milagre-shell".into(), args: vec![] }, limits(), Cleanup::Hangup);
    let error = r.terminals.open(open(80, 24)).await.unwrap_err();
    assert!(!error.0.is_empty());
    assert_eq!(r.terminals.size(), 0);
}
