#![cfg(feature = "launch-planning")]
use milagre_acp::planning::*;
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/node-planning.json")).unwrap()
}
fn base(vendor: &str, platform: &str) -> Value {
    fixture()["launches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["input"]["vendor"] == vendor && c["input"]["platform"] == platform && !c["node"].is_null())
        .unwrap()["input"]
        .clone()
}
fn plan(value: Value) -> Result<LaunchPlan, Refusal> {
    plan_vendor_launch(&serde_json::from_value(value).unwrap())
}
#[test]
fn actual_node_launch_and_model_helpers_match_supported_observations() {
    let fixtures = fixture();
    let cases = fixtures["launches"].as_array().unwrap();
    assert_eq!(cases.len(), 111);
    for (i, case) in cases.iter().enumerate() {
        let result = plan(case["input"].clone());
        if case["node"].is_null() {
            assert!(matches!(result, Err(Refusal::MissingExecutable)), "case {i}");
            continue;
        }
        let p = serde_json::to_value(result.unwrap_or_else(|e| panic!("case {i}: {e}"))).unwrap();
        for key in ["command", "args", "model", "effort", "mode_option", "mode_value"] {
            assert_eq!(p[key], case["node"][key], "case {i} {key}");
        }
        assert_eq!(p["environment"], case["node"]["env"], "case {i}");
        assert_eq!(p["cwd"], case["input"]["resources"]["cwd"]);
        assert_eq!(p["mcp"], case["input"]["mcp"]);
        assert_eq!(p["account"], case["input"]["expected_account"]);
        assert_eq!(p["authorized"], false);
        assert!(serde_json::to_vec(&p).unwrap().len() <= MAX_OUTPUT_BYTES);
    }
}
#[test]
fn actual_node_failure_helpers_match_without_retry_or_message_output() {
    let f = fixture();
    let cases = f["failures"].as_array().unwrap();
    assert_eq!(cases.len(), 360);
    for c in cases {
        let vendor = serde_json::from_value(c["vendor"].clone()).unwrap();
        let input = serde_json::from_value(c["input"].clone()).unwrap();
        assert_eq!(serde_json::to_value(classify_failure(vendor, &input).unwrap()).unwrap(), c["expected"]);
    }
    let huge = FailureObservation { rpc_error: true, code: 0, message: "x".repeat(4097), data_text: None };
    assert_eq!(classify_failure(Vendor::Kiro, &huge), Err(Refusal::InputLimit));
}
#[test]
fn recorder_executes_current_sources_without_host_access_or_drift() {
    let result = std::process::Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/scripts/record-planning.cjs"))
        .arg("--check")
        .output()
        .unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
}
#[test]
fn account_install_and_policy_refusals_are_explicit() {
    let original = base("antigravity", "mac");
    let cases: Vec<(&str, Value, Refusal)> = vec![
        ("/account", Value::Null, Refusal::MissingAccount),
        ("/account/selected/generation", json!(8), Refusal::Generation),
        ("/expected_account/generation", json!(0), Refusal::Generation),
        ("/account/selected/id", json!("other"), Refusal::AccountMismatch),
        ("/account/selected/scope", json!("other"), Refusal::AccountMismatch),
        ("/account/vendor", json!("kiro"), Refusal::AccountMismatch),
        ("/account/ready", json!(false), Refusal::AccountNotReady),
        ("/platform", json!("unsupported"), Refusal::Platform),
        ("/install/harness", Value::Null, Refusal::MissingHarness),
        ("/install/harness/executable", json!(false), Refusal::MissingHarness),
        ("/install/agent/executable", json!(false), Refusal::MissingExecutable),
        ("/install/pair_matches", json!(false), Refusal::InstallPair),
        ("/resources/profile", Value::Null, Refusal::Path),
        ("/resources/scratch", Value::Null, Refusal::Path),
        ("/requires_host_guard", json!(true), Refusal::Policy),
        ("/requires_mcp_guard", json!(true), Refusal::Policy),
        ("/mcp/0/required", json!(true), Refusal::Mcp),
        ("/mcp/1/id", json!("disabled"), Refusal::Mcp),
    ];
    for (pointer, value, expected) in cases {
        let mut input = original.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(matches!(plan(input),Err(e) if e==expected), "{pointer}");
    }
    for policy in ["auto", "full", "babysit", "advisor", "escalation", "analysis-only"] {
        let mut input = original.clone();
        input["policy"] = json!(policy);
        assert!(matches!(plan(input), Err(Refusal::Policy)));
    }
    let mut kiro = base("kiro", "mac");
    kiro["expected_account"]["id"] = json!("named");
    kiro["account"]["selected"]["id"] = json!("named");
    assert!(matches!(plan(kiro), Err(Refusal::KiroAccount)));
    let mut wrong = original;
    wrong["install"] = base("kiro", "mac")["install"].clone();
    assert!(matches!(plan(wrong), Err(Refusal::InstallMismatch)));
}
#[test]
fn environment_is_closed_typed_and_conflicts_never_override_managed_values() {
    let original = base("antigravity", "windows");
    let managed = serde_json::to_value(plan(original.clone()).unwrap()).unwrap()["environment"].clone();
    for key in ["GEMINI_HOME", "TMPDIR", "TMP", "TEMP", "ANTIGRAVITY_HARNESS_PATH", "AGY_ACP_FORCE_FILE_STORAGE", "PYTHONUNBUFFERED"] {
        let mut input = original.clone();
        input["environment"].as_array_mut().unwrap().push(json!({"key":key,"value":"conflicting"}));
        assert!(matches!(plan(input.clone()), Err(Refusal::EnvironmentConflict)), "{key}");
        input["environment"].as_array_mut().unwrap().last_mut().unwrap()["value"] = managed[key].clone();
        assert!(plan(input).is_ok(), "{key}");
    }
    let mut duplicate = original.clone();
    let entry = duplicate["environment"][0].clone();
    duplicate["environment"].as_array_mut().unwrap().push(entry);
    assert!(matches!(plan(duplicate), Err(Refusal::EnvironmentConflict)));
    for key in ["GOOGLE_API_KEY", "BROWSER", "LD_PRELOAD", "NODE_OPTIONS", "arbitrary"] {
        let mut input = original.clone();
        input["environment"] = json!([{"key":key,"value":"synthetic"}]);
        assert!(serde_json::from_value::<LaunchObservation>(input).is_err());
    }
    let mut input = base("kiro", "mac");
    input["ambient"] = json!(["browser"]);
    assert!(matches!(plan(input), Err(Refusal::EnvironmentConflict)));
}
#[test]
fn disabled_mcp_entries_survive_planning_without_endpoints_or_retry() {
    let mut input = base("antigravity", "linux");
    input["mcp"] = json!((0..16).map(|i| json!({"id":format!("server-{i}"),"enabled":i%2==0,"required":false})).collect::<Vec<_>>());
    let p = serde_json::to_value(plan(input.clone()).unwrap()).unwrap();
    assert_eq!(p["mcp"], input["mcp"]);
    assert_eq!(p["mcp"].as_array().unwrap().len(), 16);
    input["mcp"][0]["url"] = json!("not-supported");
    assert!(serde_json::from_value::<LaunchObservation>(input).is_err());
}
#[test]
fn paths_are_observations_not_discovery_and_malformed_paths_refuse() {
    for path in ["", "relative", "/fixture/../escape", "/fixture/./file", "/nul\0file", "/line\nfile"] {
        let mut input = base("antigravity", "mac");
        input["resources"]["cwd"] = json!(path);
        assert!(matches!(plan(input), Err(Refusal::Path)), "{path:?}");
    }
    let mut input = base("antigravity", "windows");
    input["resources"]["cwd"] = json!("C:relative");
    assert!(matches!(plan(input), Err(Refusal::Path)));
    let mut input = base("antigravity", "mac");
    input["resources"]["cwd"] = json!("/synthetic/nonexistent/never-probed");
    assert!(plan(input).is_ok());
}
#[test]
fn byte_and_count_limits_reject_before_unbounded_copying() {
    let original = base("antigravity", "mac");
    for (field, limit) in [("environment", MAX_ENV_ENTRIES), ("mcp", MAX_MCP), ("ambient", 4)] {
        let mut input = original.clone();
        input[field] = json!(vec![input[field][0].clone(); limit + 1]);
        assert!(matches!(plan(input), Err(Refusal::InputLimit)), "{field}");
    }
    let option = json!({"value":"test","name":"Test","efforts":[]});
    let mut input = original.clone();
    input["models"]["offered"] = json!(vec![option.clone(); MAX_MODELS]);
    assert!(plan(input.clone()).is_ok());
    input["models"]["offered"] = json!(vec![option.clone(); MAX_MODELS + 1]);
    assert!(matches!(plan(input), Err(Refusal::InputLimit)));
    let mut input = original.clone();
    input["models"]["offered"] = json!([{ "value":"test","name":"Test","efforts":vec!["low";9]}]);
    assert!(matches!(plan(input), Err(Refusal::InputLimit)));
    for (pointer, cap) in [("/resources/cwd", 4096), ("/expected_account/id", 128), ("/models/model", 128), ("/environment/0/value", 4096)]
    {
        let mut input = original.clone();
        *input.pointer_mut(pointer).unwrap() = json!("x".repeat(cap + 1));
        assert!(matches!(plan(input), Err(Refusal::InputLimit)), "{pointer}");
    }
    let mut input = original;
    input["resources"]["cwd"] = json!(format!("/{}", "x".repeat(4095)));
    assert!(plan(input).is_ok());
}
#[test]
fn debug_and_refusal_messages_never_echo_observation_values() {
    let sentinel = "synthetic-sensitive-sentinel";
    let mut o: LaunchObservation = serde_json::from_value(base("antigravity", "mac")).unwrap();
    o.environment[0].value = sentinel.into();
    o.resources.cwd = format!("/{sentinel}");
    o.models.model = sentinel.into();
    o.expected_account.id = sentinel.into();
    o.expected_account.scope = sentinel.into();
    o.account.as_mut().unwrap().selected = o.expected_account.clone();
    o.resources.profile = Some(format!("/{sentinel}/profile"));
    o.resources.scratch = Some(format!("/{sentinel}/scratch"));
    o.install = InstallObservation::Antigravity {
        agent: Candidate { path: format!("/{sentinel}/agent"), executable: true },
        harness: Some(Candidate { path: format!("/{sentinel}/harness"), executable: true }),
        pair_matches: true,
    };
    o.models.offered = vec![ModelOption { value: sentinel.into(), name: sentinel.into(), efforts: vec![sentinel.into()] }];
    o.models.effort = Some(sentinel.into());
    o.mcp[0].id = sentinel.into();
    let p = plan_vendor_launch(&o).unwrap();
    let debug = format!(
        "{o:?} {p:?} {:?} {:?} {:?} {:?} {:?} {:?} {:?}",
        o.expected_account, o.account, o.install, o.resources, o.environment, o.models, o.mcp
    );
    assert!(!debug.contains(sentinel));
    assert!(!format!("{:?} {:?}", o.models.offered, Candidate { path: sentinel.into(), executable: true }).contains(sentinel));
    let f = FailureObservation { rpc_error: true, code: 0, message: sentinel.into(), data_text: Some(sentinel.into()) };
    assert!(!format!("{f:?}").contains(sentinel));
    o.environment.push(o.environment[0].clone());
    let error = plan_vendor_launch(&o).unwrap_err();
    assert!(!format!("{error:?} {error}").contains(sentinel));
}

#[test]
fn aggregate_input_and_serialized_output_caps_are_independent() {
    let mut too_much = base("antigravity", "windows");
    let long = format!("C:/{}", "x".repeat(MAX_PATH_BYTES - 3));
    for pointer in ["/resources/cwd", "/resources/profile", "/resources/scratch", "/install/agent/path", "/install/harness/path"] {
        *too_much.pointer_mut(pointer).unwrap() = json!(long);
    }
    too_much["environment"] =
        json!((0..MAX_ENV_ENTRIES).map(|_| json!({"key":"PATH","value":"x".repeat(MAX_PATH_BYTES)})).collect::<Vec<_>>());
    // Counts and individual strings fit, but the variable payload exceeds 64 KiB.
    assert!(matches!(plan(too_much.clone()), Err(Refusal::InputLimit)));
    too_much["environment"] = json!(["PATH", "LANG", "TERM"].map(|key| json!({"key":key,"value":"x".repeat(MAX_PATH_BYTES)})));
    // Below the input budget; managed Windows temp values repeat in the serialized review plan.
    assert!(matches!(plan(too_much), Err(Refusal::OutputLimit)));
}
#[test]
fn deliberately_unsupported_model_shapes_and_remaining_field_caps_refuse() {
    let mut input = base("antigravity", "mac");
    input["models"]["offered"] = json!([{"value":"test","name":"Test","efforts":["low"]}]);
    input["models"]["effort"] = json!("low");
    for (pointer, limit) in [
        ("/models/offered/0/name", 256),
        ("/models/offered/0/value", 128),
        ("/models/offered/0/efforts/0", 32),
        ("/models/effort", 32),
        ("/account/selected/scope", 128),
        ("/mcp/0/id", 128),
        ("/install/harness/path", MAX_PATH_BYTES),
    ] {
        let mut value = input.clone();
        *value.pointer_mut(pointer).unwrap() = json!("x".repeat(limit + 1));
        assert!(matches!(plan(value), Err(Refusal::InputLimit)), "{pointer}");
    }
    for name in ["Modèle (High)", "Model (constructor)", "Model\n(High)"] {
        let mut value = input.clone();
        value["models"]["offered"][0]["name"] = json!(name);
        assert!(matches!(plan(value), Err(Refusal::Model)));
    }
    input["models"]["model"] = json!("");
    assert!(matches!(plan(input), Err(Refusal::Model)));
}
