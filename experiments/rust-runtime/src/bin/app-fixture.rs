//! Only a fixed transcript preset is optional. No paths or live owner are accepted.
use std::{
    io::{self, Write},
    sync::Arc,
    thread,
    time::Duration,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let (server, actor) = if args.is_empty() {
        milagre_rust_runtime::app_fixture::start()?
    } else if args.len() == 1 && args[0] == "--populated-transcript" {
        milagre_rust_runtime::app_fixture::start_populated()?
    } else {
        return Err("Only the fixed --populated-transcript preset is accepted; no paths".into());
    };
    let server = Arc::new(server);
    println!(
        "{}",
        milagre_rust_runtime::app_fixture::bootstrap_receipt(&server, actor)?
    );
    io::stdout().flush()?;
    milagre_rust_runtime::actor::stop_on_stdin(Arc::downgrade(&server));
    while !server.is_stopped() {
        thread::sleep(Duration::from_millis(10));
    }
    milagre_owner_wire::Server::finish(server)?;
    Ok(())
}
