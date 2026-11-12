//! The profile owner's lock, socket and refusals, without Node: each test runs the binary on its own new isolated copy.
use milagre_owner_store::Isolation;
use milagre_profile_owner::policy::owner_policy;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

const OWNER: &str = env!("CARGO_BIN_EXE_profile-owner");

struct Copy {
    _base: tempfile::TempDir,
    root: PathBuf,
    data: PathBuf,
}

fn copy() -> Copy {
    let base = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(base.path()).unwrap().join("iso");
    Isolation::create(&root, &owner_policy()).unwrap();
    let data = root.join("profile");
    std::fs::create_dir(&data).unwrap();
    Copy {
        _base: base,
        root,
        data,
    }
}

fn command(data: &Path, chats: &Path, worktrees: &Path) -> Command {
    let mut command = Command::new(OWNER);
    command
        .args(["serve", "--data-dir"])
        .arg(data)
        .args(["--app-version", "1.2.3-test", "--chats-home"])
        .arg(chats)
        .arg("--worktree-root")
        .arg(worktrees)
        .env_remove("MILAGRE_DATA_DIR")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn serve(copy: &Copy) -> Command {
    command(
        &copy.data,
        &copy.root.join("chats"),
        &copy.root.join("worktrees"),
    )
}

fn start(copy: &Copy) -> (Child, Value) {
    let mut child = serve(copy).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(!line.is_empty(), "profile-owner didn't start");
    (child, serde_json::from_str(&line).unwrap())
}

fn refused(mut command: Command) -> String {
    let output: Output = command.stdin(Stdio::null()).output().unwrap();
    assert!(!output.status.success(), "should have refused");
    assert!(output.stdout.is_empty(), "no ready line on a refusal");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn stop(mut child: Child) {
    drop(child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            return;
        }
        assert!(Instant::now() < deadline, "profile-owner didn't stop");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// installed_owner.rs `socket_path`: the client's own derivation, written out again here.
fn client_socket(data: &Path) -> PathBuf {
    let real = std::fs::canonicalize(data).unwrap();
    let digest = format!("{:x}", Sha256::digest(real.as_os_str().as_encoded_bytes()));
    PathBuf::from(format!(
        "/tmp/milagre-{}/{}.sock",
        unsafe { libc::getuid() },
        &digest[..24]
    ))
}

#[test]
fn socket_is_the_clients_derivation_and_the_lock_is_nodes_and_exclusive() {
    let copy = copy();
    let (child, ready) = start(&copy);
    let socket = client_socket(&copy.data);
    assert_eq!(ready["socketPath"], socket.to_str().unwrap());
    assert_eq!(ready["pid"], child.id());
    let meta = std::fs::symlink_metadata(&socket).unwrap();
    assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    // ownership.cjs acquireOwnership: a 0700 folder holding a 0600 owner.json, JSON.stringify(owner, null, 2).
    let lock = copy.data.join("runtime.lock");
    assert_eq!(
        std::fs::metadata(&lock).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let file = lock.join("owner.json");
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let text = std::fs::read_to_string(&file).unwrap();
    let owner: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(owner["pid"], child.id());
    assert_eq!(
        text,
        format!(
            "{{\n  \"pid\": {},\n  \"token\": {},\n  \"startedAt\": {},\n  \"processStartedAt\": {},\n  \"host\": {}\n}}",
            owner["pid"], owner["token"], owner["startedAt"], owner["processStartedAt"], owner["host"]
        )
    );
    // A second owner of the same data dir, by its path or an alias of it, is refused and changes nothing.
    let alias = copy.root.join("alias");
    std::os::unix::fs::symlink(&copy.data, &alias).unwrap();
    for data in [&copy.data, &alias] {
        let error = refused(command(
            data,
            &copy.root.join("chats"),
            &copy.root.join("worktrees"),
        ));
        assert!(error.contains("runtime.lock"), "{error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    }
    std::fs::remove_file(&alias).unwrap();
    stop(child);
    assert!(!lock.exists());
    assert!(std::fs::symlink_metadata(&socket).is_err());
}

#[test]
fn a_data_dir_outside_an_isolated_copy_is_refused_before_any_write() {
    let base = tempfile::tempdir().unwrap();
    let data = base.path().join("profile");
    std::fs::create_dir(&data).unwrap();
    let error = refused(command(
        &data,
        &base.path().join("c"),
        &base.path().join("w"),
    ));
    assert!(
        error.contains("isn't inside an isolated copy folder"),
        "{error}"
    );
    assert_eq!(std::fs::read_dir(&data).unwrap().count(), 0);
    // The isolated copy folder itself isn't a data dir either.
    let copy = copy();
    let error = refused(command(
        &copy.root,
        &copy.root.join("c"),
        &copy.root.join("w"),
    ));
    assert!(error.contains("isolated copy"), "{error}");
    assert!(!copy.root.join("runtime.lock").exists());
}

#[test]
fn the_real_profile_and_milagre_home_are_refused_without_being_touched() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let copy = copy();
    for live in [
        home.join("Library/Application Support/Milagre"),
        home.join(".milagre"),
    ] {
        if !live.is_dir() {
            continue;
        }
        let lock = live.join("runtime.lock/owner.json");
        let before = std::fs::read(&lock).ok();
        let error = refused(command(&live, &copy.root.join("c"), &copy.root.join("w")));
        assert!(error.contains("isolated copy"), "{live:?}: {error}");
        assert_eq!(std::fs::read(&lock).ok(), before, "{live:?} lock changed");
    }
    // Nor may an isolated data dir point its chats home or Worktree root at them.
    for (chats, worktrees) in [
        (home.join(".milagre/chats"), copy.root.join("w")),
        (copy.root.join("c"), home.join(".milagre/worktrees")),
    ] {
        let error = refused(command(&copy.data, &chats, &worktrees));
        assert!(
            error.contains("must be inside the isolated copy"),
            "{error}"
        );
        assert!(!copy.data.join("runtime.lock").exists());
    }
}

#[test]
fn a_dead_owners_lock_is_refused_and_left_for_an_operator() {
    let copy = copy();
    let lock = copy.data.join("runtime.lock");
    std::fs::create_dir(&lock).unwrap();
    // A pid no process has (above macOS's and Linux's default pid ranges).
    let record = "{\n  \"pid\": 2147483000,\n  \"token\": \"t\",\n  \"startedAt\": \"2026-01-01T00:00:00.000Z\"\n}";
    std::fs::write(lock.join("owner.json"), record).unwrap();
    let error = refused(serve(&copy));
    assert!(error.contains("runtime.lock"), "{error}");
    assert_eq!(
        std::fs::read_to_string(lock.join("owner.json")).unwrap(),
        record
    );
}

#[test]
fn a_stale_socket_is_replaced_and_anything_else_there_is_refused() {
    let copy = copy();
    let socket = client_socket(&copy.data);
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    std::fs::write(&socket, "not a socket").unwrap();
    let error = refused(serve(&copy));
    assert!(error.contains("UNSAFE_SOCKET"), "{error}");
    assert_eq!(std::fs::read_to_string(&socket).unwrap(), "not a socket");
    // The refused start released the lock it took.
    assert!(!copy.data.join("runtime.lock").exists());
    std::fs::remove_file(&socket).unwrap();
    // A crashed owner's socket: removed under the lock, then bound again.
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    let (child, ready) = start(&copy);
    assert_eq!(ready["socketPath"], socket.to_str().unwrap());
    stop(child);
}
