//! Start the installed Milagre.app's daemon in Node mode on an explicit throwaway data directory, adopt it, read
//! daemon:status, then print its PID (the caller stops it). Never use a real profile here.
//! `cargo run --features installed-owner --example installed_owner_start -- /tmp/some-new-dir`
use milagre_daemon_client::{ClientOptions, DaemonLaunch, InstalledOwner};
use std::path::PathBuf;

fn main() {
    let data = PathBuf::from(std::env::args().nth(1).expect("throwaway data dir"));
    assert!(
        !data.ends_with("Application Support/Milagre"),
        "never the real profile"
    );
    futures::executor::block_on(async {
        let launch = DaemonLaunch::find_installed_app().expect("Milagre.app");
        let started = std::time::Instant::now();
        let owner = InstalledOwner::adopt_or_start_profile(&data, &launch)
            .await
            .expect("start");
        println!(
            "started in {:?}: pid {} version {}",
            started.elapsed(),
            owner.info().pid,
            owner.info().version
        );
        let known = owner.known_projects().await.expect("known");
        println!("known Projects in throwaway profile: {}", known.len());
        let project = owner.project("/tmp").expect("project");
        let (_client, hello, _n) = project
            .connect(ClientOptions::default())
            .await
            .expect("connect");
        println!("capabilities: {}", hello.capabilities.len());
        println!("PID={}", owner.info().pid);
    });
}
