//! Test-only integration handles. Tool grants stay in process; no new daemon method or listener.
use crate::artifacts::ArtifactService;
use milagre_content_store::design::raster::RasterRenderer;
use milagre_owner_wire::{RpcError, Server};
use milagre_tools::{DesignScope, Dispatcher};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub struct ContentFixture {
    pub server: Server,
    pub project: String,
    content: Arc<ArtifactService>,
}
/// Trusted fixture constructor, not a renderer or MCP command. The helper is a
/// compiled test binary chosen by the owner; no request can supply its path.
pub fn start(helper: PathBuf) -> Result<ContentFixture, RpcError> {
    let raster = Arc::new(
        RasterRenderer::new(helper).map_err(|error| RpcError::new(error.code, error.message))?,
    );
    let started = crate::start_mode_with_git(true, false, Some(raster))?;
    let server = started.server;
    let project = server
        .profile_path()
        .join(".projects/alpha")
        .to_string_lossy()
        .into_owned();
    Ok(ContentFixture {
        server,
        project,
        content: started.content.expect("owned content fixture"),
    })
}
/// Immutable scope with separately revocable authority, supplied by test owner code.
pub struct ToolGrant {
    pub dispatcher: Dispatcher,
    active: Arc<AtomicBool>,
}
impl ToolGrant {
    pub fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
}
impl ContentFixture {
    /// Chat numbers refer only to the generated alpha Project. The renderer must
    /// already have opened that fixture Project through its real wire interface.
    pub fn grant(&self, chat: u64, write: bool, scope: DesignScope) -> Result<ToolGrant, RpcError> {
        let active = Arc::new(AtomicBool::new(true));
        let dispatcher = self.content.tool_session(
            &format!("{}#{chat}", self.project),
            write,
            scope,
            active.clone(),
        )?;
        Ok(ToolGrant { dispatcher, active })
    }
}
