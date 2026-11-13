use milagre_acp::{
    launch::{self, Platform},
    protocol::{self, Decision, Incoming},
    RequestId,
};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/node-traces.json")).unwrap()
}
#[test]
fn node_frames_and_permission_outcomes() {
    let f = fixture();
    for frame in f["frames"].as_array().unwrap() {
        let actual = if let Some(method) = frame["method"].as_str() {
            if let Some(id) = frame["id"].as_i64() {
                protocol::request_frame(id, method, &frame["params"])
            } else {
                protocol::notification_frame(method, frame.get("params"))
            }
        } else {
            let id = RequestId::from_value(&frame["id"]).unwrap();
            if frame.get("error").is_some() {
                protocol::error_frame(&id, frame["error"]["code"].as_i64().unwrap(), frame["error"]["message"].as_str().unwrap())
            } else {
                protocol::response_frame(&id, &frame["result"])
            }
        };
        assert_eq!(&actual, frame);
    }
    assert_eq!(protocol::initialize("test"), f["frames"][0]["params"]);
    assert_eq!(protocol::authenticate("oauth-personal"), f["frames"][1]["params"]);
    for case in f["permissions"].as_array().unwrap() {
        let decision = match case["decision"].as_str().unwrap() {
            "allow" => Decision::Allow,
            "allow-for-chat" => Decision::AllowForChat,
            "deny" => Decision::Deny,
            _ => Decision::Cancelled,
        };
        assert_eq!(
            protocol::permission_outcome(case["options"].as_array().unwrap(), decision, case["once"].as_bool().unwrap()),
            case["expected"]
        );
    }
}
#[test]
fn node_envelope_precedence_and_defaults() {
    for case in fixture()["envelopes"].as_array().unwrap() {
        let message = &case["message"];
        let events = match protocol::classify(message) {
            Incoming::Request { id, method, params } => vec![json!({"type":"request","id":id.to_value(),"method":method,"params":params})],
            Incoming::Notification { method, params } => vec![json!({"type":"notification","method":method,"params":params})],
            Incoming::Response { id: RequestId::Int(1), outcome: Ok(result) } => vec![json!({"type":"response","result":result})],
            Incoming::Response { id: RequestId::Int(1), outcome: Err(error) } => vec![json!({"type":"error","error":error})],
            Incoming::Invalid { .. } if !message.is_object() && !message.is_array() => {
                vec![json!({"type":"line","stream":"stdout","line":message.to_string()})]
            }
            _ => vec![],
        };
        assert_eq!(json!(events), case["events"], "{message}");
    }
}
#[test]
fn numeric_ids_are_lossless_and_never_alias_strings() {
    for raw in ["0", "-1", "9007199254740993", "18446744073709551616", "123456789012345678901234567890", "1.125", "1.2e100"] {
        let value: Value = serde_json::from_str(raw).unwrap();
        let id = RequestId::from_value(&value).unwrap();
        assert_ne!(id, RequestId::from(raw));
        assert_eq!(id.to_value(), value);
        assert_eq!(protocol::response_frame(&id, &Value::Null)["id"], value);
    }
    for value in [json!(true), json!([]), json!({})] {
        assert!(RequestId::from_value(&value).is_none());
        assert!(matches!(protocol::classify(&json!({"method":"permission","id":value})), Incoming::Invalid { .. }));
    }
}
#[test]
fn pure_vendor_environment_matches_node_without_host_access() {
    for case in fixture()["launches"].as_array().unwrap() {
        let platform = match case["platform"].as_str().unwrap() {
            "darwin" => Platform::Mac,
            "linux" => Platform::Linux,
            _ => Platform::Windows,
        };
        let env = serde_json::from_value(case["env"].clone()).unwrap();
        assert_eq!(
            json!(launch::antigravity_env(&env, case["harness"].as_str().unwrap(), case["tmpdir"].as_str().unwrap(), platform)),
            case["expected"]
        );
    }
    assert_eq!(launch::KIRO_ARGS, ["acp", "--agent-engine", "v3"]);
    assert_eq!(launch::antigravity_args(Platform::Linux), vec!["--uid="]);
    assert!(launch::antigravity_args(Platform::Mac).is_empty());
}

#[test]
fn equivalent_numeric_spellings_share_identity_without_precision_loss() {
    use std::collections::HashSet;
    for group in [
        vec!["1", "1.0", "1e0", "10e-1"],
        vec!["0", "-0.0", "0e100"],
        vec!["9007199254740993", "90071992547409930e-1"],
        vec!["1.25", "125e-2"],
    ] {
        let ids: Vec<_> = group.iter().map(|raw| RequestId::from_value(&serde_json::from_str::<Value>(raw).unwrap()).unwrap()).collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 1, "{group:?}");
        for id in &ids {
            assert_eq!(id, &ids[0]);
            assert_ne!(id, &RequestId::from(group[0]));
        }
    }
    let absurd: Value = serde_json::from_str("1e999999999999999999999999999").unwrap();
    assert!(RequestId::from_value(&absurd).is_none());
}
