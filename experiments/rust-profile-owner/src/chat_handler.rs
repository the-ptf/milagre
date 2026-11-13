//! Multi-Project ChatHost composition. The profile mutex is the actor: commands and ticks acquire it
//! inside the wire publication transaction, so state, runs and events have one ordering.
use super::*;
use milagre_owner_store::{
    agent_runs::project_of_key,
    chat_host::{Notice, Provider},
};
use milagre_owner_wire::{EventSink, Publication};

impl Profile {
    pub(super) fn refresh_chat_views(core: &mut Core) {
        core.views.retain(|_, context| context.is_connected());
        core.host.focused_chats = core
            .views
            .values()
            .filter_map(|context| {
                let view = context.view();
                view.focused.then_some(view.chat_id).flatten()
            })
            .collect();
    }

    pub(super) fn check_chat_projects(core: &mut Core) {
        Self::refresh_chat_views(core);
        for path in core.order.clone() {
            if core.host.is_project_ready(&path) {
                let _ = core.host.require_project_ready(&path);
            }
        }
    }

    pub(super) fn chat_runs(core: &mut Core) -> Value {
        Self::check_chat_projects(core);
        let runs: Map<String, Value> = core
            .host
            .runs()
            .iter()
            .filter(|(chat, _)| core.host.is_project_ready(Path::new(project_of_key(chat))))
            .map(|(chat, run)| (chat.clone(), run.clone()))
            .collect();
        json!({"runs":runs,"seq":core.run_seq})
    }

    pub(crate) fn register_providers(&self, providers: Vec<Box<dyn Provider>>) {
        let mut core = locked(&self.core);
        core.chats_enabled = !providers.is_empty();
        for provider in providers {
            core.host.register(provider);
        }
    }

    fn admit_chat_project(&self, core: &mut Core, path: &str) -> Result<(), RpcError> {
        let key = Path::new(path);
        if !core.loaded.contains_key(key) {
            return Err(failed("Open the project before sending to its chats."));
        }
        if core.host.is_project_ready(key) {
            return core.host.require_project_ready(key).map_err(store);
        }
        if core.chat_admitted.contains(key) {
            return core.host.open_project(key).map_err(store);
        }
        let state = self.state(core, key, path)?;
        if let Some(owner) = core.loaded.get_mut(key).unwrap().unsaved.take() {
            if let Err(refusal) = core
                .host
                .states
                .adopt_unsaved(owner, ProjectState::from_value(&state))
            {
                let (owner, error) = *refusal;
                core.loaded.get_mut(key).unwrap().unsaved = Some(owner);
                return Err(store(error));
            }
        } else {
            core.host.states.assert_owned(key).map_err(store)?;
            core.host
                .states
                .reconcile_read(key, ProjectState::from_value(&state))
                .map_err(store)?;
        }
        core.host.open_project(key).map_err(store)?;
        core.chat_admitted.insert(key.to_owned());
        Ok(())
    }

