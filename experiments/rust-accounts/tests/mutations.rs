#![cfg(unix)]
use milagre_accounts::{AccountSandbox, AccountService, Availability, IdentityState};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, os::unix::fs::MetadataExt};
fn project(mut snapshot: Value) -> Value {
    for group in snapshot["providers"].as_array_mut().unwrap() {
        group.as_object_mut().unwrap().shift_remove("installed");
        for account in group["accounts"].as_array_mut().unwrap() {
            if account["missing"] == true {
                continue;
            }
            for key in ["state", "email", "plan", "message"] {
                account.as_object_mut().unwrap().shift_remove(key);
            }
        }
    }
    snapshot
}
fn observation(
    service: &mut AccountService,
    provider: &str,
    id: &str,
    state: IdentityState,
) -> milagre_accounts::Readiness {
    let request = service.begin_observation(provider, id).unwrap();
    service.observed(request, state).unwrap()
}
fn normalize(value: Value, map: &BTreeMap<String, String>) -> Value {
    let mut text = value.to_string();
    for (from, to) in map {
        text = text.replace(from, to);
    }
    serde_json::from_str(&text).unwrap()
}
#[test]
fn actual_node_mutations_match_metadata_results_files_and_changed_events() {
    let traces: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/mutations.json")).unwrap();
    let mut steps = 0;
    for trace in traces {
        let name = trace["name"].as_str().unwrap();
        let sandbox = AccountSandbox::create(trace["seed"].as_str());
        if let Some(error) = trace["error"].as_str() {
            assert_eq!(sandbox.unwrap_err().to_string(), error);
            continue;
        }
        let sandbox = sandbox.unwrap();
        let path = sandbox.path().to_owned();
        let mut service = sandbox.open().unwrap();
        let mut names = BTreeMap::<String, String>::new();
        let mut normalized_ids = BTreeMap::new();
        for step in trace["operations"].as_array().unwrap() {
            let op = &step["call"];
            let method = op["method"].as_str().unwrap();
            let provider = op["provider"].as_str().unwrap_or("");
            let raw = op["id"].as_str();
            let id = raw
                .map(|id| names.get(id).map(String::as_str).unwrap_or(id))
                .map(str::to_owned);
            let mut proof = None;
            if let Some(state) = op["state"].as_str() {
                let state = match state {
                    "ready" => IdentityState::Ready,
                    "signed-out" => IdentityState::SignedOut,
                    _ => IdentityState::Unknown,
                };
                proof = Some(observation(
                    &mut service,
                    provider,
                    id.as_deref().unwrap(),
                    state,
                ));
            }
            let result = match method {
                "create" => service
                    .create(
                        provider,
                        op["label"].as_str().unwrap(),
                        if op["available"] == false {
                            Availability::Missing
                        } else {
                            Availability::Installed
                        },
                    )
                    .map(|pending| {
                        assert_eq!(pending.pending(), ["prepare-private-profile", "login"]);
                        let created = pending.account["id"].as_str().unwrap().to_owned();
                        names.insert(op["as"].as_str().unwrap().into(), created.clone());
                        normalized_ids.insert(created, step["newId"].as_str().unwrap().into());
                        pending.snapshot
                    }),
                "select" => {
                    // Invalid IDs/providers fail before readiness in Node. A real proof from another row is
                    // deliberately supplied so Rust can exercise the same domain validation order.
                    let proof = proof.unwrap_or_else(|| {
                        observation(&mut service, "codex", "default", IdentityState::Unknown)
                    });
                    service.select(provider, id.as_deref().unwrap(), proof)
                }
                "assign" => service.assign(
                    op["scope"].as_str().unwrap(),
                    provider,
                    id.as_deref(),
                    proof,
                ),
                "remove" => service.remove(provider, id.as_deref().unwrap()),
                "scope" => service.scope_snapshot(op["scope"].as_str().unwrap()),
                "snapshot" => Ok(service.snapshot()),
                "reopen" => {
                    service.close();
                    service = sandbox.open().unwrap();
                    Ok(service.snapshot())
                }
                _ => panic!("unreplayed method {method}"),
            };
            let result = match result {
                Ok(value) => json!({"ok":project(value)}),
                Err(error) => json!({"error":error.to_string()}),
            };
            assert_eq!(
                normalize(result, &normalized_ids),
                step["result"],
                "{name}: {op}"
            );
            let file = path.join("accounts/accounts.json");
            let metadata = fs::read_to_string(&file).ok();
            assert_eq!(
                normalize(json!(metadata), &normalized_ids),
                step["metadata"],
                "{name}: metadata after {op}"
            );
            assert_eq!(
                json!(fs::metadata(&file).ok().map(|m| m.mode() & 0o777)),
                step["mode"],
                "{name}: mode after {op}"
            );
            let events: Vec<_> = service
                .take_events()
                .into_iter()
                .map(|event| event.provider)
                .collect();
            assert_eq!(json!(events), step["events"], "{name}: events after {op}");
            steps += 1;
        }
        drop(service);
        drop(sandbox);
        fs::remove_dir_all(path).unwrap();
    }
    assert_eq!(steps, 42);
}
