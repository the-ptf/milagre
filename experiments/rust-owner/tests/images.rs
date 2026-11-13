//! Actual Node metadata/send/queue oracle plus bounded owner admission and descriptor confinement. Provider callbacks
//! are synthetic; native block ordering belongs to the Claude bridge's separate real-helper oracle.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use milagre_owner_store::changed_files::test_hooks::run_bounded;
use milagre_owner_store::chat_host::{
    AnswerId, ChatHost, ImageInput, MockProvider, Provider, ProviderError, ProviderErrorKind,
    ProviderEvent, TurnId,
};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::RawJson;
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Default)]
struct ImageCalls {
    checks: Vec<Value>,
    starts: Vec<(Value, Vec<ImageInput>)>,
    reject: bool,
}
struct ImagesProvider {
    mock: MockProvider,
    calls: Arc<Mutex<ImageCalls>>,
}
impl Provider for ImagesProvider {
    fn name(&self) -> &str {
        "claude"
    }
    fn supports_image_inputs(&self) -> bool {
        true
    }
    fn validate_image_turn(
        &self,
        request: &RawJson,
        images: &[ImageInput],
    ) -> Result<(), ProviderError> {
        assert_eq!(request.0["images"], json!([]));
        assert!(!images.is_empty());
        let mut calls = self.calls.lock().unwrap();
        calls.checks.push(request.0.clone());
        if calls.reject {
            Err(ProviderError::new(
                ProviderErrorKind::Refused,
                "synthetic native frame preflight refusal",
            ))
        } else {
            Ok(())
        }
    }
    fn start_turn_with_images(
        &mut self,
        turn: TurnId,
        request: &RawJson,
        images: &[ImageInput],
    ) -> Result<(), ProviderError> {
        self.calls
            .lock()
            .unwrap()
            .starts
            .push((request.0.clone(), images.to_vec()));
        self.mock.start_turn(turn, request)
    }
    fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> Result<(), ProviderError> {
        self.mock.start_turn(turn, request)
    }
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.mock.interrupt(chat, turn)
    }
    fn respond_permission(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        id: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        self.mock
            .respond_permission(chat, turn, answer, id, decision)
    }
    fn answer_question(
        &mut self,
        chat: &str,
        turn: TurnId,
        answer: AnswerId,
        id: &str,
        answers: &RawJson,
    ) -> Result<(), ProviderError> {
        self.mock.answer_question(chat, turn, answer, id, answers)
    }
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
        self.mock.close_chat(chat, turn)
    }
    fn shutdown(&mut self) {
        self.mock.shutdown();
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        self.mock.take_events()
    }
}

