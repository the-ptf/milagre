use milagre_git_read::{GitReader, UNSUPPORTED_MUTATIONS};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn production_node_conformance_in_disposable_repositories() {
    let temp = tempfile::Builder::new()
        .prefix("milagre-rust-git-")
        .tempdir()
        .unwrap();
    let generated = Command::new("node")
        .arg(format!("{}/tests/fixtures.cjs", env!("CARGO_MANIFEST_DIR")))
        .arg(temp.path())
        .output()
        .expect("Node required for production conformance");
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let fixture: Value = serde_json::from_slice(&generated.stdout).unwrap();
    let roots: Vec<PathBuf> = fixture["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|root| PathBuf::from(root.as_str().unwrap()))
        .collect();
    let reader = GitReader::new(roots.clone()).unwrap();
    let indexes: Vec<_> = roots
        .iter()
        .filter_map(|root| {
            let path = root.join(".git/index");
            std::fs::read(&path).ok().map(|bytes| (path, bytes))
        })
        .collect();
    let cases = fixture["cases"].as_array().unwrap();
    for case in cases {
        let result = reader
            .call(case["method"].as_str().unwrap(), case["args"].clone())
            .await;
        if let Some(error) = case.get("error") {
            let actual = result.expect_err(&format!("{} must fail", case["name"]));
            // Git supplies localized process messages; validation copy must be exact.
            if actual.kind != "GIT_PROCESS" {
                assert_eq!(actual.message, error.as_str().unwrap(), "{}", case["name"]);
            }
        } else {
            assert_eq!(
                result.unwrap_or_else(|error| panic!("{}: {error}", case["name"])),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }
    eprintln!(
        "{} production Node response comparisons passed",
        cases.len()
    );
    // status must not refresh the index; configured helpers must never run.
    reader
        .call("git:changes", json!({"cwd":fixture["helpers"]}))
        .await
        .unwrap();
    assert!(!std::path::Path::new(fixture["helperMarker"].as_str().unwrap()).exists());
    for (path, bytes) in indexes {
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "index changed: {}",
            path.display()
        );
    }
    for cwd in [json!("relative"), json!(42), Value::Null] {
        let error = reader
            .call("git:history", json!({"cwd":cwd}))
            .await
            .unwrap_err();
        assert_eq!(error.message, "The chat's folder must be an absolute path.");
    }
    for cwd in [fixture["outside"].clone(), json!(roots[0].join(".git"))] {
        let error = reader
            .call("git:diff-files", json!({"cwd":cwd}))
            .await
            .unwrap_err();
        assert_eq!(error.kind, "GIT_SCOPE");
        assert_eq!(
            error.message,
            "This folder isn't one of the open project's chats."
        );
    }
    for method in UNSUPPORTED_MUTATIONS
        .iter()
        .chain(["git:raw", "git:fetch", "git:checkout"].iter())
    {
        assert_eq!(
            reader
                .call(method, json!({"cwd":roots[0]}))
                .await
                .unwrap_err()
                .kind,
            "UNSUPPORTED_METHOD"
        );
    }
    assert!(GitReader::new(vec![PathBuf::from("relative")]).is_err());
}
