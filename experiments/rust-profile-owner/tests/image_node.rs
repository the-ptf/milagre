//! Local image discovery against Node, with explicit fake Git/account callbacks (no credentials/network).
use milagre_profile_owner::image::Images;
use serde_json::{json, Value};
use std::{fs, process::Command};

#[test]
fn local_images_match_node_without_credentials_or_network() {
    let base = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(base.path()).unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("external.png"), b"outside").unwrap();
    let mut projects = Vec::new();
    for scenario in 0..8 {
        let project = root.join(scenario.to_string());
        fs::create_dir_all(project.join("public")).unwrap();
        match scenario {
            0 => {}
            1 => {
                fs::write(project.join("public/favicon.png"), b"fallback").unwrap();
            }
            2 => {
                fs::write(
                    project.join("package.json"),
                    r#"{"build":{"icon":"extensionless"}}"#,
                )
                .unwrap();
                fs::write(project.join("public/favicon.png"), b"fallback").unwrap();
            }
            3 => {
                fs::write(
                    project.join("package.json"),
                    r#"{"expo":{"icon":"custom.PNG"}}"#,
                )
                .unwrap();
                fs::write(project.join("custom.PNG"), b"custom").unwrap();
                fs::write(project.join("logo.png"), b"logo").unwrap();
            }
            4 => {
                fs::create_dir(project.join(".milagre")).unwrap();
                fs::write(project.join(".milagre/icon.svg"), b"<svg/>").unwrap();
                fs::write(project.join("logo.png"), b"logo").unwrap();
            }
            5 => {
                std::os::unix::fs::symlink(
                    outside.path().join("external.png"),
                    project.join("logo.png"),
                )
                .unwrap();
                fs::write(project.join("public/favicon.ico"), b"ico").unwrap();
            }
            6 => {
                fs::write(project.join("local.png"), b"linked").unwrap();
                std::os::unix::fs::symlink(project.join("local.png"), project.join("logo.png"))
                    .unwrap();
            }
            _ => {
                fs::write(project.join("logo.png"), vec![1; 5 * 1024 * 1024 + 1]).unwrap();
                fs::write(project.join("icon.gif"), b"gif").unwrap();
            }
        }
        projects.push(project);
    }
    let script = r#"
const {resolveProjectImage} = require(process.argv[1]);
(async()=>{
 const values=[];
 for(const project of JSON.parse(process.argv[2])) values.push(await resolveProjectImage(project, {readGit:async()=>{throw new Error('offline fixture')},account:async()=>null}));
 process.stdout.write(JSON.stringify(values));
})().catch(e=>{console.error(e);process.exitCode=1});
"#;
    let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/src/project-image.cjs");
    let output = Command::new("node")
        .args(["-e", script])
        .arg(module)
        .arg(json!(projects).to_string())
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    let images = Images::new(&root).unwrap();
    let actual: Vec<_> = projects.iter().map(|p| images.local(p)).collect();
    assert_eq!(json!(actual), expected);
}
