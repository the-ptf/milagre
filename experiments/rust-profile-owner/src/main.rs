//! `profile-owner serve --data-dir D --app-version V ...`: see the library docs and README.md.
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

static SIGNALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    SIGNALLED.store(true, Ordering::Release);
}

fn main() {
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
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
    }
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
    let mut asked = false;
    while !owner.server.is_stopped() {
        if SIGNALLED.load(Ordering::Acquire) && !asked {
            asked = true;
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
