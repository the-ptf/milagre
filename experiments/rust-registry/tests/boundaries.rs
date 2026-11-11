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

fn git(cwd: &std::path::Path, args: &[&str]) {
    let output = std::process::Command::new("/usr/bin/git")
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@invalid",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn repo(root: &std::path::Path, name: &str) -> std::path::PathBuf {
    let path = root.join(name);
    std::fs::create_dir(&path).unwrap();
    git(&path, &["init", "-b", "main"]);
    git(&path, &["commit", "--allow-empty", "-m", "fixture"]);
    path
}
#[tokio::test]
async fn forged_worktree_back_pointers_bare_discovery_and_config_redirection_are_refused() {
    let (temp, _, registry, _) = fixture();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let a = repo(&root, "a");
    let b = repo(&root, "b");
    let branch = root.join("branch");
    git(
        &a,
        &["worktree", "add", "-b", "branch", branch.to_str().unwrap()],
    );
    assert!(registry.identify(&a).await.is_ok());
    let pointer = a.join(".git/worktrees/branch/gitdir");
    let original = std::fs::read(&pointer).unwrap();
    std::fs::write(&pointer, format!("{}\n", b.join(".git").display())).unwrap();
    assert!(
        registry.identify(&a).await.is_err(),
        "A forged listing must not admit B into A"
    );
    std::fs::write(&pointer, original).unwrap();
    let marker = std::fs::read(branch.join(".git")).unwrap();
    std::fs::remove_file(branch.join(".git")).unwrap();
    assert!(
        registry.identify(&a).await.is_err(),
        "An unrelated replacement folder is not an active Worktree"
    );
    std::fs::write(branch.join(".git"), marker).unwrap();
    let bare = a.join("nested-bare");
    std::fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "--bare"]);
    assert!(
        registry.identify(&bare).await.is_err(),
        "The selected metadata must be the metadata inspected"
    );
    git(&a, &["config", "core.worktree", b.to_str().unwrap()]);
    let error = registry.identify(&a).await.unwrap_err();
    assert!(error.contains("redirection"), "{error}");
}

#[tokio::test]
async fn linked_grant_stays_on_one_target_and_rechecks_the_source_worktree() {
    let (temp, _, registry, _) = fixture();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let a = repo(&root, "a");
    let b = repo(&root, "b");
    let c = root.join("c");
    std::fs::create_dir(&c).unwrap();
    let source = root.join("source");
    let target = root.join("target");
    git(
        &a,
        &["worktree", "add", "-b", "source", source.to_str().unwrap()],
    );
    git(
        &b,
        &["worktree", "add", "-b", "target", target.to_str().unwrap()],
    );
    let aid = registry.identify(&a).await.unwrap().value;
    let bid = registry.identify(&b).await.unwrap().value;
    let cid = registry.identify(&c).await.unwrap().value;
    save(
        &root,
        json!({"projects":[aid,bid,cid],"links":[
            {"id":"first","a":{"project_id":aid["id"],"worktree_path":source},"b":{"project_id":bid["id"],"worktree_path":target}},
            {"id":"second","a":{"project_id":bid["id"]},"b":{"project_id":cid["id"]}}
        ]}),
    );
    let snapshot = registry.snapshot().unwrap();
    let project = snapshot.project(&a).await.unwrap();
    let reached = snapshot.reachable(&project, &source).await.unwrap();
    assert_eq!(reached.len(), 1);
    assert_eq!(reached[0].identity(), &bid);
    assert_eq!(reached[0].worktree(), target);
    assert_eq!(reached[0].link_ids(), ["first"]);
    assert!(reached[0].contains_folder(&target).await.unwrap());
    assert!(!reached[0].contains_folder(&b).await.unwrap());
    assert!(!reached[0].contains_folder(&c).await.unwrap());
    let bytes = std::fs::read(root.join("profile/project-registry.json")).unwrap();
    git(
        &a,
        &["worktree", "remove", "--force", source.to_str().unwrap()],
    );
    std::fs::create_dir(&source).unwrap();
    assert_eq!(
        bytes,
        std::fs::read(root.join("profile/project-registry.json")).unwrap()
    );
    assert!(
        reached[0].check().await.is_err(),
        "Registry bytes alone cannot keep removed source scope alive"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn source_aliases_normalize_but_missing_link_ids_never_mint_a_grant() {
    let (temp, _, registry, _) = fixture();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let a = root.join("a");
    let b = root.join("b");
    let alias = root.join("alias");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    std::os::unix::fs::symlink(&a, &alias).unwrap();
    let aid = registry.identify(&a).await.unwrap().value;
    let bid = registry.identify(&b).await.unwrap().value;
    let mut value = json!({"projects":[aid,bid],"links":[{"id":"edge","a":{"project_id":a,"worktree_path":alias},"b":{"project_id":b}}]});
    save(&root, value.clone());
    let snapshot = registry.snapshot().unwrap();
    let source = snapshot.project(&alias).await.unwrap();
    let grants = snapshot.reachable(&source, &alias).await.unwrap();
    assert_eq!(grants.len(), 1);
    grants[0].check().await.unwrap();
    value["links"][0].as_object_mut().unwrap().remove("id");
    save(&root, value);
    let snapshot = registry.snapshot().unwrap();
    let source = snapshot.project(&a).await.unwrap();
    assert!(snapshot.reachable(&source, &a).await.is_err());
}

#[tokio::test]
async fn definitely_mismatched_link_target_does_not_hide_an_unrelated_valid_edge() {
    let (temp, _, registry, _) = fixture();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let a = root.join("a");
    let b = root.join("b");
    let replaced = root.join("replaced");
    let old_id = root.join("old-project-id");
    for path in [&a, &b, &replaced] {
        std::fs::create_dir(path).unwrap();
    }
    save(
        &root,
        json!({"projects":[{"id":a,"path":a},{"id":b,"path":b},{"id":old_id,"path":replaced}],"links":[
            {"id":"valid","a":{"project_id":a},"b":{"project_id":b}},
            {"id":"changed-target","a":{"project_id":a},"b":{"project_id":old_id}}
        ]}),
    );
    let snapshot = registry.snapshot().unwrap();
    let source = snapshot.project(&a).await.unwrap();
    let linked = snapshot.reachable(&source, &a).await.unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].worktree(), b);
    assert_eq!(linked[0].link_ids(), ["valid"]);
    linked[0].check().await.unwrap();
}
