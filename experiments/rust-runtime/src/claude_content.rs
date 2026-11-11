//! Fixed fixture content authority shared by the owner actor and native Claude MCP.
use milagre_claude::{
    mcp::{DispatchError, FnDispatch, InProcessMcp, McpLimits, McpRegistration, McpTool},
    SessionOptions,
};
use milagre_content_store::{ActiveCheck, Error, SystemRuntime};
use milagre_owner_store::Isolation;
use milagre_owner_wire::{RpcError, RpcResult};
use milagre_tools::{Caller, ContentOwner, DesignScope, Dispatcher};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

pub(crate) struct SharedContent {
    owner: Arc<ContentOwner>,
    project: String,
    active: Arc<AtomicBool>,
    opened: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}
fn guard(active: Arc<AtomicBool>, opened: Option<Arc<AtomicBool>>) -> ActiveCheck {
    Arc::new(move || {
        if active.load(Ordering::Acquire)
            && opened.as_ref().is_none_or(|v| v.load(Ordering::Acquire))
        {
            Ok(())
        } else {
            Err(Error::coded(
                "FIXTURE_SCOPE_REVOKED",
                "The private content scope is not active",
            ))
        }
    })
}
impl SharedContent {
    pub(crate) fn new(isolation: Isolation, project: PathBuf) -> Result<Arc<Self>, Error> {
        let project = project.to_string_lossy().into_owned();
        let active = Arc::new(AtomicBool::new(true));
        let opened = Arc::new(AtomicBool::new(false));
        let resolver_guard = guard(active.clone(), Some(opened.clone()));
        let resolved = project.clone();
        let owner = ContentOwner::open(
            isolation,
            PathBuf::from("artifacts"),
            PathBuf::from("design-kits"),
            Arc::new(move |chat| {
                resolver_guard()?;
                if [format!("{resolved}#1"), format!("{resolved}#2")].contains(&chat.to_string()) {
                    Ok(resolved.clone())
                } else {
                    Err(Error::coded(
                        "FIXTURE_CHAT_UNKNOWN",
                        "Choose an admitted fixture Chat",
                    ))
                }
            }),
            guard(active.clone(), None),
            Arc::new(SystemRuntime),
            None,
        )?;
        Ok(Arc::new(Self {
            owner,
            project,
            active,
            opened,
            generation: Arc::new(AtomicU64::new(0)),
        }))
    }
    pub(crate) fn opened(&self, value: bool) {
        if !value {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
        self.opened.store(value, Ordering::Release);
    }
    fn caller_guard(&self) -> ActiveCheck {
        let check = guard(self.active.clone(), Some(self.opened.clone()));
        let generation = self.generation.clone();
        let expected = generation.load(Ordering::Acquire);
        Arc::new(move || {
            check()?;
            if generation.load(Ordering::Acquire) != expected {
                return Err(Error::coded(
                    "FIXTURE_SCOPE_REVOKED",
                    "The fixture grant belongs to a closed Project generation",
                ));
            }
            Ok(())
        })
    }
    pub(crate) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub(crate) fn shutdown(&self) {
        self.revoke();
        self.owner.shutdown();
    }
    pub(crate) fn renderer(&self, method: &str, request: &Value) -> RpcResult {
        let chat = request["chatId"].as_str().unwrap_or("");
        let scope = self
            .owner
            .renderer_scope(chat, &self.project, self.caller_guard())
            .map_err(convert)?;
        self.owner
            .renderer(&scope, method, request)
            .map_err(convert)
    }
    fn dispatcher(&self, chat: &str) -> Result<Dispatcher, Error> {
        let caller = Caller {
            chat_id: chat.into(),
            project_id: self.project.clone(),
            roots: vec![PathBuf::from(&self.project)],
            read: true,
            write: true,
            html: true,
            designs: true,
            kits: true,
            design_scope: DesignScope::All,
            bundled_skills: PathBuf::from(&self.project),
            assert_active: self.caller_guard(),
        };
        self.owner.session(caller)
    }
    pub(crate) fn attach(
        &self,
        chat: &str,
        options: &mut SessionOptions,
    ) -> Result<McpRegistration, Error> {
        let dispatcher = self.dispatcher(chat)?;
        let manifest = dispatcher
            .provider_manifest()
            .into_iter()
            .map(|tool| McpTool {
                name: tool.name,
                read_only: tool.read_only,
            })
            .collect();
        let router = InProcessMcp::new();
        let registration=router.register("milagre",manifest,Arc::new(FnDispatch(move|frame:Vec<u8>,mut cancel:milagre_claude::CancelSignal|{
            let dispatcher=dispatcher.clone();
            Box::pin(async move{
                if cancel.reason().is_some(){return Err(DispatchError::Unavailable);}
                // Dispatcher offloads parsing/storage, owns accepted calls, and cancels queued
                // work on drop. A lost in-flight mutation reply stays conservatively uncertain.
                tokio::select!{biased;_=cancel.cancelled()=>Err(DispatchError::Unavailable),result=dispatcher.dispatch(&frame)=>Ok(result)}
            }) as milagre_claude::BoxFuture<Result<Option<Vec<u8>>,DispatchError>>
        })),McpLimits::default()).map_err(|_|Error::coded("FIXTURE_MCP_FAILED","Could not register the private content scope"))?;
        registration.attach(options).map_err(|_| {
            Error::coded(
                "FIXTURE_MCP_FAILED",
                "Could not attach the private content scope",
            )
        })?;
        Ok(registration)
    }
}
impl Drop for SharedContent {
    fn drop(&mut self) {
        self.shutdown();
    }
}
fn convert(error: Error) -> RpcError {
    RpcError::new(error.code, error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_store::{jsjson, Policy};
    use milagre_owner_wire::IsolatedProfile;
    use serde_json::json;

    #[test]
    fn retained_grants_do_not_revive_on_reopen_and_one_store_is_shared() {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(std::path::Path::new("fixture")).unwrap();
        let content = SharedContent::new(isolation.clone(), project.clone()).unwrap();
        assert!(
            SharedContent::new(isolation.clone(), project.clone()).is_err(),
            "never open a second store writer"
        );
        let chat = format!("{}#1", project.display());
        let peer = format!("{}#2", project.display());
        assert!(content.dispatcher(&chat).is_err());
        content.opened(true);
        let old = content.dispatcher(&chat).unwrap();
        let other = content.dispatcher(&peer).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let first = runtime
            .block_on(old.call("artifact_show", &json!({"title":"One","html":"<p>One</p>"})));
        assert_ne!(first["isError"], true);
        let listed = content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        let read = content
            .renderer("artifact:get", &json!({"chatId":chat,"id":listed[0]["id"]}))
            .unwrap();
        assert!(jsjson::to_string(&read).contains("<p>One</p>"));
        let scope_escape = runtime.block_on(other.call(
            "artifact_show",
            &json!({"chatId":chat,"title":"Escape","html":"no"}),
        ));
        assert_eq!(scope_escape["isError"], true);
        assert_eq!(
            content
                .renderer("artifact:list", &json!({"chatId":peer}))
                .unwrap(),
            json!([])
        );
        content.opened(false);
        content.opened(true);
        assert_eq!(
            runtime.block_on(old.call("artifact_list", &json!({})))["isError"],
            true,
            "old grant must remain revoked after reopen"
        );
        let new = content.dispatcher(&chat).unwrap();
        assert_ne!(
            runtime.block_on(new.call("artifact_list", &json!({})))["isError"],
            true
        );
        let mut options = SessionOptions::new(milagre_claude::LaunchOptions::new("unused-fixture"));
        let registration = content.attach(&chat, &mut options).unwrap();
        let mut expected: Vec<_> = new
            .provider_manifest()
            .into_iter()
            .filter(|tool| tool.read_only)
            .map(|tool| format!("mcp__milagre__{}", tool.name))
            .collect();
        expected.sort();
        let mut installed = options.launch.allowed_tools.clone();
        installed.sort();
        assert_eq!(installed, expected);
        content.shutdown();
        assert_eq!(
            runtime.block_on(new.call("artifact_list", &json!({})))["isError"],
            true
        );
        drop(registration);
        let replacement = SharedContent::new(isolation, project).unwrap();
        replacement.shutdown();
    }
}
