use milagre_content_store::design::{layout, render_html, render_html_with_options};
use milagre_owner_store::jsjson;
use serde_json::{json, Value};
use std::{path::Path, process::Command};
fn oracle(script: &str) -> Vec<u8> {
    let output = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures")
                .join(script),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
#[test]
fn native_layout_and_html_match_production_saved_previews() {
    let cases = jsjson::parse_bytes(&oracle("render.mjs")).unwrap();
    for case in cases.as_array().unwrap() {
        if let Some(error) = case["error"].as_str() {
            assert_eq!(render_html(&case["document"]).unwrap_err().message, error);
            continue;
        }
        let bounds = layout(&case["document"]).unwrap();
        let bounds = Value::Object(
            bounds
                .iter()
                .map(|(id, b)| (id.clone(), b.value()))
                .collect(),
        );
        assert_eq!(
            jsjson::parse(&jsjson::to_string(&bounds)).unwrap(),
            case["bounds"],
            "Geometry mismatch: {}",
            case["name"]
        );
        let html =
            render_html_with_options(&case["document"], case.get("options").unwrap_or(&json!({})))
                .unwrap();
        let expected = case["html"].as_str().unwrap();
        let expected = String::from_utf16_lossy(&jsjson::to_utf16(expected));
        if html != expected {
            let offset = html
                .bytes()
                .zip(expected.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(html.len().min(expected.len()));
            let start = offset.saturating_sub(120);
            let end = (offset + 200).min(html.len()).min(expected.len());
            panic!(
                "HTML mismatch {} at byte {offset}:\nRust {}\nNode {}",
                case["name"],
                String::from_utf8_lossy(&html.as_bytes()[start..end]),
                String::from_utf8_lossy(&expected.as_bytes()[start..end])
            );
        }
    }
}
#[test]
fn renderer_data_tracks_existing_fonts_icons_and_controller() {
    let expected: Value = serde_json::from_slice(&oracle("render-data.mjs")).unwrap();
    let actual: Value =
        serde_json::from_str(include_str!("../src/design/render-data.json")).unwrap();
    assert_eq!(
        actual, expected,
        "Renderer sources changed: regenerate the data and review layout/HTML compatibility."
    );
}
#[test]
fn interactive_preview_preserves_sandbox_controller_and_escapes_source() {
    let document = json!({"schemaVersion":1,"width":390,"height":844,"nodes":[{"id":"text","type":"text","width":300,"height":40,"text":"</script><script>parent.pwned=true</script>"}]});
    let html =
        render_html_with_options(&document, &json!({"interactive":true,"selectedId":"text"}))
            .unwrap();
    assert!(html.contains("id=\"design-resize\""));
    assert!(html.contains("\\u003c/script\\u003e"));
    assert!(!html.contains("<script>parent.pwned=true</script>"));
    assert!(html.contains("data-design-node=\"text\""));
    let static_html = render_html(&document).unwrap();
    assert!(!static_html.contains("<script"));
}
