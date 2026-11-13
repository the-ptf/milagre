use milagre_content_store::{
    design::{apply_operations, validate_consistency, validate_document},
    ArtifactStore, Error, Result, Runtime,
};
use milagre_owner_store::{jsjson, Isolation, Policy};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/design.mjs")
}
fn oracle(mode: &str, root: Option<&Path>) -> Value {
    let mut command = Command::new("node");
    command.arg(script()).arg(mode);
    if let Some(root) = root {
        command.arg(root);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    jsjson::parse_bytes(&output.stdout).unwrap()
}
fn normalize(value: &Value) -> Value {
    jsjson::parse(&jsjson::to_string(value)).unwrap()
}
#[test]
fn production_design_schema_components_tokens_and_edits_match() {
    let oracle = oracle("fixtures", None);
    let snapshot: Value =
        serde_json::from_str(include_str!("../src/design/contract.json")).unwrap();
    assert_eq!(oracle["contract"],snapshot,"Production Design schema/source changed. Review the port and regenerate its contract before accepting new mutations.");
    for case in oracle["cases"].as_array().unwrap() {
        let input = case["document"].clone();
        let result = match case.get("operations") {
            Some(operations) => apply_operations(&input, operations, case.get("intent")),
            None => validate_document(&input),
        }
        .and_then(|document| {
            if case["consistency"] == true {
                validate_consistency(&document)?;
            }
            Ok(document)
        });
        assert_eq!(
            input, case["document"],
            "The operation mutated the caller's source"
        );
        match result {
            Ok(value) => {
                assert!(
                    case.get("error").is_none(),
                    "{} accepted Node error: {}",
                    case["name"],
                    case["error"]
                );
                assert_eq!(normalize(&value), case["result"], "{}", case["name"]);
            }
            Err(error) => {
                assert!(
                    case.get("error").is_some(),
                    "{} Rust rejected: {}",
                    case["name"],
                    error
                );
                if case["structural"] != true {
                    assert_eq!(
                        error.message,
                        case["error"].as_str().unwrap(),
                        "{}",
                        case["name"]
                    );
                    if let Some(issues) = case.get("issues") {
                        assert_eq!(
                            error.issues.as_deref(),
                            Some(issues),
                            "{} issue paths",
                            case["name"]
                        );
                    }
                }
                if let Some(diagnostics) = case.get("diagnostics") {
                    assert_eq!(
                        error.diagnostics.as_deref().map(normalize),
                        Some(normalize(diagnostics)),
                        "{} diagnostics",
                        case["name"]
                    );
                }
                if let Some(code) = case.get("code") {
                    assert_eq!(&error.code, code.as_str().unwrap(), "{}", case["name"]);
                }
            }
        }
    }
}
struct Clock(AtomicU64);
impl Runtime for Clock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn uuid(&self) -> String {
        milagre_owner_store::ownership::random_uuid()
    }
}
fn store(isolation: Isolation, clock: Arc<Clock>) -> ArtifactStore {
    ArtifactStore::open(
        isolation,
        Path::new("rust-design-store"),
        Arc::new(|chat| {
            if chat == "/fixture#7" {
                Ok(())
            } else {
                Err(Error::new("Unknown fixture Chat."))
            }
        }),
        Arc::new(|| Ok(())),
        clock,
    )
    .unwrap()
}
fn render(document: &Value) -> Result<String> {
    let mut child = Command::new("node")
        .arg(script())
        .arg("render")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(Error::from)?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(jsjson::to_string(document).as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(Error::new(String::from_utf8_lossy(&output.stderr)));
    }
    String::from_utf8(output.stdout).map_err(|error| Error::new(error.to_string()))
}
fn tree(directory: &Path) -> Value {
    fn visit(directory: &Path, prefix: &str, values: &mut serde_json::Map<String, Value>) {
        for entry in fs::read_dir(directory).unwrap().map(|entry| entry.unwrap()) {
            let part = entry.file_name().to_string_lossy().into_owned();
            if part == ".rust-content.lock" {
                continue;
            }
            let name = format!("{prefix}{part}");
            if entry.file_type().unwrap().is_dir() {
                visit(&entry.path(), &format!("{name}/"), values);
            } else {
                let bytes = fs::read(entry.path()).unwrap();
                values.insert(
                    name,
                    if part.ends_with(".json") {
                        json!({"json":jsjson::parse_bytes(&bytes).unwrap()})
                    } else {
                        json!({"sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len()})
                    },
                );
            }
        }
    }
    let mut values = serde_json::Map::new();
    visit(directory, "", &mut values);
    json!(values)
}
#[test]
fn node_saved_revisions_variants_and_real_rendered_previews_match() {
    let temporary = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temporary.path().join("copy"), &Policy::system()).unwrap();
    let expected = oracle("store", Some(isolation.root()));
    let clock = Arc::new(Clock(AtomicU64::new(1000)));
    let mut store = store(isolation.clone(), clock.clone());
    let kit = expected["kit"].clone();
    let reader = |_: &Value| Ok(kit.clone());
    // Cache only identical documents; every cached preview was rendered by the
    // production renderer from that document. No screenshot/mock substitution.
    let cache = std::cell::RefCell::new(BTreeMap::<String, String>::new());
    let renderer = |document: &Value| {
        let key = jsjson::to_string(document);
        if let Some(html) = cache.borrow().get(&key) {
            return Ok(html.clone());
        }
        let html = render(document)?;
        cache.borrow_mut().insert(key, html.clone());
        Ok(html)
    };
    for (index, action) in expected["actions"].as_array().unwrap().iter().enumerate() {
        let mut request = action[1].clone();
        request["chatId"] = expected["chat"].clone();
        clock.0.store(
            request["time"]
                .as_u64()
                .unwrap_or(1000 + index as u64 * 100),
            Ordering::SeqCst,
        );
        let result = match action[0].as_str().unwrap() {
            "showDesign" => store
                .prepare_design_show(&request, &reader)
                .and_then(|prepared| store.commit_design(prepared, &reader, &renderer)),
            "apply" => store
                .prepare_design_apply(&request, &reader)
                .and_then(|prepared| store.commit_design(prepared, &reader, &renderer)),
            "get" => store.get(&request),
            "exportDesign" => store.export_design(&request),
            "list" => store.list(&request),
            _ => unreachable!(),
        };
        let actual = match result {
            Ok(value) => json!({"result":normalize(&value)}),
            Err(error) => {
                let mut value = json!({"error":error.message});
                if error.code != "CONTENT_ERROR" {
                    value["code"] = json!(error.code);
                }
                value
            }
        };
        assert_eq!(
            actual, expected["outputs"][index],
            "Node store mismatch at action {index}: {}",
            action[0]
        );
    }
    assert_eq!(
        tree(&isolation.root().join("rust-design-store")),
        expected["files"],
        "Saved source/HTML pair differs from actual Node output"
    );
    assert!(store
        .get(&json!({"chatId":"/fixture#7","id":"history","version":2}))
        .is_err());
    let archive = store
        .get(&json!({"chatId":"/fixture#7","id":"history","version":3}))
        .unwrap();
    assert_eq!(
        validate_document(&archive["document"]).unwrap(),
        archive["document"]
    );
    drop(store);
    let mut reopened = store_after(isolation, clock);
    assert_eq!(
        reopened
            .get(&json!({"chatId":"/fixture#7","id":"history","version":3}))
            .unwrap(),
        archive
    );
}
fn store_after(isolation: Isolation, clock: Arc<Clock>) -> ArtifactStore {
    store(isolation, clock)
}
#[test]
fn unsafe_future_or_layout_operations_fail_without_fabricated_success() {
    assert!(validate_document(
        &json!({"schemaVersion":1.0,"width":390.0,"height":844.0,"nodes":[]})
    )
    .is_ok());
    assert!(validate_consistency(&json!({"consistency":{"mode":"strict"}})).is_err());
    let input = json!({"schemaVersion":1,"width":390,"height":844,"nodes":[]});
    let error = apply_operations(
        &input,
        &json!([{"op":"document","patch":{"width":400}}]),
        Some(&json!({"mode":"text-only","textIds":["title"]})),
    )
    .unwrap_err();
    assert_eq!(error.code, "DESIGN_INTENT_VIOLATION");
    for field in ["constructor", "__proto__", "futureLayout"] {
        let mut future = input.clone();
        future[field] = json!({"unsafe":true});
        assert!(validate_document(&future).is_err());
    }
    let too_many = json!({"schemaVersion":1,"width":390,"height":844,"tokens":(0..201).map(|index|(format!("c{index}"),json!("red"))).collect::<serde_json::Map<_,_>>(),"nodes":[]});
    assert!(validate_document(&too_many).is_err());
    let nodes = (0..33)
        .map(|index| {
            let mut node = json!({"id":format!("n{index}"),"type":"frame","width":10,"height":10});
            if index > 0 {
                node["parentId"] = json!(format!("n{}", index - 1));
            }
            node
        })
        .collect::<Vec<_>>();
    assert!(
        validate_document(&json!({"schemaVersion":1,"width":390,"height":844,"nodes":nodes}))
            .unwrap_err()
            .message
            .contains("32 levels")
    );
}

#[test]
fn prepared_revision_rechecks_version_kit_and_active_owner_before_commit() {
    let temporary = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temporary.path().join("copy"), &Policy::system()).unwrap();
    let clock = Arc::new(Clock(AtomicU64::new(1000)));
    let mut store = store(isolation.clone(), clock);
    let reader = |_: &Value| Err(Error::new("Unexpected kit read"));
    let source = json!({"schemaVersion":1,"width":390,"height":844,"nodes":[]});
    let request = json!({"chatId":"/fixture#7","id":"screen","title":"Screen","document":source});
    let first = store.prepare_design_show(&request, &reader).unwrap();
    let obsolete = store.prepare_design_show(&request, &reader).unwrap();
    let preview = render(first.document()).unwrap();
    let renderer = |_: &Value| Ok(preview.clone());
    store.commit_design(first, &reader, &renderer).unwrap();
    let called = std::cell::Cell::new(false);
    let never = |_: &Value| {
        called.set(true);
        Err(Error::new("Must not render stale revision"))
    };
    assert_eq!(
        store
            .commit_design(obsolete, &reader, &never)
            .unwrap_err()
            .code,
        "DESIGN_VERSION_CONFLICT"
    );
    assert!(!called.get());
    let before = tree(&isolation.root().join("rust-design-store"));
    let rejected_intent = store.prepare_design_apply(&json!({"chatId":"/fixture#7","id":"screen","expectedVersion":1,"intent":{"mode":"text-only","textIds":["missing"]},"operations":[{"op":"document","patch":{"width":390}}]}), &reader);
    assert_eq!(
        rejected_intent.err().unwrap().code,
        "DESIGN_INTENT_VIOLATION"
    );
    assert_eq!(tree(&isolation.root().join("rust-design-store")), before);
    let replacement = json!({"expectedVersion":1,"chatId":"/fixture#7","id":"screen","title":"Replacement","document":source});
    let prepared = store.prepare_design_show(&replacement, &reader).unwrap();
    let failed = |_: &Value| {
        Err(Error::coded(
            "RENDER_UNAVAILABLE",
            "Design rendering is unavailable.",
        ))
    };
    assert_eq!(
        store
            .commit_design(prepared, &reader, &failed)
            .unwrap_err()
            .code,
        "RENDER_UNAVAILABLE"
    );
    assert_eq!(tree(&isolation.root().join("rust-design-store")), before);
    let kit = json!({"id":"brand","version":1,"title":"Brand","colors":{},"textStyles":{},"spacing":{},"radii":{}});
    let mut pinned = replacement.clone();
    pinned["document"]["kit"] = kit.clone();
    let prepared = store
        .prepare_design_show(&pinned, &|_| Ok(kit.clone()))
        .unwrap();
    let moved = |_: &Value| Ok(json!({"different":"snapshot"}));
    assert!(store
        .commit_design(prepared, &moved, &never)
        .unwrap_err()
        .message
        .contains("pinned kit differs"));
    assert!(!called.get());
    assert_eq!(tree(&isolation.root().join("rust-design-store")), before);
    drop(store);
    let checks = Arc::new(AtomicU64::new(0));
    let reject_at = Arc::new(AtomicU64::new(u64::MAX));
    let mut store = ArtifactStore::open(
        isolation.clone(),
        Path::new("rust-design-store"),
        Arc::new(|_| Ok(())),
        {
            let checks = checks.clone();
            let reject_at = reject_at.clone();
            Arc::new(move || {
                let check = checks.fetch_add(1, Ordering::SeqCst) + 1;
                if check == reject_at.load(Ordering::SeqCst) {
                    Err(Error::coded("OWNER_LOST", "Fixture lost ownership"))
                } else {
                    Ok(())
                }
            })
        },
        Arc::new(Clock(AtomicU64::new(2000))),
    )
    .unwrap();
    let prepared = store.prepare_design_show(&replacement, &reader).unwrap();
    checks.store(0, Ordering::SeqCst);
    reject_at.store(5, Ordering::SeqCst);
    assert_eq!(
        store
            .commit_design(prepared, &reader, &renderer)
            .unwrap_err()
            .code,
        "OWNER_LOST"
    );
    assert_eq!(checks.load(Ordering::SeqCst),5,"Failure must be immediately before the metadata rename, after both source and HTML files were written");
    assert_eq!(tree(&isolation.root().join("rust-design-store")),before,"Ownership loss must remove the uncommitted source/preview pair and preserve the saved revision");
}

