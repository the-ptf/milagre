use milagre_rust_runtime::acp_fixture::Scenario;
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
        [s] => match s.as_str() {
            "reply" => Scenario::Reply,
            "permission" => Scenario::Permission,
            "stop" => Scenario::Stop,
            "startfail" => Scenario::StartFailure,
            "late" => Scenario::LateUpdate,
            _ => return Err("Unknown fixed ACP fixture".into()),
        },
        _ => return Err("Choose one fixed ACP scenario".into()),
    };
    let (server, actor, monitor) = milagre_rust_runtime::actor::start_acp(scenario)?;
    let server = Arc::new(server);
    println!(
        "{}",
        json!({"profile":server.profile_path(),"socket":server.socket_path(),"actor":actor,"fakeAcp":true})
    );
    io::stdout().flush()?;
    let stop = Arc::downgrade(&server);
    thread::spawn(move || {
        let _ = io::stdin().lock().read_line(&mut String::new());
        if let Some(server) = stop.upgrade() {
            let _ = server.shutdown();
        }
    });
    while !server.is_stopped() {
        thread::sleep(Duration::from_millis(10));
    }
    milagre_owner_wire::Server::finish(server)?;
    if !monitor.wait_stopped(Duration::from_secs(3)) {
        eprintln!("ACP_CLEANUP_INCOMPLETE: retaining isolated ownership until cleanup ends");
        while monitor.workers() != 0 {
            thread::sleep(Duration::from_millis(10));
        }
        return Err("ACP_CLEANUP_DEADLINE_EXCEEDED".into());
    }
    println!("{}", json!({"reaped":monitor.pids()}));
    Ok(())
}
