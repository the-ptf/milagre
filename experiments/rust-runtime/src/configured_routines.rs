//! Disabled schedule storage only. No scheduler, timer, claim, agent execution or external trigger.
use milagre_owner_store::jsjson;
use milagre_owner_wire::{RpcError, RpcResult};
use milagre_routines::{OwnerCheck, RoutineStore, StoreCommand, StoreError};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) const METHODS: &[&str] = &[
    "routines:list",
    "routines:create",
    "routines:update",
    "routines:delete",
    "routines:enabled:read",
    "routines:enabled:save",
];
pub(crate) const FLAGS: &[&str] = &["routines:enabled:read", "routines:enabled:save"];
pub(crate) fn execution_unavailable() -> RpcError {
    RpcError::new("ROUTINE_EXECUTION_UNAVAILABLE", "Automatic routine execution is not available in this Rust runtime. Save schedules with enabled:false; no timer or agent will run them.")
}
#[cfg(feature = "routine-execution-fixture")]
fn execution_error(message: String) -> RpcError {
    RpcError::new("ROUTINE_EXECUTION_FAILED", message)
}
fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new("COMMAND_FAILED", jsjson::js_string(&message.into()))
}
fn convert(error: StoreError) -> RpcError {
    let code = match &error {
        StoreError::Busy => "ROUTINE_STORE_BUSY",
        StoreError::Ownership | StoreError::Owner(_) => "ROUTINE_OWNER_LOST",
        StoreError::Closed => "ROUTINE_STORE_CLOSED",
        StoreError::Uncertain { .. } => "ROUTINE_STORE_UNCERTAIN",
        StoreError::Io { .. } => "ROUTINE_STORE_IO",
        StoreError::Invalid(_) => "COMMAND_FAILED",
    };
    RpcError::new(code, jsjson::js_string(&error.to_string()))
}

