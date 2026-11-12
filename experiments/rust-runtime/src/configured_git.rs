//! Git reads for the dedicated Project, using the existing bounded analysis reader.
//! The actor supplies readiness/ownership checks around every call. No path in a
//! renderer request can extend the one admitted checkout, and parent-repository
//! discovery is deliberately unavailable when this Project has no local `.git`.

use milagre_git_read::{GitError, GitReader};
use milagre_owner_store::{jsjson, ownership::RootPin};
use milagre_owner_wire::{IsolatedProfile, RpcError, RpcResult};
use serde_json::{json, Value};
use std::{fs, io::Read, os::unix::fs::OpenOptionsExt, path::PathBuf, sync::Mutex};

const NOT_REPO: &str = "This chat's folder isn't a git repository.";

pub(crate) struct ConfiguredGit {
    project: PathBuf,
    root: RootPin,
    repository: Mutex<Option<RootPin>>,
    reader: GitReader,
    runtime: tokio::runtime::Runtime,
    _query_home: IsolatedProfile,
}

impl ConfiguredGit {
    pub(crate) fn new(project: PathBuf) -> Result<Self, RpcError> {
        let root = RootPin::take(&project).map_err(|error| scope(error.to_string()))?;
        root.check().map_err(scope)?;
        let query_home = IsolatedProfile::create()?;
        let reader = GitReader::private_read([project.clone()], query_home.path().to_owned())
            .map_err(convert)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        Ok(Self {
            project,
            root,
            repository: Mutex::new(None),
            reader,
            runtime,
            _query_home: query_home,
        })
    }

    /// Cheap observed local-repository state for Project metadata. It never runs
    /// Git or discovers a parent checkout during the actor's publication loop.
    /// Actual Git commands still validate the repository through GitReader.
    pub(crate) fn is_repository(&self) -> Result<bool, RpcError> {
        self.root.check().map_err(scope)?;
        if !self.check_repository()? {
            return Ok(false);
        }
        let directory = self.project.join(".git");
        match fs::symlink_metadata(directory.join("objects")) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            _ => return Ok(false),
        }
        let head = directory.join("HEAD");
        match fs::symlink_metadata(&head) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Ok(metadata) if metadata.is_file() && metadata.len() <= 1024 => {}
            _ => return Err(scope("The Project's Git HEAD is not a local regular file")),
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(head)
            .map_err(|_| scope("The Project's Git HEAD cannot be checked"))?;
        if !file.metadata()?.is_file() {
            return Err(scope("The Project's Git HEAD changed during observation"));
        }
        let mut bytes = Vec::new();
        file.take(1025).read_to_end(&mut bytes)?;
        let text = std::str::from_utf8(&bytes)
            .unwrap_or("")
            .trim_end_matches(['\r', '\n']);
        let valid = (matches!(text.len(), 40 | 64)
            && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
            || text.strip_prefix("ref: refs/").is_some_and(|reference| {
                !reference.is_empty()
                    && !reference
                        .chars()
                        .any(|character| character.is_whitespace() || character == '\0')
            });
        self.root.check().map_err(scope)?;
        self.check_repository()?;
        Ok(bytes.len() <= 1024 && valid)
    }

