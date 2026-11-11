mod common;
use common::*;
use milagre_providers::codex::session::{chat_thread, prompt_input, turn};
use milagre_providers::codex::{codex_policy, CodexPolicy, CodexSession, ConnectOptions, PermissionMode, SessionEvent, SessionOptions};
use milagre_providers::images::{FileImageStore, ImageAttachment, ImageStore, PreparedImages, ToolImageStore, MAX_TURN_IMAGES};
use milagre_providers::queue::EventReceiver;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

const PNG: &str = "iVBORw0KGgo=";
fn attachment() -> ImageAttachment {
    ImageAttachment::from_base64("image/png", PNG).unwrap()
}
fn policy() -> CodexPolicy {
    codex_policy(PermissionMode::Ask, "/repo", &[], false, false)
}
fn input(parent: &Path) -> (milagre_providers::codex::TurnSettings, PathBuf) {
    let images = PreparedImages::create("before [Image #1] after", &[attachment()], parent).unwrap();
    let path = PathBuf::from(&images.paths()[0]);
    (turn(vec![], None, policy()).with_images(images), path)
}
async fn start(scenario: &str, store: Option<ImageStore>) -> (CodexSession, EventReceiver<SessionEvent>) {
    let mut options = SessionOptions::new(ConnectOptions::new(fake(scenario), "test"), "/repo");
    options.image_store = store;
    options.image_save_timeout = Duration::from_millis(60);
    options.interrupt_grace = Duration::from_millis(100);
    CodexSession::start(options, chat_thread(None, policy())).await.unwrap()
}
async fn notify(session: &CodexSession, method: &str, params: Value) {
    session.client().rpc().request("fake/notify", json!({"method":method,"params":params})).await.unwrap();
}
async fn complete(session: &CodexSession) {
    notify(session, "turn/completed", json!({"threadId":"thread-1","turn":{"id":session.turn_id(),"status":"completed"}})).await;
}
async fn until_end(events: &mut EventReceiver<SessionEvent>) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut seen = vec![];
        while let Some(event) = events.recv().await {
            match event {
                SessionEvent::Agent(event) => seen.push(event),
                SessionEvent::TurnEnded { .. } => return seen,
                _ => {}
            }
        }
        panic!("events closed");
    })
    .await
    .unwrap()
}
fn tool(id: &str) -> Value {
    json!({"type":"mcpToolCall","id":id,"server":"images","tool":"get","status":"completed","result":{"content":[{"type":"text","text":"kept text"},{"type":"image","mimeType":"image/png","data":PNG},{"type":"image","mimeType":"image/png","data":"broken"}]}})
}
async fn item(session: &CodexSession, value: Value) {
    notify(session, "item/completed", json!({"threadId":"thread-1","turnId":session.turn_id(),"item":value})).await;
}

