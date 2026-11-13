//! Replays every case `fixtures/generate.cjs` recorded from the Node implementation and compares the Rust result
//! byte for byte (JSON as `JSON.stringify` writes it). A case this file does not know fails the test, so a new Node
//! case can't be skipped silently.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use milagre_owner_store::chat_db::{ChatId, LookupField, MessageRepository};
use milagre_owner_store::commands::{chat_page, PageOptions, ProjectReader};
use milagre_owner_store::jsjson;
use milagre_owner_store::project::{ProjectRepository, ProjectStore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PROJECTS: [&str; 7] = [
    "alpha",
    "legacy",
    "legacy-compact",
    "missing-db",
    "missing-sidecar",
    "surrogates",
    "empty",
];
/// Node-only: which Chats ProjectStates unloads from memory after a read. The Rust readers keep nothing in memory.
const NODE_ONLY: [&str; 1] = ["unloadedAfterRead"];

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn expected(project: &str) -> BTreeMap<String, String> {
    let text = std::fs::read_to_string(fixtures().join("expected").join(format!("{project}.json")))
        .unwrap();
    // jsjson::parse: a case name can hold an unpaired surrogate (sendStatus of such a clientMessageId).
    let Value::Object(cases) = jsjson::parse(&text).unwrap() else {
        panic!("expected an object")
    };
    cases
        .into_iter()
        // The recorded JSON texts escape every unpaired surrogate, so they decode to plain Rust text.
        .map(|(key, value)| {
            let text = String::from_utf16(&jsjson::to_utf16(value.as_str().unwrap())).unwrap();
            (key, text)
        })
        .collect()
}

fn error_json(message: String) -> String {
    jsjson::to_string(&json!({ "error": message }))
}

fn rows_json(rows: &[milagre_owner_store::Row]) -> String {
    jsjson::to_string(&Value::Array(
        rows.iter().map(|row| row.to_value()).collect(),
    ))
}

struct Context {
    dir: PathBuf,
    store: ProjectStore,
    reader: ProjectReader,
    chat_sets: BTreeMap<&'static str, Vec<ChatId>>,
}

impl Context {
    fn new(project: &str) -> Self {
        let dir = fixtures().join(".projects").join(project);
        let store = ProjectStore::new(&dir);
        // The chat sets generate.cjs used: sessions in JS order, then Chats with rows in Project order.
        let sessions: Vec<ChatId> = store
            .read_raw()
            .ok()
            .and_then(|raw| raw.get("sessions").and_then(Value::as_object).cloned())
            .map(|sessions| {
                jsjson::js_entries(&sessions)
                    .into_iter()
                    .filter_map(|(_, session)| session["id"].as_i64())
                    .collect()
            })
            .unwrap_or_default();
        let mut all = sessions.clone();
        if let Some(rows) = store.chats().read_rows().unwrap() {
            for row in rows {
                if let Some(chat) = row.chat.as_i64() {
                    if !all.contains(&chat) {
                        all.push(chat);
                    }
                }
            }
        }
        let chat_sets = BTreeMap::from([
            ("sessions", sessions.clone()),
            ("all", all),
            ("none", vec![]),
            ("one", sessions.into_iter().take(1).collect()),
            ("missing", vec![12345]),
        ]);
        Context {
            reader: ProjectReader::new(ProjectStore::new(&dir)),
            dir,
            store,
            chat_sets,
        }
    }

    fn chats(&self, label: &str) -> &[ChatId] {
        self.chat_sets
            .get(label)
            .unwrap_or_else(|| panic!("unknown chat set {label}"))
    }

    fn placeholder(&self, text: String) -> String {
        text.replace(&self.dir.display().to_string(), "<project>")
    }

    /// The Rust answer to one recorded case, or None for a case this test doesn't know.
    fn answer(&self, case: &str) -> Option<String> {
        let parts: Vec<&str> = case.split('.').collect();
        let db = self.store.chats();
        let text = match parts.as_slice() {
            ["readProjectState"] => match self.store.read_project_state() {
                Ok(read) => jsjson::to_string(&read.state),
                Err(error) => error_json(error.to_string()),
            },
            ["readProjectStateUncompacted"] => match self.store.read_project_state_uncompacted() {
                Ok(read) => jsjson::to_string(&read.to_value()),
                Err(error) => error_json(error.to_string()),
            },
            // ProjectStates failing to read the Project: every command on it fails with the read's error.
            ["projectStatesLoad"] => error_json(
                self.store
                    .read_project_state()
                    .expect_err("Node failed to read this Project")
                    .to_string(),
            ),
            ["readRows"] => db
                .read_rows()
                .unwrap()
                .map_or("null".into(), |rows| rows_json(&rows)),
            ["readMessages"] => jsjson::to_string(
                &db.read_messages()
                    .unwrap()
                    .map_or(Value::Null, Value::Array),
            ),
            ["readChatRows", set] => rows_json(&db.read_chat_rows(self.chats(set)).unwrap()),
            ["readChatBodies", set] => rows_json(&db.read_chat_bodies(self.chats(set)).unwrap()),
            ["readChatMarks", set] => rows_json(&db.read_chat_marks(self.chats(set)).unwrap()),
            ["readChatPreviews", set] => {
                let previews = db.read_chat_previews(self.chats(set)).unwrap();
                format!(
                    "[{}]",
                    previews
                        .iter()
                        .map(|preview| preview.to_js_json())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            }
            ["readDetailRefs", set] => {
                jsjson::to_string(&json!(db.read_detail_refs(self.chats(set)).unwrap()))
            }
            ["readChatRowsContaining", set, needles] => {
                let needles: Vec<String> = match *needles {
                    "needle" => vec!["needle".into()],
                    "multi" => vec!["orphan".into(), "Café".into(), "\\u0001".into()],
                    "none" => vec![],
                    other => panic!("unknown needles {other}"),
                };
                rows_json(
                    &db.read_chat_rows_containing(self.chats(set), &needles)
                        .unwrap(),
                )
            }
            ["readPositions"] => {
                let ids: Vec<Value> = [1, 2, 3, 900, 904, 5555]
                    .into_iter()
                    .map(Value::from)
                    .collect();
                let entries: Vec<Value> = db
                    .read_positions(&ids)
                    .unwrap()
                    .into_iter()
                    .map(|(id, position, chat)| json!([id, { "position": position, "chat": chat }]))
                    .collect();
                jsjson::to_string(&Value::Array(entries))
            }
            ["findRow", field, value, set] => {
                let field = LookupField::parse(field).unwrap();
                let value = if field == LookupField::Id {
                    json!(value.parse::<i64>().unwrap())
                } else {
                    json!(value)
                };
                let row = db.find_row(self.chats(set), field, &value).unwrap();
                row.map_or("null".into(), |row| jsjson::to_string(&row.to_value()))
            }
            ["chatPage", chat, label, before, how] => {
                let chat: i64 = chat.parse().unwrap();
                let mut options = match *label {
                    "default" => PageOptions::default(),
                    "short" => PageOptions {
                        turns: Some(json!(1)),
                        limit: Some(json!(3)),
                        ..Default::default()
                    },
                    "limitOnly" => PageOptions {
                        limit: Some(json!(4)),
                        ..Default::default()
                    },
                    "zeroTurns" => PageOptions {
                        turns: Some(json!(0)),
                        ..Default::default()
                    },
                    other => panic!("unknown page options {other}"),
                };
                if *before != "end" {
                    options.before = Some(json!(before.parse::<i64>().unwrap()));
                }
                let page = match *how {
                    // runtime.cjs, unopened Project: readChatRows + chatPage. Without chats.db, the state's messages.
                    "unopened" => self.reader.chat_messages(chat, &options).unwrap(),
                    // ProjectStates.load + chatPage over every message in memory.
                    "opened" => {
                        let state = self.store.read_project_state().unwrap().state;
                        chat_page(
                            state["messages"].as_array().unwrap(),
                            &json!(chat),
                            &options,
                        )
                    }
                    other => panic!("unknown page path {other}"),
                };
                jsjson::to_string(&page)
            }
            ["chatMessage", id] => {
                match self.reader.chat_message(&json!(id.parse::<i64>().unwrap())) {
                    Ok(message) => jsjson::to_string(&message),
                    Err(error) => error_json(error.to_string()),
                }
            }
            ["sendStatus", client] => jsjson::to_string(&self.reader.send_status(client).unwrap()),
            _ => return None,
        };
        Some(self.placeholder(text))
    }
}

fn hash_tree(root: &Path) -> BTreeMap<PathBuf, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                stack.push(entry.path());
            } else {
                out.insert(
                    entry.path(),
                    hex::encode(Sha256::digest(std::fs::read(entry.path()).unwrap())),
                );
            }
        }
    }
    out
}

