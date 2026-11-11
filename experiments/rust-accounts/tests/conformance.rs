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
            let args = operation["call"].as_array().unwrap();
            let string = |i: usize| args.get(i).and_then(Value::as_str);
            let result = match string(0).unwrap() {
                "pin" => accounts.pin(string(1)).map(|p| p.value()),
                "selected" => accounts
                    .selected(string(1).unwrap(), string(2))
                    .map(|s| json!(s)),
                "environment" => accounts
                    .environment_plan(string(1).unwrap(), string(2), &context)
                    .and_then(|p| p.prepare(|_| Ok(())))
                    .map(|env| json!(env)),
                "scope" => accounts.scope_snapshot(string(1).unwrap()),
                other => panic!("unreplayed operation {other}"),
            };
            let actual = match result {
                Ok(value) => json!({"ok":value}),
                Err(e) => json!({"error":e.to_string()}),
            };
            assert_eq!(actual, operation["result"], "{name}: {}", operation["call"]);
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
        .environment_plan("claude", Some(id), &context)
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
        .environment_plan("antigravity", None, &context)
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
