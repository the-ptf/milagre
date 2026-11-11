//! Fixed fixture content authority shared by the owner actor and native Claude MCP.
use milagre_claude::{
    mcp::{DispatchError, FnDispatch, InProcessMcp, McpLimits, McpRegistration, McpTool},
    SessionOptions,
};
use milagre_content_store::{
    design::raster::RasterRenderer, ActiveCheck, Error, Runtime, SystemRuntime,
};
use milagre_owner_store::Isolation;
use milagre_owner_wire::{RpcError, RpcResult};
use milagre_tools::{Caller, ContentOwner, DesignScope};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

/// One native session's revocable grant. It never owns a second content store.
pub(crate) struct SessionContent {
    active: AtomicBool,
    registration: Mutex<Option<Arc<McpRegistration>>>,
}
impl SessionContent {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            active: AtomicBool::new(true),
            registration: Mutex::new(None),
        })
    }
    pub(crate) fn check(&self) -> Result<(), Error> {
        if self.active.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(Error::coded(
                "FIXTURE_SESSION_REVOKED",
                "The native session content grant was closed",
            ))
        }
    }
    pub(crate) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        let registration = self
            .registration
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(registration) = registration {
            registration.revoke();
        }
    }
    fn authorize(self: &Arc<Self>, mut caller: Caller) -> Caller {
        let weak = Arc::downgrade(self);
        let previous = caller.assert_active;
        caller.assert_active = Arc::new(move || {
            weak.upgrade()
                .ok_or_else(|| {
                    Error::coded(
                        "FIXTURE_SESSION_REVOKED",
                        "The native session content grant was released",
                    )
                })?
                .check()?;
            previous()
        });
        caller
    }
    fn install(&self, registration: Arc<McpRegistration>) -> Result<(), Error> {
        let mut current = self
            .registration
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.check().is_err() || current.is_some() {
            drop(current);
            registration.revoke();
            return Err(Error::coded(
                "FIXTURE_SESSION_REVOKED",
                "The native session registration cannot be attached",
            ));
        }
        *current = Some(registration);
        Ok(())
    }
}
impl Drop for SessionContent {
    fn drop(&mut self) {
        self.revoke();
    }
}

