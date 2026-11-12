//! Dedicated-root durable schedule CRUD. No timers, claims or routine execution.
//! State preparation is the existing Node-conformant Model; filesystem ownership
//! adapts the copied writer's descriptor-relative primitives without its temp-only lifetime.
mod disk;
#[cfg(test)]
mod tests;
use super::{jsjson, limits, Model};
use serde_json::{json, Value};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

pub type OwnerCheck = Arc<dyn Fn() -> std::result::Result<(), String> + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Busy,
    Ownership,
    Closed,
    Invalid(String),
    Owner(String),
    Io {
        operation: &'static str,
        source: std::io::Error,
    },
    Uncertain {
        cause: Box<Error>,
    },
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("The dedicated routine store already has a writer"),
            Self::Ownership => {
                f.write_str("Dedicated routine store identity or saved bytes changed")
            }
            Self::Closed => f.write_str("The dedicated routine store is closed"),
            Self::Invalid(message) => f.write_str(message),
            Self::Owner(message) => write!(f, "Routine owner refused: {message}"),
            Self::Io { operation, source } => write!(f, "Routine {operation}: {source}"),
            Self::Uncertain { cause } => {
                write!(f, "Routine persistence or cleanup is uncertain: {cause}")
            }
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Uncertain { cause } => Some(cause.as_ref()),
            _ => None,
        }
    }
}
impl From<super::Error> for Error {
    fn from(error: super::Error) -> Self {
        Self::Invalid(error.to_string())
    }
}
fn io(operation: &'static str, source: std::io::Error) -> Error {
    Error::Io { operation, source }
}

/// Only store CRUD/read operations. No execution method can be selected by name.
pub enum Command {
    List,
    Get(String),
    Runs(String),
    Create(Value),
    /// Atomic paused draft: Node create + update(enabled:false) at one clock, one disk publication.
    CreatePaused(Value),
    Update {
        id: String,
        patch: Value,
    },
    Remove(String),
}
impl Command {
    fn wire(self) -> (&'static str, Vec<Value>) {
        match self {
            Self::List => ("list", vec![]),
            Self::Get(id) => ("get", vec![json!(id)]),
            Self::Runs(id) => ("runs", vec![json!(id)]),
            Self::Create(input) | Self::CreatePaused(input) => ("create", vec![input]),
            Self::Update { id, patch } => ("update", vec![json!(id), patch]),
            Self::Remove(id) => ("remove", vec![json!(id)]),
        }
    }
}

/// Only returned after the actual save and owner checks succeed. Effects are
/// returned to the host; this crate does not dispatch them or execute routines.
pub struct StoreReply {
    pub value: Value,
    pub changed: bool,
    pub effects: Vec<Value>,
}

pub struct RoutineStore {
    inner: Option<Box<State>>,
}
struct State {
    disk: disk::Disk,
    model: Model,
    owner: OwnerCheck,
    fenced: Option<String>,
    #[cfg(test)]
    ids: std::collections::VecDeque<String>,
}
impl State {
    fn fence(&mut self, error: &Error) {
        if self.fenced.is_none() {
            self.fenced = Some(error.to_string());
        }
    }
    fn check(&self) -> Result<()> {
        if self.fenced.is_some() || self.disk.uncertain {
            return Err(Error::Uncertain {
                cause: Box::new(Error::Invalid(
                    self.fenced
                        .clone()
                        .unwrap_or_else(|| "persistence has not been confirmed".into()),
                )),
            });
        }
        check_owner(&self.owner)?;
        self.disk.verify()
    }
}
impl RoutineStore {
    /// Open only a marked dedicated `chat-runtime` root. The host callback must
    /// retain and check its real runtime ownership, not infer authority from a path.
    /// This adapter never adopts an installed Milagre profile.
    pub fn open(root: &Path, owner: OwnerCheck, now: i64) -> Result<Self> {
        check_owner(&owner)?;
        let disk = disk::Disk::open(root)?;
        let seed = disk.saved_text()?;
        // Public Values are ordinary UTF-8 JSON. Legacy unpaired-surrogate imports
        // are refused without changing their files; adoption needs a lossless DTO.
        if let Some(seed) = &seed {
            serde_json::from_str::<Value>(seed)
                .map_err(|error| Error::Invalid(error.to_string()))?;
        }
        let model = Model::open(seed, now)?;
        check_owner(&owner)?;
        disk.verify()?;
        Ok(Self {
            inner: Some(Box::new(State {
                disk,
                model,
                owner,
                fenced: None,
                #[cfg(test)]
                ids: Default::default(),
            })),
        })
    }
    pub fn directory(&self) -> Result<&Path> {
        Ok(&self.inner.as_ref().ok_or(Error::Closed)?.disk.path)
    }