struct Copy {
    host: ChatHost,
    project: PathBuf,
    mock: MockProvider,
    calls: Arc<Mutex<ImageCalls>>,
    _temp: tempfile::TempDir,
}
impl Drop for Copy {
    fn drop(&mut self) {
        let _ = self.host.shutdown(true);
    }
}
impl Copy {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(&temp.path().join("copies"), &Policy::default()).unwrap();
        let project = isolation.project(Path::new("p")).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        std::fs::write(project.join(".milagre/coordination.json"), json!({ "next_id": 10, "worktrees": { "1": { "id": 1, "name": "main", "path": project } }, "sessions": { "1": { "id": 1, "worktree_id": 1 } }, "messages": [] }).to_string()).unwrap();
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        let mock = MockProvider::new("claude");
        let calls = Arc::new(Mutex::new(ImageCalls::default()));
        host.register(Box::new(ImagesProvider {
            mock: mock.clone(),
            calls: calls.clone(),
        }));
        host.open_project(&project).unwrap();
        Self {
            host,
            project,
            mock,
            calls,
            _temp: temp,
        }
    }
    fn request(&self, id: &str) -> Value {
        json!({ "projectPath": self.project, "sessionId": 1, "provider": "claude", "model": "fixture", "body": "", "images": [input()], "clientMessageId": id })
    }
    fn chat(&self) -> String {
        format!("{}#1", self.project.display())
    }
    fn state(&self) -> Value {
        self.host.states.current(&self.project).unwrap().to_value()
    }
    fn begin(&mut self) {
        self.host.send(&self.request("direct")).unwrap();
        assert!(self.host.pump().is_empty());
        self.mock.emit(
            &self.chat(),
            json!({ "type": "session-started", "nativeId": "synthetic-native" }),
        );
        assert!(self.host.pump().is_empty());
    }
    fn queue(&mut self) -> Value {
        let mut request = self.request("queued");
        request["body"] = json!("queued");
        request["delivery"] = json!("queue");
        assert!(self.host.send(&request).unwrap().queued);
        self.state()["sessions"]["1"]["queued"][0].clone()
    }
    fn finish(&mut self) -> Vec<milagre_owner_store::StoreError> {
        self.mock
            .emit(&self.chat(), json!({ "type": "turn-completed" }));
        self.host.pump()
    }
    fn images(&self) -> PathBuf {
        self.project.join(".milagre/images")
    }
}
fn input() -> Value {
    json!({ "id": "image-1", "name": "tiny.png", "path": "/never/read/upload.png", "sourcePath": "", "extra": { "kept": true }, "dataUrl": "data:image/png;base64,iVBORw0KGgo=" })
}
fn clean(value: &Value, project: &Path) -> Value {
    serde_json::from_str(
        &value
            .to_string()
            .replace(project.to_str().unwrap(), "<project>"),
    )
    .unwrap()
}
fn message_images(state: &Value, id: &str) -> Value {
    state["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["clientMessageId"] == id)
        .unwrap()["images"]
        .clone()
}

#[test]
fn actual_node_send_storage_queue_and_dedupe_match() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/images-node.cjs");
    let text = run_bounded(
        "node",
        &[fixture.to_str().unwrap()],
        Duration::from_secs(15),
        64 * 1024,
    )
    .expect("real Node image oracle completes");
    let expected: Value = serde_json::from_str(&text).unwrap();
    for (source, hash) in expected["sources"].as_object().unwrap() {
        let bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(source),
        )
        .unwrap();
        assert_eq!(hex::encode(Sha256::digest(bytes)), hash.as_str().unwrap());
    }
    let mut copy = Copy::new();
    copy.begin();
    assert_eq!(
        clean(&message_images(&copy.state(), "direct"), &copy.project),
        expected["direct"]
    );
    let entry = copy.queue();
    assert_eq!(
        clean(&entry["images"], &copy.project),
        expected["queuedStored"]
    );
    assert!(copy.finish().is_empty());
    assert_eq!(
        clean(&message_images(&copy.state(), "queued"), &copy.project),
        expected["queuedSent"]
    );
    let mut duplicate = copy.request("direct");
    duplicate["images"] = json!([{ "path": "/not/read" }]);
    assert!(copy.host.send(&duplicate).unwrap().duplicate);
    let calls = copy.calls.lock().unwrap();
    assert_eq!(calls.starts.len(), 2);
    assert_eq!(
        calls.checks.len(),
        3,
        "queued admission and queued start both preflight"
    );
    assert_eq!(calls.checks[0], calls.starts[0].0);
    assert_eq!(calls.checks[1], calls.starts[1].0);
    assert_eq!(
        calls.checks[2], calls.starts[1].0,
        "preflight receives the exact eventual request"
    );
    assert_eq!(
        json!(calls
            .starts
            .iter()
            .map(|(request, _)| request["prompt"].clone())
            .collect::<Vec<_>>()),
        expected["prompts"]
    );
    let payloads: Vec<Value> = calls.starts.iter().map(|(_, images)| json!(images.iter().map(|image| json!({ "mime": image.mime(), "sha256": hex::encode(Sha256::digest(image.bytes())) })).collect::<Vec<_>>())).collect();
    assert_eq!(json!(payloads), expected["payloads"]);
    let files: Vec<_> = std::fs::read_dir(copy.images())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_string())
        .collect();
    assert_eq!(json!(files), expected["files"]);
}

