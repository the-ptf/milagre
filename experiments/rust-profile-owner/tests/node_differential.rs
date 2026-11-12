//! Acceptance: the Rust profile owner against this repository's Node daemon on one throwaway data dir.
//!
//! (a) Node registers two Projects with saved Chats (a plain folder and a Git repository) and records the reads,
//! (b) the Rust owner serves the same data dir and answers the same reads through the production Node client,
//! (c) the Rust daemon client adopts it unchanged (`InstalledOwner::adopt_profile`), (d) each refuses while the other
//! owns the data dir, (e) Node serves it again afterwards with the same answers, and the Rust runs changed no byte.
//! Everything lives in one new isolated copy folder under the system temporary folder.
use milagre_daemon_client::{ChatPageOptions, ClientOptions, InstalledOwner};
use milagre_owner_store::Isolation;
use milagre_profile_owner::policy::owner_policy;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/node-differential.cjs");
const OWNER: &str = env!("CARGO_BIN_EXE_profile-owner");

struct Layout {
    root: PathBuf,
    data_dir: PathBuf,
    chats_home: PathBuf,
    worktree_root: PathBuf,
    alpha: PathBuf,
    beta: PathBuf,
}

fn node(args: &[&str]) -> String {
    let output = Command::new("node")
        .arg(SCRIPT)
        .args(args)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .output()
        .expect("node runs");
    assert!(
        output.status.success(),
        "node {args:?} failed\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    print!("{stdout}");
    stdout
}

fn owner_command(layout: &Layout) -> Command {
    let mut command = Command::new(OWNER);
    command
        .args(["serve", "--data-dir"])
        .arg(&layout.data_dir)
        .args(["--app-version", "0.0.0-test", "--cwd", "/", "--chats-home"])
        .arg(&layout.chats_home)
        .arg("--worktree-root")
        .arg(&layout.worktree_root)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .env_remove("MILAGRE_DATA_DIR")
        // The Node daemon runs with the copy's HOME: the same (absent) global Git config for origins.
        .env("GIT_CONFIG_GLOBAL", layout.root.join("home/.gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1");
    command
}

/// Starts the Rust owner with stdin kept open; returns it and its ready line.
fn start_owner(layout: &Layout) -> (Child, Value) {
    let mut child = owner_command(layout)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("profile-owner starts");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    if line.is_empty() {
        let output = child.wait_with_output().unwrap();
        panic!(
            "profile-owner exited before it was ready: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    (
        child,
        serde_json::from_str(&line).expect("ready line is JSON"),
    )
}

fn wait(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "process did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Every entry under `root`: type, mode, and a content hash for files. Never follows a link.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let meta = std::fs::symlink_metadata(&path).unwrap();
        let relative = path.strip_prefix(root).unwrap().to_path_buf();
        let mode = meta.mode() & 0o7777;
        let entry = if meta.file_type().is_symlink() {
            format!("link {:?}", std::fs::read_link(&path).unwrap())
        } else if meta.is_dir() {
            for child in std::fs::read_dir(&path).unwrap() {
                stack.push(child.unwrap().path());
            }
            format!("dir {mode:o}")
        } else if meta.is_file() {
            let digest = hex::encode(Sha256::digest(std::fs::read(&path).unwrap()));
            format!("file {mode:o} {} {digest}", meta.len())
        } else {
            format!("other {mode:o}")
        };
        out.insert(relative, entry);
    }
    out
}

fn differences(
    before: &BTreeMap<PathBuf, String>,
    after: &BTreeMap<PathBuf, String>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (path, entry) in before {
        match after.get(path) {
            None => out.push(format!("removed {} ({entry})", path.display())),
            Some(now) if now != entry => {
                out.push(format!("changed {}: {entry} -> {now}", path.display()))
            }
            _ => {}
        }
    }
    for (path, entry) in after {
        if !before.contains_key(path) {
            out.push(format!("added {} ({entry})", path.display()));
        }
    }
    out
}

/// What the owner holds while it runs, and leaves behind after it stopped.
fn locks(layout: &Layout) -> [PathBuf; 4] {
    [
        layout.data_dir.join("runtime.lock"),
        layout.alpha.join(".milagre/runtime.lock"),
        layout.beta.join(".milagre/runtime.lock"),
        layout.beta.join(".git/milagre-runtime.lock"),
    ]
}

fn assert_released(layout: &Layout, socket: &Path) {
    assert!(std::fs::symlink_metadata(socket).is_err(), "socket left");
    for lock in locks(layout) {
        assert!(!lock.exists(), "{} left", lock.display());
    }
}

/// (c) The Rust daemon client adopts the Rust owner exactly as it adopts the installed Node daemon.
fn adopt(layout: &Layout, pid: u32) {
    futures::executor::block_on(async {
        let owner = InstalledOwner::adopt_profile(&layout.data_dir)
            .await
            .expect("adopt_profile");
        let info = owner.info();
        assert_eq!(info.pid, pid);
        assert_eq!(info.version, "0.0.0-test");
        assert_eq!(info.data_dir, layout.data_dir);
        let known = owner.known_projects().await.expect("known_projects");
        let paths: Vec<_> = known
            .iter()
            .map(|project| PathBuf::from(&project.path))
            .collect();
        assert_eq!(paths, [layout.beta.clone(), layout.alpha.clone()]);
        for (path, chat) in [(&layout.alpha, 1u64), (&layout.beta, 1)] {
            let path = path.to_str().unwrap();
            let project = owner.project(path).expect("project authority");
            let (client, hello, notifications) = project
                .connect(ClientOptions::default())
                .await
                .expect("connect");
            assert!(hello.capabilities.contains("snapshot-pages-v1"));
            assert_eq!(hello.owner["pid"], pid);
            let view = client.load_view(path).await.expect("load_view");
            assert_eq!(view["path"], path);
            assert!(view.get("state").is_none());
            assert_eq!(view["version"], 1);
            let snapshot = client.runtime_snapshot().await.expect("runtime_snapshot");
            assert!(snapshot.body["projects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|project| project["path"] == path));
            client
                .accept_snapshot(&snapshot)
                .await
                .expect("accept_snapshot");
            let page = client
                .chat_messages(
                    path,
                    chat,
                    ChatPageOptions {
                        turns: Some(1),
                        ..Default::default()
                    },
                )
                .await
                .expect("chat page");
            assert!(!page["messages"].as_array().unwrap().is_empty());
            let read = client.project_read(path, true).await.expect("project_read");
            assert!(read["state"]["sessions"].is_object());
            let state = client.state_read(path).await.expect("state_read");
            assert_eq!(state.state, read["state"]);
            let runs = client.chat_runs().await.expect("chat_runs");
            assert_eq!(runs.seq, 0);
            notifications.discard();
            client.disconnect();
        }
        println!("adoption passed: adopt_profile, known_projects, connect, load_view, runtime_snapshot + accept_snapshot, chat page, project/state reads for 2 Projects");
    });
}

#[test]
fn node_differential_adoption_exclusion_and_rollback() {
    let base = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(base.path()).unwrap().join("iso");
    Isolation::create(&root, &owner_policy()).expect("a new isolated copy");
    let layout = Layout {
        data_dir: root.join("profile"),
        chats_home: root.join("chats"),
        worktree_root: root.join("worktrees"),
        alpha: root.join("projects/alpha"),
        beta: root.join("projects/beta"),
        root,
    };
    let root = layout.root.to_str().unwrap();
    let out = base.path().join("node.json");
    let out = out.to_str().unwrap();

    // (a) Node: Projects registered, then the reads recorded through the production Node client.
    node(&["setup", root]);
    node(&["prime", root]);
    node(&["record", root, out]);
    let before = snapshot(&layout.root);

    // (b) The Rust owner on the same data dir, read through the same client, compared case by case.
    let (mut owner, ready) = start_owner(&layout);
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["pid"], owner.id());
    assert_eq!(ready["dataDir"], layout.data_dir.to_str().unwrap());
    let socket = PathBuf::from(ready["socketPath"].as_str().unwrap());
    assert_eq!(
        socket,
        milagre_owner_wire::socket_path_for(&layout.data_dir).unwrap()
    );
    assert_eq!(
        std::fs::symlink_metadata(&socket)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let record: Value = serde_json::from_slice(
        &std::fs::read(layout.data_dir.join("runtime.lock/owner.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(record["pid"], owner.id());
    let keys: Vec<_> = record.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        ["pid", "token", "startedAt", "processStartedAt", "host"]
    );
    node(&["compare", root, out]);
    for lock in locks(&layout) {
        assert!(
            lock.join("owner.json").is_file(),
            "{} not held",
            lock.display()
        );
    }

    // (c) Adoption by the Rust daemon client, unchanged.
    adopt(&layout, owner.id());

    // daemon:stop stops it cleanly: socket, Project and repository locks, then the data dir's lock released.
    node(&["stop", root]);
    assert!(wait(&mut owner).success());
    assert_released(&layout, &socket);
    let after = snapshot(&layout.root);
    let changed = differences(&before, &after);
    assert!(
        changed.is_empty(),
        "the Rust owner changed the data:\n{}",
        changed.join("\n")
    );
    println!("rust run left {} entries byte-identical", after.len());

    // (d) The other way: the Rust owner refuses while Node owns the data dir.
    let mut hold = Command::new("node")
        .arg(SCRIPT)
        .args(["hold", root])
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(hold.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let node_ready: Value = serde_json::from_str(&line).expect("Node daemon ready");
    let refused = owner_command(&layout)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!refused.status.success());
    let refusal = String::from_utf8_lossy(&refused.stderr);
    assert!(
        refusal.contains("runtime.lock"),
        "unexpected refusal: {refusal}"
    );
    println!("rust refused while Node ran: {}", refusal.trim());
    // Node's socket and lock are untouched by the refused start.
    assert_eq!(node_ready["socketPath"], socket.to_str().unwrap());
    assert!(std::fs::symlink_metadata(&socket).is_ok());
    drop(hold.stdin.take());
    assert!(wait(&mut hold).success());

    // End of stdin stops it cleanly too.
    let before = snapshot(&layout.root);
    let (mut owner, _) = start_owner(&layout);
    drop(owner.stdin.take());
    assert!(wait(&mut owner).success());
    assert_released(&layout, &socket);
    assert!(differences(&before, &snapshot(&layout.root)).is_empty());
    println!("stdin EOF stopped the Rust owner cleanly");

    // (e) Rollback: Node serves the data dir again and answers as before.
    let again = base.path().join("node-again.json");
    node(&["record", root, again.to_str().unwrap()]);
    node(&["same", root, out, again.to_str().unwrap()]);
}