enum Storage {
    Paused(RoutineStore),
    #[cfg(feature = "routine-execution-fixture")]
    Executing(crate::routine_execution_fixture::Scheduler),
}
impl std::ops::Deref for Storage {
    type Target = RoutineStore;
    fn deref(&self) -> &RoutineStore {
        match self {
            Self::Paused(v) => v,
            #[cfg(feature = "routine-execution-fixture")]
            Self::Executing(v) => &v.store,
        }
    }
}
impl std::ops::DerefMut for Storage {
    fn deref_mut(&mut self) -> &mut RoutineStore {
        match self {
            Self::Paused(v) => v,
            #[cfg(feature = "routine-execution-fixture")]
            Self::Executing(v) => &mut v.store,
        }
    }
}
pub(crate) struct ConfiguredRoutines {
    store: Storage,
    project: PathBuf,
    revoked: bool,
    root: PathBuf,
    check: crate::configured_terminals::Check,
}
impl ConfiguredRoutines {
    pub(crate) fn open(
        root: &Path,
        project: PathBuf,
        check: crate::configured_terminals::Check,
        now: i64,
    ) -> Result<Self, RpcError> {
        let retained = check.clone();
        let owner: OwnerCheck = Arc::new(move || retained().map_err(|e| e.message));
        Ok(Self {
            store: Storage::Paused(RoutineStore::open(root, owner, now).map_err(convert)?),
            project,
            revoked: false,
            root: root.to_owned(),
            check,
        })
    }
    pub(crate) fn reopen(
        &mut self,
        host: &milagre_owner_store::chat_host::ChatHost,
        now: i64,
    ) -> Result<(), RpcError> {
        #[cfg(feature = "routine-execution-fixture")]
        if let Storage::Executing(s) = &mut self.store {
            if !self.revoked && !s.is_fenced() {
                return Ok(());
            }
            s.close_for_recovery(host).map_err(execution_error)?;
        }
        #[cfg(not(feature = "routine-execution-fixture"))]
        let _ = host;
        self.close()?;
        let retained = self.check.clone();
        let owner: OwnerCheck = Arc::new(move || retained().map_err(|e| e.message));
        #[cfg(feature = "routine-execution-fixture")]
        if let Storage::Executing(scheduler) = &self.store {
            let model = scheduler.model().to_owned();
            self.store = Storage::Executing(
                crate::routine_execution_fixture::Scheduler::open(
                    &self.root,
                    self.project.clone(),
                    model,
                    owner,
                    now,
                )
                .map_err(execution_error)?,
            );
        } else {
            self.store =
                Storage::Paused(RoutineStore::open(&self.root, owner, now).map_err(convert)?);
        }
        #[cfg(not(feature = "routine-execution-fixture"))]
        {
            self.store =
                Storage::Paused(RoutineStore::open(&self.root, owner, now).map_err(convert)?);
        }
        self.revoked = false;
        Ok(())
    }
    #[cfg(feature = "routine-execution-fixture")]
    pub(crate) fn activate(&mut self, model: String, now: i64) -> Result<(), RpcError> {
        self.store.close().map_err(convert)?;
        let retained = self.check.clone();
        let owner: OwnerCheck = Arc::new(move || retained().map_err(|e| e.message));
        self.store = Storage::Executing(
            crate::routine_execution_fixture::Scheduler::open(
                &self.root,
                self.project.clone(),
                model,
                owner,
                now,
            )
            .map_err(execution_error)?,
        );
        Ok(())
    }
    #[cfg(all(test, feature = "routine-execution-fixture"))]
    pub(crate) fn fixture_store(&mut self) -> &mut RoutineStore {
        &mut self.store
    }
    pub(crate) fn execution_supported(&self) -> bool {
        #[cfg(feature = "routine-execution-fixture")]
        if matches!(self.store, Storage::Executing(_)) {
            return true;
        }
        false
    }
    #[cfg(feature = "routine-execution-fixture")]
    pub(crate) fn advance(
        &mut self,
        host: &mut milagre_owner_store::chat_host::ChatHost,
        now: i64,
    ) -> Result<bool, RpcError> {
        if self.revoked {
            return Ok(false);
        }
        if let Storage::Executing(s) = &mut self.store {
            s.advance(host, now).map_err(execution_error)?;
            return Ok(s.take_changed());
        }
        Ok(false)
    }
    #[cfg(feature = "routine-execution-fixture")]
    pub(crate) fn stop_execution(
        &mut self,
        host: &mut milagre_owner_store::chat_host::ChatHost,
        now: i64,
    ) -> Result<(), RpcError> {
        if let Storage::Executing(s) = &mut self.store {
            s.stop(host).map_err(execution_error)?;
            if s.is_fenced() {
                if s.has_active(host) {
                    return Err(RpcError::new(
                        "QUIT_PENDING",
                        "Actual scheduled native work remains active",
                    ));
                }
                // No success is fabricated. A retained uncertain Run remains running
                // on disk and only the next verified lifetime recovers it as failed.
                s.close_for_recovery(host).map_err(execution_error)?;
            } else if host.is_project_ready(&self.project) {
                s.advance(host, now).map_err(execution_error)?;
            }
        }
        Ok(())
    }
    #[cfg(feature = "routine-execution-fixture")]
    pub(crate) fn interrupt_before_drop(
        &mut self,
        host: &mut milagre_owner_store::chat_host::ChatHost,
    ) {
        if let Storage::Executing(s) = &mut self.store {
            let _ = s.stop(host);
        }
    }
    #[cfg(feature = "routine-execution-fixture")]
    pub(crate) fn owns_active(
        &self,
        host: &milagre_owner_store::chat_host::ChatHost,
        chat: &str,
    ) -> bool {
        matches!(&self.store, Storage::Executing(s) if s.owns_active(host, chat))
    }
    pub(crate) fn revoke(&mut self) {
        self.revoked = true;
        #[cfg(feature = "routine-execution-fixture")]
        if let Storage::Executing(s) = &mut self.store {
            s.revoke();
        }
    }
    pub(crate) fn close(&mut self) -> Result<(), RpcError> {
        #[cfg(feature = "routine-execution-fixture")]
        if let Storage::Executing(s) = &mut self.store {
            if s.pending() > 0 {
                return Err(RpcError::new(
                    "QUIT_PENDING",
                    "Actual scheduled native turns still need terminal cleanup",
                ));
            }
            return s.close().map_err(execution_error);
        }
        self.store.close().map_err(convert)
    }
    // Host owns target grants and serializes this call with actual Project transitions.
    // The durable store independently retains/checks the data-root owner before its rename.
    pub(crate) fn invoke(
        &mut self,
        method: &str,
        args: &[Value],
        state: &Value,
        now: i64,
    ) -> Result<(Value, bool), RpcError> {
        if self.revoked {
            return Err(RpcError::new(
                "ROUTINE_OWNER_LOST",
                "Reopen the dedicated Project before using this captured routine store",
            ));
        }
        let ordinary: Value = serde_json::from_str(&jsjson::to_string(&Value::Array(
            args.to_vec(),
        )))
        .map_err(|_| {
            RpcError::new(
                "UNSUPPORTED_UTF16_IDENTITY",
                "Routine inputs require ordinary Unicode",
            )
        })?;
        let args = ordinary.as_array().unwrap();
        let execution = self.execution_supported();
        let mut emit = false;
        let value = match method {
            "routines:enabled:read" | "routines:enabled:save" => {
                json!({"enabled":true,"executionSupported":execution})
            }
            "routines:list" => {
                if !args.is_empty() {
                    return Err(invalid(
                        "Routine list does not accept caller state or scopes",
                    ));
                }
                let reply = self
                    .store
                    .execute(StoreCommand::List, now)
                    .map_err(convert)?;
                if reply
                    .value
                    .as_array()
                    .ok_or_else(|| invalid("Invalid stored routine list"))?
                    .iter()
                    .any(|r| r["enabled"] == true && !execution)
                {
                    return Err(execution_unavailable());
                }
                let mut list = reply.value;
                for routine in list.as_array_mut().unwrap() {
                    let id = routine["id"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid stored routine identity"))?;
                    let runs = self
                        .store
                        .execute(StoreCommand::Runs(id.into()), now)
                        .map_err(convert)?;
                    routine["runs"] = runs.value;
                    emit |= runs.changed;
                }
                emit |= reply.changed;
                json!({"routines":list})
            }
            "routines:create" => {
                if args.len() != 1 || !args[0].is_object() {
                    return Err(invalid("A Routine needs its settings."));
                }
                let mut input = args[0].clone();
                if input["enabled"] != false {
                    return Err(execution_unavailable());
                }
                input["target"] = self.target(&input["target"], state)?;
                input["createdBy"] = json!({"kind":"user"});
                let reply = self
                    .store
                    .execute(StoreCommand::CreatePaused(input), now)
                    .map_err(convert)?;
                emit = true;
                json!({"routine":reply.value})
            }
            "routines:update" => {
                let id = identifier(args.first())?;
                if args.len() != 2 || !args[1].is_object() {
                    return Err(invalid("A Routine change must be an object."));
                }
                let mut patch = args[1].clone();
                if patch.get("enabled").is_some_and(|v| v != false) {
                    return Err(execution_unavailable());
                }
                if let Some(target) = patch.get("target") {
                    patch["target"] = self.target(target, state)?;
                }
                // An imported enabled row can only be disabled or deleted here. Never
                // return it as an On/Next Run schedule to an unchanged production UI.
                let old = self
                    .store
                    .execute(StoreCommand::Get(id.into()), now)
                    .map_err(convert)?
                    .value;
                if old["enabled"] == true && patch["enabled"] != false {
                    return Err(execution_unavailable());
                }
                let reply = self
                    .store
                    .execute(
                        StoreCommand::Update {
                            id: id.into(),
                            patch,
                        },
                        now,
                    )
                    .map_err(convert)?;
                emit = true;
                reply.value
            }
            "routines:delete" => {
                let id = identifier(args.first())?;
                if args.len() != 1 {
                    return Err(invalid("Choose a Routine."));
                }
                let reply = self
                    .store
                    .execute(StoreCommand::Remove(id.into()), now)
                    .map_err(convert)?;
                emit = reply.value == true;
                json!({"removed":reply.value})
            }
            _ => return Err(execution_unavailable()),
        };
        let value = jsjson::parse(&value.to_string())
            .map_err(|error| RpcError::new("INVALID_RESPONSE", error))?;
        Ok((value, emit))
    }
    fn target(&self, target: &Value, state: &Value) -> RpcResult {
        let scope = self
            .project
            .to_str()
            .ok_or_else(|| invalid("Invalid dedicated Project path"))?;
        match target["kind"].as_str() {
            Some("new-chat")
                if target["projectPath"].as_str() == Some(scope)
                    && target["workspace"] == "project"
                    && target.as_object().is_some_and(|object| {
                        object
                            .keys()
                            .all(|key| matches!(key.as_str(), "kind" | "projectPath" | "workspace"))
                    }) =>
            {
                Ok(json!({"kind":"new-chat","projectPath":scope,"workspace":"project"}))
            }
            Some("chat") => {
                if !target.as_object().is_some_and(|object| {
                    object
                        .keys()
                        .all(|key| matches!(key.as_str(), "kind" | "chatId"))
                }) {
                    return Err(RpcError::new(
                        "ROUTINE_TARGET_SCOPE",
                        "Links, computers and extra target authority are not supported",
                    ));
                }
                let chat = target["chatId"]
                    .as_str()
                    .ok_or_else(|| invalid("Choose a Chat."))?;
                let (project, id) = chat
                    .rsplit_once('#')
                    .ok_or_else(|| invalid("Choose a Chat."))?;
                let number = id
                    .parse::<u64>()
                    .ok()
                    .filter(|n| *n >= 1 && *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| invalid("Choose a Chat."))?;
                if project != scope || number.to_string() != id {
                    return Err(RpcError::new(
                        "ROUTINE_TARGET_SCOPE",
                        "Choose a Chat in this dedicated Project",
                    ));
                }
                let session = state["sessions"]
                    .get(id)
                    .filter(|s| s["id"].as_f64().is_some_and(|value| value == number as f64))
                    .ok_or_else(|| invalid("That Chat is no longer in the Project."))?;
                if jsjson::truthy(session.get("archived"))
                    || jsjson::truthy(session.get("workspacePath"))
                    || jsjson::truthy(session.get("formerWorktree"))
                {
                    return Err(invalid("That Chat is no longer an available Project Chat."));
                }
                if let Some(worktree_id) = session.get("worktree_id").filter(|v| !v.is_null()) {
                    state["worktrees"]
                        .get(jsjson::property_key(Some(worktree_id)))
                        .filter(|worktree| {
                            jsjson::strict_equals(&worktree["id"], worktree_id)
                                && worktree["path"].as_str() == Some(scope)
                                && !jsjson::truthy(worktree.get("sharedChat"))
                        })
                        .ok_or_else(|| invalid("Choose a Chat in the dedicated Project folder."))?;
                }
                Ok(json!({"kind":"chat","chatId":chat}))
            }
            _ => Err(RpcError::new(
                "ROUTINE_TARGET_SCOPE",
                "Choose this dedicated Project or one of its current Chats",
            )),
        }
    }
}
fn identifier(value: Option<&Value>) -> Result<&str, RpcError> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("Choose a Routine."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    fn setup(
        check: crate::configured_terminals::Check,
    ) -> (
        milagre_owner_wire::IsolatedProfile,
        ConfiguredRoutines,
        Value,
    ) {
        let profile = milagre_owner_wire::IsolatedProfile::create().unwrap();
        let root = profile.path();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        fs::write(
            root.join("rust-chat-runtime.json"),
            json!({"schema":1,"kind":"milagre-rust-chat","root":root,"fixture":true}).to_string(),
        )
        .unwrap();
        fs::set_permissions(
            root.join("rust-chat-runtime.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let state = json!({"sessions":{"1":{"id":1,"worktree_id":1}},"worktrees":{"1":{"id":1,"path":project}}});
        let service = ConfiguredRoutines::open(root, project, check, 1_790_000_000_000).unwrap();
        (profile, service, state)
    }
    fn input(service: &ConfiguredRoutines) -> Value {
        json!({"name":"Stored draft","prompt":"Paused metadata","enabled":false,"trigger":{"kind":"schedule","cron":"*/15 * * * *","timezone":"UTC"},"target":{"kind":"chat","chatId":format!("{}#1",service.project.display())},"createdBy":{"kind":"agent","chatId":"/forged#1"}})
    }
    #[test]
    fn create_and_update_cannot_silently_enable_execution_or_forge_creator() {
        let (profile, mut service, state) = setup(Arc::new(|| Ok(())));
        let mut settings = input(&service);
        settings.as_object_mut().unwrap().remove("enabled");
        assert_eq!(
            service
                .invoke(
                    "routines:create",
                    &[settings.clone()],
                    &state,
                    1_790_000_000_000
                )
                .unwrap_err()
                .code,
            "ROUTINE_EXECUTION_UNAVAILABLE"
        );
        settings["enabled"] = json!(true);
        assert!(service
            .invoke(
                "routines:create",
                &[settings.clone()],
                &state,
                1_790_000_000_000
            )
            .is_err());
        assert!(!profile.path().join("routines/routines.json").exists());
        settings["enabled"] = json!(false);
        let (created, changed) = service
            .invoke("routines:create", &[settings], &state, 1_790_000_000_000)
            .unwrap();
        assert!(changed);
        assert_eq!(created["routine"]["enabled"], false);
        assert_eq!(created["routine"]["createdBy"], json!({"kind":"user"}));
        let id = created["routine"]["id"].clone();
        let saved = fs::read(profile.path().join("routines/routines.json")).unwrap();
        assert_eq!(
            service
                .invoke(
                    "routines:update",
                    &[id, json!({"enabled":true})],
                    &state,
                    1_790_000_000_001
                )
                .unwrap_err()
                .code,
            "ROUTINE_EXECUTION_UNAVAILABLE"
        );
        assert_eq!(
            fs::read(profile.path().join("routines/routines.json")).unwrap(),
            saved
        );
        let (list, changed) = service
            .invoke("routines:list", &[], &state, 1_790_000_000_001)
            .unwrap();
        assert!(!changed);
        assert_eq!(list["routines"][0]["runs"], json!([]));
        service.close().unwrap();
    }
    #[test]
    fn foreign_unknown_archived_and_link_targets_refuse_before_any_save() {
        let (profile, mut service, mut state) = setup(Arc::new(|| Ok(())));
        let mut settings = input(&service);
        for target in [
            json!({"kind":"chat","chatId":"/foreign#1"}),
            json!({"kind":"new-chat","projectPath":"/foreign"}),
            json!({"kind":"chat","chatId":format!("{}#999",service.project.display())}),
        ] {
            settings["target"] = target;
            assert!(service
                .invoke(
                    "routines:create",
                    &[settings.clone()],
                    &state,
                    1_790_000_000_000
                )
                .is_err());
        }
        for target in [
            json!({"kind":"new-chat","projectPath":service.project,"workspace":"worktree"}),
            json!({"kind":"new-chat","projectPath":service.project,"workspace":"project","branch":"foreign"}),
            json!({"kind":"chat","chatId":format!("{}#1",service.project.display()),"computer":"foreign"}),
        ] {
            settings["target"] = target;
            assert!(service
                .invoke(
                    "routines:create",
                    &[settings.clone()],
                    &state,
                    1_790_000_000_000
                )
                .is_err());
        }
        assert_eq!(
            service
                .target(
                    &json!({"kind":"new-chat","projectPath":service.project,"workspace":"project"}),
                    &state
                )
                .unwrap()["workspace"],
            "project"
        );
        settings = input(&service);
        state["sessions"]["1"]["id"] = json!(1.0);
        assert!(
            service.target(&settings["target"], &state).is_ok(),
            "JS safe numeric ids include integral float representations"
        );
        for worktree in [
            json!({"id":1,"path":"/foreign-worktree"}),
            json!({"id":2,"path":service.project}),
            json!({"id":1,"path":service.project,"sharedChat":true}),
            Value::Null,
        ] {
            state["worktrees"]["1"] = worktree;
            assert_eq!(
                service
                    .invoke(
                        "routines:create",
                        &[settings.clone()],
                        &state,
                        1_790_000_000_000
                    )
                    .unwrap_err()
                    .code,
                "COMMAND_FAILED"
            );
            assert!(!profile.path().join("routines/routines.json").exists());
        }
        state["worktrees"]["1"] = json!({"id":1,"path":service.project});
        assert!(service.target(&settings["target"], &state).is_ok());
        state["sessions"]["1"]["archived"] = json!(true);
        assert!(service
            .invoke(
                "routines:create",
                &[settings.clone()],
                &state,
                1_790_000_000_000
            )
            .is_err());
        state["sessions"]["1"]
            .as_object_mut()
            .unwrap()
            .remove("archived");
        state["sessions"]["1"]["workspacePath"] = json!("/link");
        assert!(service
            .invoke("routines:create", &[settings], &state, 1_790_000_000_000)
            .is_err());
        assert!(!profile.path().join("routines/routines.json").exists());
        service.close().unwrap();
    }
    #[test]
    fn final_native_owner_refusal_withholds_result_and_retains_one_writer() {
        let calls = Arc::new(AtomicUsize::new(0));
        let denied = Arc::new(AtomicBool::new(false));
        let count = calls.clone();
        let gate = denied.clone();
        let check = Arc::new(move || {
            if count.fetch_add(1, Ordering::AcqRel) + 1 == 5 {
                gate.store(true, Ordering::Release);
            }
            if gate.load(Ordering::Acquire) {
                Err(RpcError::new("OWNER_REVOKED", "late revoke"))
            } else {
                Ok(())
            }
        });
        let (profile, mut service, state) = setup(check);
        let settings = input(&service);
        assert_eq!(
            service
                .invoke("routines:create", &[settings], &state, 1_790_000_000_000)
                .unwrap_err()
                .code,
            "ROUTINE_STORE_UNCERTAIN"
        );
        let saved: Value = serde_json::from_slice(
            &fs::read(profile.path().join("routines/routines.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["routines"][0]["enabled"], false);
        assert!(service.close().is_err());
        denied.store(false, Ordering::Release);
        assert_eq!(
            ConfiguredRoutines::open(
                profile.path(),
                service.project.clone(),
                Arc::new(|| Ok(())),
                1_790_000_000_000
            )
            .err()
            .unwrap()
            .code,
            "ROUTINE_STORE_BUSY"
        );
        assert!(service
            .invoke("routines:list", &[], &state, 1_790_000_000_000)
            .is_err());
        service.close().unwrap();
        let mut reopened = ConfiguredRoutines::open(
            profile.path(),
            service.project.clone(),
            Arc::new(|| Ok(())),
            1_790_000_000_000,
        )
        .unwrap();
        assert_eq!(
            reopened
                .invoke("routines:list", &[], &state, 1_790_000_000_000)
                .unwrap()
                .0["routines"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        reopened.close().unwrap();
    }
}
