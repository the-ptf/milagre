use base64::{engine::general_purpose::STANDARD, Engine};
use milagre_content_store::design::raster::{image_size, RasterRenderer};
use milagre_owner_store::jsjson;
use serde_json::{json, Value};
use std::{path::Path, process::Command, sync::Arc, time::Duration};
fn helper() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_milagre-design-raster"))
}
#[tokio::test]
async fn native_raster_matches_production_wasm_pixels_and_header_rules() {
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/raster.cjs"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixtures: Value = jsjson::parse_bytes(&output.stdout).unwrap();
    let renderer = RasterRenderer::new(helper()).unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let result = if let Some(image) = case.get("image") {
            renderer
                .resize(
                    image["src"].as_str().unwrap(),
                    image["width"].as_u64().unwrap() as u32,
                    image["height"].as_u64().unwrap() as u32,
                )
                .await
                .map(|s| json!({"mime":"image/png","base64":s.split_once(',').unwrap().1}))
        } else {
            renderer.render(&case["document"], case.get("crop")).await
        };
        if let Some(expected) = case.get("error") {
            assert_eq!(
                result.unwrap_err().message,
                expected.as_str().unwrap(),
                "{}",
                case["name"]
            );
            continue;
        }
        let actual = result.unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
        let expected = &case["result"];
        assert_eq!(
            actual.get("width"),
            expected.get("width"),
            "{}",
            case["name"]
        );
        assert_eq!(
            actual.get("height"),
            expected.get("height"),
            "{}",
            case["name"]
        );
        let decode = |v: &Value| {
            resvg::tiny_skia::Pixmap::decode_png(
                &STANDARD.decode(v["base64"].as_str().unwrap()).unwrap(),
            )
            .unwrap()
        };
        let a = decode(&actual);
        let b = decode(expected);
        assert_eq!((a.width(), a.height()), (b.width(), b.height()));
        let differences = a
            .data()
            .iter()
            .zip(b.data())
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(differences, 0, "{} pixel channel differences", case["name"]);
    }
    for header in fixtures["headers"].as_array().unwrap() {
        let bytes = STANDARD.decode(header["bytes"].as_str().unwrap()).unwrap();
        let actual = image_size(&bytes)
            .map(|(w, h)| json!({"width":w,"height":h}))
            .unwrap_or(Value::Null);
        assert_eq!(actual, header["result"]);
    }
}

#[cfg(unix)]
fn fake_script(dir: &Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("helper");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path
}
#[cfg(unix)]
async fn gone(pid: i32) {
    for _ in 0..100 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("test helper {pid} survived cancellation");
}
#[cfg(unix)]
#[tokio::test]
async fn timeout_and_dropped_requests_kill_the_helper_and_allow_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let pidfile = temp.path().join("pid");
    let path = fake_script(
        temp.path(),
        &format!("echo $$ > '{}'\nexec /bin/sleep 30", pidfile.display()),
    );
    let renderer = Arc::new(
        RasterRenderer::new(path)
            .unwrap()
            .with_timeout(Duration::from_secs(2))
            .unwrap(),
    );
    let doc = json!({"schemaVersion":1,"width":240,"height":240,"nodes":[]});
    assert_eq!(
        renderer.render(&doc, None).await.unwrap_err().message,
        "Rendering took too long"
    );
    gone(
        std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap(),
    )
    .await;
    std::fs::remove_file(&pidfile).unwrap();
    let task = tokio::spawn({
        let renderer = renderer.clone();
        let doc = doc.clone();
        async move { renderer.render(&doc, None).await }
    });
    for _ in 0..100 {
        if pidfile.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let pid = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    task.abort();
    let _ = task.await;
    gone(pid).await;
    assert!(RasterRenderer::new(helper())
        .unwrap()
        .render(&doc, None)
        .await
        .is_ok());
}
#[cfg(unix)]
#[tokio::test]
async fn input_output_failures_are_bounded_and_do_not_poison_next_render() {
    let temp = tempfile::tempdir().unwrap();
    let path = fake_script(
        temp.path(),
        "exec /bin/dd if=/dev/zero bs=1048576 count=32 2>/dev/null",
    );
    let renderer = RasterRenderer::new(path).unwrap();
    assert!(renderer.render(&json!({}), None).await.is_err());
    assert_eq!(
        renderer
            .render(&json!({"tooBig":"x".repeat(4*1024*1024)}), None)
            .await
            .unwrap_err()
            .code,
        "RENDER_TOO_LARGE"
    );
    assert!(RasterRenderer::new(Path::new("relative")).is_err());
    assert!(RasterRenderer::new(helper())
        .unwrap()
        .with_timeout(Duration::from_secs(11))
        .is_err());
    let renderer = RasterRenderer::new(helper()).unwrap();
    assert!(renderer.render(&json!({}), None).await.is_err());
    assert!(renderer
        .render(
            &json!({"schemaVersion":1,"width":240,"height":240,"nodes":[]}),
            None
        )
        .await
        .is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn queue_saturation_is_explicit_and_cancelling_waiters_never_spawns_them() {
    let temp = tempfile::tempdir().unwrap();
    let pidfile = temp.path().join("pids");
    let path = fake_script(
        temp.path(),
        &format!("echo $$ >> '{}'\nexec /bin/sleep 30", pidfile.display()),
    );
    let renderer = Arc::new(RasterRenderer::new(path).unwrap());
    let mut tasks = Vec::new();
    for _ in 0..16 {
        tasks.push(tokio::spawn({
            let renderer = renderer.clone();
            async move { renderer.render(&json!({}), None).await }
        }));
    }
    for _ in 0..400 {
        if pidfile.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::task::yield_now().await;
    assert_eq!(
        renderer.render(&json!({}), None).await.unwrap_err().code,
        "RENDER_BUSY"
    );
    // Abort queued requests before the active one releases its lane.
    for task in tasks.iter().skip(1) {
        task.abort();
    }
    for task in tasks.iter().skip(1) {
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
    }
    tasks[0].abort();
    for task in tasks {
        let _ = task.await;
    }
    let pids = std::fs::read_to_string(pidfile).unwrap();
    assert_eq!(pids.lines().count(), 1);
    gone(pids.trim().parse().unwrap()).await;
}
#[tokio::test]
async fn compressed_image_bombs_are_bounded_before_decoding() {
    let mut header = vec![0; 24];
    header[..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
    header[12..16].copy_from_slice(b"IHDR");
    header[16..20].copy_from_slice(&4096u32.to_be_bytes());
    header[20..24].copy_from_slice(&4096u32.to_be_bytes());
    let src = format!("data:image/png;base64,{}", STANDARD.encode(header));
    let nodes=(0..5).map(|i|json!({"id":format!("image-{i}"),"type":"image","width":100,"height":100,"src":src})).collect::<Vec<_>>();
    let error = RasterRenderer::new(helper())
        .unwrap()
        .render(
            &json!({"schemaVersion":1,"width":240,"height":240,"nodes":nodes}),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Design images exceed the decoded pixel budget."
    );
}
