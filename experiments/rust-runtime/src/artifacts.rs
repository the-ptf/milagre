//! Saved Artifact reads and Design edits require verified ownership of isolated copies.
use crate::ReadBackend;
use milagre_content_store::{
    design::{self, DesignKits},
    ArtifactStore, Error as ContentError, SystemRuntime,
};
use milagre_owner_store::{
    jsjson,
    ownership::{OwnerGuard, RustOwnerLock},
    write::OwnerLock,
    Isolation,
};
use milagre_owner_wire::{RpcError, RpcResult};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
include!(concat!(env!("OUT_DIR"), "/artifact-fixtures.rs"));
pub const METHODS: &[&str] = &[
    "artifact:list",
    "artifact:get",
    "artifact:asset",
    "artifact:comments",
    "artifact:apply",
];

struct Authority {
    guard: Mutex<OwnerGuard>,
    backend: Arc<dyn ReadBackend>,
    scope: Mutex<Option<String>>,
    active: AtomicBool,
}
impl Authority {
    fn running(&self) -> Result<(), ContentError> {
        if !self.active.load(Ordering::Acquire) {
            return Err(ContentError::coded(
                "CONTENT_OWNER_INACTIVE",
                "The isolated Artifact owner stopped after an ownership or storage failure",
            ));
        }
        Ok(())
    }
    fn check(&self) -> Result<(), ContentError> {
        self.running()?;
        verify_owner(&self.guard.lock().unwrap())?;
        let scope = self.scope.lock().unwrap().clone().ok_or_else(|| {
            ContentError::coded(
                "OWNERSHIP_UNVERIFIED",
                "Choose an owned fixture Chat before reading its Artifacts",
            )
        })?;
        self.backend
            .assert_owned(&scope)
            .map_err(|error| ContentError::coded(&error.code, error.message))
    }
    fn fail(&self) {
        self.active.store(false, Ordering::Release);
    }
}
fn verify_owner(guard: &OwnerGuard) -> Result<(), ContentError> {
    guard
        .verify()
        .map_err(|error| ContentError::coded("OWNERSHIP_LOST", error.to_string()))
}

