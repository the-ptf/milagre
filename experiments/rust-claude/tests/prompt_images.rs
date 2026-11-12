use base64::{engine::general_purpose::STANDARD, Engine};
use milagre_claude::{
    prompt_images::{self, PromptImage},
    protocol,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn oracle() -> Value {
    serde_json::from_str(include_str!("fixtures/conformance/claude-prompt-images.json")).unwrap()
}
#[test]
fn image_content_matches_actual_node_session_and_source_hashes() {
    let oracle = oracle();
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (path, hash) in oracle["sources"].as_object().unwrap() {
        assert_eq!(
            format!("{:x}", Sha256::digest(std::fs::read(repo.join(path)).unwrap())),
            hash.as_str().unwrap(),
            "Node source changed: {path}"
        );
    }
    for case in oracle["cases"].as_array().unwrap().iter().chain(oracle["utf16"].as_array().unwrap()) {
        let decoded: Vec<_> = case["images"]
            .as_array()
            .unwrap()
            .iter()
            .map(|image| {
                let (mime, data) = image["dataUrl"].as_str().unwrap().strip_prefix("data:").unwrap().split_once(";base64,").unwrap();
                (mime, STANDARD.decode(data).unwrap())
            })
            .collect();
        let images: Vec<_> = decoded.iter().map(|(mime, bytes)| PromptImage::new(mime, bytes).unwrap()).collect();
        let prompt = case["prompt"].as_str().or_else(|| case["rustPrompt"].as_str()).unwrap();
        if let Some(units) = case["promptUnits"].as_array() {
            let original: Vec<u16> = units.iter().map(|unit| unit.as_u64().unwrap() as u16).collect();
            assert_eq!(String::from_utf16_lossy(&original), prompt, "documented owner free-text boundary");
            let before = case["nativeUnits"].as_array().unwrap();
            let after = case["content"].as_array().unwrap();
            assert_eq!(before.len(), after.len(), "replacement keeps token/code boundaries");
            for (left, right) in before.iter().zip(after) {
                if let Some(units) = left["units"].as_array() {
                    let original: Vec<u16> = units.iter().map(|unit| unit.as_u64().unwrap() as u16).collect();
                    assert_eq!(String::from_utf16_lossy(&original), right["text"].as_str().unwrap());
                } else {
                    assert_eq!(left, right);
                }
            }
        }
        let expected = case["content"].as_array().unwrap();
        let full = protocol::user_message("00000000-0000-4000-8000-000000000000", expected.clone());
        let exact = serde_json::to_vec(&full).unwrap().len();
        let actual = prompt_images::user_content(prompt, &images, exact).unwrap();
        assert_eq!(&actual, expected, "{}", case["name"]);
        assert!(prompt_images::user_content(prompt, &images, exact - 1).is_err(), "{} exact frame boundary", case["name"]);
    }
}
#[test]
fn repeated_images_are_bounded_before_materialization() {
    let mut bytes = vec![0; 128 * 1024];
    bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let image = PromptImage::new("image/png", &bytes).unwrap();
    // About 1.7 GiB if materialized; the incoming prompt is only 100 KiB.
    assert!(prompt_images::user_content(&"[Image #1]".repeat(10_000), &[image], 64 * 1024 * 1024).is_err());
    assert!(PromptImage::new("image/svg+xml", b"<svg/>").is_err());
    assert!(PromptImage::new("image/png", b"/caller/path.png").is_err());
}
