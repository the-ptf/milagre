//! The Rust owner of one Project inside an isolated copy: the write side of chat-db.cjs, project-store.cjs and
//! project-content.cjs, ported step for step.
//!
//! An [`OwnedProject`] exists only inside an [`Isolation`] and holds the Project's owner lock
//! (`.milagre/runtime.lock`, the same lock a Node runtime takes) from [`OwnedProject::open`] until it is released or
//! dropped, so a Node runtime and a Rust owner exclude each other. Everything it writes is what Node writes, byte for
//! byte (see tests/writer.rs, which runs the real Node writers on the same scenarios).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use base64::Engine;
use rusqlite::params_from_iter;
use serde_json::{Map, Value};

use crate::chat_db::{
    bind_js, sql_value, ChatDb, ChatId, LookupField, MessageRepository, Preview, Row,
};
use crate::commands::ProjectReader;
use crate::error::{Result, StoreError};
use crate::isolation::Isolation;
use crate::jsjson;
use crate::message_store::{id_key, MessageStore, Msg, MsgRef, ProjectState, SavedMsgs, SavedRow};
use crate::ownership::{self, OwnerGuard, RustOwnerLock, StrandedLocks};
use crate::project::{
    inside, is_sidecar_name, sha256_hex, state_file, MessageStorage, ProjectRepository,
    ProjectStateRead, ProjectStore,
};
use crate::write::{
    MessageStoreWriter, OwnerLock, ProjectStateWriter, SaveOptions, SaveReport, SavedRows,
    WriteOptions, WriteStats,
};
use std::sync::Arc;

/// chat-db.cjs MESSAGES_MARKER.
pub fn messages_marker() -> Value {
    serde_json::json!({ "storedIn": "chats.db", "format": 2 })
}

/// project-store.cjs `counter`: temporary file names are `coordination.json.<pid>.<n>.tmp`.
static COUNTER: AtomicU64 = AtomicU64::new(0);

const MAX_ATTACHMENT_BYTES: usize = 50 * 1024 * 1024;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// node:sqlite binding of `value ?? null`.
fn bind_or_null(value: Option<&Value>, parameter: usize) -> Result<rusqlite::types::Value> {
    bind_js(value.unwrap_or(&Value::Null), parameter)
}

/// node:sqlite binding of a value that may be `undefined` (which it refuses).
fn bind_defined(value: Option<&Value>, parameter: usize) -> Result<rusqlite::types::Value> {
    match value {
        Some(value) => bind_js(value, parameter),
        None => Err(StoreError::Sqlite(format!(
            "Provided value cannot be bound to SQLite parameter {parameter}."
        ))),
    }
}

