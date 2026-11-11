//! Saved Artifact reads and Design edits require verified ownership of isolated copies.
use crate::ReadBackend;
use milagre_content_store::{design::raster::RasterRenderer, Error as ContentError, SystemRuntime};
use milagre_owner_store::{
    jsjson,
    ownership::{OwnerGuard, RustOwnerLock},
    write::OwnerLock,
    Isolation,
};
use milagre_owner_wire::{RpcError, RpcResult};
use milagre_tools::{Caller, ContentOwner, DesignScope, Dispatcher};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
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
        if let Err(error) = verify_owner(&self.guard.lock().unwrap()) {
            self.fail();
            return Err(error);
        }
        Ok(())
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
    owner: Mutex<Option<Arc<ContentOwner>>>,
    raster: Option<Arc<RasterRenderer>>,
    authority: Arc<Authority>,
    isolation: Isolation,
    opened: Arc<Mutex<Vec<String>>>,
}
impl ArtifactService {
    pub fn new(
        isolation: Isolation,
        backend: Arc<dyn ReadBackend>,
        opened: Arc<Mutex<Vec<String>>>,
        raster: Option<Arc<RasterRenderer>>,
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
            owner: Mutex::new(None),
            raster,
            authority: Arc::new(Authority {
                guard: Mutex::new(guard),
                backend,
                active: AtomicBool::new(true),
            }),
            isolation,
            opened,
        })
    }
    fn owner(&self) -> Result<Arc<ContentOwner>, ContentError> {
        self.authority.check()?;
        let mut owner = self.owner.lock().unwrap();
        if let Some(owner) = owner.as_ref() {
            return Ok(owner.clone());
        }
        let backend = self.authority.backend.clone();
        let opened = self.opened.clone();
        let authority = self.authority.clone();
        let created = ContentOwner::open(
            self.isolation.clone(),
            PathBuf::from("artifacts"),
            PathBuf::from("design-kits"),
            Arc::new(move |chat| validate_chat(&backend, &opened, chat)),
            Arc::new(move || authority.check()),
            Arc::new(SystemRuntime),
            self.raster.clone(),
        )?;
        *owner = Some(created.clone());
        Ok(created)
    }
    fn caller(
        &self,
        chat: &str,
        write: bool,
        design_scope: DesignScope,
        revocation: Option<Arc<AtomicBool>>,
    ) -> Result<Caller, ContentError> {
        self.authority.check()?;
        let project = match validate_chat(&self.authority.backend, &self.opened, chat) {
            Ok(project) => project,
            Err(error) => {
                if fatal(&error) {
                    self.authority.fail();
                }
                return Err(error);
            }
        };
        let authority = self.authority.clone();
        let opened = self.opened.clone();
        let grant_chat = chat.to_owned();
        Ok(Caller {
            chat_id: chat.into(),
            project_id: project.clone(),
            roots: vec![PathBuf::from(project)],
            read: true,
            write,
            html: true,
            designs: true,
            kits: true,
            design_scope,
            bundled_skills: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/core/src/bundled-skills"),
            assert_active: Arc::new(move || {
                authority.check()?;
                if revocation
                    .as_ref()
                    .is_some_and(|active| !active.load(Ordering::Acquire))
                {
                    return Err(ContentError::coded(
                        "GRANT_REVOKED",
                        "This fixture tool grant was revoked",
                    ));
                }
                if let Err(error) = validate_chat(&authority.backend, &opened, &grant_chat) {
                    if fatal(&error) {
                        authority.fail();
                    }
                    return Err(error);
                }
                Ok(())
            }),
        })
    }
    pub fn invoke(&self, method: &str, request: &Value) -> RpcResult {
        self.authority.running().map_err(convert)?;
        let chat = request["chatId"].as_str().ok_or_else(invalid_chat)?;
        let caller = self
            .caller(chat, true, DesignScope::All, None)
            .map_err(convert)?;
        let result = self.owner().and_then(|owner| {
            let scope =
                owner.renderer_scope(&caller.chat_id, &caller.project_id, caller.assert_active)?;
            owner.renderer(&scope, method, request)
        });
        if result.as_ref().is_err_and(fatal) {
            self.authority.fail();
        }
        result.map_err(convert)
    }
    pub fn tool_session(
        &self,
        chat: &str,
        write: bool,
        scope: DesignScope,
        active: Arc<AtomicBool>,
    ) -> Result<Dispatcher, RpcError> {
        let caller = self
            .caller(chat, write, scope, Some(active))
            .map_err(convert)?;
        self.owner()
            .and_then(|owner| owner.session(caller))
            .map_err(convert)
    }
    pub fn shutdown(&self) -> Result<(), RpcError> {
        self.authority.fail();
        if let Some(owner) = self.owner.lock().unwrap().take() {
            owner.shutdown();
        }
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
