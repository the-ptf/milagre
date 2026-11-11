//! Loopback-only helper for the isolated runtime integration test. It exits by itself within 30 seconds.
use std::{io::Write, net::TcpListener, time::Duration};
fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("temporary loopback port");
    println!(
        "FIXTURE_LISTENER_PID={} PORT={}",
        std::process::id(),
        listener.local_addr().unwrap().port()
    );
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(30));
    drop(listener);
}
