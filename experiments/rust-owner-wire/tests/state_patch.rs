use milagre_owner_wire::state_patch::{diff, Limits};
use serde_json::{json, Value};
use std::process::Command;

#[test]
fn production_node_reducer_applies_bounded_rust_patches() {
    let mut values = vec![
        Value::Null,
        json!(false),
        json!(0),
        json!(0.0),
        json!(1),
        json!(1.0),
        json!(9007199254740992_u64),
        json!(9007199254740993_u64),
        json!(-3.5),
        json!(""),
        json!("emoji 😀 \u{10fffe}\u{f0000} \\ud800"),
        json!([]),
        json!({}),
        json!([1, null, {"text": "before"}]),
        json!({"sessions": {"12": {"title": "before", "done": false}}, "messages": [1, 2, 3]}),
        json!({"sessions": {"12": {"title": "after", "done": true}, "13": {}}, "messages": [1]}),
        json!({"constructor": "ordinary own property", "0": 1, "2": 2}),
        json!({"4294967295": 1, "01": 2, "4294967294": 3, "-0": 4, "0": 5}),
    ];
    for size in [8, 9, 16, 17, 18, 20] {
        values.push(json!((0..size).collect::<Vec<_>>()));
        values.push(json!((0..size).rev().collect::<Vec<_>>()));
    }
    let mut cases = Vec::new();
    for before in &values {
        for after in &values {
            for depth in [0, 1, 4, 6] {
                let patch = diff(
                    before,
                    after,
                    Limits {
                        depth,
                        ..Limits::default()
                    },
                )
                .unwrap();
                cases.push(json!({"before": before, "after": after, "depth": depth, "changed": patch.is_some(), "patch": patch}));
            }
        }
    }
    let file = tempfile::NamedTempFile::new().unwrap();
    serde_json::to_writer(file.as_file(), &cases).unwrap();
    let output = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/state-patch-node.mjs"
        ))
        .arg(file.path())
        .output()
        .expect("Node is required for production patch compatibility");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(&format!("{} cases passed", cases.len()))
    );
}
