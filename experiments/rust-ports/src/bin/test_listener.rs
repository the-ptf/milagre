//! Test helper: listens on a free port of 127.0.0.1 only (never a public interface), prints `PORT:<n>`, then waits
//! until killed or `<seconds>` (default 60) pass, so a failed test can't leave it running for long.

use std::io::Write;
use std::net::TcpListener;
use std::time::Duration;

fn main() {
    let lifetime = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(60u64);
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    let mut out = std::io::stdout();
    writeln!(out, "PORT:{port}").unwrap();
    out.flush().unwrap();
    std::thread::sleep(Duration::from_secs(lifetime));
    drop(listener);
}
