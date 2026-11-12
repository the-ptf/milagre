//! `profile-owner serve --data-dir D --app-version V ...`: see the library docs and README.md.
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

/// Stop signals received so far (SIGTERM, SIGINT, SIGHUP). Each new one asks the server to stop again, so a stop that
/// failed (a save, a drain) is retried by the next signal.
static SIGNALS: AtomicUsize = AtomicUsize::new(0);

extern "C" fn on_signal(_: libc::c_int) {
    SIGNALS.fetch_add(1, Ordering::AcqRel);
}

fn main() {
    // Before anything is taken: a stop signal at any point from here on is a clean stop, never the default kill that
    // would leave the data dir's lock behind.
    // SAFETY: the handler only touches an atomic, which is async-signal-safe.
    unsafe {
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(signal, on_signal as *const () as libc::sighandler_t);
        }
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match milagre_profile_owner::parse_args(&args) {
        Ok(Some(options)) => options,
        Ok(None) => {
            println!("{}", milagre_profile_owner::usage());
            return;
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    let owner = match milagre_profile_owner::start(&options) {
        Ok(owner) => owner,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    println!("{}", owner.ready_line());
    let _ = io::stdout().flush();
    let stopping = Arc::downgrade(&owner.server);
    thread::spawn(move || {
        // Input is ignored; the end of it stops the owner.
        let mut sink = [0u8; 4096];
        let mut stdin = io::stdin().lock();
        while matches!(stdin.read(&mut sink), Ok(count) if count > 0) {}
        if let Some(server) = stopping.upgrade() {
            if let Err(error) = server.shutdown() {
                eprintln!("{error}");
            }
        }
    });
    let mut handled = 0;
    while !owner.server.is_stopped() {
        let received = SIGNALS.load(Ordering::Acquire);
        if received != handled {
            handled = received;
            if let Err(error) = owner.server.shutdown() {
                eprintln!("{error}");
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    if let Err(error) = owner.finish() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