    /// `check` comes from the serial owning actor, not a client or caller grant.
    /// It must verify the configured root, Project readiness and its owner lock.
    pub(crate) fn invoke(
        &self,
        method: &str,
        args: &[Value],
        mut check: impl FnMut() -> Result<(), RpcError>,
    ) -> RpcResult {
        check()?;
        self.root.check().map_err(scope)?;
        if !milagre_git_read::METHODS.contains(&method) {
            return Err(RpcError::new(
                "UNSUPPORTED_METHOD",
                "Only the installed read-only Git commands are available",
            ));
        }
        if args.len() != 1 || !args[0].is_object() {
            return Err(RpcError::new(
                "INVALID_ARGUMENT",
                "Expected one Git argument object",
            ));
        }
        if args[0].get("cwd").and_then(Value::as_str) != self.project.to_str() {
            return Err(scope("Choose this dedicated Project's exact Git folder"));
        }
        // Match the other runtime Git boundary: never silently normalize an
        // owner-encoded lone surrogate in a path or ref passed to a subprocess.
        let argument = serde_json::from_str(&jsjson::to_string(&args[0])).map_err(|_| {
            RpcError::new(
                "UNSUPPORTED_UTF16_IDENTITY",
                "Git paths and refs must contain valid Unicode",
            )
        })?;
        let has_repository = self.check_repository()?;
        let result = if has_repository {
            self.runtime
                .block_on(self.reader.call(method, argument))
                .map_err(convert)
        } else if method == "git:diff-file" {
            Err(RpcError::new("GIT_NOT_REPOSITORY", NOT_REPO))
        } else {
            // This reports the observed absence of a local repository. Calling
            // Git here could instead discover a checkout above the owned root.
            Ok(json!({"isRepo":false,"message":NOT_REPO}))
        };
        check()?;
        self.root.check().map_err(scope)?;
        let still_repository = self.check_repository()?;
        if still_repository != has_repository {
            return Err(scope("The Project's Git directory changed during the read"));
        }
        result.and_then(|result| {
            jsjson::parse(&result.to_string())
                .map_err(|_| RpcError::new("INVALID_RESPONSE", "Git result could not be encoded"))
        })
    }

    fn check_repository(&self) -> Result<bool, RpcError> {
        let directory = self.project.join(".git");
        let mut pin = self
            .repository
            .lock()
            .map_err(|_| scope("The dedicated Git reader is unavailable"))?;
        if let Some(pin) = pin.as_ref() {
            pin.check().map_err(scope)?;
        } else {
            match fs::symlink_metadata(&directory) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(_) => return Err(scope("The Project's Git directory cannot be checked")),
                Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                    return Err(scope(
                        "External Git Worktree pointers and symbolic Git directories are not admitted",
                    ));
                }
                Ok(_) => {}
            }
            let current = RootPin::take(&directory).map_err(|error| scope(error.to_string()))?;
            current.check().map_err(scope)?;
            *pin = Some(current);
        }
        // A dedicated Project currently has no registry grant for another Git
        // common directory or alternate object store. Reject both pointer forms.
        for relative in ["commondir", "objects/info/alternates"] {
            match fs::symlink_metadata(directory.join(relative)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => {
                    return Err(scope(
                        "External Git common directories and object stores are not admitted",
                    ))
                }
            }
        }
        for relative in ["objects", "objects/info", "refs"] {
            let path = directory.join(relative);
            if fs::symlink_metadata(&path).is_ok() {
                RootPin::take(&path)
                    .map_err(|error| scope(error.to_string()))?
                    .check()
                    .map_err(scope)?;
            }
        }
        Ok(true)
    }
}

fn scope(message: impl Into<String>) -> RpcError {
    RpcError::new("GIT_SCOPE", message)
}

