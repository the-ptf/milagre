use sha2::{Digest, Sha256};
use std::path::Path;
#[test]
fn production_sources_and_embedded_timezone_release_are_pinned() {
    let manifest: serde_json::Value =
        serde_json::from_str(include_str!("../oracle-manifest.json")).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    for (name, expected) in manifest["sources"].as_object().unwrap() {
        let bytes = std::fs::read(root.join(name)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            expected.as_str().unwrap(),
            "production source drift: {name}"
        );
        let mut changed = bytes;
        changed.push(b' ');
        assert_ne!(
            format!("{:x}", Sha256::digest(changed)),
            expected.as_str().unwrap()
        );
    }
    assert_eq!(jiff_tzdb::VERSION, Some(milagre_routines::TZDB_VERSION));
    assert_eq!(milagre_routines::TZDB_VERSION, manifest["tz"]);
}