#[test]
fn validation_preflight_and_unsupported_paths_write_nothing() {
    for mode in [
        "invalid-second",
        "native-budget",
        "new-chat",
        "wrong-provider",
        "path-only",
        "from-queue",
        "count",
        "aggregate",
        "prompt-identity",
    ] {
        let mut copy = Copy::new();
        let before = copy.state();
        let mut request = copy.request("refused");
        match mode {
            "invalid-second" => request["images"] = json!([input(), { "dataUrl": "bad" }]),
            "native-budget" => copy.calls.lock().unwrap().reject = true,
            "new-chat" => {
                request.as_object_mut().unwrap().remove("sessionId");
                request["worktreeId"] = json!(1);
            }
            "wrong-provider" => {
                copy.host.register(Box::new(MockProvider::new("kiro")));
                request["provider"] = json!("kiro");
            }
            "path-only" => request["images"] = json!([{ "path": copy.images().join("a.png") }]),
            "from-queue" => request["fromQueue"] = json!("caller-cannot-authorize-a-read"),
            "count" => request["images"] = json!(vec![input(); 11]),
            "aggregate" => {
                let mut bytes = vec![0; 600 * 1024];
                bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
                let image = json!({"dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))});
                request["images"] = json!([image.clone(), image]);
            }
            "prompt-identity" => {
                request["model"] = json!(milagre_owner_store::jsjson::parse("\"\\ud800\"").unwrap())
            }
            _ => unreachable!(),
        }
        assert!(copy.host.send(&request).is_err(), "{mode}");
        assert_eq!(copy.state(), before, "{mode}");
        assert!(!copy.images().exists(), "{mode}");
        assert!(copy.calls.lock().unwrap().starts.is_empty(), "{mode}");
    }
}

#[test]
fn queued_duplicate_needs_no_decode_or_storage_and_runs_once() {
    let mut copy = Copy::new();
    copy.begin();
    let entry = copy.queue();
    let mut duplicate = copy.request("queued");
    duplicate["images"] = json!([{ "dataUrl": "invalid" }]);
    assert!(copy.host.send(&duplicate).unwrap().duplicate);
    assert_eq!(copy.state()["sessions"]["1"]["queued"], json!([entry]));
    assert_eq!(copy.calls.lock().unwrap().checks.len(), 2);
    assert!(copy.finish().is_empty());
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 2);
    assert!(copy.host.send(&duplicate).unwrap().duplicate);
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 2);
}

#[test]
fn empty_or_nonstring_client_ids_never_skip_queued_image_hydration() {
    for id in [json!(""), json!(17), json!(true), Value::Null] {
        let mut copy = Copy::new();
        let mut first = copy.request("");
        first["clientMessageId"] = id.clone();
        copy.host.send(&first).unwrap();
        assert!(copy.host.pump().is_empty());
        copy.mock.emit(
            &copy.chat(),
            json!({ "type": "session-started", "nativeId": "synthetic-native" }),
        );
        assert!(copy.host.pump().is_empty());
        let mut request = copy.request("");
        request["clientMessageId"] = id.clone();
        request["delivery"] = json!("queue");
        request["body"] = json!("empty/nonstring id image");
        assert!(copy.host.send(&request).unwrap().queued);
        // Public sends keep empty strings but omit nonstrings. Seed malformed legacy nonstring ids in both saved
        // places to prove they cannot gain dedupe authority during hydration either.
        if !id.is_string() {
            copy.host
                .states
                .update(&copy.project, Some(&[1]), true, |latest| {
                    let mut sessions = latest.get("sessions").unwrap().clone();
                    sessions["1"]["queued"][0]["clientMessageId"] = id.clone();
                    let messages = latest
                        .message_list()
                        .iter()
                        .map(|message| {
                            if id.is_boolean()
                                || message.get("role").and_then(Value::as_str) != Some("user")
                            {
                                return message.clone();
                            }
                            let mut value = message.value().clone();
                            value["clientMessageId"] = id.clone();
                            milagre_owner_store::message_store::Msg::new(value)
                        })
                        .collect();
                    Some(
                        latest
                            .with_field("sessions", sessions)
                            .with_messages(messages),
                    )
                })
                .unwrap();
            copy.host.states.flush(Some(&copy.project)).unwrap();
        }
        assert!(copy.finish().is_empty(), "{id}");
        let calls = copy.calls.lock().unwrap();
        assert_eq!(calls.starts.len(), 2, "{id}");
        assert_eq!(
            calls.starts[1].1.len(),
            1,
            "{id}: queued image must not disappear"
        );
        assert_eq!(
            calls.starts[1].1[0].bytes(),
            &[137, 80, 78, 71, 13, 10, 26, 10],
            "{id}"
        );
        assert!(
            copy.state()["sessions"]["1"].get("queued").is_none(),
            "{id}"
        );
    }
}

