#![cfg(unix)]
use milagre_accounts::{AccountSandbox, Availability, PreparationStatus, SyntheticSources};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    path::Path,
};
fn sources(v: &Value) -> SyntheticSources {
    let text = |key: &str| v[key].as_str().map(str::to_owned);
    SyntheticSources {
        codex_config: text("codex_config"),
        codex_instructions: text("codex_instructions"),
        claude_settings: text("claude_settings"),
        claude_instructions: text("claude_instructions"),
        claude_mcp: text("claude_mcp"),
        gemini_config_skills: v["gemini_config_skills"] == true,
        gemini_cli_skills: v["gemini_cli_skills"] == true,
    }
}
fn tree(dir: &Path, base: &Path) -> Value {
    let mut out = serde_json::Map::new();
    if !dir.exists() {
        return Value::Object(out);
    }
    let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let p = entry.path();
        let m = fs::symlink_metadata(&p).unwrap();
        let value = if m.file_type().is_symlink() {
            json!({"link":fs::read_link(&p).unwrap().to_str().unwrap().replace(base.to_str().unwrap(),"@ROOT@")})
        } else if m.is_dir() {
            assert_eq!(m.mode() & 0o777, 0o700);
            json!({"directory":tree(&p,base)})
        } else {
            assert_eq!(m.mode() & 0o777, 0o600);
            json!({"text":fs::read_to_string(&p).unwrap().replace(base.to_str().unwrap(),"@ROOT@")})
        };
        out.insert(entry.file_name().to_str().unwrap().into(), value);
    }
    Value::Object(out)
}
#[test]
fn real_node_preparation_files_and_pending_status() {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/preparation.json")).unwrap();
    for (index, case) in fixture["preparations"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let sandbox = AccountSandbox::create(None).unwrap();
        let path = sandbox.path().to_owned();
        let mut service = sandbox.open().unwrap();
        let mut pending = service
            .create(
                case["provider"].as_str().unwrap(),
                "Synthetic",
                Availability::Installed,
            )
            .unwrap();
        let result = service
            .seed_synthetic_sources(&sources(&case["sources"]))
            .and_then(|()| service.prepare_creation(&mut pending));
        if case.get("error").is_some() {
            assert!(result.is_err(), "case {index}");
            assert_eq!(pending.preparation(), PreparationStatus::Pending);
        } else {
            result.unwrap_or_else(|e| panic!("case {index}: {e}"));
            assert_eq!(pending.pending(), ["login"]);
            assert_eq!(
                tree(
                    &path
                        .join("accounts")
                        .join(pending.account["id"].as_str().unwrap()),
                    &path
                ),
                case["profile"],
                "case {index}"
            );
            assert_eq!(
                tree(&path.join("accounts/antigravity-default"), &path),
                case["default"],
                "case {index}"
            );
            let before = tree(&path.join("accounts"), &path);
            service.prepare_creation(&mut pending).unwrap();
            assert_eq!(tree(&path.join("accounts"), &path), before);
            assert_eq!(
                service.snapshot()["providers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|g| g["provider"] == case["provider"])
                    .unwrap()["accounts"][1]["state"],
                "unknown"
            );
        }
        service.close();
        drop(service);
        drop(sandbox);
        fs::remove_dir_all(path).unwrap();
        if case.get("error").is_none() {
            let sandbox = AccountSandbox::create(None).unwrap();
            let path = sandbox.path().to_owned();
            let mut service = sandbox.open().unwrap();
            service
                .seed_synthetic_sources(&sources(&case["sources"]))
                .unwrap();
            let pending = service
                .create_prepared(
                    case["provider"].as_str().unwrap(),
                    "Synthetic",
                    Availability::Installed,
                )
                .unwrap();
            assert_eq!(pending.pending(), ["login"]);
            assert_eq!(
                service.accounts().saved()["accounts"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                tree(
                    &path
                        .join("accounts")
                        .join(pending.account["id"].as_str().unwrap()),
                    &path
                ),
                case["profile"],
                "combined case {index}"
            );
            assert_eq!(
                tree(&path.join("accounts/antigravity-default"), &path),
                case["default"],
                "combined case {index}"
            );
            service.close();
            drop(service);
            drop(sandbox);
            fs::remove_dir_all(path).unwrap();
        }
    }
}
#[test]
fn mcp_real_node_files_and_noop_inodes() {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/preparation.json")).unwrap();
    for (index, case) in fixture["mcp"].as_array().unwrap().iter().enumerate() {
        let sandbox = AccountSandbox::create(None).unwrap();
        let path = sandbox.path().to_owned();
        let mut service = sandbox.open().unwrap();
        service
            .seed_synthetic_sources(&SyntheticSources::default())
            .unwrap();
        let provider = case["provider"].as_str().unwrap();
        let mut pending = service
            .create(provider, "Synthetic", Availability::Installed)
            .unwrap();
        service.prepare_creation(&mut pending).unwrap();
        let id = pending.account["id"].as_str().unwrap();
        let dir = path.join("accounts").join(id);
        let file = dir.join(if provider == "codex" {
            "config.toml"
        } else {
            ".claude.json"
        });
        let record = dir.join("milagre-inherited-mcp.json");
        // Only these synthetic test fixtures impersonate provider-written files. No auth/login is claimed.
        for (file, text) in [(&file, &case["target"]), (&record, &case["previous"])] {
            if let Some(text) = text.as_str() {
                fs::write(file, text).unwrap();
                fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
            } else if file.exists() {
                fs::remove_file(file).unwrap();
            }
        }
        let inode = |file: &Path| fs::metadata(file).ok().map(|m| m.ino());
        let before = (inode(&file), inode(&record));
        let result = service.inherit_synthetic_mcp(provider, id, case["source"].as_str());
        if case["error"] == true {
            assert!(result.is_err(), "case {index}");
        } else {
            let report = result.unwrap_or_else(|e| panic!("case {index}: {e}"));
            assert_eq!(
                report.config_changed,
                case["targetChanged"] == true,
                "case {index}"
            );
            assert_eq!(
                report.record_changed,
                case["recordChanged"] == true,
                "case {index}"
            );
        }
        assert_eq!(
            fs::read_to_string(&file)
                .ok()
                .map(Value::String)
                .unwrap_or(Value::Null),
            case["next"],
            "case {index}"
        );
        assert_eq!(
            fs::read_to_string(&record)
                .ok()
                .map(Value::String)
                .unwrap_or(Value::Null),
            case["record"],
            "case {index}"
        );
        assert_eq!(
            inode(&file).is_some() && inode(&file) != before.0,
            case["targetChanged"] == true,
            "case {index}"
        );
        assert_eq!(
            inode(&record).is_some() && inode(&record) != before.1,
            case["recordChanged"] == true,
            "case {index}"
        );
        service.close();
        drop(service);
        drop(sandbox);
        fs::remove_dir_all(path).unwrap();
    }
}
#[test]
fn preparation_tickets_close_remove_and_external_aliases() {
    for attack in [
        "external-link",
        "same-target-new-link",
        "source-replacement",
        "source-alias",
        "hardlink",
        "removed-link",
    ] {
        let sandbox = AccountSandbox::create(None).unwrap();
        let path = sandbox.path().to_owned();
        let mut service = sandbox.open().unwrap();
        service
            .seed_synthetic_sources(&SyntheticSources::default())
            .unwrap();
        let mut pending = service
            .create("codex", "Synthetic", Availability::Installed)
            .unwrap();
        service.prepare_creation(&mut pending).unwrap();
        let id = pending.account["id"].as_str().unwrap().to_owned();
        let dir = path.join("accounts").join(&id);
        let link = dir.join("sessions");
        let target = path.join("home/.codex/sessions");
        let sentinel = tempfile::tempdir().unwrap();
        fs::write(sentinel.path().join("sentinel"), "unchanged").unwrap();
        match attack {
            "external-link" => {
                fs::remove_file(&link).unwrap();
                symlink(sentinel.path(), &link).unwrap();
            }
            "same-target-new-link" => {
                fs::rename(&link, dir.join("original-link")).unwrap();
                symlink(&target, &link).unwrap();
            }
            "source-replacement" => {
                fs::rename(&target, path.join("old-source")).unwrap();
                fs::create_dir(&target).unwrap();
            }
            "source-alias" => {
                fs::rename(&target, path.join("old-source")).unwrap();
                symlink(sentinel.path(), &target).unwrap();
            }
            "hardlink" => {
                fs::hard_link(sentinel.path().join("sentinel"), target.join("alias")).unwrap();
            }
            "removed-link" => {
                fs::remove_file(&link).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(service.prepare_creation(&mut pending).is_err(), "{attack}");
        assert!(
            service
                .inherit_synthetic_mcp("codex", &id, Some("x=1"))
                .is_err(),
            "{attack}"
        );
        assert_eq!(
            fs::read_to_string(sentinel.path().join("sentinel")).unwrap(),
            "unchanged"
        );
        service.close();
        assert!(sandbox.open().is_err(), "{attack}");
        drop(service);
        drop(sandbox);
        fs::remove_dir_all(path).unwrap();
    }
}
#[test]
fn prepared_links_survive_reopen_without_retaining_writer_or_readiness() {
    let sandbox = AccountSandbox::create(None).unwrap();
    let path = sandbox.path().to_owned();
    let mut service = sandbox.open().unwrap();
    service
        .seed_synthetic_sources(&SyntheticSources::default())
        .unwrap();
    let mut pending = service
        .create("claude", "Synthetic", Availability::Installed)
        .unwrap();
    service.prepare_creation(&mut pending).unwrap();
    service.close();
    let mut next = sandbox.open().unwrap();
    assert!(next.prepare_creation(&mut pending).is_err());
    assert!(service.prepare_creation(&mut pending).is_err());
    let id = pending.account["id"].as_str().unwrap();
    next.inherit_synthetic_mcp("claude", id, Some("{}"))
        .unwrap();
    next.remove("claude", id).unwrap();
    assert!(next
        .inherit_synthetic_mcp("claude", id, Some("{}"))
        .is_err());
    assert!(path.join("accounts").join(id).exists());
    next.close();
    drop(next);
    drop(service);
    drop(sandbox);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn unprepared_directories_and_modified_tickets_are_refused() {
    let sandbox = AccountSandbox::create(None).unwrap();
    let path = sandbox.path().to_owned();
    let mut service = sandbox.open().unwrap();
    service
        .seed_synthetic_sources(&SyntheticSources::default())
        .unwrap();
    let mut pending = service
        .create("codex", "Synthetic", Availability::Installed)
        .unwrap();
    let original = pending.account.clone();
    pending.account["provider"] = json!("claude");
    assert!(service.prepare_creation(&mut pending).is_err());
    pending.account = original;
    let dir = path
        .join("accounts")
        .join(pending.account["id"].as_str().unwrap());
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(dir.join("sentinel"), "keep").unwrap();
    assert!(service.prepare_creation(&mut pending).is_err());
    assert_eq!(pending.pending(), ["prepare-private-profile", "login"]);
    assert_eq!(fs::read_to_string(dir.join("sentinel")).unwrap(), "keep");
    assert!(service
        .seed_synthetic_sources(&SyntheticSources::default())
        .is_err());
    service.close();
    drop(service);
    drop(sandbox);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn config_is_copied_once_history_shared_and_bad_other_provider_is_independent() {
    let sandbox = AccountSandbox::create(None).unwrap();
    let path = sandbox.path().to_owned();
    let mut service = sandbox.open().unwrap();
    service
        .seed_synthetic_sources(&SyntheticSources {
            codex_config: Some("# first\nroot=1\n[mcp_servers.a]\nx=1\n".into()),
            claude_settings: Some("{bad JSON".into()),
            ..Default::default()
        })
        .unwrap();
    let mut first = service
        .create("codex", "First", Availability::Installed)
        .unwrap();
    service.prepare_creation(&mut first).unwrap();
    let mut failed = service
        .create("claude", "Malformed", Availability::Installed)
        .unwrap();
    assert!(service.prepare_creation(&mut failed).is_err());
    assert_eq!(failed.preparation(), PreparationStatus::Pending);
    assert!(!path
        .join("accounts")
        .join(failed.account["id"].as_str().unwrap())
        .exists());
    let first_id = first.account["id"].as_str().unwrap().to_owned();
    let first_config = path.join("accounts").join(&first_id).join("config.toml");
    let original = fs::read_to_string(&first_config).unwrap();
    let updated = "# second\nroot=2\n[mcp_servers.a]\nx=2\n";
    fs::write(path.join("home/.codex/config.toml"), updated).unwrap();
    let mut second = service
        .create("codex", "Second", Availability::Installed)
        .unwrap();
    service.prepare_creation(&mut second).unwrap();
    let second_id = second.account["id"].as_str().unwrap();
    service.prepare_creation(&mut first).unwrap();
    assert_eq!(fs::read_to_string(&first_config).unwrap(), original);
    for id in [&first_id, second_id] {
        assert_eq!(
            fs::read_link(path.join("accounts").join(id).join("sessions")).unwrap(),
            path.join("home/.codex/sessions")
        );
    }
    service
        .inherit_synthetic_mcp("codex", &first_id, Some(updated))
        .unwrap();
    let after = fs::read_to_string(&first_config).unwrap();
    assert!(after.contains("# first\nroot=1"));
    assert!(after.contains("[mcp_servers.a]\nx=2"));
    assert!(!after.contains("root=2"));
    service.close();
    drop(service);
    drop(sandbox);
    fs::remove_dir_all(path).unwrap();
}
