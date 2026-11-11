use base64::Engine;
use milagre_content_store::{design::raster::RasterRenderer, Runtime};
use milagre_owner_store::{jsjson, Isolation, Policy};
use milagre_tools::{Caller, DesignScope, Dispatcher};
use serde_json::{json, Value};
use std::{path::Path, process::Command, sync::Arc};
struct Clock;
impl Runtime for Clock {
    fn now_ms(&self) -> u64 {
        1000
    }
    fn uuid(&self) -> String {
        milagre_owner_store::ownership::random_uuid()
    }
}
fn caller() -> Caller {
    Caller {
        chat_id: "/fixture#7".into(),
        project_id: "/fixture".into(),
        roots: vec![],
        read: true,
        write: true,
        html: true,
        designs: true,
        kits: true,
        design_scope: DesignScope::All,
        bundled_skills: Path::new("/fixture/skills").into(),
        assert_active: Arc::new(|| Ok(())),
    }
}
fn normalize(value: &Value, inline: Option<&str>) -> Value {
    let mut result = value.clone();
    for item in result["content"].as_array_mut().unwrap() {
        if item["type"] == "image" {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(item["data"].as_str().unwrap())
                .unwrap();
            let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes))
                .read_info()
                .unwrap();
            let mut pixels = vec![0; decoder.output_buffer_size()];
            let info = decoder.next_frame(&mut pixels).unwrap();
            use sha2::Digest;
            item["data"] = json!({"width":info.width,"height":info.height,"rgba":hex::encode(sha2::Sha256::digest(&pixels[..info.buffer_size()]))});
        } else {
            let text = item["text"].as_str().unwrap();
            let text = inline
                .map(|id| text.replace(id, "$INLINE"))
                .unwrap_or_else(|| text.into());
            item["text"] = Value::Array(
                text.lines()
                    .map(|line| jsjson::parse(line).unwrap_or_else(|_| json!(line)))
                    .collect(),
            );
        }
    }
    result
}
#[tokio::test]
async fn native_content_tools_match_real_node_definitions_and_stores() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/conformance.cjs");
    let output = Command::new("node")
        .arg(script)
        .arg(temp.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixtures = jsjson::parse_bytes(&output.stdout).unwrap();
    assert_eq!(
        fixtures["actions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|action| action.get("name").is_some())
            .count(),
        63
    );
    let raster =
        Arc::new(RasterRenderer::new(env!("CARGO_BIN_EXE_milagre-design-raster")).unwrap());
    let mut dispatcher = Dispatcher::open(
        isolation,
        "rust-artifacts".into(),
        "rust-kits".into(),
        caller(),
        Arc::new(Clock),
        Some(raster),
    )
    .unwrap();
    let mut inline = None;
    for (index, action) in fixtures["actions"].as_array().unwrap().iter().enumerate() {
        if let Some(comments) = action.get("seedComments") {
            use sha2::Digest;
            let folder = hex::encode(sha2::Sha256::digest(b"/fixture#7"));
            std::fs::write(
                temp.path()
                    .join("rust-artifacts")
                    .join(&folder[..32])
                    .join("comments"),
                jsjson::to_string(comments),
            )
            .unwrap();
            continue;
        }
        let name = action["name"].as_str().unwrap();
        let args = jsjson::parse(
            &jsjson::to_string(&action["args"])
                .replace("$INLINE", inline.as_deref().unwrap_or("none")),
        )
        .unwrap();
        let actual = dispatcher.call(name, &args).await;
        if name == "artifact_show" && actual["isError"] == false && inline.is_none() {
            inline = Some(
                jsjson::parse(actual["content"][0]["text"].as_str().unwrap()).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        assert_eq!(
            normalize(&actual, inline.as_deref()),
            normalize(&action["result"], None),
            "action {index}: {name} {args}"
        );
    }
}
#[test]
fn advertised_contract_tracks_current_node_sources() {
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/contract.cjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        jsjson::parse_bytes(&output.stdout).unwrap(),
        jsjson::parse(include_str!("../src/contract.json")).unwrap()
    );
}
