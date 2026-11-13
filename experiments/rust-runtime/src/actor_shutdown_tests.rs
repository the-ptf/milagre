// Included inside actor::job_tests. Every path and lock belongs to a fresh isolated fixture.

struct ReplaceLockOnShutdown {
    record: PathBuf,
    replacement: Arc<Mutex<Option<Vec<u8>>>>,
    shutdowns: Arc<AtomicU64>,
}

impl Provider for ReplaceLockOnShutdown {
    fn name(&self) -> &str {
        "release-fault-fixture"
    }
    fn start_turn(&mut self, _: TurnId, _: &RawJson) -> Result<(), ProviderError> {
        panic!("the release-only fixture must never start a provider turn")
    }
    fn interrupt(&mut self, _: &str, _: TurnId) -> Result<(), ProviderError> {
        panic!("the release-only fixture has no provider turn to interrupt")
    }
    fn respond_permission(
        &mut self,
        _: &str,
        _: TurnId,
        _: AnswerId,
        _: &str,
        _: &str,
    ) -> Result<(), ProviderError> {
        panic!("the release-only fixture has no pending permission")
    }
    fn answer_question(
        &mut self,
        _: &str,
        _: TurnId,
        _: AnswerId,
        _: &str,
        _: &RawJson,
    ) -> Result<(), ProviderError> {
        panic!("the release-only fixture has no pending question")
    }
    fn close_chat(&mut self, _: &str, _: TurnId) -> Result<(), ProviderError> {
        panic!("the release-only fixture has no provider session")
    }
    fn shutdown(&mut self) {
        assert_eq!(self.shutdowns.fetch_add(1, Ordering::AcqRel), 0);
        // This callback runs after State::shutdown's pre-close publication verified the owner,
        // and before ProjectStates::close removes the slot and tries to release its lock.
        let mut record: Value = serde_json::from_slice(&fs::read(&self.record).unwrap()).unwrap();
        record["token"] = json!("synthetic-replacement-owner-token");
        let replacement = serde_json::to_vec(&record).unwrap();
        fs::write(&self.record, &replacement).unwrap();
        *self.replacement.lock().unwrap() = Some(replacement);
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        vec![]
    }
}

#[test]
fn failed_lock_release_preserves_shutdown_error_audit_and_content_revocation() {
    for preexisting_delivery_failure in [false, true] {
        let (profile, project, mut host) = seeded();
        let profile_path = profile.path().to_path_buf();
        let record = project.join(".milagre/runtime.lock/owner.json");
        let replacement = Arc::new(Mutex::new(None));
        let shutdowns = Arc::new(AtomicU64::new(0));
        host.register(Box::new(ReplaceLockOnShutdown {
            record: record.clone(),
            replacement: replacement.clone(),
            shutdowns: shutdowns.clone(),
        }));
        let content = crate::claude_content::SharedContent::new(
            host.states.isolation().clone(),
            project.clone(),
        )
        .unwrap();
        let (server, actor) = running_content(
            profile,
            &project,
            host,
            Default::default(),
            Some(content.clone()),
        );
        let chat = format!("{}#1", project.display());
        let retained = content.dispatcher(&chat).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            runtime.block_on(retained.call("artifact_list", &json!({})))["isError"],
            false
        );
        assert_eq!(
            actor.shared.snapshot.lock().unwrap()["projects"][0]["path"],
            json!(project)
        );
        if preexisting_delivery_failure {
            actor.shared.delivery_failed.store(true, Ordering::Release);
        }

        let original = convert(milagre_owner_store::StoreError::OwnershipChanged(
            record.parent().unwrap().to_path_buf(),
        ));
        let refused = actor.call(Command::shutdown(false)).unwrap_err();
        assert_eq!(refused.code, "COMMAND_FAILED");
        assert_eq!(refused.code, original.code);
        assert_eq!(refused.message, original.message);
        assert_eq!(shutdowns.load(Ordering::Acquire), 1);
        assert!(!server.is_stopped());
        assert!(actor.shared.closing.load(Ordering::Acquire));
        assert_eq!(
            actor.shared.delivery_failed.load(Ordering::Acquire),
            preexisting_delivery_failure,
            "a released slot must not create a publication failure"
        );
        let snapshot = diagnostic_snapshot(&actor.shared).unwrap();
        assert_eq!(snapshot["projects"], json!([]));
        assert_eq!(snapshot["runs"]["runs"], json!({}));
        assert_eq!(
            snapshot["diagnostics"]["rustOwnerAudit"]["ownerLockStrandedNotices"],
            1
        );
        assert_eq!(
            snapshot["diagnostics"]["rustOwnerAudit"]["ownerLockStranded"],
            true
        );
        assert!(content
            .renderer("artifact:list", &json!({"chatId":chat}))
            .is_err());
        assert_eq!(
            runtime.block_on(retained.call("artifact_list", &json!({})))["isError"],
            true,
            "the pre-close dispatcher must lose its Project generation"
        );
        let foreign = replacement.lock().unwrap().clone().unwrap();
        assert_eq!(fs::read(&record).unwrap(), foreign);

        // No slot remains to retry. The next explicit shutdown completes without adopting or
        // deleting the foreign record, even when publication was already latched closed.
        server.shutdown().unwrap();
        assert!(server.is_stopped());
        assert_eq!(
            *actor.shared.observed_quit.lock().unwrap(),
            Some(QuitState::Done)
        );
        assert_eq!(shutdowns.load(Ordering::Acquire), 1);
        assert_eq!(
            actor.shared.stranded_lock_notices.load(Ordering::Acquire),
            1
        );
        assert_eq!(actor.shared.snapshot.lock().unwrap()["projects"], json!([]));
        assert_eq!(fs::read(&record).unwrap(), foreign);
        assert_eq!(
            runtime.block_on(retained.call("artifact_list", &json!({})))["isError"],
            true
        );
        drop(retained);
        drop(content);
        drop(actor);
        Server::finish(server).unwrap();
        assert!(!profile_path.exists());
    }
}
