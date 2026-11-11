use milagre_owner_store::{jsjson, Isolation, Policy};
use milagre_registry::{links, scopes, Registry};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, process::Command, sync::Arc};
fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let p = entry.path();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                out.insert(
                    format!("directory:{}", p.strip_prefix(root).unwrap().display()),
                    vec![],
                );
                walk(root, &p, out)
            } else if kind.is_file() {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into(),
                    std::fs::read(p).unwrap(),
                );
            } else {
                out.insert(
                    p.strip_prefix(root).unwrap().to_string_lossy().into(),
                    std::fs::read_link(p)
                        .unwrap()
                        .to_string_lossy()
                        .as_bytes()
                        .to_vec(),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
#[tokio::test]
async fn actual_node_registry_identity_links_and_scope_conformance_without_writes() {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/node.cjs"))
        .arg(temp.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value =
        jsjson::parse_bytes(&std::fs::read(temp.path().join("cases.json")).unwrap()).unwrap();
    let before = snapshot(temp.path());
    let registry = Registry::open(isolation.clone(), "profile", Arc::new(|| Ok(()))).unwrap();
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let a = &case["args"];
        let result: Result<Value, String> = match case["kind"].as_str().unwrap() {
            "identify" => registry
                .identify(a["path"].as_str().unwrap())
                .await
                .map(|identity| json!({"identity":identity.value,"worktrees":identity.worktrees})),
            "snapshot" => Registry::open(
                isolation.clone(),
                a["profile"].as_str().unwrap(),
                Arc::new(|| Ok(())),
            )
            .unwrap()
            .snapshot()
            .map(|s| s.value().clone()),
            "recent" => registry.recent(),
            "members" => links::member_entries(
                &a["group"],
                registry.snapshot().unwrap().value()["projects"]
                    .as_array()
                    .unwrap(),
            )
            .map(|v| json!(v)),
            "reachable" => {
                let snapshot = registry.snapshot().unwrap();
                let source = snapshot
                    .project(a["project"].as_str().unwrap())
                    .await
                    .unwrap();
                snapshot.reachable(&source,Path::new(a["worktree"].as_str().unwrap())).await.map(|grants|json!(grants.iter().map(|grant|json!({"project_id":grant.project().identity()["id"],"worktree_path":grant.worktree(),"link_id":grant.link_ids()[0],"link_ids":grant.link_ids()})).collect::<Vec<_>>()))
            }
            "canLink" => Ok(json!(links::can_link(
                &a["a"],
                &a["b"],
                a["projects"].as_array().unwrap(),
                &a["active"]
            ))),
            "linked" => {
                links::linked_worktrees(&a["source"], a["links"].as_array().unwrap(), &a["active"])
                    .map(|v| json!(v))
            }
            "prune" => Ok(json!(links::prune(
                a["links"].as_array().unwrap(),
                a["projects"].as_array().unwrap(),
                &a["active"]
            ))),
            "validGroup" => Ok(json!(links::valid_group(&a["group"]))),
            "scopeFromKey" => Ok(scopes::scope_from_key(&a["key"])),
            "scopeKey" => scopes::scope_key(&a["scope"]).map(|v| json!(v)),
            "isLink" => Ok(json!(scopes::is_link(&a["key"]))),
            "computer" => Ok(json!(scopes::computer_of_key(&a["key"]))),
            "unqualify" => Ok(scopes::unqualify(&a["key"])),
            "qualify" => scopes::qualify(&a["computer"], &a["key"]),
            "scopeFromChat" => scopes::scope_from_chat(&a["key"]),
            "chatKey" => scopes::chat_key(&a["scope"], &a["id"]).map(|v| json!(v)),
            other => panic!("Unrecognized Node case {other}"),
        };
        match result {
            Ok(value) => assert_eq!(value, case["result"], "case {index}: {case}"),
            Err(error) => assert_eq!(json!(error), case["error"], "case {index}: {case}"),
        }
    }
    assert_eq!(
        before,
        snapshot(temp.path()),
        "Readers changed fixture files"
    );
    let snap = registry.snapshot().unwrap();
    let project = snap.project(temp.path().join("repo/nested")).await.unwrap();
    assert!(project
        .contains_folder(temp.path().join("branch"))
        .await
        .unwrap());
    assert!(!project
        .contains_folder(temp.path().join("repo/nested"))
        .await
        .unwrap());
    assert!(snap.project(temp.path().join("profile")).await.is_err());
    println!(
        "{} actual Node comparisons",
        cases.as_array().unwrap().len()
    );
}