pub struct ArtifactService {
    store: Mutex<Option<ArtifactStore>>,
    kits: Mutex<Option<DesignKits>>,
    authority: Arc<Authority>,
    isolation: Isolation,
    opened: Arc<Mutex<Vec<String>>>,
}
impl ArtifactService {
    pub fn new(
        isolation: Isolation,
        backend: Arc<dyn ReadBackend>,
        opened: Arc<Mutex<Vec<String>>>,
    ) -> Result<Self, RpcError> {
        // Fixture bootstrap copies only recorded Node bytes before the content store has a writer.
        let alpha = backend
            .projects()
            .into_iter()
            .find(|info| info.name == "alpha")
            .expect("embedded alpha fixture");
        let folder = isolation
            .root()
            .join("artifacts")
            .join(milagre_content_store::chat_hash(&format!(
                "{}#1",
                alpha.path
            )));
        for (relative, bytes) in ARTIFACT_FILES {
            let file = folder.join(
                relative
                    .strip_suffix(".fixture")
                    .expect("recorded Node fixture suffix"),
            );
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(file.parent().unwrap())?;
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(file)?
                .write_all(bytes)?;
        }
        let kit_directory = isolation
            .root()
            .join("design-kits")
            .join(hex::encode(Sha256::digest(alpha.path.as_bytes())));
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&kit_directory)?;
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(kit_directory.join("project.json"))?
            .write_all(include_bytes!(
                "../fixtures/design-kits/alpha/project.json.fixture"
            ))?;
        let guard = RustOwnerLock
            .acquire(&isolation.root().join("artifact-owner.lock"))
            .map_err(|error| RpcError::new("CONTENT_OWNERSHIP", error.to_string()))?;
        Ok(Self {
            store: Mutex::new(None),
            kits: Mutex::new(None),
            authority: Arc::new(Authority {
                guard: Mutex::new(guard),
                backend,
                scope: Mutex::new(None),
                active: AtomicBool::new(true),
            }),
            isolation,
            opened,
        })
    }
    pub fn invoke(&self, method: &str, request: &Value) -> RpcResult {
        self.authority.running().map_err(convert)?;
        // Match the production scope rule: a real Chat in a Project this owner already has open.
        let chat = request["chatId"].as_str().ok_or_else(invalid_chat)?;
        let scope = match validate_chat(&self.authority.backend, &self.opened, chat) {
            Ok(scope) => scope,
            Err(error) => {
                if fatal(&error) {
                    self.authority.fail();
                }
                return Err(convert(error));
            }
        };
        let mut store = self.store.lock().unwrap();
        *self.authority.scope.lock().unwrap() = Some(scope);
        let outcome = (|| {
            self.authority.check()?;
            if store.is_none() {
                let backend = self.authority.backend.clone();
                let opened = self.opened.clone();
                let authority = self.authority.clone();
                *store = Some(ArtifactStore::open(
                    self.isolation.clone(),
                    Path::new("artifacts"),
                    Arc::new(move |chat| validate_chat(&backend, &opened, chat).map(|_| ())),
                    Arc::new(move || authority.check()),
                    Arc::new(SystemRuntime),
                )?);
            }
            let store = store.as_mut().unwrap();
            let result = match method {
                "artifact:list" => store.list(request),
                "artifact:get" => store.get(request),
                "artifact:asset" => store.asset(request),
                "artifact:comments" => store.comments(request),
                "artifact:apply" => {
                    let reader = |request: &Value| self.read_kit(request);
                    let prepared = store.prepare_design_apply(request, &reader)?;
                    store.commit_design(prepared, &reader, &design::render_html)
                }
                _ => {
                    return Err(ContentError::coded(
                        "COMMAND_FAILED",
                        format!("Unknown command: {method}"),
                    ))
                }
            }?;
            self.authority.check()?;
            Ok(result)
        })();
        if outcome.as_ref().is_err_and(fatal) {
            self.authority.fail();
        }
        outcome.map_err(convert)
    }
    fn read_kit(&self, request: &Value) -> Result<Value, ContentError> {
        self.authority.check()?;
        let mut kits = self.kits.lock().unwrap();
        if kits.is_none() {
            let backend = self.authority.backend.clone();
            let opened = self.opened.clone();
            let authority = self.authority.clone();
            *kits = Some(DesignKits::open(
                self.isolation.clone(),
                Path::new("design-kits"),
                Arc::new(move |chat| validate_chat(&backend, &opened, chat)),
                Arc::new(move || authority.check()),
            )?);
        }
        let value = kits.as_mut().unwrap().read(request)?;
        self.authority.check()?;
        Ok(value)
    }
    pub fn shutdown(&self) -> Result<(), RpcError> {
        self.authority.fail();
        self.store.lock().unwrap().take();
        self.kits.lock().unwrap().take();
        self.authority
            .guard
            .lock()
            .unwrap()
            .release()
            .map_err(|error| RpcError::new("OWNERSHIP_LOST", error.to_string()))
    }
}
fn invalid_chat() -> RpcError {
    RpcError::new(
        "COMMAND_FAILED",
        "Open an existing Chat before showing a design.",
    )
}
fn validate_chat(
    backend: &Arc<dyn ReadBackend>,
    opened: &Arc<Mutex<Vec<String>>>,
    chat: &str,
) -> Result<String, ContentError> {
    let invalid = || ContentError::new("Open an existing Chat before showing a design.");
    let (scope, id) = chat.rsplit_once('#').ok_or_else(invalid)?;
    let number = id
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        .ok_or_else(invalid)?;
    if number.to_string() != id
        || !opened.lock().unwrap().iter().any(|path| path == scope)
        || !backend.projects().iter().any(|info| info.path == scope)
    {
        return Err(invalid());
    }
    backend
        .assert_owned(scope)
        .map_err(|error| ContentError::coded(&error.code, error.message))?;
    let state = backend
        .state(scope)
        .map_err(|error| ContentError::coded(&error.code, error.message))?;
    if state["sessions"]
        .get(id)
        .is_none_or(|session| jsjson::property_key(session.get("id")) != id)
    {
        return Err(invalid());
    }
    Ok(scope.into())
}
fn convert(error: ContentError) -> RpcError {
    RpcError {
        code: if error.code == "CONTENT_ERROR" {
            "COMMAND_FAILED".into()
        } else {
            error.code
        },
        message: error.message,
        details: error.issues.map(|issues| *issues),
    }
}

fn fatal(error: &ContentError) -> bool {
    matches!(
        error.code.as_str(),
        "IO_ERROR"
            | "ENOENT"
            | "STORE_OWNED"
            | "UNSAFE_FILE"
            | "INVALID_CONTENT_STORAGE"
            | "CONTENT_OWNERSHIP"
            | "OWNERSHIP_LOST"
            | "OWNERSHIP_UNVERIFIED"
            | "CONTENT_OWNER_INACTIVE"
    )
}