    pub(super) fn chat_command(
        &self,
        core: &mut Core,
        method: &str,
        args: &[Value],
        publication: &Publication<'_>,
    ) -> RpcResult {
        if method == "chat:send" {
            let path = args
                .first()
                .and_then(|v| v["projectPath"].as_str())
                .unwrap_or("");
            self.admit_chat_project(core, path)?;
        } else if matches!(
            method,
            "agent:interrupt" | "chat:queue-send" | "chat:queue-remove"
        ) {
            let chat = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| failed("Choose a Chat."))?;
            let path = Path::new(project_of_key(chat));
            if !core.loaded.contains_key(path) || !core.host.is_project_ready(path) {
                return Err(failed("Open the project before sending to its chats."));
            }
            core.host.require_project_ready(path).map_err(store)?;
        } else {
            let path = args.first().and_then(Value::as_str).unwrap_or("");
            let loaded = core
                .loaded
                .get(Path::new(path))
                .ok_or_else(|| failed("Open the Project before reading its messages."))?;
            if loaded.unsaved.is_some() {
                return match method {
                    "chat:send-status"
                        if args
                            .get(1)
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty()) =>
                    {
                        Ok(Value::Null)
                    }
                    "chat:send-status" => Err(store(StoreError::BadSendStatus)),
                    "chat:all-messages" => {
                        if args.get(1).is_some_and(|o| o["withState"] == true) {
                            Ok(
                                json!({"state":self.state(core, Path::new(path), path)?, "messages":[]}),
                            )
                        } else {
                            Ok(json!([]))
                        }
                    }
                    "chat:search" => Ok(json!([])),
                    "chat:subagent" => Err(failed("That subagent is no longer in this Chat.")),
                    _ => unreachable!(),
                };
            }
            core.host
                .states
                .assert_owned(Path::new(path))
                .map_err(store)?;
            return core.host.states.call(method, args).map_err(store);
        }
        let result = core.host.call(method, args).map_err(store);
        // Even a failed start can have a durably saved user message and turn-failed event.
        self.publish_chat_notices(core, publication)?;
        result
    }

    pub(super) fn publish_chat_notices(
        &self,
        core: &mut Core,
        publication: &Publication<'_>,
    ) -> Result<(), RpcError> {
        self.publish_chat_notices_with(core, |channel, payload| publication.emit(channel, payload))
    }

    fn publish_chat_notices_with(
        &self,
        core: &mut Core,
        mut emit: impl FnMut(&str, Value) -> Result<u64, RpcError>,
    ) -> Result<(), RpcError> {
        core.notices.extend(core.host.take_notices());
        core.state_events.extend(core.host.states.take_events());
        // A failed hydration/publication retains the front and all following notices. Commands and ticks
        // drain this queue before admitting more work, so repeated delivery failure cannot grow the queue.
        while let Some(notice) = core.notices.front().cloned() {
            match notice {
                Notice::Event {
                    chat,
                    event,
                    seq,
                    with_state,
                } => {
                    let path = Path::new(project_of_key(&chat));
                    if core.host.require_project_ready(path).is_err() {
                        core.notices.pop_front();
                        continue;
                    }
                    let mut payload = json!({"chatId": chat, "event":event});
                    if let Some(seq) = seq {
                        payload["seq"] = json!(seq);
                    }
                    if with_state {
                        payload["state"] = core.host.states.whole_state(path).map_err(store)?;
                    }
                    emit("agent:event", payload)?;
                    if let Some(seq) = seq {
                        core.run_seq = core.run_seq.max(seq);
                    }
                }
                Notice::Broadcast { project } | Notice::ProjectReady { project } => {
                    if core.host.require_project_ready(&project).is_err() {
                        core.notices.pop_front();
                        continue;
                    }
                    let state = core.host.states.whole_state(&project).map_err(store)?;
                    let version = Self::chat_version(core, &project, &state);
                    emit(
                        "project:state",
                        json!({"path":project,"state":state,"version":version,"epoch":self.epoch}),
                    )?;
                }
                Notice::Failed { error, .. } | Notice::Gap { what: error, .. } => {
                    // No silent loss of a failed fold. A later read still checks ownership and persistence.
                    eprintln!("profile ChatHost: {error}");
                }
                Notice::LockStranded { why, .. } => eprintln!("profile ChatHost ownership: {why}"),
                _ => {} // Naming and async answer/mode commands are outside this fixture's advertised surface.
            }
            core.notices.pop_front();
        }
        while let Some(event) = core.state_events.front().cloned() {
            use milagre_owner_store::states::Event;
            match event {
                Event::Persistence { project, .. } | Event::Unloaded { project } => {
                    if core.host.require_project_ready(&project).is_err() {
                        core.state_events.pop_front();
                        continue;
                    }
                    let state = core.host.states.whole_state(&project).map_err(store)?;
                    let version = Self::chat_version(core, &project, &state);
                    emit(
                        "project:state",
                        json!({"path":project,"state":state,"version":version,"epoch":self.epoch}),
                    )?;
                }
                Event::Saved { .. } | Event::SaveFailed { .. } => {}
            }
            core.state_events.pop_front();
        }
        Ok(())
    }

    pub(super) fn chat_version(core: &mut Core, path: &Path, state: &Value) -> u64 {
        let (old, version) = core
            .versions
            .entry(path.to_owned())
            .or_insert_with(|| (state.clone(), 1));
        if old != state {
            *old = state.clone();
            *version += 1;
        }
        *version
    }

    pub(crate) fn watch_chats(self: &Arc<Self>, events: EventSink) {
        if !locked(&self.core).chats_enabled {
            return;
        }
        let owner = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(20));
            let Some(owner) = owner.upgrade() else {
                break;
            };
            if locked(&owner.core).closed {
                break;
            }
            let result = events.transaction(|publication| {
                owner.check_owned()?;
                let mut core = locked(&owner.core);
                if core.closed {
                    return Ok(());
                }
                Self::check_chat_projects(&mut core);
                owner.publish_chat_notices(&mut core, publication)?;
                for error in core.host.tick(now_ms()) {
                    eprintln!("profile ChatHost tick: {error}");
                }
                owner.publish_chat_notices(&mut core, publication)
            });
            if result
                .as_ref()
                .is_err_and(|error| error.code == "DAEMON_CLOSED")
            {
                break;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_failure_retains_front_and_later_notices_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap().join("copy");
        let isolation = Isolation::create(&root, &crate::policy::owner_policy()).unwrap();
        let data = root.join("profile");
        let project = root.join("alpha");
        std::fs::create_dir(&data).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        std::fs::write(
            project.join(".milagre/coordination.json"),
            br#"{"next_id":1,"sessions":{},"worktrees":{},"messages":[]}"#,
        )
        .unwrap();
        let guard = RustOwnerLock
            .acquire(&data, &data.join("runtime.lock"))
            .unwrap();
        let profile = Profile::new(
            isolation,
            data,
            root.join("chats"),
            Arc::new(Mutex::new(Some(guard))),
            "test".into(),
        )
        .unwrap();
        let mut core = locked(&profile.core);
        core.host.open_project(&project).unwrap();
        core.host.take_notices();
        let chat = format!("{}#1", project.display());
        for seq in [1, 2] {
            core.notices.push_back(Notice::Event {
                chat: chat.clone(),
                event: json!({"type":"text-delta","text":seq}),
                seq: Some(seq),
                with_state: false,
            });
        }
        let error = profile
            .publish_chat_notices_with(&mut core, |_, _| {
                Err(RpcError::new("FRAME_TOO_LARGE", "injected"))
            })
            .unwrap_err();
        assert_eq!(error.code, "FRAME_TOO_LARGE");
        assert_eq!(core.notices.len(), 2);
        assert_eq!(core.run_seq, 0);
        let mut seen = Vec::new();
        profile
            .publish_chat_notices_with(&mut core, |channel, payload| {
                seen.push((channel.to_owned(), payload));
                Ok(1)
            })
            .unwrap();
        assert!(core.notices.is_empty());
        assert!(core.state_events.is_empty());
        assert_eq!(core.run_seq, 2);
        assert_eq!(
            seen.iter()
                .map(|(_, v)| v["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        drop(core);
        profile.close().unwrap();
    }
}
