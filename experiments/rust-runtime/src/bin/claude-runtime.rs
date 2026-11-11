//! Fixed fake CLI fixture only. Arguments select a checked-in scenario, never a program or path.
use milagre_rust_runtime::claude_fixture::Scenario;
use serde_json::json;
use std::{
    io::{self, BufRead, Write},
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
    let stopping = Arc::downgrade(&server);
    thread::spawn(move || {
        let _ = io::stdin().lock().read_line(&mut String::new());
        if let Some(server) = stopping.upgrade() {
            let _ = server.shutdown();
        }
    });
    while !server.is_stopped() {
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
