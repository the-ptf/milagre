//! One content authority shared by the owner actor and native Claude MCP.
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
    collections::{HashMap, HashSet},
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
    authority: Option<ActiveCheck>,
}
impl SessionContent {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            active: AtomicBool::new(true),
            registration: Mutex::new(None),
            authority: None,
        })
    }
    pub(crate) fn check(&self) -> Result<(), Error> {
        if self.active.load(Ordering::Acquire) {
            self.authority.as_ref().map_or(Ok(()), |check| check())
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

type ChatGrants = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;
pub(crate) struct SharedContent {
    owner: Arc<ContentOwner>,
    project: String,
    active: Arc<AtomicBool>,
    scope: Arc<AtomicU64>,
    skills: PathBuf,
    feedback: Arc<Mutex<Vec<Value>>>,
    chats: Option<ChatGrants>,
    native_drained: Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>,
}
const CONFIGURED_CHATS: usize = 1024;
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
    #[cfg(feature = "chat-runtime")]
    pub(crate) fn chat_limit(&self) -> Option<usize> {
        self.chats.as_ref().map(|_| CONFIGURED_CHATS)
    }
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
        Self::open(
            isolation,
            project,
            skills,
            raster,
            runtime,
            None,
            Arc::new(|| Ok(())),
        )
    }
    /// Trusted configured owner only. Chat membership comes from owned state or the owner's
    /// committed outbound Provider call, never renderer paths or positive-suffix guessing.
    #[cfg(feature = "chat-runtime")]
    pub(crate) fn configured(
        isolation: Isolation,
        project: PathBuf,
        skills: PathBuf,
        owner_check: ActiveCheck,
    ) -> Result<Arc<Self>, Error> {
        let skills = skills.canonicalize()?;
        if !skills.is_dir() {
            return Err(Error::new(
                "The captured bundled skills directory is unavailable",
            ));
        }
        Self::open(
            isolation,
            project,
            skills,
            None,
            Arc::new(SystemRuntime),
            Some(Arc::new(Mutex::new(HashMap::new()))),
            owner_check,
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn open(
        isolation: Isolation,
        project: PathBuf,
        skills: PathBuf,
        raster: Option<Arc<RasterRenderer>>,
        runtime: Arc<dyn Runtime>,
        chats: Option<ChatGrants>,
        owner_check: ActiveCheck,
    ) -> Result<Arc<Self>, Error> {
        let project = project.to_string_lossy().into_owned();
        let active = Arc::new(AtomicBool::new(true));
        let scope = Arc::new(AtomicU64::new(0));
        let resolver_guard = guard(active.clone(), Some(scope.clone()));
        let resolved = project.clone();
        let admitted = chats.clone();
        let live = active.clone();
        let owner_guard = guard(active.clone(), None);
        let owner = ContentOwner::open(
            isolation,
            PathBuf::from("artifacts"),
            PathBuf::from("design-kits"),
            Arc::new(move |chat| {
                resolver_guard()?;
                let known = match &admitted {
                    Some(chats) => chats
                        .lock()
                        .unwrap()
                        .get(chat)
                        .is_some_and(|active| active.load(Ordering::Acquire)),
                    None => [format!("{resolved}#1"), format!("{resolved}#2")]
                        .contains(&chat.to_string()),
                };
                if known {
                    Ok(resolved.clone())
                } else {
                    Err(Error::coded(
                        "FIXTURE_CHAT_UNKNOWN",
                        "Choose an admitted fixture Chat",
                    ))
                }
            }),
            Arc::new(move || {
                owner_guard()?;
                owner_check().inspect_err(|_| {
                    live.store(false, Ordering::Release);
                })
            }),
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
            chats,
            native_drained: Mutex::new(None),
        }))
    }
    /// Called only after the ChatHost has committed its outbound Chat identity. This closes
    /// the new-Chat gap before Worker::run attaches MCP, while the actor still owns the call.
    pub(crate) fn admit_owner_chat(&self, chat: &str) -> Result<(), Error> {
        let Some(chats) = &self.chats else {
            return Ok(());
        };
        guard(self.active.clone(), Some(self.scope.clone()))()?;
        self.chat_number(chat)?;
        let mut chats = chats.lock().unwrap();
        if !chats.contains_key(chat) && chats.len() >= CONFIGURED_CHATS {
            return Err(Error::coded(
                "CONTENT_CHAT_LIMIT",
                "Configured content Chat admission is full",
            ));
        }
        chats
            .entry(chat.into())
            .or_insert_with(|| Arc::new(AtomicBool::new(true)));
        Ok(())
    }
    fn chat_number(&self, chat: &str) -> Result<i64, Error> {
        let id = chat
            .strip_prefix(&format!("{}#", self.project))
            .and_then(|id| {
                id.parse::<i64>()
                    .ok()
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991 && n.to_string() == id)
            });
        id.ok_or_else(|| {
            Error::coded(
                "CONTENT_CHAT_UNKNOWN",
                "Choose an admitted Chat in this Project",
            )
        })
    }
    /// Actor-only reconciliation from its current owned state. Removed Chat tokens stay
    /// revoked even if that number is later reintroduced in the same Project generation.
    pub(crate) fn reconcile(
        &self,
        sessions: Option<&serde_json::Map<String, Value>>,
    ) -> Result<(), Error> {
        self.reconcile_inner(sessions)
            .inspect_err(|_| self.opened(false))
    }
    fn reconcile_inner(
        &self,
        sessions: Option<&serde_json::Map<String, Value>>,
    ) -> Result<(), Error> {
        let Some(chats) = &self.chats else {
            return Ok(());
        };
        let sessions = sessions.ok_or_else(|| Error::new("Owned Chat state is unavailable"))?;
        if sessions.len() > CONFIGURED_CHATS {
            return Err(Error::coded(
                "CONTENT_CHAT_LIMIT",
                "Configured content Chat admission is full",
            ));
        }
        let mut next = HashSet::new();
        for (id, session) in sessions {
            let chat = format!("{}#{id}", self.project);
            let number = self.chat_number(&chat)?;
            if session["id"].as_f64() != Some(number as f64) {
                return Err(Error::new("Owned Chat identity is inconsistent"));
            }
            next.insert(chat);
        }
        let mut chats = chats.lock().unwrap();
        chats.retain(|chat, active| {
            let keep = next.contains(chat);
            if !keep {
                active.store(false, Ordering::Release);
            }
            keep
        });
        for chat in next {
            chats
                .entry(chat)
                .or_insert_with(|| Arc::new(AtomicBool::new(true)));
        }
        Ok(())
    }
    #[cfg(feature = "chat-runtime")]
    pub(crate) fn retain_native_drain(&self, check: Arc<dyn Fn() -> bool + Send + Sync>) {
        *self.native_drained.lock().unwrap() = Some(check);
    }
    pub(crate) fn native_drained(&self) -> bool {
        self.native_drained
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|check| check())
    }
    /// Capture before spawning a worker. Attach may happen later but cannot discover a newer grant.
    pub(crate) fn capture_session(&self, chat: &str) -> Result<Arc<SessionContent>, Error> {
        if self.chats.is_none() {
            return Ok(SessionContent::new());
        }
        let authority = self.caller(chat).assert_active;
        authority()?;
        Ok(Arc::new(SessionContent {
            active: AtomicBool::new(true),
            registration: Mutex::new(None),
            authority: Some(authority),
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
        let membership = self
            .chats
            .as_ref()
            .map(|chats| chats.lock().unwrap().get(chat).cloned());
        let generation = self.caller_guard();
        let assert_active = Arc::new(move || {
            generation()?;
            if membership.as_ref().is_some_and(|token| {
                token
                    .as_ref()
                    .is_none_or(|live| !live.load(Ordering::Acquire))
            }) {
                return Err(Error::coded(
                    "CONTENT_CHAT_REVOKED",
                    "This Chat content grant was revoked",
                ));
            }
            Ok(())
        });
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
            assert_active,
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

    #[cfg(feature = "chat-runtime")]
    #[test]
    fn configured_content_persists_and_captured_membership_never_revives() {
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(std::path::Path::new("project")).unwrap();
        let skills = isolation
            .project(std::path::Path::new("test-bundle"))
            .unwrap();
        let owned = Arc::new(AtomicBool::new(true));
        let check = owned.clone();
        let content = SharedContent::configured(
            isolation.clone(),
            project.clone(),
            skills.clone(),
            Arc::new(move || {
                if check.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(Error::new("captured owner lost"))
                }
            }),
        )
        .unwrap();
        let sessions = json!({"1":{"id":1},"10":{"id":10}});
        let chat = format!("{}#10", project.display());
        assert!(
            content.admit_owner_chat(&chat).is_err(),
            "ready generation is required"
        );
        content.reconcile(sessions.as_object()).unwrap();
        content.opened(true);
        for forged in [
            format!("{}#999", project.display()),
            format!("{}#01", project.display()),
            "/foreign#10".into(),
        ] {
            assert!(content.dispatcher(&forged).is_err());
            assert!(content
                .renderer("artifact:list", &json!({"chatId":forged}))
                .is_err());
        }
        let grant = content.dispatcher(&chat).unwrap();
        let delayed = content.capture_session(&chat).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            content
                .renderer("artifact:list", &json!({"chatId":chat}))
                .unwrap(),
            json!([]),
            "no seeded content"
        );
        assert_eq!(
            rt.block_on(grant.call(
                "artifact_show",
                &json!({"id":"retained","title":"Owned","html":"<main>retained bytes</main>"})
            ))["isError"],
            false
        );
        let saved = content
            .renderer("artifact:get", &json!({"chatId":chat,"id":"retained"}))
            .unwrap();
        content
            .reconcile(json!({"1":{"id":1}}).as_object())
            .unwrap();
        content.reconcile(sessions.as_object()).unwrap();
        assert!(
            delayed.check().is_err(),
            "a delayed worker cannot acquire the replacement member token"
        );
        assert_eq!(
            rt.block_on(grant.call("artifact_list", &json!({})))["isError"],
            true
        );
        let fresh = content.dispatcher(&chat).unwrap();
        assert!(content.reconcile(None).is_err());
        content.reconcile(sessions.as_object()).unwrap();
        content.opened(true);
        assert_eq!(
            rt.block_on(fresh.call("artifact_list", &json!({})))["isError"],
            true,
            "invalid authoritative snapshots revoke the generation"
        );
        let fresh = content.dispatcher(&chat).unwrap();
        owned.store(false, Ordering::Release);
        assert_eq!(
            rt.block_on(fresh.call("artifact_list", &json!({})))["isError"],
            true
        );
        owned.store(true, Ordering::Release);
        assert!(
            content.dispatcher(&chat).is_err(),
            "restoring owner inputs does not revive authority"
        );
        content.shutdown();
        let reopened =
            SharedContent::configured(isolation, project, skills, Arc::new(|| Ok(()))).unwrap();
        reopened.reconcile(sessions.as_object()).unwrap();
        reopened.opened(true);
        assert_eq!(
            reopened
                .renderer("artifact:get", &json!({"chatId":chat,"id":"retained"}))
                .unwrap(),
            saved
        );
        assert_eq!(
            rt.block_on(fresh.call("artifact_list", &json!({})))["isError"],
            true
        );
        reopened.shutdown();
    }

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
