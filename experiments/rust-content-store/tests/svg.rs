use milagre_content_store::design::render_svg;
use milagre_owner_store::jsjson;
use std::{path::Path, process::Command};
#[test]
fn native_svg_matches_production_export_geometry_paint_and_fonts() {
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/svg.mjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases = jsjson::parse_bytes(&output.stdout).unwrap();
    for case in cases.as_array().unwrap() {
        let result = render_svg(&case["document"], &case["options"]);
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.unwrap_err().message, error);
            continue;
        }
        let svg = result.unwrap();
        let expected = case["svg"].as_str().unwrap();
        if svg != expected {
            let at = svg
                .bytes()
                .zip(expected.bytes())
                .position(|(a, b)| a != b)
                .unwrap_or(svg.len().min(expected.len()));
            let start = at.saturating_sub(100);
            let end = (at + 200).min(svg.len()).min(expected.len());
            panic!(
                "SVG mismatch {} at{at}:\nRust {}\nNode {}",
                case["name"],
                String::from_utf8_lossy(&svg.as_bytes()[start..end]),
                String::from_utf8_lossy(&expected.as_bytes()[start..end])
            );
        }
    }
}
