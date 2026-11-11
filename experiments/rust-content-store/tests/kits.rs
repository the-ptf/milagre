use milagre_content_store::{design::DesignKits, Error};
use milagre_owner_store::{jsjson, Isolation, Policy};
use serde_json::json;
use std::{
    fs,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
#[test]
fn project_scoped_immutable_kits_match_node_store() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temp.path().join("copy"), &Policy::system()).unwrap();
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/kits.cjs"))
        .arg(isolation.root())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixture = jsjson::parse_bytes(&output.stdout).unwrap();
    let project = Arc::new(|chat: &str| match chat {
        "/one#1" | "/one#2" => Ok("/project/one".into()),
        "/two#1" => Ok("/project/two".into()),
        _ => Err(Error::new("Unknown Chat")),
    });
    let mut kits = DesignKits::open(
        isolation.clone(),
        Path::new("rust-kits"),
        project,
        Arc::new(|| Ok(())),
    )
    .unwrap();
    for (index, action) in fixture["actions"].as_array().unwrap().iter().enumerate() {
        let result = if action[0] == "read" {
            kits.read(&action[1])
        } else {
            kits.save(&action[1])
        };
        let actual = match result {
            Ok(value) => json!({"result":jsjson::parse(&jsjson::to_string(&value)).unwrap()}),
            Err(error) => json!({"error":error.message}),
        };
        assert_eq!(actual, fixture["outputs"][index], "Kit mismatch at {index}");
    }
    let mut files = serde_json::Map::new();
    for project in fs::read_dir(isolation.root().join("rust-kits"))
        .unwrap()
        .map(|item| item.unwrap())
    {
        if !project.file_type().unwrap().is_dir() {
            continue;
        }
        for file in fs::read_dir(project.path())
            .unwrap()
            .map(|item| item.unwrap())
        {
            files.insert(
                format!(
                    "{}/{}",
                    project.file_name().to_string_lossy(),
                    file.file_name().to_string_lossy()
                ),
                jsjson::parse_bytes(&fs::read(file.path()).unwrap()).unwrap(),
            );
        }
    }
    assert_eq!(json!(files), fixture["files"]);
}
#[cfg(unix)]
#[test]
fn kit_snapshot_commit_checks_owner_and_refuses_symlink_storage() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temp.path().join("copy"), &Policy::system()).unwrap();
    let active = Arc::new(AtomicBool::new(true));
    let mut kits = DesignKits::open(
        isolation.clone(),
        Path::new("kits"),
        Arc::new(|_| Ok("/project".into())),
        {
            let active = active.clone();
            Arc::new(move || {
                if active.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(Error::coded("OWNER_LOST", "Lost owner"))
                }
            })
        },
    )
    .unwrap();
    let request = json!({"chatId":"/project#1","expectedVersion":0,"kit":{"title":"Kit","colors":{},"textStyles":{},"spacing":{},"radii":{}}});
    kits.save(&request).unwrap();
    active.store(false, Ordering::SeqCst);
    let mut next = request.clone();
    next["expectedVersion"] = json!(1);
    assert_eq!(kits.save(&next).unwrap_err().code, "OWNER_LOST");
    let file = isolation
        .root()
        .join("kits")
        .join(hex::encode(Sha256::digest(b"/project")))
        .join("project.json");
    let before = fs::read(&file).unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, &before).unwrap();
    fs::remove_file(&file).unwrap();
    symlink(&outside, &file).unwrap();
    assert!(kits.read(&json!({"chatId":"/project#1"})).is_err());
    assert_eq!(fs::read(outside).unwrap(), before);
    let bad = DesignKits::open(
        isolation,
        Path::new("../outside-kits"),
        Arc::new(|_| Ok("/project".into())),
        Arc::new(|| Ok(())),
    );
    assert!(bad.is_err());
}

#[test]
fn native_kit_reader_and_renderer_commit_a_real_design_revision() {
    use milagre_content_store::{design::render_html, ArtifactStore, SystemRuntime};
    use std::cell::RefCell;
    let temporary = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temporary.path().join("copy"), &Policy::system()).unwrap();
    let mut kits = DesignKits::open(
        isolation.clone(),
        Path::new("kits"),
        Arc::new(|_| Ok("/project".into())),
        Arc::new(|| Ok(())),
    )
    .unwrap();
    let kit=kits.save(&json!({"chatId":"/project#1","expectedVersion":0,"kit":{"title":"Project kit","colors":{"paper":"white","ink":"#202720"},"textStyles":{"body":{"fontSize":16,"fontFamily":"Inter"}},"spacing":{"base":8},"radii":{"control":6}}})).unwrap();
    let kits = RefCell::new(kits);
    let read_kit = |request: &serde_json::Value| kits.borrow_mut().read(request);
    let mut store = ArtifactStore::open(
        isolation,
        Path::new("artifacts"),
        Arc::new(|_| Ok(())),
        Arc::new(|| Ok(())),
        Arc::new(SystemRuntime),
    )
    .unwrap();
    let prepared=store.prepare_design_show(&json!({"chatId":"/project#1","id":"welcome","title":"Welcome","document":{"schemaVersion":1,"width":390,"height":844,"background":"$paper","kit":kit,"consistency":{"mode":"strict"},"nodes":[{"id":"heading","type":"text","width":300,"height":40,"text":"Saved by Rust","textStyle":"body","fill":"$ink"}]}}),&read_kit).unwrap();
    let saved = store
        .commit_design(prepared, &read_kit, &render_html)
        .unwrap();
    assert_eq!(saved["version"], 1);
    let read = store
        .get(&json!({"chatId":"/project#1","id":"welcome"}))
        .unwrap();
    let html = read["html"].as_str().unwrap();
    assert!(html.contains("Saved by Rust"));
    assert!(html.contains("data:font/ttf;base64,"));
    assert_eq!(read["document"]["nodes"][0]["fontSize"], 16);
    assert_eq!(read["document"]["kit"]["version"].as_f64(), Some(1.0));
}
