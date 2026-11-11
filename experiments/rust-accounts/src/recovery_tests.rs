use super::*;
use crate::{AccountService, Availability, PreparationStatus, SyntheticSources};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::process::CommandExt,
    process::{Command, Stdio},
};
fn sources() -> SyntheticSources {
    SyntheticSources {
        codex_config: Some(
            "# keep\nmodel='synthetic'\n[mcp_servers.a]\ncommand='never-run'\n".into(),
        ),
        codex_instructions: Some("instructions\n".into()),
        claude_settings: Some("{\"apiKeyHelper\":\"synthetic\",\"unknown\":true}".into()),
        claude_instructions: Some("Claude instructions\n".into()),
        claude_mcp: Some("{\"mcpServers\":{\"a\":{}}}".into()),
        gemini_config_skills: true,
        gemini_cli_skills: true,
    }
}
const SCENARIOS: [&str; 7] = [
    "sources",
    "codex",
    "claude",
    "default",
    "antigravity",
    "combined",
    "remove",
];
fn setup(scenario: &str) -> (AccountSandbox, AccountService, String) {
    journal::inject(None, false);
    let copy = AccountSandbox::create(None).unwrap();
    let mut service = copy.open().unwrap();
    if scenario != "sources" {
        service.seed_synthetic_sources(&sources()).unwrap();
    }
    let id = if matches!(scenario, "sources" | "default" | "combined") {
        String::new()
    } else if scenario == "remove" {
        service
            .create_prepared("codex", "Synthetic", Availability::Installed)
            .unwrap()
            .account["id"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        service
            .create(scenario, "Synthetic", Availability::Installed)
            .unwrap()
            .account["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    fs::write(copy.path().join("unrelated-sentinel"), "must survive").unwrap();
    (copy, service, id)
}
fn run(service: &mut AccountService, scenario: &str, id: &str) -> Result<()> {
    match scenario {
        "sources" => match service.resume_synthetic_sources() {
            Err(error) if error.to_string() == "No isolated preparation plan exists." => {
                service.seed_synthetic_sources(&sources())
            }
            result => result,
        },
        "combined" => {
            let existing = service.accounts().unwrap().saved()["accounts"]
                .as_array()
                .unwrap()
                .first()
                .and_then(|a| a["id"].as_str())
                .map(str::to_owned);
            let pending = service
                .recoverable_creations()?
                .first()
                .and_then(|a| a.account["id"].as_str())
                .map(str::to_owned);
            let ready = if let Some(id) = existing.or(pending) {
                service.recover_creation("codex", &id)?
            } else {
                service
                    .create_prepared("codex", "Synthetic", Availability::Installed)
                    .map_err(crate::CreationError::into_cause)?
            };
            assert_eq!(ready.pending(), ["login"]);
            Ok(())
        }
        "remove" => service.remove("codex", id).map(|_| ()),
        "default" => service.prepare_synthetic_antigravity_default(),
        provider => service.resume_preparation(provider, id).map(|p| {
            assert_eq!(p.pending(), ["login"]);
        }),
    }
}
fn snapshot(path: &Path, root: &Path, id: &str) -> Value {
    let mut result = serde_json::Map::new();
    if !path.exists() {
        return Value::Object(result);
    }
    for entry in fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let name = entry.file_name().to_str().unwrap().to_owned();
        let name = if id.is_empty() {
            name
        } else {
            name.replace(id, "@ID@")
        };
        let m = fs::symlink_metadata(&path).unwrap();
        let norm = |text: String| {
            let text = text.replace(root.to_str().unwrap(), "@ROOT@");
            if id.is_empty() {
                text
            } else {
                text.replace(id, "@ID@")
            }
        };
        let value = if m.file_type().is_symlink() {
            json!({"link":norm(fs::read_link(path).unwrap().to_str().unwrap().into())})
        } else if m.is_dir() {
            snapshot(&path, root, id)
        } else {
            json!({"text":norm(fs::read_to_string(path).unwrap()),"mode":m.mode()&0o777})
        };
        result.insert(name, value);
    }
    Value::Object(result)
}
fn finished(copy: &AccountSandbox, service: &AccountService, scenario: &str, id: &str) -> Value {
    let discovered = service.accounts().unwrap().saved()["accounts"]
        .as_array()
        .unwrap()
        .first()
        .and_then(|a| a["id"].as_str())
        .unwrap_or("");
    let id = if scenario == "combined" {
        discovered
    } else {
        id
    };
    assert_eq!(
        fs::read_to_string(copy.path().join("unrelated-sentinel")).unwrap(),
        "must survive"
    );
    assert_eq!(
        fs::read_to_string(copy.path().join(MARKER)).unwrap(),
        copy.0.marker
    );
    if !matches!(scenario, "sources" | "default" | "combined" | "remove") {
        assert_eq!(
            service.preparation_status(scenario, id).unwrap(),
            PreparationStatus::Complete
        );
        assert!(service.snapshot().unwrap()["providers"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .all(|a| a["state"] == "unknown")));
    }
    json!({"home":snapshot(&copy.path().join("home"),copy.path(),id),"accounts":snapshot(&copy.path().join("accounts"),copy.path(),id)})
}
fn cleanup(copy: AccountSandbox, mut service: AccountService) {
    service.close();
    let path = copy.path().to_owned();
    drop(service);
    drop(copy);
    fs::remove_dir_all(path).unwrap();
}
fn baseline(scenario: &str) -> (Vec<&'static str>, Value) {
    let (copy, mut service, id) = setup(scenario);
    journal::inject(None, false);
    run(&mut service, scenario, &id).unwrap();
    let stages = journal::stages();
    journal::inject(None, false);
    let result = finished(&copy, &service, scenario, &id);
    cleanup(copy, service);
    (stages, result)
}
#[test]
fn every_logical_step_and_io_stage_can_resume_after_error() {
    for scenario in SCENARIOS {
        let (stages, expected) = baseline(scenario);
        let mut types = BTreeSet::new();
        let points: Vec<_> = stages
            .iter()
            .enumerate()
            .filter_map(|(i, s)| {
                let first = types.insert(*s);
                (first || matches!(*s, "step-before" | "step-recorded" | "plan-complete"))
                    .then_some(i)
            })
            .collect();
        eprintln!(
            "{scenario}: {} error points across {} checkpoints",
            points.len(),
            stages.len()
        );
        for point in points {
            let (copy, mut service, id) = setup(scenario);
            journal::inject(Some(point), false);
            assert!(
                run(&mut service, scenario, &id).is_err(),
                "{scenario}/{point}"
            );
            journal::inject(None, false);
            service.close();
            let mut next = copy
                .open()
                .unwrap_or_else(|e| panic!("reopen {scenario}/{point}: {e}"));
            run(&mut next, scenario, &id)
                .unwrap_or_else(|e| panic!("resume {scenario}/{point}: {e}"));
            assert_eq!(
                finished(&copy, &next, scenario, &id),
                expected,
                "{scenario}/{point}"
            );
            drop(service);
            cleanup(copy, next);
        }
    }
}
fn child(copy: &AccountSandbox, scenario: &str, id: &str, point: usize) -> std::process::Output {
    let root_fd = copy.0.dir.as_raw_fd();
    let accounts_fd = copy.0.accounts.as_raw_fd();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "store::recovery_tests::crash_child",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(root_fd, 198) < 0 || libc::dup2(accounts_fd, 199) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    let transfer = json!({"path":copy.path(),"marker":copy.0.marker,"key":copy.0.journal_key,"scenario":scenario,"id":id,"point":point});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&transfer).unwrap().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
#[test]
fn real_process_crashes_recover_with_retained_capability_at_every_io_stage() {
    for scenario in SCENARIOS {
        let (stages, expected) = baseline(scenario);
        let mut types = BTreeSet::new();
        let points: Vec<_> = stages
            .iter()
            .enumerate()
            .filter_map(|(i, s)| types.insert(*s).then_some(i))
            .collect();
        eprintln!("{scenario}: {} process crash stages", points.len());
        for point in points {
            let (copy, mut service, id) = setup(scenario);
            service.close();
            let output = child(&copy, scenario, &id, point);
            assert_eq!(
                output.status.code(),
                Some(72),
                "child {scenario}/{point}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let mut next = copy
                .open()
                .unwrap_or_else(|e| panic!("reopen {scenario}/{point}: {e}"));
            run(&mut next, scenario, &id)
                .unwrap_or_else(|e| panic!("resume {scenario}/{point}: {e}"));
            assert_eq!(
                finished(&copy, &next, scenario, &id),
                expected,
                "{scenario}/{point}"
            );
            drop(service);
            cleanup(copy, next);
        }
    }
}
#[test]
#[ignore = "exec-only fixture child; inherited private copy descriptors, never caller paths"]
fn crash_child() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let value: Value = serde_json::from_str(&input).unwrap();
    let key: [u8; 32] = serde_json::from_value(value["key"].clone()).unwrap();
    let dir = unsafe { File::from_raw_fd(198) };
    let accounts = unsafe { File::from_raw_fd(199) };
    let staging = open(
        &dir,
        ".preparation-staging",
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )
    .unwrap();
    // Only test code reconstructs a capability from inherited descriptors and its parent's secret.
    // Production exposes no deserializer, caller-path admission or recovery-key export.
    let copy = AccountSandbox(Arc::new(Root {
        path: PathBuf::from(value["path"].as_str().unwrap()),
        dir,
        accounts,
        staging,
        marker: value["marker"].as_str().unwrap().into(),
        links: Mutex::new(BTreeMap::new()),
        journal_key: key,
        journal: Mutex::new(JournalState {
            data: Journal::default(),
            bytes: vec![],
        }),
    }));
    let mut service = copy.open().unwrap();
    journal::inject(Some(value["point"].as_u64().unwrap() as usize), true);
    run(
        &mut service,
        value["scenario"].as_str().unwrap(),
        value["id"].as_str().unwrap(),
    )
    .unwrap();
    panic!("crash point was not reached")
}
#[test]
fn conflicts_journal_edits_and_unrelated_files_are_not_overwritten() {
    let (copy, mut service, id) = setup("codex");
    let (stages, _) = baseline("codex");
    let point = stages
        .iter()
        .position(|s| *s == "profile-file-published")
        .unwrap();
    journal::inject(Some(point), false);
    assert!(run(&mut service, "codex", &id).is_err());
    journal::inject(None, false);
    let dir = copy.path().join("accounts").join(&id);
    let config = dir.join("config.toml");
    fs::write(&config, "changed independently").unwrap();
    fs::write(dir.join("unknown-file"), "leave alone").unwrap();
    service.close();
    let mut next = copy.open().unwrap();
    assert!(run(&mut next, "codex", &id).is_err());
    assert_eq!(
        fs::read_to_string(&config).unwrap(),
        "changed independently"
    );
    assert_eq!(
        fs::read_to_string(dir.join("unknown-file")).unwrap(),
        "leave alone"
    );
    next.close();
    let journal_path = copy.path().join(journal::FILE);
    let original = fs::read(&journal_path).unwrap();
    fs::write(&journal_path, b"{}").unwrap();
    assert!(copy.open().is_err());
    assert_eq!(fs::read(&journal_path).unwrap(), b"{}");
    fs::write(&journal_path, original).unwrap();
    let removed = next.remove("codex", &id);
    assert!(removed.is_err());
    drop(service);
    cleanup(copy, next);
}

#[test]
fn creation_publication_is_idempotent_and_forgetting_never_resurrects() {
    let (stages, _) = baseline("combined");
    for stage in [
        "creation-before-metadata",
        "metadata-temp-synced",
        "metadata-renamed",
        "creation-after-metadata",
        "creation-published",
    ] {
        let point = stages.iter().position(|s| *s == stage).unwrap();
        let (copy, mut service, id) = setup("combined");
        journal::inject(Some(point), false);
        assert!(run(&mut service, "combined", &id).is_err());
        journal::inject(None, false);
        service.close();
        let mut next = copy.open().unwrap();
        let before = next.accounts().unwrap().saved()["accounts"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(
            before,
            usize::from(matches!(
                stage,
                "metadata-renamed" | "creation-after-metadata" | "creation-published"
            ))
        );
        if before == 0 {
            let pending = next.recoverable_creations().unwrap();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].preparation, PreparationStatus::Complete);
        }
        run(&mut next, "combined", &id).unwrap();
        let account = next.accounts().unwrap().saved()["accounts"][0].clone();
        let id = account["id"].as_str().unwrap();
        assert_eq!(
            next.accounts().unwrap().saved()["accounts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        next.recover_creation("codex", id).unwrap();
        assert_eq!(
            next.accounts().unwrap().saved()["accounts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        next.remove("codex", id).unwrap();
        assert!(next.recover_creation("codex", id).is_err());
        assert!(next.recoverable_creations().unwrap().is_empty());
        assert!(copy.path().join("accounts").join(id).exists());
        drop(service);
        cleanup(copy, next);
    }
}
#[test]
fn reserved_creation_counts_toward_limit_and_retry_uses_saved_source() {
    let (stages, _) = baseline("combined");
    let point = stages
        .iter()
        .position(|s| *s == "creation-before-metadata")
        .unwrap();
    let seed=json!({"accounts":(0..19).map(|i|json!({"id":format!("{i:08}-1111-4111-8111-111111111111"),"provider":"codex","label":"Existing"})).collect::<Vec<_>>(),"selected":{}}).to_string();
    let copy = AccountSandbox::create(Some(&seed)).unwrap();
    let mut service = copy.open().unwrap();
    service.seed_synthetic_sources(&sources()).unwrap();
    journal::inject(Some(point), false);
    assert!(service
        .create_prepared("codex", "Reserved", Availability::Installed)
        .is_err());
    journal::inject(None, false);
    assert_eq!(service.recoverable_creations().unwrap().len(), 1);
    assert_eq!(
        service
            .create("codex", "Extra", Availability::Installed)
            .unwrap_err()
            .to_string(),
        "You can save up to 20 accounts."
    );
    let id = service.recoverable_creations().unwrap()[0].account["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let config = copy.path().join("accounts").join(&id).join("config.toml");
    let before = fs::read(&config).unwrap();
    fs::write(
        copy.path().join("home/.codex/config.toml"),
        "source changed",
    )
    .unwrap();
    service.recover_creation("codex", &id).unwrap();
    assert_eq!(fs::read(config).unwrap(), before);
    assert_eq!(
        service.accounts().unwrap().saved()["accounts"]
            .as_array()
            .unwrap()
            .len(),
        20
    );
    cleanup(copy, service);
}

#[test]
fn authenticated_older_journal_cannot_resurrect_a_removed_creation() {
    let (copy, mut service, _) = setup("combined");
    let point = baseline("combined")
        .0
        .iter()
        .position(|s| *s == "creation-before-metadata")
        .unwrap();
    journal::inject(Some(point), false);
    assert!(service
        .create_prepared("codex", "Synthetic", Availability::Installed)
        .is_err());
    journal::inject(None, false);
    let old = fs::read(copy.path().join(journal::FILE)).unwrap();
    let id = service.recoverable_creations().unwrap()[0].account["id"]
        .as_str()
        .unwrap()
        .to_owned();
    service.recover_creation("codex", &id).unwrap();
    service.remove("codex", &id).unwrap();
    let current = fs::read(copy.path().join(journal::FILE)).unwrap();
    service.close();
    fs::write(copy.path().join(journal::FILE), old).unwrap();
    assert!(copy.open().is_err());
    assert!(
        !fs::read_to_string(copy.path().join("accounts/accounts.json"))
            .unwrap()
            .contains(&id)
    );
    fs::write(copy.path().join(journal::FILE), current).unwrap();
    let mut next = copy.open().unwrap();
    assert!(next.recover_creation("codex", &id).is_err());
    drop(service);
    cleanup(copy, next);
}

#[test]
fn twenty_failed_creations_can_be_identified_abandoned_or_recovered() {
    let (copy, mut service, _) = setup("combined");
    let stages = baseline("combined").0;
    let point = stages.iter().position(|s| *s == "step-before").unwrap();
    let mut ids = vec![];
    for n in 0..20 {
        journal::inject(Some(point), false);
        let error = service
            .create_prepared(
                "codex",
                &format!("Reservation {n}"),
                Availability::Installed,
            )
            .unwrap_err();
        journal::inject(None, false);
        let identity = error
            .identity()
            .expect("failed allocation retains its typed identity");
        assert_eq!(identity.provider, "codex");
        ids.push(identity.id.clone());
    }
    assert_eq!(service.recoverable_creations().unwrap().len(), 20);
    assert!(service.accounts().unwrap().saved()["accounts"]
        .as_array()
        .unwrap()
        .is_empty());
    let full = service
        .create_prepared("codex", "Full", Availability::Installed)
        .unwrap_err();
    assert!(full.identity().is_none());
    assert_eq!(full.to_string(), "You can save up to 20 accounts.");
    // This plan has a persistent conflict. Abandon must preserve that exact file.
    let dir = copy.path().join("accounts").join(&ids[0]);
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(dir.join("config.toml"), "unrelated conflicting content").unwrap();
    fs::set_permissions(dir.join("config.toml"), fs::Permissions::from_mode(0o600)).unwrap();
    assert!(service.recover_creation("codex", &ids[0]).is_err());
    for id in &ids[..15] {
        service.abandon_creation("codex", id).unwrap();
        service.abandon_creation("codex", id).unwrap();
        assert!(service.recover_creation("codex", id).is_err());
    }
    assert_eq!(
        fs::read_to_string(dir.join("config.toml")).unwrap(),
        "unrelated conflicting content"
    );
    for id in &ids[15..] {
        service.recover_creation("codex", id).unwrap();
        assert!(service.abandon_creation("codex", id).is_err());
    }
    assert!(service.recoverable_creations().unwrap().is_empty());
    service
        .create_prepared("codex", "New", Availability::Installed)
        .unwrap();
    assert_eq!(
        service.accounts().unwrap().saved()["accounts"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    service.close();
    let mut next = copy.open().unwrap();
    for id in &ids[..15] {
        assert!(next.recover_creation("codex", id).is_err());
    }
    assert_eq!(
        fs::read_to_string(dir.join("config.toml")).unwrap(),
        "unrelated conflicting content"
    );
    drop(service);
    cleanup(copy, next);
}
#[test]
fn failure_identity_covers_ambiguous_publication_without_claiming_a_plan_exists() {
    let stages = baseline("combined").0;
    for stage in ["journal-before-temp", "metadata-renamed"] {
        let (copy, mut service, _) = setup("combined");
        journal::inject(
            Some(stages.iter().position(|s| *s == stage).unwrap()),
            false,
        );
        let error = service
            .create_prepared("codex", "Synthetic", Availability::Installed)
            .unwrap_err();
        journal::inject(None, false);
        let identity = error.identity().unwrap().clone();
        service.close();
        let mut next = copy.open().unwrap();
        if stage == "journal-before-temp" {
            assert!(next.recoverable_creations().unwrap().is_empty());
            assert!(next
                .abandon_creation(&identity.provider, &identity.id)
                .is_err());
            next.create_prepared("codex", "Retry", Availability::Installed)
                .unwrap();
        } else {
            assert!(next
                .abandon_creation(&identity.provider, &identity.id)
                .is_err());
            next.recover_creation(&identity.provider, &identity.id)
                .unwrap();
            assert_eq!(
                next.accounts().unwrap().saved()["accounts"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        drop(service);
        cleanup(copy, next);
    }
}

#[test]
fn every_removal_stage_refuses_resume_and_finishes_without_resurrection() {
    let (stages, _) = baseline("remove");
    for (point, stage) in stages.iter().enumerate() {
        let (copy, mut service, id) = setup("remove");
        let dir = copy.path().join("accounts").join(&id);
        fs::write(dir.join("sentinel"), "keep").unwrap();
        journal::inject(Some(point), false);
        assert!(service.remove("codex", &id).is_err());
        journal::inject(None, false);
        // The first two failures precede a durable Removing intent; all later points must refuse.
        if point > 1 {
            assert!(
                service.resume_preparation("codex", &id).is_err(),
                "{point}/{}",
                stage
            );
        }
        service.close();
        let mut next = copy.open().unwrap();
        if point > 1 {
            assert!(next.resume_preparation("codex", &id).is_err());
        }
        next.remove("codex", &id).unwrap();
        next.remove("codex", &id).unwrap();
        assert!(next.accounts().unwrap().saved()["accounts"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(next.recover_creation("codex", &id).is_err());
        assert_eq!(fs::read_to_string(dir.join("sentinel")).unwrap(), "keep");
        drop(service);
        cleanup(copy, next);
    }
}
#[test]
fn ambiguous_publish_latches_every_service_operation_until_close_and_reopen() {
    let stages = baseline("combined").0;
    for stage in ["journal-renamed", "profile-renamed", "metadata-renamed"] {
        let (copy, mut service, _) = setup("combined");
        let mut ticket = service
            .create("codex", "Existing", Availability::Installed)
            .unwrap();
        let id = ticket.account["id"].as_str().unwrap().to_owned();
        let request = service.begin_observation("codex", "default").unwrap();
        let proof = service
            .observed(request, crate::IdentityState::Ready)
            .unwrap();
        let request = service.begin_observation("claude", "default").unwrap();
        journal::inject(
            Some(stages.iter().position(|s| *s == stage).unwrap()),
            false,
        );
        assert!(service
            .create_prepared("codex", "Synthetic", Availability::Installed)
            .is_err());
        journal::inject(None, false);
        let before_meta = fs::read(copy.path().join("accounts/accounts.json")).unwrap();
        let before_journal = fs::read(copy.path().join(journal::FILE)).unwrap();
        assert!(service.accounts().is_err());
        assert!(service.snapshot().is_err());
        assert!(service.scope_snapshot("/synthetic").is_err());
        assert!(service.pin(None).is_err());
        assert!(service.owner_id().is_err());
        assert!(service.generation().is_err());
        assert!(service.take_events().is_err());
        assert!(service
            .create("codex", "No", Availability::Installed)
            .is_err());
        assert!(service
            .create_prepared("codex", "No", Availability::Installed)
            .is_err());
        assert!(service.recoverable_creations().is_err());
        assert!(service.recover_creation("codex", &id).is_err());
        assert!(service.abandon_creation("codex", &id).is_err());
        assert!(service.prepare_creation(&mut ticket).is_err());
        assert!(service.resume_preparation("codex", &id).is_err());
        assert!(service.preparation_status("codex", &id).is_err());
        assert!(service.seed_synthetic_sources(&sources()).is_err());
        assert!(service.resume_synthetic_sources().is_err());
        assert!(service.prepare_synthetic_antigravity_default().is_err());
        assert!(service
            .inherit_synthetic_mcp("codex", &id, Some(""))
            .is_err());
        assert!(service.begin_observation("codex", "default").is_err());
        assert!(service
            .observed(request, crate::IdentityState::Ready)
            .is_err());
        assert!(service.select("codex", "default", proof).is_err());
        assert!(service.assign("/synthetic", "codex", None, None).is_err());
        assert!(service.remove("codex", &id).is_err());
        assert_eq!(
            fs::read(copy.path().join("accounts/accounts.json")).unwrap(),
            before_meta
        );
        assert_eq!(
            fs::read(copy.path().join(journal::FILE)).unwrap(),
            before_journal
        );
        assert!(copy.open().is_err());
        service.close();
        assert!(service.snapshot().is_err());
        let next = copy.open().unwrap();
        assert!(next.snapshot().is_ok());
        drop(service);
        cleanup(copy, next);
    }
}
