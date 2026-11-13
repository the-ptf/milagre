use milagre_accounts::{Accounts, EnvironmentContext, AMBIENT_ENV};
use serde_json::{json, Value};

#[test]
fn actual_node_accounts_match_on_saved_metadata_scopes_and_environment() {
    let fixtures: Value = serde_json::from_str(include_str!("../fixtures/accounts.json")).unwrap();
    assert_eq!(fixtures["ambientEnv"], json!(AMBIENT_ENV));
    let mut calls = 0;
    for case in fixtures["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let result = Accounts::parse(case["body"].as_str());
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.unwrap_err().to_string(), error, "{name}");
            continue;
        }
        let accounts = result.unwrap();
        assert_eq!(accounts.snapshot(), case["initial"], "{name} initial");
        let c = &case["context"];
        let context = EnvironmentContext {
            data_dir: c["dataDir"].as_str().unwrap().into(),
            home: c["home"].as_str().unwrap().into(),
            cwd: c["cwd"].as_str().unwrap().into(),
            env: serde_json::from_value(c["env"].clone()).unwrap(),
        };
        for operation in case["operations"].as_array().unwrap() {
            let mut preparations = Vec::new();
            let args = operation["call"].as_array().unwrap();
            let string = |i: usize| args.get(i).and_then(Value::as_str);
            let result = match string(0).unwrap() {
                "pin" => accounts.pin(string(1)).map(|p| p.value()),
                "selected" => accounts
                    .selected(string(1).unwrap(), string(2))
                    .map(|s| json!(s)),
                "environment" => accounts
                    .environment_for_account(
                        string(1).unwrap(),
                        string(2).unwrap_or(
                            accounts
                                .selected(string(1).unwrap(), None)
                                .unwrap_or("default"),
                        ),
                        &context,
                    )
                    .and_then(|p| p.prepare(|prep| {
                        use milagre_accounts::Preparation;
                        preparations.push(match prep {
                            Preparation::AntigravityDefault { directory, root, home } => json!({"kind":"antigravity","directory":directory,"root":root,"home":home}),
                            Preparation::InheritMcp { provider, source, target, home, config_dir_set } => json!({"kind":"mcp","provider":provider,"sourceDir":source,"targetDir":target,"home":home,"configDirSet":config_dir_set}),
                        });
                        Ok(())
                    }))
                    .map(|env| json!(env)),
                "scope" => accounts.scope_snapshot(string(1).unwrap()),
                other => panic!("unreplayed operation {other}"),
            };
            let actual = match result {
                Ok(value) => json!({"ok":value}),
                Err(e) => json!({"error":e.to_string()}),
            };
            assert_eq!(actual, operation["result"], "{name}: {}", operation["call"]);
            if string(0) == Some("environment")
                && (!operation["preparations"].as_array().unwrap().is_empty()
                    || string(1) != Some("antigravity"))
            {
                // Node memoizes Antigravity default preparation; the Rust owner must do so.
                // Compare every actual first invocation and every MCP invocation verbatim.
                assert_eq!(
                    json!(preparations),
                    operation["preparations"],
                    "{name}: preparation {}",
                    operation["call"]
                );
            }
            calls += 1;
        }
    }
    assert!(calls > 250, "fixture coverage disappeared");
}

#[test]
fn plans_do_not_expose_credentials_until_preparation_succeeds_and_debug_is_redacted() {
    use milagre_accounts::{AccountError, Preparation};
    let id = "11111111-1111-4111-8111-111111111111";
    let accounts = Accounts::parse(Some(
        &json!({"accounts":[{"id":id,"provider":"claude","label":"One"}],"selected":{}})
            .to_string(),
    ))
    .unwrap();
    let context = EnvironmentContext {
        data_dir: "/isolated/profile".into(),
        home: "/isolated/home".into(),
        cwd: "/isolated".into(),
        env: [("ANTHROPIC_API_KEY".into(), "NEVER_PRINT_THIS".into())].into(),
    };
    let plan = accounts
        .environment_for_account("claude", id, &context)
        .unwrap();
    assert!(!format!("{context:?} {plan:?}").contains("NEVER_PRINT_THIS"));
    assert!(
        matches!(&plan.preparation()[0], Preparation::InheritMcp {provider,..} if provider=="claude")
    );
    assert_eq!(
        plan.prepare(|_| Err(AccountError("not implemented")))
            .unwrap_err()
            .0,
        "not implemented"
    );
    let plan = accounts
        .environment_plan("antigravity", &accounts.pin(None).unwrap(), &context)
        .unwrap();
    assert!(matches!(
        &plan.preparation()[0],
        Preparation::AntigravityDefault { .. }
    ));
}

#[test]
fn pinned_accounts_and_removed_overrides_do_not_silently_switch() {
    let id = "11111111-1111-4111-8111-111111111111";
    let original=Accounts::parse(Some(&json!({"accounts":[{"id":id,"provider":"claude","label":"One"}],"selected":{},"scopes":{"/a":{"claude":id}}}).to_string())).unwrap();
    let pinned = original.pin(Some("/a")).unwrap();
    let removed = Accounts::parse(Some(
        &json!({"accounts":[],"selected":{},"scopes":{"/a":{"claude":id}}}).to_string(),
    ))
    .unwrap();
    assert_eq!(pinned.account_id("claude").unwrap(), id);
    assert_eq!(removed.selected("claude", Some("/a")).unwrap(), id);
    assert!(removed
        .account("claude", pinned.account_id("claude").unwrap())
        .is_err());
}

#[test]
fn duplicate_profile_ids_are_refused_across_and_within_providers() {
    let id = "11111111-1111-4111-8111-111111111111";
    for provider in ["claude", "codex"] {
        let body = json!({"accounts":[{"id":id,"provider":"claude","label":"A"},{"id":id,"provider":provider,"label":"B"}],"selected":{}});
        assert_eq!(
            Accounts::parse(Some(&body.to_string())).unwrap_err().0,
            milagre_accounts::READ_ERROR
        );
    }
}

#[test]
fn launch_environment_requires_the_pin_and_rejects_removed_accounts() {
    let id = "11111111-1111-4111-8111-111111111111";
    let body = json!({"accounts":[{"id":id,"provider":"claude","label":"Project account"}],"selected":{},"scopes":{"/a":{"claude":id}}});
    let accounts = Accounts::parse(Some(&body.to_string())).unwrap();
    let pin = accounts.pin(Some("/a")).unwrap();
    let context = EnvironmentContext {
        data_dir: "/private/profile".into(),
        home: "/private/home".into(),
        cwd: "/private".into(),
        env: Default::default(),
    };
    let env = accounts
        .environment_plan("claude", &pin, &context)
        .unwrap()
        .prepare(|_| Ok(()))
        .unwrap();
    assert_eq!(
        env["CLAUDE_CONFIG_DIR"],
        format!("/private/profile/accounts/{id}")
    );
    let removed = Accounts::parse(Some(
        &json!({"accounts":[],"selected":{},"scopes":{"/a":{"claude":id}}}).to_string(),
    ))
    .unwrap();
    assert_eq!(
        removed
            .environment_plan("claude", &pin, &context)
            .unwrap_err()
            .0,
        milagre_accounts::MISSING_ACCOUNT
    );
    let snapshot = removed.scope_snapshot("/a").unwrap();
    let group = snapshot["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["provider"] == "claude")
        .unwrap();
    assert_eq!(group["effectiveId"], id);
    assert_eq!(
        group["accounts"].as_array().unwrap().last().unwrap()["missing"],
        true
    );
}
