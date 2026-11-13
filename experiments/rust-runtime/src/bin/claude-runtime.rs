//! Fixed fake CLI fixture only. Arguments select a checked-in scenario, never a program or path.
use milagre_rust_runtime::claude_fixture::Scenario;
use serde_json::json;
use std::{
    io::{self, Write},
    sync::Arc,
    thread,
    time::Duration,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let scenario = match args.as_slice() {
        [] => Scenario::Reply,
        [s] => match s.as_str() {
            "reply" => Scenario::Reply,
            "permission" => Scenario::Permission,
            "question" => Scenario::Question,
            "stop" => Scenario::Stop,
            "crash" => Scenario::Crash,
            "unicode" => Scenario::Unicode,
            "content" => Scenario::Content,
            "content-allow" => Scenario::ContentAllow,
            "content-deny" => Scenario::ContentDeny,
            "queue" => Scenario::Queue,
            "design" => Scenario::Design,
            "ordinary" => Scenario::Ordinary,
            "modes" => Scenario::Modes,
            "live-modes" => Scenario::LiveModes,
            "background-retention" => Scenario::BackgroundRetention,
            "images" => Scenario::Images,
            _ => return Err("Unknown fixture scenario".into()),
        },
        _ => return Err("Only one fixed fixture scenario is accepted".into()),
    };
    let (server, actor, monitor) = milagre_rust_runtime::actor::start_claude(scenario)?;
    let server = Arc::new(server);
    println!(
        "{}",
        json!({"profile":server.profile_path(),"socket":server.socket_path(),"fixture":true,"fakeClaude":true,"actor":actor})
    );
    io::stdout().flush()?;
    milagre_rust_runtime::actor::stop_on_stdin(Arc::downgrade(&server));
    let retention_chat = format!("{}#1", actor["project"].as_str().unwrap_or_default());
    let mut retention_pid = None;
    let mut retention_stopped = false;
    let mut retention_launches = 0;
    while !server.is_stopped() {
        if matches!(scenario, Scenario::BackgroundRetention) {
            if let Some(pid) = monitor.pid(&retention_chat) {
                if retention_pid != Some(pid) {
                    retention_pid = Some(pid);
                    retention_launches += 1;
                    println!("{}", json!({"retentionPid":pid}));
                    io::stdout().flush()?;
                }
            }
            if retention_launches == 2 && monitor.workers() == 0 && !retention_stopped {
                retention_stopped = true;
                println!("{}", json!({"retentionStopped":true}));
                io::stdout().flush()?;
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    milagre_owner_wire::Server::finish(server)?;
    if !monitor.wait_stopped(Duration::from_secs(3)) {
        eprintln!("CLAUDE_CLEANUP_INCOMPLETE: retaining the fixture owner until provider supervisors exit");
        while monitor.workers() != 0 {
            thread::sleep(Duration::from_millis(20));
        }
        return Err("CLAUDE_CLEANUP_DEADLINE_EXCEEDED".into());
    }
    if matches!(scenario, Scenario::Design) {
        println!("{}", json!({"designFeedback":monitor.design_feedback()}));
    }
    Ok(())
}