fn convert(error: GitError) -> RpcError {
    RpcError {
        code: error.kind.into(),
        message: error.message.clone(),
        details: Some(serde_json::to_value(error).expect("GitError serializes")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use milagre_owner_wire::IsolatedProfile;
    use std::{cell::Cell, path::Path, process::Command};

    fn project() -> (IsolatedProfile, PathBuf) {
        let profile = IsolatedProfile::create().unwrap();
        let root = profile.path().join("project");
        fs::create_dir(&root).unwrap();
        (profile, root)
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let result = Command::new("/usr/bin/git")
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Synthetic")
            .env("GIT_AUTHOR_EMAIL", "synthetic@example.invalid")
            .env("GIT_COMMITTER_NAME", "Synthetic")
            .env("GIT_COMMITTER_EMAIL", "synthetic@example.invalid")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap().trim().into()
    }

    #[test]
    fn configured_git_reads_real_changes_diff_and_history_without_writes() {
        let (_profile, project) = project();
        git(&project, &["init", "-b", "main"]);
        fs::write(project.join("hello.txt"), "before\n").unwrap();
        git(&project, &["add", "hello.txt"]);
        git(&project, &["commit", "-m", "baseline"]);
        git(&project, &["checkout", "-b", "topic"]);
        fs::write(project.join("hello.txt"), "committed\n").unwrap();
        git(&project, &["add", "hello.txt"]);
        git(&project, &["commit", "-m", "topic change"]);
        let head = git(&project, &["rev-parse", "HEAD"]);
        fs::write(project.join("hello.txt"), "working\n").unwrap();
        fs::write(project.join("added.txt"), "new\n").unwrap();
        let unicode_path = "unicode-body.txt";
        fs::write(project.join(unicode_path), "literal \u{10fffe} Unicode\n").unwrap();
        let service = ConfiguredGit::new(project.clone()).unwrap();
        assert!(service.is_repository().unwrap());
        let calls = Cell::new(0);
        let check = || {
            calls.set(calls.get() + 1);
            Ok(())
        };
        let changes = service
            .invoke(
                "git:changes",
                &[json!({"cwd":project,"base":"main"})],
                check,
            )
            .unwrap();
        assert_eq!(changes["isRepo"], true);
        assert_eq!(changes["hasChanges"], true);
        assert!(changes["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["path"] == "hello.txt"));
        let wire_changes: Value = serde_json::from_str(&jsjson::to_string(&changes)).unwrap();
        assert!(wire_changes["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["path"] == unicode_path));
        let files = service
            .invoke("git:diff-files", &[json!({"cwd":project})], check)
            .unwrap();
        assert!(files["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["path"] == "hello.txt"));
        let diff = service
            .invoke(
                "git:diff-file",
                &[json!({"cwd":project,"path":"hello.txt"})],
                check,
            )
            .unwrap();
        assert!(diff["patch"].as_str().unwrap().contains("+working"));
        let history = service
            .invoke(
                "git:history",
                &[json!({"cwd":project,"base":"main"})],
                check,
            )
            .unwrap();
        assert_eq!(history["head"], head);
        assert_eq!(history["commits"][0]["message"], "topic change");
        let unicode_diff = service
            .invoke(
                "git:diff-file",
                &[json!({"cwd":project,"path":unicode_path,"untracked":true})],
                check,
            )
            .unwrap();
        let wire_diff: Value = serde_json::from_str(&jsjson::to_string(&unicode_diff)).unwrap();
        assert!(wire_diff["patch"]
            .as_str()
            .unwrap()
            .contains("literal \u{10fffe} Unicode"));
        assert_eq!(calls.get(), 10);
        let validation = Cell::new(0);
        let revoked = service
            .invoke(
                "git:history",
                &[json!({"cwd":project,"base":"main"})],
                || {
                    validation.set(validation.get() + 1);
                    if validation.get() == 2 {
                        Err(RpcError::new("PROJECT_NOT_READY", "revoked after query"))
                    } else {
                        Ok(())
                    }
                },
            )
            .unwrap_err();
        assert_eq!(revoked.code, "PROJECT_NOT_READY");
        assert_eq!(validation.get(), 2);
        assert_eq!(git(&project, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            fs::read_to_string(project.join("hello.txt")).unwrap(),
            "working\n"
        );
    }

    #[test]
    fn configured_git_refuses_scope_and_revoked_result_and_never_discovers_parent_repo() {
        let (profile, project) = project();
        git(profile.path(), &["init", "-b", "main"]);
        let service = ConfiguredGit::new(project.clone()).unwrap();
        assert!(!service.is_repository().unwrap());
        for method in ["git:changes", "git:history", "git:diff-files"] {
            assert_eq!(
                service
                    .invoke(method, &[json!({"cwd":project})], || Ok(()))
                    .unwrap()["isRepo"],
                false
            );
        }
        assert_eq!(
            service
                .invoke(
                    "git:diff-file",
                    &[json!({"cwd":project,"path":"x"})],
                    || Ok(())
                )
                .unwrap_err()
                .code,
            "GIT_NOT_REPOSITORY"
        );
        assert_eq!(
            service
                .invoke("git:changes", &[json!({"cwd":profile.path()})], || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        assert_eq!(
            service
                .invoke("git:commit", &[json!({"cwd":project})], || Ok(()))
                .unwrap_err()
                .code,
            "UNSUPPORTED_METHOD"
        );
        let calls = Cell::new(0);
        let error = service
            .invoke("git:changes", &[json!({"cwd":project})], || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    Err(RpcError::new("PROJECT_NOT_READY", "revoked"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(error.code, "PROJECT_NOT_READY");
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn configured_git_metadata_observes_initialization_without_initializing_itself() {
        let (_profile, project) = project();
        let service = ConfiguredGit::new(project.clone()).unwrap();
        assert!(!service.is_repository().unwrap());
        assert!(!project.join(".git").exists());
        fs::create_dir(project.join(".git")).unwrap();
        assert!(!service.is_repository().unwrap());
        git(&project, &["init", "-b", "main"]);
        assert!(service.is_repository().unwrap());
        fs::write(project.join(".git/HEAD"), "invalid HEAD\n").unwrap();
        assert!(!service.is_repository().unwrap());
    }

    #[test]
    fn configured_git_pins_checkout_and_refuses_external_git_pointers() {
        let (_profile, project) = project();
        let service = ConfiguredGit::new(project.clone()).unwrap();
        let args = [json!({"cwd":project})];
        fs::write(project.join(".git"), "gitdir: /not/admitted\n").unwrap();
        assert_eq!(
            service
                .invoke("git:changes", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        fs::remove_file(project.join(".git")).unwrap();
        std::os::unix::fs::symlink(project.parent().unwrap(), project.join(".git")).unwrap();
        assert_eq!(
            service
                .invoke("git:changes", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        fs::remove_file(project.join(".git")).unwrap();
        git(&project, &["init", "-b", "main"]);
        assert!(service.is_repository().unwrap());
        service.invoke("git:changes", &args, || Ok(())).unwrap();
        fs::rename(project.join(".git"), project.join(".git-retained")).unwrap();
        fs::create_dir(project.join(".git")).unwrap();
        assert_eq!(
            service
                .invoke("git:history", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        fs::remove_dir(project.join(".git")).unwrap();
        fs::rename(project.join(".git-retained"), project.join(".git")).unwrap();
        fs::write(project.join(".git/commondir"), "/not/admitted\n").unwrap();
        assert_eq!(
            service
                .invoke("git:changes", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        fs::remove_file(project.join(".git/commondir")).unwrap();
        fs::write(
            project.join(".git/objects/info/alternates"),
            "/not/admitted\n",
        )
        .unwrap();
        assert_eq!(
            service
                .invoke("git:changes", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        fs::remove_file(project.join(".git/objects/info/alternates")).unwrap();
        fs::rename(
            project.join(".git/objects"),
            project.join(".git/objects-retained"),
        )
        .unwrap();
        std::os::unix::fs::symlink(project.parent().unwrap(), project.join(".git/objects"))
            .unwrap();
        assert_eq!(
            service
                .invoke("git:changes", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
        fs::remove_file(project.join(".git/objects")).unwrap();
        fs::rename(
            project.join(".git/objects-retained"),
            project.join(".git/objects"),
        )
        .unwrap();
        let moved = project.with_extension("retained");
        fs::rename(&project, &moved).unwrap();
        fs::create_dir(&project).unwrap();
        assert_eq!(
            service
                .invoke("git:changes", &args, || Ok(()))
                .unwrap_err()
                .code,
            "GIT_SCOPE"
        );
    }
}
