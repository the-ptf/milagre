use super::*;
use crate::{GitDiffFileOptions, GitDiffMode, GitDiffOptions, GitHistoryOptions};

const SHA: &str = "1234567890123456789012345678901234567890";
const GIT: &[&str] = &[
    "git:changes",
    "git:history",
    "git:diff-files",
    "git:diff-file",
];
fn git_server(
    run: impl FnOnce(&mut Peer) + Send + 'static,
) -> (FixtureGuard, thread::JoinHandle<()>) {
    let (guard, mut peer) = pair();
    let worker = thread::spawn(move || {
        let request = peer.request("daemon:status");
        let mut body = status();
        body["methods"] = json!(METHODS.iter().chain(GIT.iter()).collect::<Vec<_>>());
        peer.reply(&request, body);
        run(&mut peer);
    });
    (guard, worker)
}
fn open(peer: &mut Peer) {
    let request = peer.request("project:open");
    peer.reply(&request, json!({"path":PROJECT}));
}

#[test]
fn four_read_routes_preserve_only_supported_options_and_fixed_cwd() {
    let (guard, worker) = git_server(|peer| {
        open(peer);
        for (method, argument) in [
            ("git:changes", json!({"cwd":PROJECT})),
            ("git:changes", json!({"cwd":PROJECT,"base":""})),
            (
                "git:history",
                json!({"cwd":PROJECT,"base":"main","recordedBase":"origin/main","branchesVersion":"opaque-version","limit":0}),
            ),
            (
                "git:diff-files",
                json!({"cwd":PROJECT,"mode":"uncommitted"}),
            ),
            (
                "git:diff-files",
                json!({"cwd":PROJECT,"mode":"committed","base":"main","commit":SHA}),
            ),
            (
                "git:diff-file",
                json!({"cwd":PROJECT,"mode":"committed","commit":SHA,"path":"new/λ😀.txt","oldPath":"old/λ😀.txt"}),
            ),
            (
                "git:diff-file",
                json!({"cwd":PROJECT,"mode":"uncommitted","path":"untracked.txt","untracked":true}),
            ),
        ] {
            let request = peer.request(method);
            assert_eq!(request["args"], json!([argument]));
            peer.reply(&request,json!({"method":method,"isRepo":false,"patch":"unmodified","tooLarge":true,"binary":false}));
        }
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let git = client.owned_git_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        for (method, result) in [
            ("git:changes", git.changes(None).await),
            ("git:changes", git.changes(Some("")).await),
            (
                "git:history",
                git.history(GitHistoryOptions {
                    base: Some("main".into()),
                    recorded_base: Some("origin/main".into()),
                    branches_version: Some("opaque-version".into()),
                    limit: Some(0),
                })
                .await,
            ),
            (
                "git:diff-files",
                git.diff_files(GitDiffOptions::default()).await,
            ),
            (
                "git:diff-files",
                git.diff_files(GitDiffOptions {
                    mode: GitDiffMode::Committed,
                    base: Some("main".into()),
                    commit: Some(SHA.into()),
                })
                .await,
            ),
            (
                "git:diff-file",
                git.diff_file(
                    "new/λ😀.txt",
                    GitDiffFileOptions {
                        diff: GitDiffOptions {
                            mode: GitDiffMode::Committed,
                            commit: Some(SHA.into()),
                            ..Default::default()
                        },
                        old_path: Some("old/λ😀.txt".into()),
                        ..Default::default()
                    },
                )
                .await,
            ),
            (
                "git:diff-file",
                git.diff_file(
                    "untracked.txt",
                    GitDiffFileOptions {
                        untracked: true,
                        ..Default::default()
                    },
                )
                .await,
            ),
        ] {
            assert_eq!(
                result.unwrap(),
                json!({"method":method,"isRepo":false,"patch":"unmodified","tooLarge":true,"binary":false})
            );
        }
    });
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn exact_authority_and_explicit_view_are_required_and_dropped_capability_stays_weak() {
    let (guard, worker) = git_server(|peer| {
        let current = peer.request("project:current");
        peer.reply(&current, json!({"path":PROJECT}));
        open(peer);
        let request = peer.request("git:changes");
        peer.reply(&request, json!({"isRepo":false}));
        peer.closed();
    });
    let (foreign, _) = pair();
    let (client, _, _) = connect(&guard);
    assert!(matches!(
        client.owned_git_for(&foreign.authority),
        Err(Error::InvalidScope)
    ));
    let git = client.owned_git_for(&guard.authority).unwrap();
    block_on(async {
        for result in [
            git.changes(None).await,
            git.history(Default::default()).await,
            git.diff_files(Default::default()).await,
            git.diff_file("file", Default::default()).await,
        ] {
            assert_eq!(result, Err(Error::ViewNotOpened));
        }
        client.project_current().await.unwrap();
        assert_eq!(git.changes(None).await, Err(Error::ViewNotOpened));
        client.open_view(PROJECT).await.unwrap();
        git.changes(None).await.unwrap();
    });
    drop(client);
    assert_eq!(block_on(git.changes(None)), Err(Error::Disconnected));
    worker.join().unwrap();
}

#[test]
fn malformed_paths_refs_and_incompatible_options_refuse_before_enqueue() {
    let (guard, worker) = git_server(|peer| {
        open(peer);
        let request = peer.request("git:changes");
        assert_eq!(request["args"][0]["base"], "a".repeat(1024));
        peer.reply(&request, Value::Null);
        let request = peer.request("git:history");
        assert_eq!(request["args"][0]["branchesVersion"], "v".repeat(128));
        assert_eq!(request["args"][0]["limit"], 300);
        peer.reply(&request, Value::Null);
        let request = peer.request("git:diff-file");
        assert_eq!(request["args"][0]["path"], "a".repeat(4096));
        peer.reply(&request, Value::Null);
        let request = peer.request("project:current");
        peer.reply(&request, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let git = client.owned_git_for(&guard.authority).unwrap();
    block_on(async {
        client.open_view(PROJECT).await.unwrap();
        for base in ["a".repeat(1025), "invalid\0ref".into()] {
            assert!(matches!(
                git.changes(Some(&base)).await,
                Err(Error::InvalidInput { field: "base", .. })
            ));
        }
        assert!(git
            .history(GitHistoryOptions {
                recorded_base: Some("a".repeat(1025)),
                ..Default::default()
            })
            .await
            .is_err());
        assert!(git
            .history(GitHistoryOptions {
                branches_version: Some("v".repeat(129)),
                ..Default::default()
            })
            .await
            .is_err());
        assert!(git
            .history(GitHistoryOptions {
                limit: Some(301),
                ..Default::default()
            })
            .await
            .is_err());
        for path in [
            "",
            "/outside",
            "../outside",
            "a/../b",
            "a\\..\\b",
            "\\outside",
            "nul\0file",
            &"a".repeat(4097),
        ] {
            assert!(matches!(
                git.diff_file(path, Default::default()).await,
                Err(Error::InvalidInput { field: "path", .. })
            ));
        }
        assert!(matches!(
            git.diff_file(
                "valid",
                GitDiffFileOptions {
                    old_path: Some("../old".into()),
                    ..Default::default()
                }
            )
            .await,
            Err(Error::InvalidInput {
                field: "oldPath",
                ..
            })
        ));
        for commit in ["short", &"A".repeat(40), &"a".repeat(41)] {
            assert!(matches!(
                git.diff_files(GitDiffOptions {
                    mode: GitDiffMode::Committed,
                    commit: Some(commit.into()),
                    ..Default::default()
                })
                .await,
                Err(Error::InvalidInput {
                    field: "commit",
                    ..
                })
            ));
        }
        assert!(git
            .diff_files(GitDiffOptions {
                commit: Some(SHA.into()),
                ..Default::default()
            })
            .await
            .is_err());
        assert!(matches!(
            git.diff_file(
                "valid",
                GitDiffFileOptions {
                    diff: GitDiffOptions {
                        mode: GitDiffMode::Committed,
                        ..Default::default()
                    },
                    untracked: true,
                    ..Default::default()
                }
            )
            .await,
            Err(Error::InvalidInput {
                field: "untracked",
                ..
            })
        ));
        git.changes(Some(&"a".repeat(1024))).await.unwrap();
        git.history(GitHistoryOptions {
            branches_version: Some("v".repeat(128)),
            limit: Some(300),
            ..Default::default()
        })
        .await
        .unwrap();
        git.diff_file(&"a".repeat(4096), Default::default())
            .await
            .unwrap();
        drop(git.changes(Some("never polled")));
        client.project_current().await.unwrap();
    });
    client.disconnect();
    worker.join().unwrap();
    assert_eq!(
        block_on(git.history(Default::default())),
        Err(Error::Disconnected)
    );
    assert!(matches!(
        client.owned_git_for(&guard.authority),
        Err(Error::Disconnected)
    ));
}

#[test]
fn pending_read_does_not_retain_client_or_replay_after_drop() {
    let (sent, seen) = mpsc::channel();
    let (guard, worker) = git_server(move |peer| {
        open(peer);
        let _ = peer.request("git:history");
        sent.send(()).unwrap();
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let git = client.owned_git_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    let mut pending = Box::pin(git.history(Default::default()));
    assert!(pending.as_mut().now_or_never().is_none());
    seen.recv_timeout(Duration::from_secs(3)).unwrap();
    drop(client);
    assert_eq!(block_on(pending), Err(Error::Disconnected));
    assert_eq!(block_on(git.changes(None)), Err(Error::Disconnected));
    worker.join().unwrap();
}

#[test]
fn remote_scope_errors_and_submitted_timeouts_keep_exact_payload_without_replay() {
    let (release, resume) = mpsc::channel();
    let error =
        json!({"code":"GIT_SCOPE","message":"Repository changed","details":{"git":"retained"}});
    let expected = error.clone();
    let (guard, worker) = git_server(move |peer| {
        open(peer);
        let request = peer.request("git:diff-file");
        peer.send(json!({"v":1,"id":request["id"],"error":error}));
        let request = peer.request("git:history");
        resume.recv_timeout(Duration::from_secs(3)).unwrap();
        peer.reply(&request, json!({"late":true}));
        let request = peer.request("git:changes");
        peer.reply(&request, json!({"isRepo":false}));
        peer.closed();
    });
    let (client, _, _) = block_on(Client::connect(
        guard.endpoint(),
        ClientOptions {
            request_timeout: Duration::from_millis(80),
            ..Default::default()
        },
    ))
    .unwrap();
    let git = client.owned_git_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(git.diff_file("file", Default::default())),
        Err(Error::Remote {
            code: "GIT_SCOPE".into(),
            message: "Repository changed".into(),
            payload: expected
        })
    );
    assert_eq!(
        block_on(git.history(Default::default())),
        Err(Error::TimedOut { submitted: true })
    );
    release.send(()).unwrap();
    assert_eq!(
        block_on(git.changes(None)).unwrap(),
        json!({"isRepo":false})
    );
    client.disconnect();
    worker.join().unwrap();
}

#[test]
fn unsupported_git_method_is_capability_error_without_discovery_or_fallback() {
    let (guard, worker) = server(|peer| {
        open(peer);
        let request = peer.request("project:current");
        peer.reply(&request, json!({"path":PROJECT}));
        peer.closed();
    });
    let (client, _, _) = connect(&guard);
    let git = client.owned_git_for(&guard.authority).unwrap();
    block_on(client.open_view(PROJECT)).unwrap();
    assert_eq!(
        block_on(git.changes(None)),
        Err(Error::Capability {
            required: "method:git:changes".into()
        })
    );
    block_on(client.project_current()).unwrap();
    client.disconnect();
    worker.join().unwrap();
}