#[test]
fn rust_reads_match_node_for_every_recorded_case() {
    let before = hash_tree(&fixtures().join(".projects"));
    let mut compared = 0;
    let mut failures = Vec::new();
    for project in PROJECTS {
        let context = Context::new(project);
        for (case, node) in expected(project) {
            if NODE_ONLY.contains(&case.as_str()) {
                continue;
            }
            let rust = context
                .answer(&case)
                .unwrap_or_else(|| panic!("{project}: no Rust answer for recorded case {case}"));
            compared += 1;
            if rust != node {
                let at = rust
                    .bytes()
                    .zip(node.bytes())
                    .position(|(a, b)| a != b)
                    .unwrap_or(0);
                let from = rust[..at]
                    .char_indices()
                    .map(|(i, _)| i)
                    .rfind(|i| *i + 120 <= at)
                    .unwrap_or(0);
                let node = &node[from.min(node.len())..];
                let rust = &rust[from..];
                failures.push(format!(
                    "{project} {case}\n  node: {}\n  rust: {}",
                    &node[..node.len().min(400)],
                    &rust[..rust.len().min(400)]
                ));
            }
        }
    }
    let after = hash_tree(&fixtures().join(".projects"));
    assert_eq!(before, after, "reading the fixtures changed them");
    assert!(compared > 300, "only {compared} cases compared");
    assert!(
        failures.is_empty(),
        "{} of {compared} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    eprintln!("{compared} Node-recorded cases match byte for byte");
}

#[test]
fn compaction_pending_is_reported_not_written() {
    let store = ProjectStore::new(fixtures().join(".projects/legacy-compact"));
    let read = store.read_project_state().unwrap();
    assert_eq!(read.pending_detail_compaction, vec![json!(2)]);
    // The sidecar Node wrote on its read of a copy: same name, and its bytes hash to it.
    let (name, details) = &read.pending_sidecars[0];
    assert_eq!(read.state["messages"][1]["detailFile"], json!(name));
    let bytes = jsjson::to_string(&Value::Object(details.clone()));
    assert_eq!(
        format!("{}.json", hex::encode(Sha256::digest(bytes.as_bytes()))),
        *name
    );
    assert!(
        !fixtures()
            .join(".projects/legacy-compact/.milagre/details")
            .exists(),
        "a read must not create sidecars"
    );
}

#[test]
fn no_messages_table_reads_as_empty_and_hot_journal_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".milagre")).unwrap();
    let file = dir.path().join(".milagre/chats.db");
    rusqlite::Connection::open(&file)
        .unwrap()
        .execute_batch("CREATE TABLE other (x);")
        .unwrap();
    let store = ProjectStore::new(dir.path());
    assert_eq!(store.chats().read_rows().unwrap(), Some(vec![]));
    assert_eq!(store.chats().read_chat_rows(&[1]).unwrap(), vec![]);
    std::fs::write(
        dir.path().join(".milagre/chats.db-journal"),
        b"half a transaction",
    )
    .unwrap();
    let error = store.chats().read_rows().unwrap_err();
    assert!(
        error.to_string().contains("unfinished transaction"),
        "{error}"
    );
}

#[test]
fn unknown_lookup_field_matches_node_error() {
    assert_eq!(
        LookupField::parse("body").unwrap_err().to_string(),
        "Messages can't be looked up by body"
    );
}
