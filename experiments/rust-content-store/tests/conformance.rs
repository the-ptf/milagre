use milagre_content_store::{ArtifactStore, Error, Result, Runtime};
use milagre_owner_store::{jsjson, Isolation, Policy};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

struct Clock(AtomicU64);
impl Runtime for Clock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
    fn uuid(&self) -> String {
        milagre_owner_store::ownership::random_uuid()
    }
}
fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().map(|entry| entry.unwrap()) {
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}
fn normalize(value: Value, inline: &str) -> Value {
    jsjson::parse(&jsjson::to_string(&value).replace(inline, "$INLINE")).unwrap()
}
fn tree(root: &Path, inline: &str) -> Value {
    fn visit(
        directory: &Path,
        prefix: &str,
        inline: &str,
        out: &mut serde_json::Map<String, Value>,
    ) {
        for entry in fs::read_dir(directory).unwrap().map(|entry| entry.unwrap()) {
            let part = entry.file_name().to_str().unwrap().to_owned();
            if part == ".rust-content.lock" {
                continue;
            }
            let name = format!("{prefix}{part}");
            if entry.file_type().unwrap().is_dir() {
                visit(&entry.path(), &format!("{name}/"), inline, out);
            } else {
                let bytes = fs::read(entry.path()).unwrap();
                let value = if part.ends_with(".json") || part == "comments" {
                    json!({"json":jsjson::parse_bytes(&bytes).unwrap()})
                } else {
                    json!({"sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len()})
                };
                out.insert(name.replace(inline, "$INLINE"), normalize(value, inline));
            }
        }
    }
    let mut output = serde_json::Map::new();
    visit(root, "", inline, &mut output);
    Value::Object(output)
}
fn call(store: &mut ArtifactStore, method: &str, args: &Value, root: &Path) -> Result<Value> {
    match method {
        "list" => store.list(args),
        "get" => store.get(args),
        "artifactRead" => store.artifact_read(args),
        "show" => store.show(args, &[root.join("worktree")]),
        "asset" => store.asset(args),
        "render" => store.render(args),
        "comments" => store.comments(args),
        "addComments" => store.add_comments(args),
        "resolveComment" => store.resolve_comment(args),
        _ => Err(Error::new("Unknown fixture method")),
    }
}

#[test]
fn node_generated_saved_files_and_operations_match_rust() {
    let temporary = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temporary.path().join("copy"), &Policy::system()).unwrap();
    let generator = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/generate.cjs");
    let generated = Command::new("node")
        .arg(generator)
        .arg(isolation.root())
        .output()
        .unwrap();
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let expected =
        jsjson::parse_bytes(&fs::read(isolation.root().join("node-expected.json")).unwrap())
            .unwrap();
    copy(
        &isolation.root().join("seed"),
        &isolation.root().join("rust-store"),
    );
    let clock = Arc::new(Clock(AtomicU64::new(1000)));
    let mut store = ArtifactStore::open(
        isolation.clone(),
        Path::new("rust-store"),
        Arc::new(|id| {
            if id == "/fixture#7" {
                Ok(())
            } else {
                Err(Error::new("Unknown fixture Chat."))
            }
        }),
        Arc::new(|| Ok(())),
        clock.clone(),
    )
    .unwrap();
    let mut inline = String::from("$UNCREATED_INLINE");
    for (index, action) in expected["actions"].as_array().unwrap().iter().enumerate() {
        clock.0.store(1000 + index as u64 * 100, Ordering::Relaxed);
        let method = action[0].as_str().unwrap();
        let mut args =
            jsjson::parse(&jsjson::to_string(&action[1]).replace("$INLINE", &inline)).unwrap();
        args["chatId"] = expected["chat"].clone();
        let result = match call(&mut store, method, &args, isolation.root()) {
            Ok(value) => {
                if method == "render" {
                    inline = value["id"].as_str().unwrap().to_owned();
                }
                json!({"result":normalize(value,&inline)})
            }
            Err(error) => {
                let mut value = json!({"error":error.message});
                if error.code != "CONTENT_ERROR" {
                    value["code"] = json!(error.code);
                }
                value
            }
        };
        assert_eq!(
            result,
            expected["outputs"][index],
            "Node mismatch at action {index}: {method}, args {}",
            jsjson::to_string(&args)
        );
    }
    assert_eq!(
        tree(&isolation.root().join("rust-store"), &inline),
        expected["disk"],
        "Saved metadata, version files, assets and comments differ from Node"
    );
    drop(store);
    let mut reopened = ArtifactStore::open(
        isolation,
        Path::new("rust-store"),
        Arc::new(|_| Ok(())),
        Arc::new(|| Ok(())),
        clock,
    )
    .unwrap();
    assert_eq!(
        reopened
            .list(&json!({"chatId":"/fixture#7","format":"html"}))
            .unwrap()[0]["id"],
        "split"
    );
    assert_eq!(
        reopened
            .comments(&json!({"chatId":"/fixture#7"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