#[test]
fn private_store_hash_deduplicates_and_refuses_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let store = FileImageStore::new(temp.path().join("images"));
    let first = store.save("image/png", PNG).unwrap();
    assert_eq!(first, store.save("image/png", PNG).unwrap());
    assert_eq!(std::fs::read_dir(store.directory()).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&first).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(store.directory()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    std::fs::write(&first, "corrupt").unwrap();
    assert!(store.save("image/png", PNG).is_err());
    assert_eq!(std::fs::read(&first).unwrap(), b"corrupt");
    assert_eq!(std::fs::read_dir(store.directory()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn storage_refuses_symlinks_and_public_existing_files() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let store = FileImageStore::new(temp.path().join("store"));
    let file = store.save("image/png", PNG).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.save("image/png", PNG).is_err());
    std::fs::remove_file(&file).unwrap();
    let target = temp.path().join("target");
    std::fs::write(&target, "untouched").unwrap();
    symlink(&target, &file).unwrap();
    assert!(store.save("image/png", PNG).is_err());
    assert_eq!(std::fs::read_to_string(target).unwrap(), "untouched");
    let alias = temp.path().join("alias");
    symlink(store.directory(), &alias).unwrap();
    assert!(FileImageStore::new(alias).save("image/png", PNG).is_err());
}

#[test]
fn input_files_are_private_shared_and_bounded() {
    let temp = tempfile::tempdir().unwrap();
    let images = PreparedImages::create("[Image #1]", &[attachment()], temp.path()).unwrap();
    let path = PathBuf::from(&images.paths()[0]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let clone = images.clone();
    drop(images);
    assert!(path.exists());
    drop(clone);
    assert!(!path.exists());
    assert!(PreparedImages::create("", &vec![attachment(); MAX_TURN_IMAGES + 1], temp.path()).is_err());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    assert!(PreparedImages::create("", &[attachment()], &temp.path().join("missing")).is_err());
    assert!(!format!("{:?}", attachment()).contains(PNG));
    assert!(PreparedImages::create("", &[attachment()], Path::new("relative")).is_err());
}

#[tokio::test]
async fn inputs_live_through_steering_and_are_removed_at_completion() {
    let temp = tempfile::tempdir().unwrap();
    let (session, mut events) = start("slow", None).await;
    let (first, p1) = input(temp.path());
    session.send(first).await.unwrap();
    let (second, p2) = input(temp.path());
    assert!(session.send(second).await.unwrap().steered);
    assert!(p1.exists() && p2.exists());
    let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap();
    let frames = frames["received"].as_array().unwrap();
    for method in ["turn/start", "turn/steer"] {
        let frame = frames.iter().find(|f| f["method"] == method).unwrap();
        let input = &frame["params"]["input"];
        assert_eq!(input[0]["text"], "before ");
        assert_eq!(input[1]["type"], "localImage");
        assert_eq!(input[2]["text"], " after");
        assert!(Path::new(input[1]["path"].as_str().unwrap()).exists());
    }
    complete(&session).await;
    until_end(&mut events).await;
    assert!(!p1.exists() && !p2.exists());
    session.close().await;
}

#[tokio::test]
async fn inputs_clean_on_interrupt_crash_start_failure_close_and_drop() {
    for action in ["interrupt", "crash", "start-failure", "close", "drop"] {
        let temp = tempfile::tempdir().unwrap();
        let (session, mut events) = start(if action == "start-failure" { "hang-turn" } else { "slow" }, None).await;
        let (mut message, path) = input(temp.path());
        if action == "start-failure" {
            message.start_timeout = Some(Duration::from_millis(30));
        }
        let sent = session.send(message).await;
        if action == "start-failure" {
            assert!(sent.is_err());
        } else {
            sent.unwrap();
        }
        match action {
            "interrupt" => session.interrupt().await,
            "close" => {
                session.close().await;
            }
            "crash" => {
                let _ = session.client().rpc().request("fake/exit", json!({"code":7})).await;
            }
            "drop" => {
                drop(session);
                tokio::time::timeout(Duration::from_secs(3), async {
                    while path.exists() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .unwrap();
                continue;
            }
            _ => {}
        }
        until_end(&mut events).await;
        assert!(!path.exists(), "{action}");
        session.close().await;
    }
}

#[tokio::test]
async fn rejected_steer_keeps_input_for_next_turn() {
    let temp = tempfile::tempdir().unwrap();
    let (session, mut events) = start("steer-late", None).await;
    session.send(turn(prompt_input("first", &[]), None, policy())).await.unwrap();
    let (message, path) = input(temp.path());
    let sent = session.send(message).await.unwrap();
    assert!(!sent.steered);
    assert!(path.exists());
    until_end(&mut events).await;
    complete(&session).await;
    until_end(&mut events).await;
    assert!(!path.exists());
    session.close().await;
}

#[tokio::test]
async fn steering_cannot_exceed_input_budget() {
    let temp = tempfile::tempdir().unwrap();
    let (session, mut events) = start("slow", None).await;
    let images = PreparedImages::create("", &vec![attachment(); MAX_TURN_IMAGES], temp.path()).unwrap();
    session.send(turn(vec![], None, policy()).with_images(images)).await.unwrap();
    let (extra, path) = input(temp.path());
    assert!(matches!(session.send(extra).await, Err(milagre_providers::codex::SessionError::ImageBudget)));
    assert!(!path.exists());
    session.close().await;
    until_end(&mut events).await;
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn accepted_outputs_persist_without_base64_and_internal_or_stale_outputs_do_not() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("outputs");
    let store = Arc::new(CountingStore { inner: FileImageStore::new(&directory), calls: AtomicUsize::new(0) });
    let (session, mut events) = start("slow", Some(ImageStore(store.clone()))).await;
    session.send(turn(prompt_input("hi", &[]), None, policy())).await.unwrap();
    for (thread, turn_id) in [("foreign", "turn-1"), ("thread-1", "stale")] {
        notify(&session, "item/completed", json!({"threadId":thread,"turnId":turn_id,"item":tool("stale")})).await;
    }
    for name in ["design_show", "design_apply", "html_preview"] {
        let mut value = tool(name);
        value["server"] = json!("milagre");
        value["tool"] = json!(name);
        item(&session, value).await;
    }
    item(&session, tool("accepted")).await;
    item(&session, json!({"type":"imageGeneration","id":"generated","status":"completed","result":PNG})).await;
    item(&session, json!({"type":"imageGeneration","id":"failed","status":"failed","result":PNG})).await;
    item(&session, json!({"type":"imageGeneration","id":"saved","status":"completed","result":PNG,"savedPath":"/provider/kept.png"})).await;
    complete(&session).await;
    let seen = until_end(&mut events).await;
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    assert_eq!(store.calls.load(Ordering::SeqCst), 2);
    assert_eq!(seen.iter().filter(|e| e["step"]["kind"] == "image" && e["step"]["title"] == "Image from tool").count(), 1);
    assert!(seen.iter().any(|e| e["id"] == "accepted" && e["detail"].as_str().is_some_and(|s| s.contains("kept text"))));
    for id in ["accepted:image:1", "generated"] {
        let file = seen.iter().find(|e| e["type"] == "step-completed" && e["id"] == id).unwrap()["file"].as_str().unwrap();
        assert!(Path::new(file).exists());
    }
    assert!(seen.iter().any(|e| e["id"] == "saved" && e["file"] == "/provider/kept.png"));
    assert!(!json!(seen).to_string().contains(PNG));
    session.close().await;
}

struct FailingStore;
impl ToolImageStore for FailingStore {
    fn save(&self, _: &str, _: &str) -> Result<PathBuf, String> {
        Err("disk unavailable".into())
    }
}
#[tokio::test]
async fn absent_or_failed_store_preserves_text_and_terminal_events() {
    for store in [None, Some(ImageStore(Arc::new(FailingStore)))] {
        let (session, mut events) = start("slow", store).await;
        session.send(turn(prompt_input("hi", &[]), None, policy())).await.unwrap();
        item(&session, tool("tool")).await;
        complete(&session).await;
        let seen = until_end(&mut events).await;
        assert!(seen.iter().any(|e| e["id"] == "tool" && e["type"] == "step-completed"));
        assert!(!seen.iter().any(|e| e["id"] == "tool:image:1"));
        session.close().await;
    }
}
struct SlowStore {
    calls: AtomicUsize,
}
impl ToolImageStore for SlowStore {
    fn save(&self, _: &str, _: &str) -> Result<PathBuf, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(500));
        Ok("/late/image.png".into())
    }
}
#[tokio::test]
async fn stalled_store_times_out_and_cannot_spawn_unbounded_workers() {
    let store = Arc::new(SlowStore { calls: AtomicUsize::new(0) });
    let (session, mut events) = start("slow", Some(ImageStore(store.clone()))).await;
    session.send(turn(prompt_input("hi", &[]), None, policy())).await.unwrap();
    item(&session, tool("first")).await;
    item(&session, tool("second")).await;
    complete(&session).await;
    let seen = tokio::time::timeout(Duration::from_millis(350), until_end(&mut events)).await.unwrap();
    assert_eq!(store.calls.load(Ordering::SeqCst), 1);
    assert!(!seen.iter().any(|e| e["id"] == "first:image:1" || e["id"] == "second:image:1"));
    session.close().await;
}

struct CountingStore {
    inner: FileImageStore,
    calls: AtomicUsize,
}
impl ToolImageStore for CountingStore {
    fn save(&self, mime: &str, data: &str) -> Result<PathBuf, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.save(mime, data)
    }
}

#[tokio::test]
async fn cancelled_start_releases_input_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let (session, mut events) = start("hang-turn", None).await;
    let (message, path) = input(temp.path());
    let copy = session.clone();
    let task = tokio::spawn(async move { copy.send(message).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frames = session.client().rpc().request("fake/received", json!({})).await.unwrap();
            if frames["received"].as_array().unwrap().iter().any(|f| f["method"] == "turn/start") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(path.exists());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    until_end(&mut events).await;
    assert!(!path.exists());
    session.close().await;
}

#[test]
fn oversized_payload_is_refused_before_decode_or_io() {
    let data = "A".repeat(milagre_providers::images::MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1);
    assert!(ImageAttachment::from_base64("image/png", &data).is_err());
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("outputs");
    assert!(FileImageStore::new(&target).save("image/png", &data).is_err());
    assert!(!target.exists());
}

#[tokio::test]
async fn empty_batches_do_not_accumulate_turn_owned_directories() {
    let temp = tempfile::tempdir().unwrap();
    let (session, mut events) = start("slow", None).await;
    for _ in 0..3 {
        let empty = PreparedImages::create("text", &[], temp.path()).unwrap();
        session.send(turn(vec![], None, policy()).with_images(empty)).await.unwrap();
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }
    session.close().await;
    until_end(&mut events).await;
}
