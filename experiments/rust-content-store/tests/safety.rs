use milagre_content_store::{chat_hash, ArtifactStore, Error, SystemRuntime};
use milagre_owner_store::{jsjson, Isolation, Policy};
use serde_json::json;
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicIsize, Ordering},
        Arc,
    },
};

fn open(isolation: &Isolation) -> ArtifactStore {
    ArtifactStore::open(
        isolation.clone(),
        Path::new("artifacts"),
        Arc::new(|chat| {
            if chat == "/fixture#7" {
                Ok(())
            } else {
                Err(Error::new("Unknown Chat"))
            }
        }),
        Arc::new(|| Ok(())),
        Arc::new(SystemRuntime),
    )
    .unwrap()
}
fn isolated() -> (tempfile::TempDir, Isolation) {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&temp.path().join("copy"), &Policy::system()).unwrap();
    (temp, isolation)
}
fn show(store: &mut ArtifactStore, html: &str) -> milagre_content_store::Result<serde_json::Value> {
    store.show(
        &json!({"chatId":"/fixture#7","id":"page","title":"Report","html":html}),
        &[],
    )
}
#[test]
fn isolation_and_descriptor_paths_refuse_traversal_and_symlinks() {
    let (temp, isolation) = isolated();
    for path in [
        Path::new("../escaped"),
        Path::new("/tmp/escaped"),
        Path::new(""),
    ] {
        assert!(ArtifactStore::open(
            isolation.clone(),
            path,
            Arc::new(|_| Ok(())),
            Arc::new(|| Ok(())),
            Arc::new(SystemRuntime)
        )
        .is_err());
    }
    assert!(!temp.path().join("escaped").exists());
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, isolation.root().join("redirect")).unwrap();
    assert!(ArtifactStore::open(
        isolation.clone(),
        Path::new("redirect"),
        Arc::new(|_| Ok(())),
        Arc::new(|| Ok(())),
        Arc::new(SystemRuntime)
    )
    .is_err());
    let mut store = open(&isolation);
    let chat = isolation
        .root()
        .join("artifacts")
        .join(chat_hash("/fixture#7"));
    std::os::unix::fs::symlink(&outside, &chat).unwrap();
    assert!(show(&mut store, "<p>Never outside</p>").is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_file(&chat).unwrap();
    show(&mut store, "<p>Saved</p>").unwrap();
    let secret = outside.join("secret");
    fs::write(&secret, "private").unwrap();
    let html = chat.join("page/v1.html");
    fs::remove_file(&html).unwrap();
    std::os::unix::fs::symlink(&secret, &html).unwrap();
    assert!(store
        .get(&json!({"chatId":"/fixture#7","id":"page"}))
        .is_err());
    assert_eq!(fs::read_to_string(&secret).unwrap(), "private");
    assert!(store
        .get(&json!({"chatId":"/fixture#7","id":"../secret"}))
        .is_err());
    assert!(store.list(&json!({"chatId":"/other#9"})).is_err());
}
#[test]
fn independent_rust_writers_cannot_share_an_isolated_store() {
    let (_temp, isolation) = isolated();
    let first = open(&isolation);
    let second = ArtifactStore::open(
        isolation.clone(),
        Path::new("artifacts"),
        Arc::new(|_| Ok(())),
        Arc::new(|| Ok(())),
        Arc::new(SystemRuntime),
    );
    assert_eq!(second.err().unwrap().code, "STORE_OWNED");
    drop(first);
    let mut next = open(&isolation);
    show(&mut next, "<p>After release</p>").unwrap();
}
#[test]
fn metadata_commit_rechecks_authority_and_rolls_back_uncommitted_versions() {
    let (_temp, isolation) = isolated();
    let remaining = Arc::new(AtomicIsize::new(0));
    let guard = remaining.clone();
    let mut store = ArtifactStore::open(
        isolation.clone(),
        Path::new("artifacts"),
        Arc::new(|_| Ok(())),
        Arc::new(move || {
            if guard.fetch_sub(1, Ordering::Relaxed) == 1 {
                Err(Error::coded("OWNERSHIP_LOST", "Owner stopped"))
            } else {
                Ok(())
            }
        }),
        Arc::new(SystemRuntime),
    )
    .unwrap();
    show(&mut store, "<p>Original</p>").unwrap();
    remaining.store(4, Ordering::Relaxed);
    assert_eq!(
        show(&mut store, "<p>Rejected</p>").unwrap_err().code,
        "OWNERSHIP_LOST"
    );
    let page = store
        .get(&json!({"chatId":"/fixture#7","id":"page"}))
        .unwrap();
    assert_eq!(page["version"], 1);
    assert_eq!(page["html"], "<p>Original</p>");
    let directory = isolation
        .root()
        .join("artifacts")
        .join(chat_hash("/fixture#7"))
        .join("page");
    assert!(!directory.join("v2.html").exists());
    assert!(!fs::read_dir(directory).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}
#[test]
fn assets_are_regular_bounded_copied_worktree_files_and_whole_references() {
    let (temp, isolation) = isolated();
    let mut store = open(&isolation);
    let worktree = isolation.root().join("worktree");
    fs::create_dir(&worktree).unwrap();
    let chart = worktree.join("chart.png");
    fs::write(&chart, "png").unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "private").unwrap();
    let link = worktree.join("link.txt");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    for path in [&outside, &link] {
        assert!(store.show(&json!({"chatId":"/fixture#7","title":"No","html":"<a href=assets/secret.txt>","assets":[{"name":"secret.txt","path":path}]}),std::slice::from_ref(&worktree)).is_err());
    }
    for html in [
        "xassets/chart.png",
        "path/assets/chart.png",
        "assets/chart.png-suffix",
    ] {
        assert!(store.show(&json!({"chatId":"/fixture#7","title":"No","html":html,"assets":[{"name":"chart.png","path":chart}]}),std::slice::from_ref(&worktree)).unwrap_err().message.contains("doesn't use"));
    }
    let large = worktree.join("large.mp4");
    fs::File::create(&large)
        .unwrap()
        .set_len(95 * 1024 * 1024 + 1)
        .unwrap();
    assert!(store.show(&json!({"chatId":"/fixture#7","title":"No","html":"assets/large.mp4","assets":[{"name":"large.mp4","path":large}]}),std::slice::from_ref(&worktree)).unwrap_err().message.contains("95 MB"));
    let fifo = worktree.join("pipe.txt");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(store.show(&json!({"chatId":"/fixture#7","title":"No","html":"assets/pipe.txt","assets":[{"name":"pipe.txt","path":fifo}]}),std::slice::from_ref(&worktree)).is_err());
    store.show(&json!({"chatId":"/fixture#7","id":"page","title":"Valid","html":"字<img src='./assets/chart.png'>","assets":[{"name":"chart.png","path":chart}]}),std::slice::from_ref(&worktree)).unwrap();
    assert_eq!(
        store
            .asset(&json!({"chatId":"/fixture#7","name":"chart.png"}))
            .unwrap()["base64"],
        "cG5n"
    );
    let page = store
        .get(&json!({"chatId":"/fixture#7","id":"page"}))
        .unwrap();
    let path = store
        .asset_path(&json!({"chatId":"/fixture#7","hash":page["assets"][0]["hash"]}))
        .unwrap();
    assert!(path.starts_with(isolation.root()));
    fs::write(&path, "p").unwrap();
    assert!(store
        .asset(&json!({"chatId":"/fixture#7","name":"chart.png"}))
        .is_err());
    assert_eq!(
        fs::read_dir(isolation.root().join("artifacts/.incoming"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "private");
}
#[test]
fn html_tabs_comments_and_utf16_limits_are_enforced_without_partial_updates() {
    let (_temp, isolation) = isolated();
    let mut store = open(&isolation);
    show(&mut store, "<p>Original</p>").unwrap();
    assert!(show(&mut store, &"😀".repeat(500_001)).is_err());
    let tabs = (0..21)
        .map(|index| json!({"id":format!("tab-{index}"),"title":"Tab","html":"x"}))
        .collect::<Vec<_>>();
    assert!(store
        .show(
            &json!({"chatId":"/fixture#7","title":"Too many","tabs":tabs}),
            &[]
        )
        .is_err());
    assert!(store
        .add_comments(&json!({"chatId":"/fixture#7","comments":vec![json!({});51]}))
        .is_err());
    let text = format!("a{}", "😀".repeat(2000));
    let comments=store.add_comments(&json!({"chatId":"/fixture#7","comments":[{"id":"00000001","design":{"id":"page","version":1},"text":text}]})).unwrap();
    assert_eq!(
        jsjson::utf16_len(comments[0]["text"].as_str().unwrap()),
        4000
    );
    assert!(jsjson::has_lone_surrogate(
        comments[0]["text"].as_str().unwrap()
    ));
    let saved = store.comments(&json!({"chatId":"/fixture#7"})).unwrap();
    assert_eq!(comments, saved);
    assert!(store.add_comments(&json!({"chatId":"/fixture#7","comments":[{"id":"00000002","design":{"id":"page","version":1},"text":"would be valid"},{"design":{"id":"missing","version":1},"text":"reject batch"}]})).is_err());
    assert_eq!(
        store
            .comments(&json!({"chatId":"/fixture#7"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .get(&json!({"chatId":"/fixture#7","id":"page"}))
            .unwrap()["version"],
        1
    );
}

#[test]
fn comments_keep_the_newest_two_thousand_and_store_files_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, isolation) = isolated();
    let mut store = open(&isolation);
    show(&mut store, "<p>Saved</p>").unwrap();
    let directory = isolation
        .root()
        .join("artifacts")
        .join(chat_hash("/fixture#7"));
    let older = (0..2000).map(|index| json!({
        "id":format!("{index:08x}"),"design":{"id":"page","version":1},"text":"Saved comment","createdAt":index
    })).collect::<Vec<_>>();
    fs::write(directory.join("comments"), jsjson::to_string(&json!(older))).unwrap();
    store
        .add_comments(&json!({"chatId":"/fixture#7","comments":[{
            "id":"fffffffe","design":{"id":"page","version":1},"text":"Newest"
        }]}))
        .unwrap();
    let comments = store.comments(&json!({"chatId":"/fixture#7"})).unwrap();
    assert_eq!(comments.as_array().unwrap().len(), 2000);
    assert_eq!(comments[0]["id"], "00000001");
    assert_eq!(comments[1999]["id"], "fffffffe");
    for file in ["comments", "page/meta.json", "page/v1.html"] {
        assert_eq!(
            fs::metadata(directory.join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        fs::metadata(directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn stored_fault_codes_remain_distinct_from_missing_assets_and_bad_requests() {
    let (temp, isolation) = isolated();
    let worktree = isolation.root().join("worktree");
    fs::create_dir(&worktree).unwrap();
    let source = worktree.join("photo.png");
    fs::write(&source, b"fixture image bytes").unwrap();
    let mut store = open(&isolation);
    store.show(&json!({"chatId":"/fixture#7","id":"page","title":"Photo","html":"<img src=\"assets/photo.png\">","assets":[{"name":"photo.png","path":source}]}),&[worktree]).unwrap();
    let request = json!({"chatId":"/fixture#7","name":"photo.png"});
    let asset = store.asset(&request).unwrap();
    let path = store
        .asset_path(&json!({"chatId":"/fixture#7","hash":asset["hash"]}))
        .unwrap();
    assert_eq!(
        store
            .asset(&json!({"chatId":"/fixture#7","name":"missing.png"}))
            .unwrap_err()
            .code,
        "CONTENT_ERROR"
    );
    assert_eq!(
        store
            .asset(&json!({"chatId":"/fixture#7","name":"photo.png","offset":-1}))
            .unwrap_err()
            .code,
        "CONTENT_ERROR"
    );
    fs::write(&path, b"").unwrap();
    assert_eq!(store.asset(&request).unwrap_err().code, "IO_ERROR");
    fs::remove_file(&path).unwrap();
    assert_eq!(store.asset(&request).unwrap_err().code, "CONTENT_ERROR");
    fs::create_dir(&path).unwrap();
    assert_eq!(store.asset(&request).unwrap_err().code, "UNSAFE_FILE");
    fs::remove_dir(&path).unwrap();
    let outside = temp.path().join("outside");
    fs::write(&outside, b"private fixture").unwrap();
    fs::hard_link(&outside, &path).unwrap();
    assert_eq!(store.asset(&request).unwrap_err().code, "UNSAFE_FILE");
    assert_eq!(fs::read(&outside).unwrap(), b"private fixture");
    let metadata = isolation
        .root()
        .join("artifacts")
        .join(chat_hash("/fixture#7"))
        .join("page/meta.json");
    fs::write(metadata, b"broken json").unwrap();
    assert_eq!(
        store
            .list(&json!({"chatId":"/fixture#7"}))
            .unwrap_err()
            .code,
        "INVALID_CONTENT_STORAGE"
    );
}
