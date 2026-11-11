//! This binary accepts no path arguments and never connects to a live owner.
use serde_json::json;
use std::{
    io::{self, Write},
    sync::Arc,
    thread,
    time::Duration,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().len() != 1 {
        return Err("This isolated runtime accepts no arguments or existing profile path".into());
    }
    let (server, actor) = milagre_rust_runtime::app_fixture::start()?;
    let server = Arc::new(server);
    println!(
        "{}",
        json!({"profile":server.profile_path(),"socket":server.socket_path(),"fixture":true,"scriptedOwner":true,"bootstrapVersion":1,"protocolVersion":1,"pid":std::process::id(),"appFixture":true,"ownedCopies":true,"actor":actor})
    );
    io::stdout().flush()?;
    milagre_rust_runtime::actor::stop_on_stdin(Arc::downgrade(&server));
    while !server.is_stopped() {
        thread::sleep(Duration::from_millis(10));
    }
    milagre_owner_wire::Server::finish(server)?;
    Ok(())
}