#[test]
fn eventual_queue_preflight_refusal_preserves_attachment_and_holds_queue() {
    let mut copy = Copy::new();
    copy.begin();
    let entry = copy.queue();
    copy.calls.lock().unwrap().reject = true;
    assert!(copy.finish().is_empty());
    assert_eq!(
        copy.state()["sessions"]["1"]["queued"],
        json!([entry.clone()])
    );
    assert_eq!(copy.state()["sessions"]["1"]["queueHeld"], true);
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 1);
    let id = entry["id"].as_str().unwrap();
    assert!(copy
        .host
        .send_queued_now(&copy.chat(), id)
        .unwrap_err()
        .to_string()
        .contains("preflight refusal"));
    assert_eq!(copy.state()["sessions"]["1"]["queued"], json!([entry]));
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 1);
}

#[test]
fn saved_nonempty_duplicate_queue_settles_without_missing_image_read() {
    let mut copy = Copy::new();
    copy.begin();
    let entry = copy.queue();
    copy.host
        .states
        .update(&copy.project, Some(&[]), true, |latest| {
            let mut sessions = latest.get("sessions").unwrap().clone();
            sessions["1"]["queued"][0]["clientMessageId"] = json!("direct");
            Some(latest.with_field("sessions", sessions))
        })
        .unwrap();
    std::fs::remove_file(entry["images"][0]["path"].as_str().unwrap()).unwrap();
    assert!(copy.finish().is_empty());
    assert!(copy.state()["sessions"]["1"].get("queued").is_none());
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 1);
}

#[test]
fn failed_message_commit_keeps_immutable_content_and_retry_sends_once() {
    let mut copy = Copy::new();
    let before = copy.state();
    copy.host
        .states
        .fail_next_commit("synthetic image message commit failure");
    let request = copy.request("retry");
    assert!(copy
        .host
        .send(&request)
        .unwrap_err()
        .to_string()
        .contains("synthetic image message commit failure"));
    assert_eq!(copy.state(), before);
    assert!(copy.calls.lock().unwrap().starts.is_empty());
    assert_eq!(std::fs::read_dir(copy.images()).unwrap().count(), 1);
    copy.host.send(&request).unwrap();
    assert_eq!(std::fs::read_dir(copy.images()).unwrap().count(), 1);
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 1);
    assert!(copy.host.send(&request).unwrap().duplicate);
    assert_eq!(copy.calls.lock().unwrap().starts.len(), 1);
}

#[test]
fn forgotten_or_lost_owner_never_stores_or_starts_images() {
    for forgotten in [false, true] {
        let mut copy = Copy::new();
        let request = copy.request("revoked");
        if forgotten {
            copy.host.forget(&copy.project, true).unwrap();
        } else {
            let path = copy.project.join(".milagre/runtime.lock/owner.json");
            let mut owner: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            owner["token"] = json!("synthetic-foreign-owner");
            std::fs::write(path, owner.to_string()).unwrap();
        }
        assert!(copy.host.send(&request).is_err());
        assert!(!copy.images().exists());
        assert!(copy.calls.lock().unwrap().checks.is_empty());
        assert!(copy.calls.lock().unwrap().starts.is_empty());
    }
}

#[test]
fn decoder_caps_count_and_decoded_aggregate_at_exact_boundaries() {
    assert_eq!(
        ImageInput::decode_for_tests(&json!(vec![input(); 10]))
            .unwrap()
            .len(),
        10
    );
    assert!(ImageInput::decode_for_tests(&json!(vec![input(); 11])).is_err());
    let mut bytes = vec![0; 1024 * 1024];
    bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let encoded = |bytes: &[u8]| json!({ "dataUrl": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)) });
    assert_eq!(
        ImageInput::decode_for_tests(&json!([encoded(&bytes)])).unwrap()[0]
            .bytes()
            .len(),
        1024 * 1024
    );
    bytes.push(0);
    assert!(ImageInput::decode_for_tests(&json!([encoded(&bytes)]))
        .unwrap_err()
        .to_string()
        .contains("at most 1 MiB"));
}

