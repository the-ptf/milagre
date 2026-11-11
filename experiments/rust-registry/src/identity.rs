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
pub(crate) async fn identify(registry: &Registry, requested: &Path) -> Result<Identity> {
    let opened = directory(registry, requested)?;
    let marker = opened.join(".milagre-folder-chats");
    if std::fs::symlink_metadata(&marker).is_ok_and(|meta| meta.is_file()) {
        let mut worktrees = vec![json!({"path":opened,"name":"main","plain":true})];
        let folders = opened.join(".chat-folders");
        if folders.exists() {
            let canonical = directory(registry, &folders)?;
            if canonical != folders {
                return Err("Chats-home folder aliases are unsupported.".into());
            }
            let mut entries = std::fs::read_dir(folders)
                .map_err(error)?
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
        let marker = current.join(".git");
        if std::fs::symlink_metadata(&marker).is_ok() {
            found = Some(git_directory(registry, &marker)?);
            break;
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
    verify_git(registry, &git_dir)?;
    if let Some(bytes) = read_file(&git_dir.join("commondir"))? {
        let text = std::str::from_utf8(&bytes).map_err(error)?;
        verify_git(registry, &directory(registry, &git_dir.join(text.trim()))?)?;
    }
    let top = directory(
        registry,
        Path::new(
            git(registry, &opened, &["rev-parse", "--show-toplevel"])
                .await?
                .trim(),
        ),
    )?;
    let common = directory(
        registry,
        &top.join(
            git(registry, &top, &["rev-parse", "--git-common-dir"])
                .await?
                .trim(),
        ),
    )?;
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
    let main = all
        .first()
        .and_then(|v| v["path"].as_str())
        .ok_or("The Project's main checkout is missing.")?;
    let main = directory(registry, Path::new(main))
        .map_err(|_| "The Project's main checkout is missing.".to_string())?;
    let mut worktrees = Vec::new();
    for tree in all {
        let path = Path::new(tree["path"].as_str().unwrap());
        if !path.exists() {
            continue;
        }
        directory(registry, path)?;
        worktrees.push(tree);
    }
    registry.check()?;
    Ok(Identity {
        value: json!({"id":common,"path":main,"name":name(&main),"git":true}),
        worktrees,
    })
}
