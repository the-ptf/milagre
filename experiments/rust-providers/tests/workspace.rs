//! `inside_workspace` on real temporary folders: what Auto may edit without a card.

use milagre_providers::workspace::inside_workspace;
use std::path::{Path, PathBuf};

/// A fresh folder with `repo/` (the root, holding `src/a.txt`) and `outside/` next to it.
struct Tree {
    base: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Tree {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("milagre-ws-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(base.join("repo/src")).unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::fs::write(base.join("repo/src/a.txt"), "a").unwrap();
        std::fs::write(base.join("outside/secret.txt"), "s").unwrap();
        Tree { base }
    }
    fn repo(&self) -> PathBuf {
        self.base.join("repo")
    }
    fn outside(&self) -> PathBuf {
        self.base.join("outside")
    }
    fn inside(&self, files: &[&str]) -> bool {
        let files: Vec<PathBuf> = files.iter().map(PathBuf::from).collect();
        inside_workspace(&[self.repo()], &files, &self.repo())
    }
    fn abs(&self, rel: &str) -> String {
        self.base.join(rel).to_string_lossy().into_owned()
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[cfg(unix)]
fn link(target: &Path, at: &Path) {
    std::os::unix::fs::symlink(target, at).unwrap();
}

#[test]
fn existing_and_new_files_inside_the_root() {
    let t = Tree::new("inside");
    assert!(t.inside(&[&t.abs("repo/src/a.txt")]));
    assert!(t.inside(&[&t.abs("repo/src/new.txt")]), "a new file in an existing folder");
    assert!(t.inside(&[&t.abs("repo/new/deeper/file.txt")]), "a new file in new folders");
    assert!(t.inside(&[&t.abs("repo/src/a.txt"), &t.abs("repo/b.txt")]));
}

#[test]
fn dot_dot_cannot_escape() {
    let t = Tree::new("dotdot");
    assert!(!t.inside(&[&t.abs("repo/../outside/secret.txt")]));
    assert!(!t.inside(&[&t.abs("repo/src/../../outside/new.txt")]));
    assert!(!t.inside(&[&t.abs("repo/src/../b.txt")]), "even safe `..` requires a card");
    // One file outside spoils the set.
    assert!(!t.inside(&[&t.abs("repo/src/a.txt"), &t.abs("repo/../x.txt")]));
}

#[test]
fn the_root_itself_and_no_files_are_not_inside() {
    let t = Tree::new("root");
    assert!(!t.inside(&[&t.abs("repo")]));
    assert!(!t.inside(&[&t.abs("repo/")]));
    assert!(!t.inside(&[&t.abs("repo/src/..")]));
    assert!(!t.inside(&[""]), "an empty path is the cwd, the root itself");
    assert!(!t.inside(&[]));
    assert!(!t.inside(&["/"]));
}

#[test]
fn relative_paths_resolve_against_cwd() {
    let t = Tree::new("relative");
    assert!(t.inside(&["src/a.txt"]));
    assert!(t.inside(&["./src/new.txt"]));
    assert!(!t.inside(&["../outside/secret.txt"]));
    assert!(!t.inside(&["src/../../outside/x"]));
    // cwd elsewhere: relative files land there.
    let files = [PathBuf::from("secret.txt")];
    assert!(!inside_workspace(&[t.repo()], &files, &t.outside()));
}

#[cfg(unix)]
#[test]
fn symlinks_are_followed() {
    let t = Tree::new("links");
    link(&t.outside(), &t.repo().join("out-dir"));
    link(&t.outside().join("secret.txt"), &t.repo().join("out-file"));
    link(&t.repo().join("src"), &t.repo().join("in-dir"));
    link(&t.base.join("nowhere/missing.txt"), &t.repo().join("dangling"));
    assert!(!t.inside(&[&t.abs("repo/out-dir/secret.txt")]), "an existing file through a link to outside");
    assert!(!t.inside(&[&t.abs("repo/out-dir/new.txt")]), "a new file under a link to outside");
    assert!(!t.inside(&[&t.abs("repo/out-dir/new/deeper.txt")]));
    assert!(!t.inside(&[&t.abs("repo/out-file")]), "a file link to outside");
    assert!(t.inside(&[&t.abs("repo/in-dir/a.txt")]), "a link that stays inside");
    assert!(t.inside(&[&t.abs("repo/in-dir/new.txt")]));
    assert!(!t.inside(&[&t.abs("repo/dangling")]), "a dangling link fails closed");
    // A link to the root itself is the root, not inside it.
    link(&t.repo(), &t.repo().join("self"));
    assert!(!t.inside(&[&t.abs("repo/self")]));
    assert!(t.inside(&[&t.abs("repo/self/src/a.txt")]));
}

#[cfg(unix)]
#[test]
fn a_root_reached_through_a_link_is_the_same_root() {
    let t = Tree::new("rootlink");
    link(&t.repo(), &t.base.join("alias"));
    let alias = t.base.join("alias");
    let file = [t.repo().join("src/a.txt")];
    assert!(inside_workspace(std::slice::from_ref(&alias), &file, &alias));
    let via_alias = [alias.join("src/new.txt")];
    assert!(inside_workspace(&[t.repo()], &via_alias, &t.repo()));
}

#[test]
fn tmp_and_private_tmp_are_one_place() {
    // On macOS /tmp is a link to /private/tmp; elsewhere both spellings may not exist.
    let Ok(real) = std::fs::canonicalize("/tmp") else { return };
    if real == Path::new("/tmp") {
        return;
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let name = format!("milagre-ws-tmp-{}-{nanos}", std::process::id());
    let short = Path::new("/tmp").join(&name);
    let long = real.join(&name);
    std::fs::create_dir_all(&short).unwrap();
    assert!(inside_workspace(std::slice::from_ref(&short), &[long.join("x.txt")], &short));
    assert!(inside_workspace(std::slice::from_ref(&long), &[short.join("x.txt")], &long));
    assert!(!inside_workspace(std::slice::from_ref(&short), &[real.join("other").join("x.txt")], &short));
    let _ = std::fs::remove_dir_all(&short);
}

#[test]
fn errors_fail_closed() {
    let t = Tree::new("errors");
    // A root that doesn't exist.
    let missing = [t.base.join("no-such-root")];
    assert!(!inside_workspace(&missing, &[t.base.join("no-such-root/x")], &t.repo()));
    // Under a regular file: not a directory.
    assert!(!t.inside(&[&t.abs("repo/src/a.txt/child")]));
    // Several roots: the file only needs one.
    let roots = [t.repo(), t.outside()];
    assert!(inside_workspace(&roots, &[t.outside().join("secret.txt")], &t.repo()));
    assert!(!inside_workspace(&roots, &[t.base.join("elsewhere.txt")], &t.repo()));
}

#[cfg(unix)]
#[test]
fn unreadable_folders_fail_closed() {
    use std::os::unix::fs::PermissionsExt;
    let t = Tree::new("perm");
    let locked = t.repo().join("locked");
    std::fs::create_dir_all(locked.join("inner")).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = t.inside(&[&t.abs("repo/locked/inner/x.txt")]);
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Root may still traverse it; anyone else gets a permission error, which must not count as inside.
    if !is_root() {
        assert!(!result);
    }
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(unix)]
#[test]
fn symlink_then_parent_never_uses_the_lexically_folded_path() {
    let t = Tree::new("link-parent");
    std::fs::create_dir(t.outside().join("sub")).unwrap();
    link(&t.outside().join("sub"), &t.repo().join("out-dir"));
    link(&t.repo().join("src"), &t.repo().join("in-dir"));
    // Prove the existing path escapes in the kernel, despite folding to repo/secret.txt.
    let existing = t.repo().join("out-dir/../secret.txt");
    assert_eq!(std::fs::canonicalize(&existing).unwrap(), std::fs::canonicalize(t.outside().join("secret.txt")).unwrap());
    for file in ["out-dir/../secret.txt", "out-dir/../new.txt", "in-dir/../b.txt"] {
        assert!(!t.inside(&[file]), "relative {file}");
        assert!(!t.inside(&[&t.abs(&format!("repo/{file}"))]), "absolute {file}");
    }
    // A new file follows the same escape when opened, not just when canonicalized.
    std::fs::write(t.repo().join("out-dir/../new.txt"), "outside").unwrap();
    assert_eq!(std::fs::read_to_string(t.outside().join("new.txt")).unwrap(), "outside");
    assert!(!t.inside(&["out-dir/../new.txt"]));
}

#[test]
fn empty_file_is_rejected_even_when_cwd_is_below_root() {
    let t = Tree::new("empty");
    assert!(!inside_workspace(&[t.repo()], &[""], &t.repo().join("src")));
}
