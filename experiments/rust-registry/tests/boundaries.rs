use milagre_owner_store::{Isolation, Policy};
use milagre_registry::Registry;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
fn fixture() -> (tempfile::TempDir, Isolation, Registry, Arc<AtomicBool>) {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    std::fs::create_dir(temp.path().join("profile")).unwrap();
    let active = Arc::new(AtomicBool::new(true));
    let registry = Registry::open(
        isolation.clone(),
        "profile",
        Arc::new({
            let active = active.clone();
            move || {
                if active.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("Registry lease revoked".into())
                }
            }
        }),
    )
    .unwrap();
    (temp, isolation, registry, active)
}
fn save(root: &std::path::Path, value: serde_json::Value) {
    std::fs::write(
        root.join("profile/project-registry.json"),
        value.to_string(),
    )
    .unwrap();
}
#[tokio::test]
async fn grants_require_registered_identities_exact_roots_and_fresh_snapshots() {
    let (temp, _, registry, active) = fixture();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let a = root.join("a");
    let b = root.join("b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    std::fs::create_dir(a.join("nested")).unwrap();
    let id = "12345678-1234-1234-1234-123456789abc";
    let value = json!({"scanned":true,"projects":[{"id":a,"path":a,"name":"a","git":false},{"id":b,"path":b,"name":"b","git":false}],"projectGroups":[{"id":id,"name":"Together","projectIds":[a,b]}],"links":[{"id":"edge","a":{"project_id":a},"b":{"project_id":b}}]});
    save(&root, value.clone());
    let snapshot = registry.snapshot().unwrap();
    let grant = snapshot.project(&a).await.unwrap();
    assert!(grant.contains_folder(&a).await.unwrap());
    assert!(!grant.contains_folder(a.join("nested")).await.unwrap());
    assert!(snapshot.project(a.join("nested")).await.is_err());
    let link = snapshot.link(id).await.unwrap();
    assert_eq!(link.members().len(), 2);
    let reached = snapshot.reachable(&grant, &a).await.unwrap();
    assert_eq!(reached.len(), 1);
    assert_eq!(reached[0].worktree(), b);
    reached[0].check().await.unwrap();
    active.store(false, Ordering::SeqCst);
    assert!(grant.contains_folder(&a).await.is_err());
    assert!(link.check().await.is_err());
    assert!(reached[0].check().await.is_err());
    active.store(true, Ordering::SeqCst);
    let mut changed = value;
    changed["links"] = json!([]);
    save(&root, changed);
    assert!(snapshot.check().is_err());
    assert!(grant.contains_folder(&a).await.is_err());
    assert!(reached[0].check().await.is_err());
    let fresh = registry.snapshot().unwrap();
    let freshgrant = fresh.project(&a).await.unwrap();
    assert!(fresh.reachable(&freshgrant, &a).await.unwrap().is_empty());
}
#[tokio::test]
async fn wrong_saved_identity_and_unavailable_link_members_never_become_grants() {
    let (temp, _, registry, _) = fixture();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let a = root.join("a");
    std::fs::create_dir(&a).unwrap();
    let id = "12345678-1234-1234-1234-123456789abc";
    save(
        &root,
        json!({"projects":[{"id":root.join("forged"),"path":a}],"projectGroups":[{"id":id,"name":"Unavailable","projectIds":[root.join("forged"),root.join("missing")]}]}),
    );
    let snapshot = registry.snapshot().unwrap();
    assert!(snapshot.project(&a).await.is_err());
    assert!(snapshot.link(id).await.is_err());
    assert!(
        registry.identify(&a).await.is_ok(),
        "Identity discovery alone grants nothing"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn file_and_git_pointer_escapes_are_refused_without_touching_sentinels() {
    use std::os::unix::fs::symlink;
    let (temp, _, registry, _) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let sentinel = outside.path().join("secret");
    std::fs::write(&sentinel, "unchanged").unwrap();
    symlink(&sentinel, temp.path().join("profile/project-registry.json")).unwrap();
    assert!(registry.snapshot().is_err());
    std::fs::remove_file(temp.path().join("profile/project-registry.json")).unwrap();
    std::fs::hard_link(&sentinel, temp.path().join("profile/project-registry.json")).unwrap();
    assert!(registry.snapshot().is_err());
    std::fs::remove_file(temp.path().join("profile/project-registry.json")).unwrap();
    symlink(outside.path(), temp.path().join("alias")).unwrap();
    assert!(registry.identify(temp.path().join("alias")).await.is_err());
    let repo = temp.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    std::fs::write(
        repo.join(".git"),
        format!("gitdir: {}\n", outside.path().display()),
    )
    .unwrap();
    assert!(registry.identify(&repo).await.is_err());
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "unchanged");
}
#[test]
fn file_size_limits_and_profile_aliases_fail_closed() {
    let (temp, isolation, registry, _) = fixture();
    std::fs::write(
        temp.path().join("profile/project-registry.json"),
        vec![b' '; 4 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert!(registry.snapshot().is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            temp.path().join("profile"),
            temp.path().join("alias-profile"),
        )
        .unwrap();
        assert!(Registry::open(isolation, "alias-profile", Arc::new(|| Ok(()))).is_err());
    }
}

#[test]
fn retained_registry_capability_refuses_a_replaced_profile_directory() {
    let (temp, _, registry, _) = fixture();
    let snapshot = registry.snapshot().unwrap();
    std::fs::rename(
        temp.path().join("profile"),
        temp.path().join("previous-profile"),
    )
    .unwrap();
    std::fs::create_dir(temp.path().join("profile")).unwrap();
    assert!(registry.snapshot().is_err());
    assert!(snapshot.check().is_err());
}
