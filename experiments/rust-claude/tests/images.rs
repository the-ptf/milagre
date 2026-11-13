mod common;
use base64::{engine::general_purpose::STANDARD, Engine};
use milagre_claude::{ClaudeMapper, FileImageStore, ToolImageStore};
use serde_json::{json, Value};
use std::sync::Arc;
fn normalize(value: &mut Value, root: &std::path::Path) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if key == "file" {
                    if let Some(path) = v.as_str().map(std::path::Path::new).filter(|p| p.starts_with(root)) {
                        *v = path.file_name().unwrap().to_string_lossy().into_owned().into();
                    }
                } else {
                    normalize(v, root);
                }
            }
        }
        Value::Array(items) => {
            for v in items {
                normalize(v, root)
            }
        }
        _ => {}
    }
}
#[test]
fn read_image_events_and_saved_bytes_match_node() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/conformance/claude-images.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let root = common::scratch("images");
        let dir = root.join("images");
        if case["unwritable"] == true {
            std::fs::write(&dir, "not a directory").unwrap();
        }
        let mut mapper = ClaudeMapper::default();
        mapper.turn_id = Some("turn-1".into());
        mapper.set_image_store(Arc::new(FileImageStore::new(&dir)));
        for step in case["steps"].as_array().unwrap() {
            let mut events = Value::Array(mapper.map(&step["message"]));
            normalize(&mut events, &dir);
            assert_eq!(events, step["events"], "{}", case["name"]);
            let mut files = serde_json::Map::new();
            if dir.is_dir() {
                for entry in std::fs::read_dir(&dir).unwrap() {
                    let entry = entry.unwrap();
                    let bytes = std::fs::read(entry.path()).unwrap();
                    files.insert(
                        entry.file_name().to_string_lossy().into_owned(),
                        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>().into(),
                    );
                }
            }
            assert_eq!(Value::Object(files), step["files"], "{}", case["name"]);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn image_store_deduplicates_atomically_and_rejects_corrupt_existing_files() {
    let root = common::scratch("images-atomic");
    let store = Arc::new(FileImageStore::new(root.join("private")));
    let encoded = STANDARD.encode(b"GIF87a");
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let store = store.clone();
            let encoded = encoded.clone();
            std::thread::spawn(move || store.save("image/gif", &encoded).unwrap())
        })
        .collect();
    let paths: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(paths.iter().all(|p| p == &paths[0]));
    assert_eq!(std::fs::read_dir(store.directory()).unwrap().count(), 1);
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"GIF87a");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&paths[0]).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(store.directory()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    std::fs::write(&paths[0], "corrupt").unwrap();
    assert!(store.save("image/gif", &encoded).is_err());
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"corrupt");
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn image_store_does_not_follow_destination_or_directory_symlinks() {
    use std::os::unix::fs::symlink;
    let root = common::scratch("image-links");
    let store = FileImageStore::new(root.join("private"));
    let encoded = STANDARD.encode(b"GIF89a");
    let path = store.save("image/gif", &encoded).unwrap();
    std::fs::remove_file(&path).unwrap();
    let target = root.join("target");
    std::fs::write(&target, "untouched").unwrap();
    symlink(&target, &path).unwrap();
    assert!(store.save("image/gif", &encoded).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
    let link = root.join("linked-dir");
    symlink(store.directory(), &link).unwrap();
    assert!(FileImageStore::new(link).save("image/gif", &encoded).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn no_configured_store_never_writes_and_size_limit_fails_before_io() {
    let root = common::scratch("image-limit");
    let store = FileImageStore::new(root.join("not-created"));
    assert!(store.save("image/png", &"A".repeat(milagre_claude::images::MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1)).is_err());
    assert!(!store.directory().exists());
    let mut mapper = ClaudeMapper::default();
    mapper.map(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"r","name":"Read","input":{}}]}}));
    let events=mapper.map(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"r","content":[{"type":"image","source":{"type":"base64","media_type":"image/gif","data":"R0lGODlh"}}]}]}}));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "step-completed");
    std::fs::remove_dir_all(root).unwrap();
}