#[cfg(unix)]
#[test]
fn archived_future_documents_remain_readable_and_design_paths_do_not_follow_symlinks() {
    use std::os::unix::fs::symlink;
    let temporary = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temporary.path().join("copy"), &Policy::system()).unwrap();
    let mut store = store(isolation.clone(), Arc::new(Clock(AtomicU64::new(1000))));
    let reader = |_: &Value| Err(Error::new("Unexpected kit"));
    let source = json!({"schemaVersion":1,"width":390,"height":844,"nodes":[]});
    let request = json!({"chatId":"/fixture#7","id":"archive","title":"Archive","document":source});
    let prepared = store.prepare_design_show(&request, &reader).unwrap();
    store.commit_design(prepared, &reader, &render).unwrap();
    let chat_hash = hex::encode(Sha256::digest(b"/fixture#7"));
    let folder = isolation
        .root()
        .join("rust-design-store")
        .join(&chat_hash[..32])
        .join("archive");
    let mut future = source.clone();
    future["futureModel"] = json!({"retained":[1,2,3]});
    fs::write(folder.join("v1.design.json"), jsjson::to_string(&future)).unwrap();
    let archived = store
        .get(&json!({"chatId":"/fixture#7","id":"archive"}))
        .unwrap();
    assert_eq!(
        archived["document"], future,
        "Reads preserve saved unknown fields for recovery"
    );
    assert!(store.prepare_design_apply(&json!({"chatId":"/fixture#7","id":"archive","expectedVersion":1,"operations":[{"op":"document","patch":{"width":400}}]}),&reader).is_err());
    let outside = temporary.path().join("outside.json");
    fs::write(&outside, b"{\"outside\":true}").unwrap();
    fs::remove_file(folder.join("v1.design.json")).unwrap();
    symlink(&outside, folder.join("v1.design.json")).unwrap();
    assert!(store
        .get(&json!({"chatId":"/fixture#7","id":"archive"}))
        .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"{\"outside\":true}");
}
