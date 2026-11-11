//! This binary accepts no path arguments and never connects to a live owner.
use serde_json::json;
use std::{
    io::{self, BufRead, Write},
    sync::Arc,
    thread,
    time::Duration,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().len() != 1 {
        return Err("This isolated runtime accepts no arguments or existing profile path".into());
    }
    let server = Arc::new(milagre_rust_runtime::start_owned()?);
    println!(
        "{}",
        json!({"profile":server.profile_path(),"socket":server.socket_path(),"fixture":true,"projectReadCommandsOnly":true,"ownedCopies":true,"terminals":true})
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
    Ok(())
}
