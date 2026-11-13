//! Read-only Git commands attached to a fresh isolated repository and one copied Project.
use crate::ReadBackend;
use milagre_git_read::{
    isolated::{IsolatedGit, IsolatedGitReader},
    GitError,
};
use milagre_owner_store::jsjson;
use milagre_owner_wire::{ClientContext, RpcError, RpcResult};
use serde_json::{json, Value};
use std::{fs, sync::Arc};
use tokio::runtime::Runtime;

pub struct GitService {
    owner: IsolatedGit,
    reader: IsolatedGitReader,
    project: String,
    backend: Arc<dyn ReadBackend>,
    runtime: Runtime,
}
impl GitService {
    pub fn new(project: String, backend: Arc<dyn ReadBackend>) -> Result<Self, RpcError> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let owner = runtime.block_on(IsolatedGit::create()).map_err(convert)?;
        // Bootstrap runs before the socket exists, on library-created paths only.
        fs::write(
            owner.project_path().join("README.md"),
            "First line\nOriginal line\n",
        )?;
        fs::write(owner.project_path().join("remove.txt"), "Tracked content\n")?;
        let initial = runtime
            .block_on(owner.commit(owner.project_path(), "Fixture baseline"))
            .map_err(convert)?;
        if initial["ok"] != true {
            return Err(RpcError::new(
                "GIT_FIXTURE_FAILED",
                "Could not initialize the isolated Git fixture",
            ));
        }
        fs::write(
            owner.project_path().join("README.md"),
            "First line\nChanged line\n",
        )?;
        fs::remove_file(owner.project_path().join("remove.txt"))?;
        fs::write(owner.project_path().join("unicode-é.txt"), "New text\n")?;
        fs::write(owner.project_path().join("binary.bin"), [0, 1, 2, 3])?;
        fs::write(
            owner.project_path().join(".env.local"),
            "SYNTHETIC=hidden-fixture-value\n",
        )?;
        fs::create_dir(owner.project_path().join(".milagre"))?;
        fs::write(owner.project_path().join(".milagre/ignored.json"), "{}\n")?;
        let reader = runtime.block_on(owner.reader()).map_err(convert)?;
        Ok(Self {
            owner,
            reader,
            project,
            backend,
            runtime,
        })
    }
    pub fn metadata(&self) -> Value {
        json!({"root":self.owner.root_path(),"cwd":self.owner.project_path(),"project":self.project,"readOnly":true})
    }
    pub fn invoke(&self, method: &str, args: &[Value], context: &ClientContext) -> RpcResult {
        if context.view().project_path.as_deref() != Some(self.project.as_str()) {
            return Err(RpcError::new(
                "ISOLATED_GIT_SCOPE",
                "Open the fixture Project on this connection before reading its Git folder",
            ));
        }
        self.backend.assert_owned(&self.project)?;
        // Verify the capability's marker, registered checkout and common Git directory
        // before every read. This never accepts a root supplied by the client.
        self.runtime
            .block_on(self.owner.list_worktrees())
            .map_err(convert)?;
        let argument = args.first().cloned().unwrap_or(Value::Null);
        let argument = serde_json::from_str(&jsjson::to_string(&argument)).map_err(|_| {
            RpcError::new(
                "UNSUPPORTED_UTF16_IDENTITY",
                "Git paths and refs must contain valid Unicode",
            )
        })?;
        let result = self
            .runtime
            .block_on(self.reader.call(method, argument))
            .map_err(convert)?;
        self.backend.assert_owned(&self.project)?;
        jsjson::parse(&result.to_string())
            .map_err(|_| RpcError::new("INVALID_RESPONSE", "Git result could not be encoded"))
    }
}
fn convert(error: GitError) -> RpcError {
    // Match the existing daemon's structured process error details, without adding
    // a production command or exposing a raw Git invocation.
    RpcError {
        code: error.kind.into(),
        message: error.message.clone(),
        details: Some(serde_json::to_value(error).expect("GitError serializes")),
    }
}
