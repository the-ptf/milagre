use milagre_acp::events::*;
use serde_json::{json, Value};

#[test]
fn actual_node_mapper_traces_match_events_state_and_clock() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/node-event-traces.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 600);
    for (index, case) in cases.iter().enumerate() {
        let mut state = AcpEventState::from_snapshot(case.get("before").cloned().unwrap_or(json!({}))).unwrap();
        let args = &case["args"];
        let now = case["now"].as_i64().unwrap_or(0);
        let result = match case["fn"].as_str().unwrap() {
            "mapAcpUpdate" => Some(json!(map_acp_update(&args[0], &mut state, now))),
            "closeThinking" => Some(json!(close_thinking(&mut state, now))),
            "readConfigOptions" => {
                read_config_options(&args[0], &mut state);
                None
            }
            "stopReasonEvent" => Some(stop_reason_event(&args[0], args[1].as_str().unwrap())),
            "commandOf" => Some(command_of(&args[0]).into()),
            "cwdOf" => cwd_of(&args[0]).map(Value::from),
            "fileOf" => file_of(&args[0]).map(Value::from),
            "diffsOf" => Some(json!(diffs_of(&args[0]))),
            "createsFile" => Some(creates_file(Some(&args[0])).into()),
            "isQuestionCall" => Some(is_question_call(Some(&args[0])).into()),
            "acpDiff" => Some(acp_diff(&args[0]).into()),
            "acpDiffText" => acp_diff_text(args[0].as_array().unwrap()).map(Value::from),
            "acpStep" => Some(acp_step(&args[0], args.get(1).and_then(Value::as_array).map(Vec::as_slice))),
            "acpStepResult" => Some(acp_step_result(&args[0], args.get(1).and_then(Value::as_array).map(Vec::as_slice))),
            name => panic!("unhandled {name}"),
        };
        let label = format!("case {index} {} {}", case["fn"], case["label"]);
        assert_eq!(result.is_some(), case["defined"].as_bool().unwrap(), "{label} defined");
        assert_eq!(result.unwrap_or(Value::Null), case["result"], "{label} output");
        if let Some(after) = case.get("after") {
            assert_eq!(state.snapshot(), *after, "{label} state");
        }
        if let Some(clock) = case.get("clock") {
            assert!(clock.as_array().unwrap().iter().all(|v| v.as_i64() == Some(now)), "{label} deterministic clock");
        }
    }
}

#[test]
fn recorded_surrogate_boundary_divergence_drops_only_unpaired_fragments() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/node-event-traces.json")).unwrap();
    for case in fixture["deviations"].as_array().unwrap() {
        let result = match case["fn"].as_str().unwrap() {
            "acpStep" => acp_step(&case["call"], None),
            "acpStepResult" => acp_step_result(&case["call"], None),
            _ => unreachable!(),
        };
        let units: Vec<u16> = case["nodeUtf16"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u16).collect();
        assert!(String::from_utf16(&units).is_err(), "Node fixture must cut a surrogate pair");
        let scalars: String = char::decode_utf16(units).filter_map(Result::ok).collect();
        assert_eq!(scalars, case["rustScalarText"].as_str().unwrap());
        assert_eq!(result[case["field"].as_str().unwrap()], case["rustScalarText"]);
    }
}

#[test]
fn malformed_state_containers_are_rejected_before_mapping() {
    for snapshot in [
        json!(null),
        json!([]),
        json!({"calls":{}}),
        json!({"steps":{}}),
        json!({"calls":[["id",{},3]]}),
        json!({"calls":[[3,{}]]}),
        json!({"calls":[["id",{}],["id",{}]]}),
        json!({"steps":["id","id"]}),
        json!({"thinking":true}),
        json!({"thinking":{"id":"t","text":"x"}}),
    ] {
        assert!(AcpEventState::from_snapshot(snapshot.clone()).is_err(), "accepted {snapshot}");
    }
    let mut state = AcpEventState::new(json!("t"));
    assert!(map_acp_update(&json!(null), &mut state, 0).is_empty());
    assert!(close_thinking(&mut state, 0).is_empty());
}

#[test]
fn recorder_executes_current_node_sources_without_drift() {
    let output = std::process::Command::new("node")
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/record-events.cjs"))
        .arg("--check")
        .output()
        .expect("Node is required for the ACP mapper compatibility suite");
    assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}