pub(crate) struct SharedContent {
    owner: Arc<ContentOwner>,
    project: String,
    active: Arc<AtomicBool>,
    scope: Arc<AtomicU64>,
    skills: PathBuf,
    feedback: Arc<Mutex<Vec<Value>>>,
}
fn guard(active: Arc<AtomicBool>, scope: Option<Arc<AtomicU64>>) -> ActiveCheck {
    Arc::new(move || {
        if active.load(Ordering::Acquire)
            && scope
                .as_ref()
                .is_none_or(|v| v.load(Ordering::Acquire) & 1 == 1)
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
        Self::with_raster(isolation, project, None)
    }
    pub(crate) fn with_raster(
        isolation: Isolation,
        project: PathBuf,
        raster: Option<Arc<RasterRenderer>>,
    ) -> Result<Arc<Self>, Error> {
        Self::with_runtime(isolation, project, raster, Arc::new(SystemRuntime))
    }
    pub(crate) fn with_runtime(
        isolation: Isolation,
        project: PathBuf,
        raster: Option<Arc<RasterRenderer>>,
        runtime: Arc<dyn Runtime>,
    ) -> Result<Arc<Self>, Error> {
        let project = project.to_string_lossy().into_owned();
        let active = Arc::new(AtomicBool::new(true));
        let scope = Arc::new(AtomicU64::new(0));
        let resolver_guard = guard(active.clone(), Some(scope.clone()));
        let resolved = project.clone();
        let skills = isolation
            .project(std::path::Path::new("bundled-skills"))
            .map_err(|_| {
                Error::coded(
                    "FIXTURE_SKILLS_FAILED",
                    "Could not create the private empty skills directory",
                )
            })?;
        if std::fs::read_dir(&skills)
            .map_err(|_| {
                Error::coded(
                    "FIXTURE_SKILLS_FAILED",
                    "Could not inspect the private skills directory",
                )
            })?
            .next()
            .is_some()
        {
            return Err(Error::coded(
                "FIXTURE_SKILLS_FAILED",
                "The fixture skills directory must be empty",
            ));
        }
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
            runtime,
            raster,
        )?;
        Ok(Arc::new(Self {
            owner,
            project,
            active,
            scope,
            skills,
            feedback: Arc::new(Mutex::new(Vec::new())),
        }))
    }
    /// Fixed synthetic content only: retain at most eight PNG feedback replies, each <=512KiB.
    pub(crate) fn feedback(&self) -> Vec<Value> {
        self.feedback.lock().unwrap().clone()
    }
    pub(crate) fn opened(&self, value: bool) {
        if value {
            self.scope.fetch_or(1, Ordering::AcqRel);
        } else if self
            .scope
            .try_update(Ordering::AcqRel, Ordering::Acquire, |state| {
                state.checked_add(2).map(|next| next & !1)
            })
            .is_err()
        {
            // Generation exhaustion permanently revokes authority; never wrap to an old grant.
            self.revoke();
        }
    }
    fn caller_guard(&self) -> ActiveCheck {
        let active = self.active.clone();
        let scope = self.scope.clone();
        let expected = scope.load(Ordering::Acquire);
        Arc::new(move || {
            if !active.load(Ordering::Acquire)
                || expected & 1 == 0
                || scope.load(Ordering::Acquire) != expected
            {
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
    fn caller(&self, chat: &str) -> Caller {
        Caller {
            chat_id: chat.into(),
            project_id: self.project.clone(),
            roots: vec![PathBuf::from(&self.project)],
            read: true,
            write: true,
            html: true,
            designs: true,
            kits: true,
            design_scope: DesignScope::All,
            bundled_skills: self.skills.clone(),
            assert_active: self.caller_guard(),
        }
    }
    #[cfg(any(test, feature = "app-fixture"))]
    pub(crate) fn dispatcher(&self, chat: &str) -> Result<milagre_tools::Dispatcher, Error> {
        self.owner.session(self.caller(chat))
    }
    pub(crate) fn attach(
        &self,
        chat: &str,
        options: &mut SessionOptions,
        scope: &Arc<SessionContent>,
    ) -> Result<Arc<McpRegistration>, Error> {
        scope.check()?;
        let dispatcher = self.owner.session(scope.authorize(self.caller(chat)))?;
        let manifest = dispatcher
            .provider_manifest()
            .into_iter()
            .map(|tool| McpTool {
                name: tool.name,
                read_only: tool.read_only,
            })
            .collect();
        let router = InProcessMcp::new();
        let feedback = self.feedback.clone();
        let registration=router.register("milagre",manifest,Arc::new(FnDispatch(move|frame:Vec<u8>,mut cancel:milagre_claude::CancelSignal|{
            let dispatcher=dispatcher.clone();
            let feedback=feedback.clone();
            Box::pin(async move{
                if cancel.reason().is_some(){return Err(DispatchError::Unavailable);}
                // Dispatcher offloads parsing/storage, owns accepted calls, and cancels queued
                // work on drop. A lost in-flight mutation reply stays conservatively uncertain.
                tokio::select!{biased;_=cancel.cancelled()=>Err(DispatchError::Unavailable),result=dispatcher.dispatch(&frame)=>{
                    if let Some(bytes)=result.as_ref().filter(|b|b.len()<=512*1024) {
                        if let Ok(reply)=serde_json::from_slice::<Value>(bytes) {
                            if reply["result"]["content"].as_array().is_some_and(|blocks|blocks.iter().any(|block|block["type"]=="image"&&block["mimeType"]=="image/png")) {
                                let mut kept=feedback.lock().unwrap();if kept.len()<8 {kept.push(reply["result"].clone());}
                            }
                        }
                    }
                    Ok(result)
                }}
            }) as milagre_claude::BoxFuture<Result<Option<Vec<u8>>,DispatchError>>
        })),McpLimits::default()).map_err(|_|Error::coded("FIXTURE_MCP_FAILED","Could not register the private content scope"))?;
        let registration = Arc::new(registration);
        scope.install(registration.clone())?;
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
    fn read_only_dispatcher_refuses_native_write_even_without_a_cli_permission_gate() {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(std::path::Path::new("fixture")).unwrap();
        let content = SharedContent::new(isolation, project.clone()).unwrap();
        content.opened(true);
        let chat = format!("{}#1", project.display());
        let mut caller = content.caller(&chat);
        caller.write = false;
        let read_only = content.owner.session(caller).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(read_only.call(
            "artifact_show",
            &json!({"title":"Denied","html":"<main>never saved</main>"}),
        ));
        assert!(result["isError"] == true, "{result:?}");
        let saved = content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .unwrap();
        assert_eq!(saved, json!([]));
        // A separate ordinary grant still works; the rejected caller cannot fault the owner.
        let writer = content.dispatcher(&chat).unwrap();
        let written = rt.block_on(writer.call(
            "artifact_show",
            &json!({"title":"Allowed","html":"<main>saved once</main>"}),
        ));
        assert_eq!(written["isError"], false, "{written:?}");
        let saved = content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .unwrap();
        assert_eq!(saved.as_array().unwrap().len(), 1);
    }

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
        assert_ne!(content.skills, project);
        assert_eq!(std::fs::read_dir(&content.skills).unwrap().count(), 0);
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
        let session_scope = SessionContent::new();
        let registration = content.attach(&chat, &mut options, &session_scope).unwrap();
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
        let poison = session_scope.clone();
        assert!(std::thread::spawn(move || {
            let _held = poison.registration.lock().unwrap();
            panic!("fixed lease poison");
        })
        .join()
        .is_err());
        session_scope.revoke();
        let mut refused_options =
            SessionOptions::new(milagre_claude::LaunchOptions::new("unused-fixture"));
        assert!(
            registration.attach(&mut refused_options).is_err(),
            "the endpoint is revoked even with a retained registration handle"
        );
        assert!(
            content
                .attach(&chat, &mut refused_options, &session_scope)
                .is_err(),
            "a close before attach cannot mint a late registration"
        );
        let scoped = content
            .owner
            .session(session_scope.authorize(content.caller(&chat)));
        assert!(
            scoped.is_err(),
            "the revoked write lease also refuses bypassing native MCP"
        );
        let (send, receive) = std::sync::mpsc::sync_channel(0);
        let (release, resume) = std::sync::mpsc::sync_channel(0);
        let issuer = content.clone();
        let issuing = std::thread::spawn(move || {
            for _ in 0..64 {
                send.send(issuer.caller_guard()).unwrap();
                resume.recv().unwrap();
            }
        });
        for _ in 0..64 {
            let before_close = receive.recv().unwrap();
            content.opened(false);
            let while_closed = content.caller_guard();
            content.opened(true);
            assert!(before_close().is_err());
            assert!(while_closed().is_err());
            assert!(content.caller_guard()().is_ok());
            release.send(()).unwrap();
        }
        issuing.join().unwrap();
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