#[test]
fn queued_missing_tampered_linked_or_foreign_images_stay_held_and_unsent() {
    use std::os::unix::fs::symlink;
    for mode in [
        "missing",
        "tampered",
        "symlink",
        "hardlink",
        "foreign",
        "directory",
        "directory-symlink",
    ] {
        let mut copy = Copy::new();
        copy.begin();
        let entry = copy.queue();
        let file = PathBuf::from(entry["images"][0]["path"].as_str().unwrap());
        let foreign = copy._temp.path().join("foreign.png");
        std::fs::write(&foreign, b"private bytes never to be delivered").unwrap();
        match mode {
            "missing" => std::fs::remove_file(&file).unwrap(),
            "tampered" => std::fs::write(&file, b"changed").unwrap(),
            "symlink" => {
                std::fs::remove_file(&file).unwrap();
                symlink(&foreign, &file).unwrap();
            }
            "hardlink" => std::fs::hard_link(&file, copy._temp.path().join("alias.png")).unwrap(),
            "foreign" => {
                copy.host
                    .states
                    .update(&copy.project, Some(&[]), true, |latest| {
                        let mut sessions = latest.get("sessions").unwrap().clone();
                        sessions["1"]["queued"][0]["images"][0]["path"] = json!(foreign);
                        Some(latest.with_field("sessions", sessions))
                    })
                    .unwrap();
            }
            "directory" => {
                std::fs::remove_file(&file).unwrap();
                std::fs::create_dir(&file).unwrap();
            }
            "directory-symlink" => {
                let moved = copy._temp.path().join("moved-images");
                std::fs::rename(copy.images(), &moved).unwrap();
                symlink(moved, copy.images()).unwrap();
            }
            _ => unreachable!(),
        }
        let _errors = copy.finish();
        assert!(
            copy.host.take_notices().iter().any(|notice| matches!(
                notice,
                milagre_owner_store::chat_host::Notice::Failed { .. }
            )),
            "{mode}"
        );
        let state = copy.state();
        assert_eq!(
            state["sessions"]["1"]["queued"].as_array().unwrap().len(),
            1,
            "{mode}"
        );
        assert_eq!(state["sessions"]["1"]["queueHeld"], true, "{mode}");
        assert_eq!(copy.calls.lock().unwrap().starts.len(), 1, "{mode}");
        assert_eq!(
            std::fs::read(foreign).unwrap(),
            b"private bytes never to be delivered"
        );
    }
}

#[test]
fn unsupported_image_steering_and_restore_refuse_before_new_files() {
    let mut copy = Copy::new();
    copy.begin();
    let before = copy.state();
    let mut request = copy.request("steer");
    request["images"][0]["dataUrl"] = json!("data:image/gif;base64,R0lGODlh");
    assert!(copy
        .host
        .send(&request)
        .unwrap_err()
        .to_string()
        .contains("Steering"));
    assert_eq!(copy.state(), before);
    assert!(copy.finish().is_empty());
    copy.host
        .states
        .update(&copy.project, Some(&[]), true, |latest| {
            let mut sessions = latest.get("sessions").unwrap().clone();
            sessions["1"]
                .as_object_mut()
                .unwrap()
                .remove("native_session_id");
            Some(latest.with_field("sessions", sessions))
        })
        .unwrap();
    assert!(copy
        .host
        .send(&request)
        .unwrap_err()
        .to_string()
        .contains("Restoring"));
    assert_eq!(std::fs::read_dir(copy.images()).unwrap().count(), 1);
}

#[test]
fn decoder_matches_freshly_pinned_node_validation_except_documented_count_cap() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../rust-claude/tests/fixtures/conformance/claude-prompt-images.json");
    let oracle: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for (source, hash) in oracle["sources"].as_object().unwrap() {
        let bytes = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(source),
        )
        .unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(bytes)),
            hash.as_str().unwrap(),
            "stale Node source {source}"
        );
    }
    for case in oracle["validation"].as_array().unwrap() {
        let result = ImageInput::decode_for_tests(&case["images"]);
        if case["images"]
            .as_array()
            .is_some_and(|images| images.len() > 10)
        {
            assert!(result.unwrap_err().to_string().contains("at most 10"));
            continue;
        }
        if let Some(expected) = case.get("error") {
            assert_eq!(
                result.unwrap_err().to_string(),
                expected.as_str().unwrap(),
                "{}",
                case["name"]
            );
        } else {
            let decoded: Vec<Value> = result.unwrap().iter().map(|image| json!({ "mime": image.mime(), "base64": base64::engine::general_purpose::STANDARD.encode(image.bytes()), "size": image.bytes().len(), "sha256": hex::encode(Sha256::digest(image.bytes())) })).collect();
            assert_eq!(json!(decoded), case["decoded"], "{}", case["name"]);
        }
    }
}
