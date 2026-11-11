//! Real ProjectStates ownership inside this run's new marked fixture copies only.
use crate::{ProjectInfo, ReadBackend};
use milagre_owner_store::{
    states::{ProjectStates, Timing},
    Isolation, PageOptions, ProjectReader, ProjectStore, StoreError,
};
use milagre_owner_wire::{RpcError, RpcResult};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) struct OwnedCopies {
    projects: Vec<ProjectInfo>,
    isolation: Isolation,
    states: Mutex<ProjectStates>,
}
impl OwnedCopies {
    pub(crate) fn new(projects: Vec<ProjectInfo>, isolation: Isolation) -> Self {
        let states = ProjectStates::new(isolation.clone(), Timing::default(), now());
        Self {
            projects,
            isolation,
            states: Mutex::new(states),
        }
    }
    fn path(&self, path: &str) -> Result<PathBuf, RpcError> {
        if !self.projects.iter().any(|project| project.path == path) {
            return Err(RpcError::new(
                "ISOLATED_SCOPE_ONLY",
                "Only this runtime's embedded fixture copies can be read",
            ));
        }
        if !fs::symlink_metadata(self.isolation.root())?.is_dir() {
            return Err(RpcError::new(
                "UNSAFE_FIXTURE",
                "The isolated profile cannot be replaced by a symbolic link",
            ));
        }
        self.isolation.resolve(Path::new(path)).map_err(store_error)
    }
    fn with_states(
        &self,
        path: &str,
        read: impl FnOnce(&mut ProjectStates, &Path) -> milagre_owner_store::Result<Value>,
    ) -> RpcResult {
        let path = self.path(path)?;
        let mut states = self.states.lock().unwrap();
        states.advance(now());
        read(&mut states, &path).map_err(store_error)
    }
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn store_error(error: StoreError) -> RpcError {
    RpcError::new(error.code().unwrap_or("COMMAND_FAILED"), error.to_string())
}
impl ReadBackend for OwnedCopies {
    fn projects(&self) -> Vec<ProjectInfo> {
        self.projects.clone()
    }
    fn state(&self, path: &str) -> RpcResult {
        self.with_states(path, ProjectStates::whole_state)
    }
    fn messages(&self, path: &str, chat: i64, options: Option<&Value>, opened: bool) -> RpcResult {
        let options = PageOptions::from_value(options);
        if opened {
            self.with_states(path, |states, path| {
                states.chat_messages(path, chat, &options)
            })
        } else {
            ProjectReader::new(ProjectStore::new(self.path(path)?))
                .chat_messages(chat, &options)
                .map_err(store_error)
        }
    }
    fn message(&self, path: &str, id: &Value) -> RpcResult {
        self.with_states(path, |states, path| states.chat_message(path, id))
    }
    fn send_status(&self, path: &str, identity: &str) -> RpcResult {
        self.with_states(path, |states, path| {
            states.send_status(path, &Value::String(identity.into()))
        })
    }
    fn has_database(&self, path: &str) -> Result<bool, RpcError> {
        Ok(ProjectStore::new(self.path(path)?).chats().exists())
    }
    fn inbox_state(&self, path: &str) -> RpcResult {
        self.with_states(path, ProjectStates::inbox)
    }
    fn extra_methods(&self) -> Vec<String> {
        ["chat:all-messages", "chat:search", "chat:subagent"]
            .map(str::to_string)
            .to_vec()
    }
    fn call(&self, method: &str, args: &[Value]) -> RpcResult {
        let scope = args.first().and_then(Value::as_str).ok_or_else(|| {
            RpcError::new(
                "COMMAND_FAILED",
                "Open the Project before reading its messages.",
            )
        })?;
        self.with_states(scope, |states, _| states.call(method, args))
    }
    fn assert_owned(&self, path: &str) -> Result<(), RpcError> {
        let path = self.path(path)?;
        self.states
            .lock()
            .unwrap()
            .assert_owned(&path)
            .map_err(|error| RpcError::new("OWNERSHIP_LOST", error.to_string()))
    }
    fn shutdown(&self) -> Result<(), RpcError> {
        self.states.lock().unwrap().close().map_err(store_error)
    }
}
