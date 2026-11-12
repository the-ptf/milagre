//! `origin::origin_id` against Node's own `originId` (packages/shared/src/project-origin.mjs) on the remote forms Git
//! reports. Hosts are ASCII here: Node's URL parser also applies IDNA (punycode) and percent-encoding, which the port
//! doesn't (see README).
use milagre_profile_owner::origin::origin_id;
use serde_json::{json, Value};

const URLS: &[&str] = &[
    "git@github.com:Owner/Repo.git",
    "https://github.com/owner/repo",
    "ssh://git@github.com/owner/repo/",
    "HTTPS://User:Token@GitHub.com:443/Owner/Repo.GIT",
    "git://host.xz/path/to/repo.git",
    "ssh://host.xz:2222/a/b",
    "ssh://git@github.com:22/o/r.git",
    "https://github.com/o/r.git?x=1#y",
    "https:///github.com/o/r",
    "https://[::1]:8080/o/r",
    "https://github.com",
    "https://github.com/",
    "https://host:port/o/r",
    "user@host.com:path/repo",
    "github.com:o/r",
    "host.com:/abs/repo",
    "a@b:c",
    "x:y",
    "C:\\code\\repo",
    "/srv/repo.git",
    "../relative/repo",
    "file:///srv/repo.git",
    "  \tgit@github.com:O/R\n",
    "git@github.com:o/r.git/",
    "",
];

#[test]
fn origin_ids_match_node() {
    let script = format!(
        "import {{ originId }} from {};\nconsole.log(JSON.stringify(JSON.parse(process.argv[1]).map((url) => originId(url))));",
        json!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/shared/src/project-origin.mjs"))
    );
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .arg(json!(URLS).to_string())
        .env_remove("ELECTRON_RUN_AS_NODE")
        .output()
        .expect("node runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for (url, expected) in URLS.iter().zip(&node) {
        assert_eq!(json!(origin_id(url)), *expected, "{url:?}");
    }
    println!("originId: {} remote forms equal to Node's", URLS.len());
}
