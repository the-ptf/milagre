use crate::*;
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
#[derive(Clone, Debug)]
pub struct Identity {
    pub value: Value,
    pub worktrees: Vec<Value>,
}
fn name(path: &Path) -> &str {
    path.file_name().and_then(|s| s.to_str()).unwrap_or("")
}
fn plain(path: PathBuf, worktrees: Vec<Value>) -> Identity {
    Identity {
        value: json!({"id":path,"path":path,"name":name(&path),"git":false}),
        worktrees,
    }
}
fn directory(registry: &Registry, path: &Path) -> Result<PathBuf> {
    let path = registry.contained(path)?;
    if path.to_str().is_none() {
        return Err("Non-UTF-8 registry paths are unsupported.".into());
    }
    if !path.is_dir() {
        return Err(format!("{} isn't a folder.", name(&path)));
    }
    Ok(path)
}
fn git_directory(registry: &Registry, marker: &Path) -> Result<PathBuf> {
    let meta = std::fs::symlink_metadata(marker).map_err(error)?;
    if meta.file_type().is_symlink() {
        return Err("Git metadata symlinks are unsupported in registry copies.".into());
    }
    if meta.is_dir() {
        return directory(registry, marker);
    }
    let bytes = read_file(marker)?.ok_or("Git marker disappeared")?;
    let text = std::str::from_utf8(&bytes).map_err(error)?;
    let target = text
        .trim()
        .strip_prefix("gitdir: ")
        .ok_or("Invalid Git directory marker")?;
    directory(registry, &marker.parent().unwrap().join(target))
}
fn verify_git(registry: &Registry, git_dir: &Path) -> Result<()> {
    let mut pending = vec![git_dir.to_owned()];
    let mut count = 0;
    while let Some(path) = pending.pop() {
        count += 1;
        if count > 4096 {
            return Err("Git metadata inspection limit exceeded.".into());
        }
        let meta = std::fs::symlink_metadata(&path).map_err(error)?;
        if meta.file_type().is_symlink() {
            return Err("Git metadata symlinks are unsupported in registry copies.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.is_file() && meta.nlink() != 1 {
                return Err("Git metadata hard links are unsupported in registry copies.".into());
            }
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(&path).map_err(error)? {
                if pending.len() + count >= MAX_ENTRIES {
                    return Err("Git metadata inspection limit exceeded.".into());
                }
                pending.push(entry.map_err(error)?.path());
            }
        } else if !meta.is_file() {
            return Err("Unsupported Git metadata file.".into());
        }
        if path
            .file_name()
            .is_some_and(|s| s == "config" || s == "config.worktree")
        {
            let text = String::from_utf8(read_file(&path)?.unwrap_or_default()).map_err(error)?;
            let compact = text
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase();
            if compact.contains("worktree=") {
                return Err(
                    "Git core.worktree redirection is unsupported in registry copies.".into(),
                );
            }
            if compact.contains("[include") {
                return Err("Git config includes are unsupported in registry copies.".into());
            }
        }
    }
    registry.check()
}
async fn git(registry: &Registry, cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", registry.isolation.root())
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CEILING_DIRECTORIES", registry.isolation.root())
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(error)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    async fn read(stream: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        stream
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(error)?;
        if bytes.len() > 1024 * 1024 {
            return Err("Git identity output limit exceeded.".into());
        }
        Ok(bytes)
    }
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        let (stdout, stderr, status) = tokio::try_join!(read(stdout), read(stderr), async {
            child.wait().await.map_err(error)
        })?;
        if !status.success() {
            return Err(format!(
                "Git identity query failed: {}",
                String::from_utf8_lossy(&stderr).trim()
            ));
        }
        String::from_utf8(stdout).map_err(error)
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            Err("Git identity query timed out.".into())
        }
    }
}
async fn verify_checkout(
    registry: &Registry,
    opened: &Path,
    top: &Path,
    git_dir: &Path,
) -> Result<PathBuf> {
    verify_git(registry, git_dir)?;
    let common = if let Some(bytes) = read_file(&git_dir.join("commondir"))? {
        let text = std::str::from_utf8(&bytes).map_err(error)?;
        directory(registry, &git_dir.join(text.trim()))?
    } else {
        git_dir.to_owned()
    };
    if common != git_dir {
        verify_git(registry, &common)?;
        if git_dir.parent() != Some(common.join("worktrees").as_path()) {
            return Err("Git Worktree metadata is not under its common directory.".into());
        }
        let bytes =
            read_file(&git_dir.join("gitdir"))?.ok_or("Git Worktree back pointer is missing.")?;
        let back = std::str::from_utf8(&bytes).map_err(error)?.trim();
        let expected = std::fs::canonicalize(top.join(".git")).map_err(error)?;
        let actual = std::fs::canonicalize(git_dir.join(back)).map_err(error)?;
        if actual != expected {
            return Err("Git Worktree back pointer does not match its checkout.".into());
        }
    }
    let actual_git = directory(
        registry,
        Path::new(
            git(registry, opened, &["rev-parse", "--absolute-git-dir"])
                .await?
                .trim(),
        ),
    )?;
    if actual_git != git_dir {
        return Err("Git selected unverified repository metadata.".into());
    }
    if git(registry, opened, &["rev-parse", "--is-bare-repository"])
        .await?
        .trim()
        != "false"
    {
        return Err("Bare repositories are unsupported in registry copies.".into());
    }
    let actual_top = directory(
        registry,
        Path::new(
            git(registry, opened, &["rev-parse", "--show-toplevel"])
                .await?
                .trim(),
        ),
    )?;
    if actual_top != top
        || !opened.starts_with(top)
        || git_directory(registry, &actual_top.join(".git"))? != git_dir
    {
        return Err("Git checkout redirected outside its verified repository.".into());
    }
    let actual_common = directory(
        registry,
        &opened.join(
            git(registry, opened, &["rev-parse", "--git-common-dir"])
                .await?
                .trim(),
        ),
    )?;
    if actual_common != common {
        return Err("Git selected an unverified common directory.".into());
    }
    registry.check()?;
    Ok(common)
}
pub(crate) async fn identify(registry: &Registry, requested: &Path) -> Result<Identity> {
    let opened = directory(registry, requested)?;
    let marker = opened.join(".milagre-folder-chats");
    let folder_home = match std::fs::symlink_metadata(&marker) {
        Ok(meta) => meta.is_file(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(error(e)),
    };
    if folder_home {
        let mut worktrees = vec![json!({"path":opened,"name":"main","plain":true})];
        let folders = opened.join(".chat-folders");
        if !registry.definitely_gone(&folders)? {
            let canonical = directory(registry, &folders)?;
            if canonical != folders {
                return Err("Chats-home folder aliases are unsupported.".into());
            }
            let mut entries = std::fs::read_dir(folders)
                .map_err(error)?
                .take(MAX_ENTRIES + 1)
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(error)?;
            if entries.len() > MAX_ENTRIES {
                return Err("Chats-home folder limit exceeded.".into());
            }
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().map_err(error)?.is_dir()
                    && name.len() == 41
                    && name.starts_with("chat-")
                    && name[5..]
                        .chars()
                        .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
                {
                    worktrees.push(json!({"path":entry.path(),"name":name,"plain":true}));
                }
            }
        }
        return Ok(plain(opened, worktrees));
    }
    let mut current = opened.as_path();
    let mut found = None;
    while current != registry.isolation.root() {
        // Git can prefer an implicit bare repository before an ancestor .git.
        // Refuse it before launching Git, so its unverified config is not read.
        let mut bare_parts = 0;
        for part in ["HEAD", "objects", "refs"] {
            match std::fs::symlink_metadata(current.join(part)) {
                Ok(_) => bare_parts += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(error(e)),
            }
        }
        if bare_parts == 3 {
            return Err("Implicit bare repositories are unsupported in registry copies.".into());
        }
        let marker = current.join(".git");
        match std::fs::symlink_metadata(&marker) {
            Ok(_) => {
                found = Some(git_directory(registry, &marker)?);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(e)),
        }
        current = current
            .parent()
            .ok_or("Git discovery escaped the isolated root")?;
    }
    let Some(git_dir) = found else {
        return Ok(plain(
            opened.clone(),
            vec![json!({"path":opened,"name":name(&opened),"plain":true})],
        ));
    };
    let expected_top = current.to_owned();
    let common = verify_checkout(registry, &opened, &expected_top, &git_dir).await?;
    let top = expected_top;
    let output = git(registry, &top, &["worktree", "list", "--porcelain", "-z"]).await?;
    let mut all = Vec::new();
    for block in output.split("\0\0").filter(|s| !s.is_empty()) {
        let fields = block.split('\0').collect::<Vec<_>>();
        let Some(path) = fields.iter().find_map(|s| s.strip_prefix("worktree ")) else {
            continue;
        };
        let branch = fields
            .iter()
            .find_map(|s| s.strip_prefix("branch refs/heads/"));
        all.push(json!({"path":path,"name":branch.unwrap_or_else(||name(Path::new(path)))}));
    }
    if all.len() > MAX_ENTRIES {
        return Err("Git Worktree limit exceeded.".into());
    }
    let main_path = all
        .first()
        .and_then(|v| v["path"].as_str())
        .ok_or("The Project's main checkout is missing.")?;
    let main = directory(registry, Path::new(main_path))?;
    let mut worktrees = Vec::new();
    for mut tree in all {
        let path = Path::new(tree["path"].as_str().unwrap());
        if registry.definitely_gone(path)? {
            continue;
        }
        let path = directory(registry, path)?;
        let tree_git = git_directory(registry, &path.join(".git"))?;
        let tree_common = verify_checkout(registry, &path, &path, &tree_git).await?;
        if tree_common != common {
            return Err("Git Worktree belongs to another Project.".into());
        }
        if path == main && tree_git != common {
            return Err("Git main checkout metadata does not match the common directory.".into());
        }
        tree["path"] = json!(path);
        worktrees.push(tree);
    }
    registry.check()?;
    Ok(Identity {
        value: json!({"id":common,"path":main,"name":name(&main),"git":true}),
        worktrees,
    })
}
