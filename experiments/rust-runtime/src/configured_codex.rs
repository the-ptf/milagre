//! Explicit owner-selected Codex launch. No discovery, credentials or Node sidecar.
// Account environment selection adapted from MonoCode accounts.rs/provider.rs.
// Copyright (c) 2026 Nick. MIT; see THIRD_PARTY_NOTICES.md.
// Source: hardbeat920/monocode@09d04436babb39ad72198cdf22f735067027fc04.
use milagre_owner_store::Isolation;
use milagre_providers::codex;
use std::{path::PathBuf, sync::Arc};

pub(crate) type Check = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
/// Only the dedicated owner constructs this capability from its pinned manifest.
/// No request JSON can select executable, account, environment or root lifetime.
pub(crate) struct CodexLaunchContext {
    pub(crate) isolation: Isolation,
    pub(crate) project: PathBuf,
    pub(crate) program: PathBuf,
    pub(crate) home: PathBuf,
    pub(crate) config_directory: PathBuf,
    pub(crate) path: String,
    pub(crate) user_name: String,
    pub(crate) model: String,
    pub(crate) developer_instructions: String,
    pub(crate) tldr_enabled: bool,
    pub(crate) lifetime: Arc<dyn Send + Sync>,
    pub(crate) check: Check,
}
impl CodexLaunchContext {
    pub(crate) fn validate(&self) -> Result<(), String> {
        (self.check)()?;
        if self
            .isolation
            .resolve(&self.project)
            .map_err(|e| e.to_string())?
            != self.project
            || !self.project.is_dir()
            || !self.program.is_absolute()
            || !self.home.is_absolute()
            || !self.config_directory.is_absolute()
            || !self.home.is_dir()
            || !self.config_directory.is_dir()
            || self.model.is_empty()
            || self.model.len() > 256
            || self.user_name.is_empty()
            || self.user_name.len() > 256
            || self.user_name.contains('\0')
            || self.path.contains('\0')
            || self.developer_instructions.is_empty()
            || self.developer_instructions.len() > 1024 * 1024
        {
            return Err("Invalid captured Codex launch".into());
        }
        Ok(())
    }
    pub(crate) fn spawn(&self) -> Result<codex::SpawnOptions, String> {
        self.validate()?;
        // MonoCode selects CODEX_HOME and removes ambient API-token overrides.
        // An exact replacement environment makes those removals unconditional,
        // and avoids its ambient GUI discovery / directory creation behavior.
        Ok(codex::SpawnOptions::new(self.program.as_os_str())
            .cwd(&self.project)
            .env(vec![
                ("HOME", self.home.as_os_str().to_owned()),
                ("CODEX_HOME", self.config_directory.as_os_str().to_owned()),
                ("PATH", self.path.clone().into()),
                ("USER", self.user_name.clone().into()),
                ("LOGNAME", self.user_name.clone().into()),
                ("LANG", "en_US.UTF-8".into()),
            ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_store::{
        chat_host::{Provider, ProviderEvent, TurnId},
        jsjson::RawJson,
        Policy,
    };
    use milagre_owner_wire::IsolatedProfile;
    use serde_json::json;
    use std::path::Path;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };
    fn context() -> (IsolatedProfile, CodexLaunchContext, Arc<AtomicBool>) {
        context_scenario("reply")
    }
    fn context_scenario(scenario: &str) -> (IsolatedProfile, CodexLaunchContext, Arc<AtomicBool>) {
        assert!(matches!(scenario, "reply" | "approval"));
        let profile = IsolatedProfile::create().unwrap();
        let isolation = Isolation::create(profile.path(), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("owned")).unwrap();
        std::fs::create_dir(project.join(".milagre")).unwrap();
        let home = profile.path().join("home");
        let account = profile.path().join("selected-account");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&account).unwrap();
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|p| p.join("node"))
            .find(|p| p.is_file())
            .unwrap()
            .canonicalize()
            .unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/src/agents/fixtures/fake-app-server.cjs")
            .canonicalize()
            .unwrap();
        let probe = profile.path().join("probe.cjs");
        let receipt = profile.path().join("launch-received.json");
        let recorder = r#"const fs=require('fs');let buf='';process.stdin.on('data',chunk=>{buf+=chunk;let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);if(!line)continue;const f=JSON.parse(line);if(f.method==='thread/start')fs.writeFileSync(RECEIPT,JSON.stringify({frame:f,home:process.env.HOME,account:process.env.CODEX_HOME,user:process.env.USER,api:process.env.OPENAI_API_KEY??null}));}});"#;
        std::fs::write(
            &probe,
            recorder.replace("RECEIPT", &serde_json::to_string(&receipt).unwrap()),
        )
        .unwrap();
        let program = profile.path().join("codex");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\n[ \"$1\" = app-server ] || exit 92\nexport FAKE_SCENARIO={scenario}\nexec '{}' --require '{}' '{}' \"$@\"\n",
                node.display(),
                probe.display(),
                script.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let live = Arc::new(AtomicBool::new(true));
        let check = live.clone();
        let context = CodexLaunchContext {
            isolation,
            project,
            program,
            home,
            config_directory: account,
            path: "/usr/bin:/bin".into(),
            user_name: "synthetic".into(),
            model: "fixture-model".into(),
            developer_instructions: "Explicit captured developer instructions".into(),
            tldr_enabled: true,
            lifetime: Arc::new(()),
            check: Arc::new(move || {
                if check.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err("revoked".into())
                }
            }),
        };
        (profile, context, live)
    }
    #[test]
    fn configured_modes_ask_auto_card_and_full_allow_match_existing_native_policy() {
        for mode in ["ask", "auto", "full"] {
            let (_profile, context, live) = context_scenario("approval");
            let project = context.project.clone();
            let mut provider = crate::codex_fixture::CodexFixture::configured(context).unwrap();
            let monitor = provider.monitor();
            let request = json!({"provider":"codex","model":"fixture-model","cwd":project,"chatId":"owned#1","prompt":"hello","permissionMode":mode,"tldrEnabled":true});
            provider
                .start_turn(TurnId(1), &RawJson(request.clone()))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut cards = 0;
            loop {
                let events = provider.take_events();
                let mut ended = false;
                for event in events {
                    if let ProviderEvent::Agent {
                        event: RawJson(value),
                        ..
                    } = event
                    {
                        if value["type"] == "permission-request" {
                            cards += 1;
                            assert_ne!(
                                mode, "full",
                                "Full should resolve native card automatically"
                            );
                            provider
                                .respond_permission(
                                    "owned#1",
                                    TurnId(1),
                                    milagre_owner_store::chat_host::AnswerId(1),
                                    "srv-1",
                                    "allow",
                                )
                                .unwrap();
                        }
                        if value["type"] == "turn-completed" {
                            ended = true;
                        }
                        assert_ne!(value["type"], "turn-failed", "{value}");
                    }
                }
                if ended {
                    break;
                }
                assert!(Instant::now() < deadline, "mode {mode} did not finish");
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(cards, usize::from(mode != "full"));
            if mode == "auto" {
                let first_pid = monitor.native_session("owned#1").unwrap().0;
                let mut next = request.clone();
                next["permissionMode"] = json!("full");
                provider.start_turn(TurnId(2), &RawJson(next)).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    let events = provider.take_events();
                    assert!(!events.iter().any(|e| matches!(e, ProviderEvent::Agent { event: RawJson(v), .. } if v["type"] == "permission-request")), "Full second turn must auto-allow");
                    if events.iter().any(|e| matches!(e, ProviderEvent::Agent { turn, event: RawJson(v), .. } if *turn == TurnId(2) && v["type"] == "turn-completed")) { break; }
                    assert!(Instant::now() < deadline, "Full second turn did not finish");
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert_eq!(monitor.native_session("owned#1").unwrap().0, first_pid);
            }
            live.store(false, Ordering::Release);
            assert!(provider.start_turn(TurnId(3), &RawJson(request)).is_err());
            provider.shutdown();
            assert!(monitor.wait_stopped(Duration::from_secs(5)));
            assert!(!monitor.cleanup_failed());
        }
    }
    #[test]
    fn environment_is_exact_selected_account_without_ambient_tokens() {
        let (_profile, context, live) = context();
        let spawn = context.spawn().unwrap();
        assert_eq!(spawn.args, vec![std::ffi::OsString::from("app-server")]);
        let env = spawn.env.unwrap();
        assert_eq!(env.len(), 6);
        assert!(env
            .iter()
            .any(|(k, v)| k == "CODEX_HOME" && v == context.config_directory.as_os_str()));
        assert!(!env.iter().any(|(k, _)| k == "OPENAI_API_KEY"
            || k == "CODEX_API_KEY"
            || k == "CODEX_ACCESS_TOKEN"));
        live.store(false, Ordering::Release);
        assert!(context.spawn().is_err());
    }
    #[test]
    fn captured_selection_and_request_refusals_start_no_worker_or_write_project() {
        let (_profile, context, _live) = context();
        let project = context.project.clone();
        let mut provider = crate::codex_fixture::CodexFixture::configured(context).unwrap();
        let base = json!({"provider":"codex","model":"fixture-model","cwd":project,"chatId":"owned#1","prompt":"hello","permissionMode":"ask","tldrEnabled":true});
        for (field, value) in [
            ("model", json!("foreign")),
            ("tldrEnabled", json!(false)),
            ("tldrEnabled", json!("true")),
            ("permissionMode", json!("unknown")),
            ("permissionMode", json!(true)),
            ("fastMode", json!(true)),
            ("replies", json!("verbose")),
            ("replies", json!("Concise")),
            ("replies", json!("")),
            ("replies", json!(2)),
            ("replies", json!(true)),
            ("replies", json!([])),
            ("replies", json!({})),
        ] {
            let mut request = base.clone();
            request[field] = value;
            assert!(
                provider.start_turn(TurnId(1), &RawJson(request)).is_err(),
                "{field}"
            );
            assert_eq!(provider.monitor().workers(), 0);
            assert_eq!(
                std::fs::read_dir(project.join(".milagre")).unwrap().count(),
                0
            );
        }
    }
    #[test]
    fn configured_bridge_uses_direct_owned_child_and_revocation_refuses_new_turn() {
        let (_profile, context, live) = context();
        let project = context.project.clone();
        let mut provider = crate::codex_fixture::CodexFixture::configured(context).unwrap();
        let monitor = provider.monitor();
        let request = json!({"provider":"codex","model":"fixture-model","cwd":project,"chatId":"owned#1","prompt":"hello","permissionMode":"ask","tldrEnabled":true});
        provider
            .start_turn(TurnId(1), &RawJson(request.clone()))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut events = Vec::new();
        loop {
            events.extend(provider.take_events());
            if events.iter().any(|e|matches!(e,ProviderEvent::Agent{event:RawJson(v),..} if v["type"]=="turn-completed")){break;}
            assert!(Instant::now() < deadline, "{events:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(monitor.native_session("owned#1").unwrap().0.is_some());
        assert_eq!(
            events
                .iter()
                .filter_map(|e| match e {
                    ProviderEvent::Agent {
                        event: RawJson(v), ..
                    } if v["type"] == "text-delta" => v["text"].as_str(),
                    _ => None,
                })
                .collect::<String>(),
            "Hello"
        );
        let captured: serde_json::Value = serde_json::from_slice(
            &std::fs::read(_profile.path().join("launch-received.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            captured["frame"]["params"]["developerInstructions"],
            "Explicit captured developer instructions"
        );
        assert_eq!(captured["frame"]["params"]["cwd"], json!(project));
        assert_eq!(captured["home"], json!(_profile.path().join("home")));
        assert_eq!(
            captured["account"],
            json!(_profile.path().join("selected-account"))
        );
        assert_eq!(captured["user"], "synthetic");
        assert!(captured["api"].is_null());
        live.store(false, Ordering::Release);
        assert!(provider.start_turn(TurnId(2), &RawJson(request)).is_err());
        provider.shutdown();
        assert!(monitor.wait_stopped(Duration::from_secs(3)));
    }
}
