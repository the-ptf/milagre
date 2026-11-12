use super::*;
use crate::{InstalledOwner, SendOptions, SendTarget};
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::path::PathBuf;

const ACTIONS: &[&str] = &["chat:send", "chat:send-status"];

fn installed_status() -> Value {
    json!({"pid":PID,"protocolVersion":1,"closing":false,"capabilities":["desktop-v1","snapshot-pages-v1","result-pages-v1"],"methods":METHODS.iter().filter(|m| !m.starts_with("daemon:snapshot")).chain(ACTIONS.iter()).collect::<Vec<_>>()})
}

fn installed_pair() -> (crate::InstalledProject, Peer) {
    let (client, server) = UnixStream::pair().unwrap();
    let connection = Mutex::new(Some(client));
    let project = crate::installed_owner::InstalledProject::for_test(Arc::new(Authority {
        launcher: None,
        project: PROJECT.into(),
        pid: PID,
        connect: Box::new(move || connection.lock().unwrap().take().ok_or(Error::Disconnected)),
    }));
    (project, Peer::new(server))
}

#[test]
fn installed_actions_send_the_chosen_provider_and_model() {
    let (project, mut peer) = installed_pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        peer.reply(&request, installed_status());
        let open = peer.request("project:open");
        peer.reply(&open, json!({"path":PROJECT}));
        let send = peer.request("chat:send");
        assert_eq!(send["args"][0]["provider"], "codex");
        assert_eq!(send["args"][0]["model"], "gpt-5.5");
        assert_eq!(send["args"][0]["projectPath"], PROJECT);
        assert_eq!(send["args"][0]["sessionId"], 7);
        peer.reply(&send, json!({"sessionId":7}));
        peer.closed();
    });
    let (client, _, _) = block_on(project.connect(ClientOptions::default())).unwrap();
    assert!(matches!(
        project.chat_actions(&client, "gpt", "gpt-5.5"),
        Err(Error::InvalidInput {
            field: "provider",
            ..
        })
    ));
    assert!(matches!(
        project.chat_actions(&client, "codex", ""),
        Err(Error::InvalidInput { field: "model", .. })
    ));
    let actions = project.chat_actions(&client, "codex", "gpt-5.5").unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    block_on(actions.send(SendTarget::Existing(7), "hi", "c-1", SendOptions::default())).unwrap();
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn desktop_capability_unlocks_the_unlisted_node_snapshot() {
    let (project, mut peer) = installed_pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        peer.reply(&request, installed_status());
        peer.snapshot(4);
        peer.closed();
    });
    let (client, _, _) = block_on(project.connect(ClientOptions::default())).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    assert_eq!(snapshot.event_seq, 4);
    client.disconnect();
    worker.join().unwrap();
}

/// A fake Node daemon on the real derived socket path for a throwaway data directory.
struct FakeDaemon {
    socket: PathBuf,
    _data: tempfile::TempDir,
    data: PathBuf,
}
impl FakeDaemon {
    fn start(status: impl Fn(&Path) -> Value + Send + 'static, connections: usize) -> Self {
        let data = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(data.path()).unwrap();
        let uid = unsafe { libc::getuid() };
        let directory = PathBuf::from(format!("/tmp/milagre-{uid}"));
        if !directory.exists() {
            std::fs::create_dir(&directory).unwrap();
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let digest = format!(
            "{:x}",
            sha2::Sha256::digest(canonical.as_os_str().as_encoded_bytes())
        );
        let socket = directory.join(format!("{}.sock", &digest[..24]));
        let listener = UnixListener::bind(&socket).unwrap();
        let dir = canonical.clone();
        thread::spawn(move || {
            for stream in listener.incoming().take(connections) {
                let stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    let frame: Value = serde_json::from_str(&line).unwrap();
                    let result = match frame["method"].as_str().unwrap() {
                        "daemon:status" => status(&dir),
                        "project:known" => {
                            json!([{"path":"/p/one","name":"one"},{"path":"/p/two"}])
                        }
                        other => panic!("unexpected {other}"),
                    };
                    writeln!(writer, "{}", json!({"v":1,"event":{"seq":1}})).unwrap();
                    writeln!(
                        writer,
                        "{}",
                        json!({"v":1,"id":frame["id"],"result":result})
                    )
                    .unwrap();
                    line.clear();
                }
            }
        });
        Self {
            socket,
            data: canonical,
            _data: data,
        }
    }
}
impl Drop for FakeDaemon {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
    }
}
use sha2::Digest;
use std::path::Path;

#[test]
fn adopts_only_the_running_daemon_for_this_data_directory() {
    let me = std::process::id();
    let daemon = FakeDaemon::start(
        move |dir| json!({"pid":me,"version":"test","protocolVersion":1,"closing":false,"dataDir":dir}),
        2,
    );
    let owner = block_on(InstalledOwner::adopt_profile(&daemon.data)).unwrap();
    assert_eq!(owner.info().pid, me);
    assert_eq!(owner.info().socket, daemon.socket);
    let known = block_on(owner.known_projects()).unwrap();
    assert_eq!(known.len(), 2);
    assert_eq!(known[0].name, "one");
    assert_eq!(known[1].name, "");
    assert!(owner.project("relative/path").is_err());
    assert!(owner.project("/p/one").is_ok());
}

#[test]
fn refuses_a_daemon_for_another_data_directory_or_pid() {
    let me = std::process::id();
    let other_dir = FakeDaemon::start(
        move |_| json!({"pid":me,"protocolVersion":1,"closing":false,"dataDir":"/elsewhere"}),
        1,
    );
    assert!(matches!(
        block_on(InstalledOwner::adopt_profile(&other_dir.data)),
        Err(Error::Launch {
            code: "INSTALLED_OWNER_MISMATCH",
            ..
        })
    ));
    let other_pid = FakeDaemon::start(
        move |dir| json!({"pid":me + 1,"protocolVersion":1,"closing":false,"dataDir":dir}),
        1,
    );
    assert!(matches!(
        block_on(InstalledOwner::adopt_profile(&other_pid.data)),
        Err(Error::Launch {
            code: "INSTALLED_OWNER_MISMATCH",
            ..
        })
    ));
}

#[test]
fn a_profile_without_a_running_daemon_is_unavailable() {
    let data = tempfile::tempdir().unwrap();
    assert!(matches!(
        block_on(InstalledOwner::adopt_profile(data.path())),
        Err(Error::Launch {
            code: "DAEMON_UNAVAILABLE",
            ..
        })
    ));
    assert!(matches!(
        block_on(InstalledOwner::adopt_profile(&data.path().join("missing"))),
        Err(Error::Launch {
            code: "PROFILE_UNAVAILABLE",
            ..
        })
    ));
}
