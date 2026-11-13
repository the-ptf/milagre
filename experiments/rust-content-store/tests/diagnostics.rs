use milagre_content_store::design::{diagnostics, document_diff, warning_text};
use milagre_owner_store::jsjson;
use serde_json::Value;
use std::{path::Path, process::Command};
fn close(a: &Value, b: &Value, path: &str) {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!((a - b).abs() < 1e-12, "{path}: {a}!={b}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                close(a, b, &format!("{path}.{index}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (key, a) in a {
                close(
                    a,
                    b.get(key).unwrap_or_else(|| panic!("{path}.{key} absent")),
                    &format!("{path}.{key}"),
                );
            }
        }
        _ => assert_eq!(a, b, "{path}"),
    }
}
#[test]
fn diagnostic_measurements_suggestions_and_document_diffs_match_node() {
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/diagnostics.mjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixture = jsjson::parse_bytes(&output.stdout).unwrap();
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let result = diagnostics(&case["document"]).unwrap();
        close(&result, &case["diagnostics"], &format!("case{index}"));
        assert_eq!(
            warning_text(result["warnings"].as_array().unwrap()),
            case["warningText"].as_str().unwrap()
        );
    }
    for case in fixture["diffs"].as_array().unwrap() {
        let result = document_diff(&case["before"], &case["after"]).unwrap();
        assert_eq!(
            jsjson::parse(&jsjson::to_string(&result)).unwrap(),
            case["operations"],
            "{}",
            case["name"]
        );
    }
}