    pub fn execute(&mut self, command: Command, now: i64) -> Result<StoreReply> {
        let state = self.inner.as_mut().ok_or(Error::Closed)?;
        if let Err(error) = state.check() {
            state.fence(&error);
            return Err(error);
        }
        let paused_create = matches!(&command, Command::CreatePaused(_));
        let (operation, arguments) = command.wire();
        limits::values(&arguments.iter().collect::<Vec<_>>())?;
        // Enter the same injective JS string/number representation as the oracle.
        let arguments = limits::decode(
            &serde_json::to_string(&arguments).map_err(|e| Error::Invalid(e.to_string()))?,
        )?;
        let arguments = arguments.as_array().ok_or(Error::Ownership)?;
        if operation == "create" {
            #[cfg(test)]
            let id = state.ids.pop_front().unwrap_or_else(random_id);
            #[cfg(not(test))]
            let id = random_id();
            state.model.ids.forced = Some(id);
        }
        let prepared = state.model.prepare(operation, arguments, now);
        state.model.ids.forced = None;
        let stamp = prepared?;
        if paused_create {
            if let Err(error) = pause_created_candidate(&mut state.model) {
                state.model.discard(stamp)?;
                return Err(error);
            }
        }
        let image = state.model.pending_image(stamp)?.map(str::to_owned);
        // Ensure the public result is representable before any persistence occurs.
        if let super::Phase::Pending(candidate) = &state.model.phase {
            let representable = public_value(&candidate.result).and_then(|_| {
                candidate
                    .effects
                    .iter()
                    .map(public_value)
                    .collect::<Result<Vec<_>>>()
            });
            if let Err(error) = representable {
                state.model.discard(stamp)?;
                return Err(error);
            }
        }
        if let Some(image) = &image {
            if let Err(error) = state.disk.persist(image.as_bytes(), &state.owner) {
                if state.disk.uncertain {
                    state.fence(&error);
                    return Err(Error::Uncertain {
                        cause: Box::new(error),
                    });
                }
                state.model.discard(stamp)?;
                if matches!(error, Error::Owner(_) | Error::Ownership) {
                    state.fence(&error);
                }
                return Err(error);
            }
        }
        if let Err(error) = state.check() {
            // Revocation is permanent for this captured store, including reads
            // whose prepared candidate has no file publication to retain.
            state.fence(&error);
            if image.is_some() {
                return Err(Error::Uncertain {
                    cause: Box::new(error),
                });
            }
            state.model.discard(stamp)?;
            return Err(error);
        }
        let value = public_value(&state.model.install(stamp)?)?;
        let effects = state
            .model
            .effects
            .iter()
            .map(public_value)
            .collect::<Result<Vec<_>>>()?;
        Ok(StoreReply {
            value,
            changed: image.is_some(),
            effects,
        })
    }

    /// Verify and close without publishing a withheld candidate or retrying it.
    /// On uncertainty/root loss the handles remain held. Dropping that store parks
    /// the handles for this process; a fresh process can reopen the actual file.
    pub fn close(&mut self) -> Result<()> {
        let Some(state) = self.inner.as_mut() else {
            return Ok(());
        };
        if let Err(error) = check_owner(&state.owner).and_then(|()| state.disk.close()) {
            state.fence(&error);
            return Err(error);
        }
        self.inner.take();
        Ok(())
    }
}
impl Drop for RoutineStore {
    fn drop(&mut self) {
        if self.inner.is_some() && self.close().is_err() {
            if let Some(state) = self.inner.take() {
                std::mem::forget(state);
            }
        }
    }
}
// A schedule create's same-clock Node update changes only enabled. Build the
// final candidate before any native save, so no enabled intermediate reaches disk or a caller.
fn pause_created_candidate(model: &mut Model) -> Result<()> {
    let super::Phase::Pending(candidate) = &mut model.phase else {
        return Err(Error::Ownership);
    };
    let publication = candidate.publication.as_mut().ok_or(Error::Ownership)?;
    let id = candidate.result["id"].clone();
    let row = publication.data["routines"]
        .as_array_mut()
        .and_then(|rows| rows.iter_mut().find(|row| row["id"] == id))
        .ok_or(Error::Ownership)?;
    row["enabled"] = json!(false);
    candidate.result["enabled"] = json!(false);
    super::check::state(&publication.data)?;
    publication.image = limits::image(&publication.data)?;
    Ok(())
}
fn random_id() -> String {
    uuid::Uuid::new_v4().as_bytes()[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn public_value(value: &Value) -> Result<Value> {
    if jsjson::is_undefined(value) {
        return Ok(Value::Null);
    }
    serde_json::from_str(&jsjson::to_string(value)).map_err(|error| {
        Error::Invalid(format!(
            "Routine result needs lossless JavaScript JSON: {error}"
        ))
    })
}

fn check_owner(owner: &OwnerCheck) -> Result<()> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| owner()))
        .map_err(|_| Error::Owner("ownership check panicked".into()))?
        .map_err(Error::Owner)
}