fn number_of(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

/// One Project owned by this process, inside an isolated copy.
pub struct OwnedProject {
    store: ProjectStore,
    guard: OwnerGuard,
    /// message-store.cjs's store for this Project: the saved rows the writer and the message cache share.
    messages: MessageStore,
    /// project-store.cjs `settled`: session/agent -> digest of the transcript sidecar the saved state points at.
    settled: Option<HashMap<String, String>>,
    /// project-store.cjs `swept`: the first save of a run sweeps old sidecars even when it wrote none.
    swept: bool,
}

impl OwnedProject {
    /// Takes the owner lock of `project` (a folder inside `isolation`). Refused when any lock is already there.
    ///
    /// `stranded` is where the lock is recorded if dropping this Project can't release it (its root no longer holds;
    /// see [`crate::ownership::StrandedLock`]). `None` drops that diagnostic: pass a sink unless nobody could show it.
    pub fn open(
        isolation: &Isolation,
        project: &Path,
        stranded: Option<StrandedLocks>,
    ) -> Result<Self> {
        let root = isolation.project(project)?;
        // The lock pins the root folder (device and inode) as it is taken. Every write checks it is still that folder
        // at that canonical path, and releasing the lock (also on drop) removes nothing unless it is.
        let mut guard = RustOwnerLock.acquire(&root, &ownership::project_lock(&root))?;
        if let Some(sink) = stranded {
            guard.report_stranded_to(sink);
        }
        Ok(OwnedProject {
            store: ProjectStore::owned(&root),
            guard,
            messages: MessageStore::default(),
            settled: None,
            swept: false,
        })
    }

    pub fn root(&self) -> &Path {
        self.store.root()
    }

    pub fn lock(&self) -> &OwnerGuard {
        &self.guard
    }

    /// What chats.db holds for the Chats in memory, as the next save will use it.
    pub fn saved_rows(&self) -> Option<SavedRows> {
        self.messages.saved.as_ref().map(to_rows)
    }

    /// Whether this process still owns the Project, checked before every write: the lock is ours
    /// ([`OwnerGuard::verify`]), the root is still the folder opened (same device and inode, its canonical path
    /// unchanged: nothing moved, no link on or above it), and the files a save writes lead nowhere else (`.milagre` a
    /// real folder, `chats.db` and `coordination.json` neither symbolic links nor hard-linked files). The full walk of
    /// `.milagre` ran at open ([`crate::isolation::Isolation::check_contents`]); this is the cheap check repeated per
    /// write.
    pub fn verify_owned(&self) -> Result<()> {
        let lost = |why: &str| StoreError::OwnershipLost {
            lock: self.guard.path().to_path_buf(),
            why: why.into(),
        };
        // The root first: still the folder that was opened, at its canonical path. A Project moved away (its lock with
        // it) and a link put in its place, or a link above it, would otherwise send every write below elsewhere.
        if let Err(why) = self.guard.root().check() {
            return Err(lost(why));
        }
        self.guard.verify()?;
        let metadata = self.root().join(".milagre");
        match std::fs::symlink_metadata(&metadata) {
            Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
                return Err(lost(".milagre isn't a real folder"))
            }
            Ok(_) => {}
            Err(_) => return Err(lost(".milagre is gone")),
        }
        for name in ["chats.db", "chats.db-journal", "coordination.json"] {
            if let Ok(meta) = std::fs::symlink_metadata(metadata.join(name)) {
                use std::os::unix::fs::MetadataExt;
                // A link would send the write elsewhere. Anything else in the way (a folder) fails the write itself, as
                // in Node.
                if meta.file_type().is_symlink() || (meta.is_file() && meta.nlink() > 1) {
                    return Err(lost(&format!("{name} isn't a plain file of this Project")));
                }
            }
        }
        Ok(())
    }

    /// Releases the owner lock (ownership.cjs release). A root that no longer holds (see [`Self::verify_owned`]) is
    /// `OwnershipLost` and nothing is removed: the lock path would lead outside the folder opened. Dropping does the
    /// same check.
    pub fn release(mut self) -> Result<()> {
        self.guard.release()
    }

    /// Command answers over this Project (chat:messages, chat:message, chat:send-status) from what is saved.
    pub fn reader(&self) -> ProjectReader {
        ProjectReader::new(self.store.clone())
    }

    /// The receipt of a send (ChatHost.sendStatus): `{ sessionId }` once a message with this clientMessageId is saved
    /// or queued, else null. A resend with the same id finds it and must not run twice.
    pub fn send_status(&self, client_message_id: &str) -> Result<Value> {
        self.reader().send_status(client_message_id)
    }

    /// project-store.cjs readProjectState as the owner runs it: a hot journal is rolled back, the detail sidecars
    /// compaction moved are written, and what chats.db holds becomes the saved rows the next save compares against.
    pub fn load(&mut self) -> Result<ProjectStateRead> {
        Ok(self.load_shared()?.1)
    }

    // ---- content-addressed files (project-content.cjs) -------------------------------------------------------

    /// contentDirectory: `<realpath(project)>/.milagre/<folder>`, made if missing, refused if it resolves elsewhere.
    fn content_directory(&self, folder: &str) -> Result<PathBuf> {
        let outside =
            || StoreError::Invalid("Project content directory is outside the Project".into());
        let root = std::fs::canonicalize(self.root())
            .map_err(|error| StoreError::io(error, "realpath", self.root()))?;
        let metadata = root.join(".milagre");
        std::fs::create_dir_all(&metadata)
            .map_err(|error| StoreError::io(error, "mkdir", &metadata))?;
        let real = std::fs::canonicalize(&metadata)
            .map_err(|error| StoreError::io(error, "realpath", &metadata))?;
        if !inside(&root, &real) {
            return Err(outside());
        }
        let directory = metadata.join(folder);
        std::fs::create_dir_all(&directory)
            .map_err(|error| StoreError::io(error, "mkdir", &directory))?;
        let real = std::fs::canonicalize(&directory)
            .map_err(|error| StoreError::io(error, "realpath", &directory))?;
        if !inside(&metadata, &real) {
            return Err(outside());
        }
        Ok(directory)
    }

    /// writeContent: an immutable `<sha256>.<extension>` file, written to a private temporary file and hard-linked
    /// into place, so a reader never sees half of it and an existing file is checked, never replaced.
    fn write_content(&self, folder: &str, bytes: &[u8], extension: &str) -> Result<PathBuf> {
        use std::os::unix::fs::OpenOptionsExt;
        self.verify_owned()?;
        let directory = self.content_directory(folder)?;
        let name = format!("{}.{extension}", sha256_hex(bytes));
        let file = directory.join(&name);
        let temporary = directory.join(format!(".{name}.{}.tmp", ownership::random_uuid()));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .and_then(|mut handle| std::io::Write::write_all(&mut handle, bytes))
            .map_err(|error| StoreError::io(error, "open", &temporary))?;
        let linked = match std::fs::hard_link(&temporary, &file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let same = std::fs::canonicalize(&file)
                    .ok()
                    .filter(|real| inside(&directory, real))
                    .and_then(|real| std::fs::read(real).ok())
                    .is_some_and(|existing| sha256_hex(&existing) == sha256_hex(bytes));
                if same {
                    Ok(())
                } else {
                    Err(StoreError::ContentMismatch(file.clone()))
                }
            }
            Err(error) => Err(StoreError::io2(error, "link", &temporary, &file)),
        };
        let _ = std::fs::remove_file(&temporary);
        linked.map(|_| file)
    }

    /// sweepContent: removes `<sha256>.json` files of `.milagre/<folder>` no saved state references, older than
    /// `min_age`. Best effort, like Node: a leftover costs disk, never data.
    fn sweep(
        &self,
        folder: &str,
        referenced: &HashSet<String>,
        min_age: Duration,
        now: SystemTime,
    ) -> u64 {
        let Ok(root) = std::fs::canonicalize(self.root()) else {
            return 0;
        };
        let metadata = root.join(".milagre");
        let directory = metadata.join(folder);
        let Ok(real) = std::fs::canonicalize(&directory) else {
            return 0;
        };
        if real != directory
            || !std::fs::canonicalize(&metadata).is_ok_and(|real| inside(&root, &real))
        {
            return 0;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_sidecar_name(&name) || referenced.contains(&name) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            let age = meta
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .unwrap_or(Duration::ZERO);
            if !meta.is_file() || age < min_age {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    // ---- saveProjectState steps ------------------------------------------------------------------------------

    /// image-input.cjs decodeImages for one image: `(mime, bytes)`.
    pub(crate) fn decode_image(image: &Value) -> std::result::Result<(String, Vec<u8>), String> {
        let size_error = || {
            format!(
                "Each image must be {} MiB or smaller.",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            )
        };
        let Some(url) = image.get("dataUrl").and_then(Value::as_str) else {
            return Err(size_error());
        };
        if jsjson::utf16_len(url) > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 100 {
            return Err(size_error());
        }
        let type_error = || "Use PNG, JPEG, WebP, or GIF images.".to_string();
        let rest = url.strip_prefix("data:").ok_or_else(type_error)?;
        let (mime, payload) = rest.split_once(";base64,").ok_or_else(type_error)?;
        let base64_ok = {
            let trimmed = payload.trim_end_matches('=');
            !trimmed.is_empty()
                && payload.len() - trimmed.len() <= 2
                && trimmed
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
        };
        if mime.is_empty()
            || mime.contains([';', ','])
            || !base64_ok
            || !IMAGE_TYPES.contains(&mime)
        {
            return Err(type_error());
        }
        let lenient = base64::engine::GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
                .with_decode_allow_trailing_bits(true),
        );
        let invalid = || "Invalid image data.".to_string();
        let bytes = lenient.decode(payload).map_err(|_| invalid())?;
        if bytes.is_empty()
            || bytes.len() > MAX_ATTACHMENT_BYTES
            || base64::engine::general_purpose::STANDARD.encode(&bytes) != payload
        {
            return Err(invalid());
        }
        let valid = match mime {
            "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
            "image/jpeg" => bytes.len() >= 3 && bytes[..3] == [255, 216, 255],
            "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            _ => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        };
        if !valid {
            return Err("The pasted file is not a valid supported image.".into());
        }
        Ok((mime.to_string(), bytes))
    }

    /// storeImages for one image.
    fn store_image(&self, image: &Value) -> Result<Value> {
        let (mime, bytes) = Self::decode_image(image).map_err(StoreError::Invalid)?;
        let extension = if mime == "image/jpeg" {
            "jpg".to_string()
        } else {
            mime["image/".len()..].to_string()
        };
        let stored = self.write_content("images", &bytes, &extension)?;
        let mut rest = image.as_object().cloned().unwrap_or_default();
        rest.shift_remove("dataUrl");
        let uploaded = rest.shift_remove("path");
        let source = image
            .get("sourcePath")
            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()));
        let original = source.cloned().or(uploaded);
        rest.insert(
            "path".into(),
            Value::String(jsjson::js_string(&stored.to_string_lossy())),
        );
        if jsjson::truthy(original.as_ref()) {
            rest.insert("sourcePath".into(), original.unwrap());
        }
        Ok(Value::Object(rest))
    }

    /// migrateImages: inline `dataUrl` images become files; one that can't be stored stays as it is. When any image
    /// was stored, every message that had inline images is a new message (Node rebuilds them all); otherwise all stay.
    fn migrate_images(&self, messages: &[MsgRef]) -> Vec<MsgRef> {
        let mut changed = false;
        let mut out: Vec<MsgRef> = Vec::with_capacity(messages.len());
        for message in messages {
            let images = match message.get("images") {
                Some(Value::Array(images))
                    if images
                        .iter()
                        .any(|image| image.get("dataUrl").is_some_and(Value::is_string)) =>
                {
                    images
                }
                _ => {
                    out.push(message.clone());
                    continue;
                }
            };
            let mut stored = Vec::with_capacity(images.len());
            for image in images {
                if !image.get("dataUrl").is_some_and(Value::is_string) {
                    stored.push(image.clone());
                    continue;
                }
                match self.store_image(image) {
                    Ok(image) => {
                        stored.push(image);
                        changed = true;
                    }
                    Err(_) => stored.push(image.clone()),
                }
            }
            let mut value = message.value().as_object().cloned().unwrap_or_default();
            value.insert("images".into(), Value::Array(stored));
            out.push(Msg::new(Value::Object(value)));
        }
        if changed {
            out
        } else {
            messages.to_vec()
        }
    }

    /// compactDetails with sidecar writes: long details of finished steps move to `.milagre/details`. Messages in
    /// `known` (by identity: compacted already) are skipped, as compactProjectDetails passes `previous`.
    pub(crate) fn compact_details(
        &self,
        messages: &[MsgRef],
        known: Option<&HashSet<*const Msg>>,
    ) -> Result<(Vec<MsgRef>, bool)> {
        let mut wrote = false;
        let mut out = Vec::with_capacity(messages.len());
        for message in messages {
            if known.is_some_and(|known| known.contains(&Arc::as_ptr(message))) {
                out.push(message.clone());
                continue;
            }
            match self.store.compact_message(message.value()) {
                Some((compacted, _, details)) => {
                    self.write_content(
                        "details",
                        jsjson::to_string(&Value::Object(details)).as_bytes(),
                        "json",
                    )?;
                    wrote = true;
                    out.push(Msg::new(compacted));
                }
                None => out.push(message.clone()),
            }
        }
        Ok((out, wrote))
    }

    /// compactSubagents: each subagent's full transcript in a sidecar, the state keeping its last entry (1000 code
    /// units) marked `compact`. Returns the state, the digests to settle once it is saved, and whether it wrote.
    fn compact_subagents(&self, state: &Value) -> Result<(Value, HashMap<String, String>, bool)> {
        let mut next = HashMap::new();
        let mut wrote = false;
        let Some(Value::Object(sessions)) = state.get("sessions") else {
            return Ok((state.clone(), next, false));
        };
        let known = self.settled.as_ref();
        let mut existing: Option<HashSet<String>> = None;
        let mut out = Map::new();
        for (id, session) in jsjson::js_entries(sessions) {
            let agents = match session.get("subagents") {
                Some(Value::Array(agents)) if !agents.is_empty() => agents,
                _ => {
                    out.insert(id.clone(), session.clone());
                    continue;
                }
            };
            let mut compacted = Vec::with_capacity(agents.len());
            for agent in agents {
                let transcript = match agent.get("transcript") {
                    Some(Value::Array(transcript)) if !transcript.is_empty() => transcript,
                    _ => {
                        compacted.push(agent.clone());
                        continue;
                    }
                };
                let bytes = jsjson::to_string(&Value::Array(transcript.clone()));
                let hash = sha256_hex(bytes.as_bytes());
                let key = format!("{id}/{}", jsjson::property_key(agent.get("id")));
                let name = format!("{hash}.json");
                let remembered = known.and_then(|known| known.get(&key)) == Some(&hash);
                if remembered && existing.is_none() {
                    existing = Some(
                        std::fs::read_dir(self.root().join(".milagre").join("subagents"))
                            .map(|entries| {
                                entries
                                    .flatten()
                                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                                    .collect()
                            })
                            .unwrap_or_default(),
                    );
                }
                if !remembered || !existing.as_ref().is_some_and(|names| names.contains(&name)) {
                    self.write_content("subagents", bytes.as_bytes(), "json")?;
                    wrote = true;
                }
                next.insert(key, hash);
                let mut refs: Vec<Value> = Vec::new();
                let listed = match agent.get("transcriptFiles") {
                    Some(Value::Array(items)) => items.clone(),
                    _ => Vec::new(),
                };
                for candidate in listed.iter().chain(agent.get("transcriptFile")) {
                    let usable = jsjson::truthy(Some(candidate))
                        && candidate.as_str() != Some(name.as_str());
                    if usable
                        && !refs
                            .iter()
                            .any(|known| jsjson::strict_equals(known, candidate))
                    {
                        refs.push(candidate.clone());
                    }
                }
                let last = transcript.last().expect("not empty");
                let text = last.get("text").and_then(Value::as_str).ok_or_else(|| {
                    StoreError::Invalid(
                        "Cannot read properties of a subagent transcript entry without text".into(),
                    )
                })?;
                let units = jsjson::to_utf16(text);
                let tail = jsjson::from_utf16(&units[units.len().saturating_sub(1000)..]);
                let mut entry = last.as_object().cloned().unwrap_or_default();
                entry.insert("text".into(), Value::String(tail));
                entry.insert("compact".into(), Value::Bool(true));
                let mut slim = agent.as_object().cloned().unwrap_or_default();
                slim.insert("transcriptFile".into(), Value::String(name));
                if !refs.is_empty() {
                    slim.insert("transcriptFiles".into(), Value::Array(refs));
                }
                slim.insert(
                    "transcript".into(),
                    Value::Array(vec![Value::Object(entry)]),
                );
                compacted.push(Value::Object(slim));
            }
            let mut session = session.as_object().cloned().unwrap_or_default();
            session.insert("subagents".into(), Value::Array(compacted));
            out.insert(id.clone(), Value::Object(session));
        }
        let mut state = state.clone();
        state["sessions"] = Value::Object(out);
        Ok((state, next, wrote))
    }

    /// Writes coordination.json through `coordination.json.<pid>.<n>.tmp` and a rename; the temporary file is removed
    /// when anything fails.
    fn write_state_file(&self, contents: &str, durable: bool) -> Result<()> {
        self.verify_owned()?;
        let file = state_file(self.root());
        let directory = file.parent().expect("inside .milagre").to_path_buf();
        std::fs::create_dir_all(&directory)
            .map_err(|error| StoreError::io(error, "mkdir", &directory))?;
        let temporary = directory.join(format!(
            "coordination.json.{}.{}.tmp",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst) + 1
        ));
        let result = (|| {
            if durable {
                let mut handle = std::fs::File::create(&temporary)
                    .map_err(|error| StoreError::io(error, "open", &temporary))?;
                std::io::Write::write_all(&mut handle, contents.as_bytes())
                    .map_err(|error| StoreError::io(error, "write", &temporary))?;
                handle
                    .sync_all()
                    .map_err(|error| StoreError::io(error, "fsync", &temporary))?;
            } else {
                std::fs::write(&temporary, contents)
                    .map_err(|error| StoreError::io(error, "open", &temporary))?;
            }
            std::fs::rename(&temporary, &file)
                .map_err(|error| StoreError::io2(error, "rename", &temporary, &file))?;
            if durable {
                // syncDirectory: best effort.
                if let Ok(handle) = std::fs::File::open(&directory) {
                    let _ = handle.sync_all();
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

impl MessageRepository for OwnedProject {
    fn read_rows(&self) -> Result<Option<Vec<Row>>> {
        self.store.chats().read_rows()
    }
    fn read_chat_rows(&self, chats: &[ChatId]) -> Result<Vec<Row>> {
        self.store.chats().read_chat_rows(chats)
    }
    fn read_chat_bodies(&self, chats: &[ChatId]) -> Result<Vec<Row>> {
        self.store.chats().read_chat_bodies(chats)
    }
    fn read_chat_previews(&self, chats: &[ChatId]) -> Result<Vec<Preview>> {
        self.store.chats().read_chat_previews(chats)
    }
    fn read_chat_marks(&self, chats: &[ChatId]) -> Result<Vec<Row>> {
        self.store.chats().read_chat_marks(chats)
    }
    fn read_chat_rows_containing(&self, chats: &[ChatId], needles: &[String]) -> Result<Vec<Row>> {
        self.store.chats().read_chat_rows_containing(chats, needles)
    }
    fn read_positions(&self, ids: &[Value]) -> Result<Vec<(Value, Value, Value)>> {
        self.store.chats().read_positions(ids)
    }
    fn find_row(&self, chats: &[ChatId], field: LookupField, value: &Value) -> Result<Option<Row>> {
        self.store.chats().find_row(chats, field, value)
    }
    fn read_detail_refs(&self, chats: &[ChatId]) -> Result<BTreeSet<String>> {
        self.store.chats().read_detail_refs(chats)
    }
}

impl ProjectRepository for OwnedProject {
    fn read_raw(&self) -> Result<Value> {
        self.store.read_raw()
    }
    fn read_project_state(&self) -> Result<ProjectStateRead> {
        self.store.read_project_state()
    }
    fn read_project_state_uncompacted(&self) -> Result<ProjectStateRead> {
        self.store.read_project_state_uncompacted()
    }
    fn with_details_from(
        &self,
        message: &Value,
        pending: &[(String, Map<String, Value>)],
    ) -> Value {
        self.store.with_details_from(message, pending)
    }
}

/// How a save decides a message is unchanged since it was saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Same {
    /// Node's `===`: the same message object (the runtime's states, see message_store.rs).
    Identity,
    /// Equal values (callers that hand over plain JSON, where identity means nothing).
    Value,
}

impl Same {
    fn eq(self, a: &MsgRef, b: &MsgRef) -> bool {
        match self {
            Same::Identity => Arc::ptr_eq(a, b),
            Same::Value => Arc::ptr_eq(a, b) || a.value() == b.value(),
        }
    }
}

struct Known {
    id: Value,
    chat: Value,
    position: f64,
    message: Option<MsgRef>,
}

impl OwnedProject {
    /// The saved rows and chats.db, for the message cache (message_store.rs) that shares them with the writer.
    pub(crate) fn cache(&mut self) -> (&ChatDb, &mut MessageStore) {
        (self.store.chats(), &mut self.messages)
    }

    pub(crate) fn chats(&self) -> &ChatDb {
        self.store.chats()
    }

    /// chat-db.cjs writeMessages over shared messages.
    pub(crate) fn write_rows(
        &self,
        messages: &[MsgRef],
        saved: Option<&SavedMsgs>,
        options: &WriteOptions,
        same: Same,
    ) -> Result<(SavedMsgs, WriteStats)> {
        self.verify_owned()?;
        let connection = self.store.chats().open_writable(true)?.expect("created");
        connection.execute_batch(&format!(
            "PRAGMA synchronous = {}",
            if options.durable { "FULL" } else { "NORMAL" }
        ))?;
        let mut stats = WriteStats::default();
        let mut writes: Vec<(String, SavedRow)> = Vec::new();
        let mut removals: Vec<String> = Vec::new();
        let mut renumbered: Option<HashMap<String, Value>> = None;
        connection.execute_batch("BEGIN")?;
        let work = (|| -> Result<()> {
            let known: Vec<(String, Known)> = match saved {
                Some(saved) => saved
                    .iter()
                    .map(|(key, row)| {
                        let known = Known {
                            id: row.msg.get("id").cloned().unwrap_or(Value::Null),
                            chat: row.chat.clone(),
                            position: row.position(),
                            message: Some(row.msg.clone()),
                        };
                        (key.clone(), known)
                    })
                    .collect(),
                None => {
                    let mut statement =
                        connection.prepare("SELECT id, session_id, position FROM messages")?;
                    let mut rows = statement.query([])?;
                    let mut out = Vec::new();
                    while let Some(row) = rows.next()? {
                        let id = sql_value(row.get_ref(0)?);
                        let known = Known {
                            chat: sql_value(row.get_ref(1)?),
                            position: number_of(&sql_value(row.get_ref(2)?)),
                            message: None,
                            id: id.clone(),
                        };
                        out.push((id_key(Some(&id)), known));
                    }
                    out
                }
            };
            let known_index: HashMap<&str, usize> = known
                .iter()
                .enumerate()
                .map(|(index, (key, _))| (key.as_str(), index))
                .collect();
            // A message the map lacks but chats.db has (a Chat loaded while the save that made the map ran) keeps its
            // row's place instead of moving after every row.
            let mut found: HashMap<String, Known> = HashMap::new();
            if let Some(saved) = saved {
                let unknown: Vec<Value> = messages
                    .iter()
                    .filter(|message| !saved.contains_key(&message.key()))
                    .map(|message| message.get("id").cloned().unwrap_or(Value::Null))
                    .collect();
                if !unknown.is_empty() {
                    let mut statement = connection.prepare("SELECT id, session_id, position FROM messages WHERE id IN (SELECT value FROM json_each(?))")?;
                    let mut rows = statement.query([jsjson::to_string(&Value::Array(unknown))])?;
                    while let Some(row) = rows.next()? {
                        let id = sql_value(row.get_ref(0)?);
                        let known = Known {
                            chat: sql_value(row.get_ref(1)?),
                            position: number_of(&sql_value(row.get_ref(2)?)),
                            message: None,
                            id: id.clone(),
                        };
                        found.insert(id_key(Some(&id)), known);
                    }
                }
            }
            let mut top: f64 = connection
                .query_row("SELECT MAX(position) AS top FROM messages", [], |row| {
                    Ok(sql_value(row.get_ref(0)?))
                })?
                .as_f64()
                .unwrap_or(-1.0);
            let mut upsert = connection.prepare(
                "INSERT INTO messages (id, session_id, position, client_message_id, operation_id, payload) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, position = excluded.position,
           client_message_id = excluded.client_message_id, operation_id = excluded.operation_id, payload = excluded.payload",
            )?;
            let mut previous = f64::NEG_INFINITY;
            let mut ids: HashSet<String> = HashSet::new();
            for message in messages {
                let key = message.key();
                let last = known_index
                    .get(key.as_str())
                    .map(|index| &known[*index].1)
                    .or_else(|| found.get(&key));
                let position = match last {
                    Some(last) if last.position > previous => last.position,
                    _ => {
                        top += 1.0;
                        top
                    }
                };
                previous = position;
                ids.insert(key.clone());
                let unchanged = last.is_some_and(|last| {
                    last.message
                        .as_ref()
                        .is_some_and(|known| same.eq(known, message))
                        && last.position == position
                });
                if !unchanged {
                    let params = vec![
                        bind_defined(message.get("id"), 1)?,
                        bind_or_null(message.get("session_id"), 2)?,
                        rusqlite::types::Value::Real(position),
                        bind_or_null(message.get("clientMessageId"), 4)?,
                        bind_or_null(message.get("operationId"), 5)?,
                        // JSON.stringify output: plain text, unpaired surrogates already escaped as \udxxx.
                        rusqlite::types::Value::Text(jsjson::to_string(message.value())),
                    ];
                    upsert.execute(params_from_iter(params))?;
                    stats.written += 1;
                }
                let chat = message.get("session_id").cloned().unwrap_or(Value::Null);
                writes.push((
                    key,
                    SavedRow {
                        msg: message.clone(),
                        position: jsjson::number(position),
                        chat,
                    },
                ));
            }
            let mut remove = connection.prepare("DELETE FROM messages WHERE id = ?")?;
            let kept = |chat: &Value| {
                chat.as_f64()
                    .is_some_and(|chat| options.keep.iter().any(|keep| *keep as f64 == chat))
            };
            for (key, row) in &known {
                if !ids.contains(key) && !kept(&row.chat) {
                    remove.execute([bind_js(&row.id, 1)?])?;
                    removals.push(key.clone());
                    stats.removed += 1;
                }
            }
            let mut remove_chat =
                connection.prepare("DELETE FROM messages WHERE session_id = ?")?;
            for chat in &options.drop {
                stats.removed +=
                    remove_chat.execute([rusqlite::types::Value::Real(*chat as f64)])? as u64;
            }
            let (last, count): (Value, i64) = connection.query_row(
                "SELECT MAX(position) AS last, COUNT(*) AS count FROM messages",
                [],
                |row| Ok((sql_value(row.get_ref(0)?), row.get(1)?)),
            )?;
            if count > 0 && last.as_f64() != Some((count - 1) as f64) {
                connection.execute_batch(
                    "WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS rank FROM messages)
            UPDATE messages SET position = ranked.rank FROM ranked WHERE messages.id = ranked.id AND messages.position != ranked.rank",
                )?;
                let mut statement = connection.prepare("SELECT id, position FROM messages")?;
                let mut rows = statement.query([])?;
                let mut map = HashMap::new();
                while let Some(row) = rows.next()? {
                    map.insert(
                        id_key(Some(&sql_value(row.get_ref(0)?))),
                        sql_value(row.get_ref(1)?),
                    );
                }
                renumbered = Some(map);
            }
            connection.execute_batch("COMMIT")?;
            Ok(())
        })();
        if let Err(error) = work {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }
        let mut next = saved.cloned().unwrap_or_default();
        for key in &removals {
            next.remove(key);
        }
        for (key, row) in writes {
            next.insert(key, row);
        }
        if let Some(renumbered) = renumbered {
            stats.renumbered = true;
            for (key, row) in next.iter_mut() {
                if let Some(position) = renumbered.get(key) {
                    row.position = position.clone();
                }
            }
        }
        Ok((next, stats))
    }

    /// project-store.cjs saveProjectState over a state of shared messages (`state.unloaded` gives keep and drop).
    pub(crate) fn save_state(
        &mut self,
        state: &ProjectState,
        options: &SaveOptions,
        same: Same,
    ) -> Result<SaveReport> {
        // Before anything is migrated, compacted or written.
        self.verify_owned()?;
        let messages = state.messages.as_ref().map(|messages| messages.as_slice());
        let migrated = messages.map(|messages| self.migrate_images(messages));
        let (compacted, details_wrote) = match &migrated {
            Some(messages) => {
                let (messages, wrote) = self.compact_details(messages, None)?;
                (Some(messages), wrote)
            }
            None => (None, false),
        };
        let (rest, settle, subagents_wrote) =
            self.compact_subagents(&Value::Object((*state.rest).clone()))?;
        let mut rest = rest;
        ProjectStore::without_suggestions(&mut rest);
        let has_session = |value: &Value, chat: &ChatId| {
            value
                .get("sessions")
                .and_then(Value::as_object)
                .is_some_and(|sessions| sessions.contains_key(&chat.to_string()))
        };
        let keep: BTreeSet<ChatId> = state
            .unloaded
            .iter()
            .copied()
            .filter(|chat| has_session(&rest, chat))
            .collect();
        let drop: BTreeSet<ChatId> = state
            .unloaded
            .iter()
            .copied()
            .filter(|chat| !keep.contains(chat))
            .collect();
        let mut stats = WriteStats::default();
        if let Some(messages) = &compacted {
            if self.messages.saved.is_none() {
                // The first save after the move keeps the old file once, beside it, in case anything needs it back.
                let from = state_file(self.root());
                let to = PathBuf::from(format!("{}.before-chats-db", from.display()));
                if from.is_file() && !to.exists() {
                    let _ = std::fs::copy(&from, &to);
                }
            }
            let (next, written) = self.write_rows(
                messages,
                self.messages.saved.as_ref(),
                &WriteOptions {
                    durable: options.durable,
                    keep,
                    drop,
                },
                same,
            )?;
            self.messages.saved = Some(next);
            stats = written;
        }
        let contents = if compacted.is_some() {
            let mut marked = rest.clone();
            marked["messages"] = messages_marker();
            jsjson::to_string(&marked)
        } else {
            jsjson::to_string(&rest)
        };
        self.write_state_file(&contents, options.durable)?;
        self.settled = Some(settle);
        let wrote = details_wrote || subagents_wrote;
        if wrote || !self.swept {
            self.swept = true;
            let mut sidecars = HashSet::new();
            if let Some(Value::Object(sessions)) = rest.get("sessions") {
                for session in sessions.values() {
                    for agent in session
                        .get("subagents")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        let listed = agent
                            .get("transcriptFiles")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        for name in agent.get("transcriptFile").into_iter().chain(listed.iter()) {
                            if let Value::String(name) = name {
                                sidecars.insert(name.clone());
                            }
                        }
                    }
                }
            }
            let now = options.now.unwrap_or_else(SystemTime::now);
            self.sweep("subagents", &sidecars, options.sweep_min_age, now);
            let mut details: HashSet<String> = compacted
                .iter()
                .flatten()
                .filter_map(|message| {
                    message
                        .get("detailFile")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect();
            // The messages of an unloaded Chat point at sidecars too, from their rows.
            let readable: Vec<ChatId> = state
                .unloaded
                .iter()
                .copied()
                .filter(|chat| state.has_session(*chat))
                .collect();
            details.extend(
                self.store
                    .chats()
                    .read_detail_refs(&readable)
                    .unwrap_or_default(),
            );
            self.sweep("details", &details, options.sweep_min_age, now);
        }
        Ok(SaveReport {
            rows_written: stats.written,
            rows_removed: stats.removed,
            sidecars_written: wrote,
            state_bytes: contents.len() as u64,
        })
    }

    /// readProjectState as the owner runs it, keeping the messages shared with the saved rows (as Node's are): a hot
    /// journal is rolled back, the detail sidecars compaction moved are written.
    pub fn load_shared(&mut self) -> Result<(ProjectState, ProjectStateRead)> {
        self.verify_owned()?;
        self.messages.saved = None;
        let read = ProjectRepository::read_project_state_uncompacted(&self.store)?;
        let mut state = ProjectState::from_value(&read.state);
        if read.storage == MessageStorage::ChatsDb {
            let rows = self.store.chats().read_rows()?.unwrap_or_default();
            let mut saved = SavedMsgs::new();
            for (row, message) in rows.into_iter().zip(state.message_list().iter()) {
                saved.insert(
                    message.key(),
                    SavedRow {
                        msg: message.clone(),
                        position: row.position,
                        chat: row.chat,
                    },
                );
            }
            self.messages.saved = Some(saved);
        }
        self.messages.unloaded = false;
        let (compacted, _) = self.compact_details(state.message_list(), None)?;
        let pending: Vec<Value> = state
            .message_list()
            .iter()
            .zip(&compacted)
            .filter(|(before, after)| !Arc::ptr_eq(before, after))
            .map(|(before, _)| before.get("id").cloned().unwrap_or(Value::Null))
            .collect();
        if state.messages.is_some() {
            state = state.with_messages(compacted);
        }
        let read = ProjectStateRead {
            state: state.to_value(),
            storage: read.storage,
            pending_detail_compaction: pending,
            pending_sidecars: Vec::new(),
        };
        Ok((state, read))
    }
}

impl MessageStoreWriter for OwnedProject {
    fn write_messages(
        &mut self,
        messages: &[Value],
        saved: Option<&SavedRows>,
        options: &WriteOptions,
    ) -> Result<(SavedRows, WriteStats)> {
        let messages: Vec<MsgRef> = messages.iter().cloned().map(Msg::new).collect();
        let saved: Option<SavedMsgs> = saved.map(|saved| {
            saved
                .iter()
                .map(|(key, row)| {
                    (
                        key.clone(),
                        SavedRow {
                            msg: Msg::new(row.message.clone()),
                            position: row.position.clone(),
                            chat: row.chat.clone(),
                        },
                    )
                })
                .collect()
        });
        let (next, stats) = self.write_rows(&messages, saved.as_ref(), options, Same::Value)?;
        Ok((to_rows(&next), stats))
    }
}

fn to_rows(saved: &SavedMsgs) -> SavedRows {
    saved
        .iter()
        .map(|(key, row)| {
            (
                key.clone(),
                Row {
                    message: row.msg.value().clone(),
                    position: row.position.clone(),
                    chat: row.chat.clone(),
                },
            )
        })
        .collect()
}

impl ProjectStateWriter for OwnedProject {
    fn save_project_state(&mut self, state: &Value, options: &SaveOptions) -> Result<SaveReport> {
        let mut shared = ProjectState::from_value(state);
        shared.unloaded = std::sync::Arc::new(options.unloaded.clone());
        self.save_state(&shared, options, Same::Value)
    }
}
