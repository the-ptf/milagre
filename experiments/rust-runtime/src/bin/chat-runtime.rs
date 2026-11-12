//! Explicit dedicated-root Chat backend. No production profile/socket or ambient provider discovery.
use std::{
    io::{self, Write},
    sync::Arc,
    time::Duration,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime =
        milagre_rust_runtime::chat_runtime::start(&std::env::args().skip(1).collect::<Vec<_>>())?;
    println!("{}", runtime.receipt);
    io::stdout().flush()?;
    milagre_rust_runtime::actor::stop_on_stdin(Arc::downgrade(&runtime.server));
    while !runtime.server.is_stopped() {
        std::thread::sleep(Duration::from_millis(20));
    }
    runtime.finish()
}
