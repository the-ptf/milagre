use serde::Serialize;
use std::{
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, Semaphore},
};

pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_BUFFER: usize = 16 * 1024 * 1024;

/// The fields on Node's GitError, including partial output on timeout/overflow.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
    pub ok: bool,
    pub code: Option<i32>,
    pub missing: bool,
    pub timed_out: bool,
    pub overflow: bool,
    pub stdout: String,
    pub stderr: String,
    pub message: String,
    /// Stable Rust adapter classification; `code` remains the Git process exit code.
    pub kind: &'static str,
}
impl GitError {
    pub(crate) fn validation(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            code: None,
            missing: false,
            timed_out: false,
            overflow: false,
            stdout: String::new(),
            stderr: String::new(),
            message: message.into(),
            kind,
        }
    }
}
impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for GitError {}

pub(crate) type Outcome = GitError;

struct Cleanup {
    pid: Option<u32>,
    kill_group: bool,
    readers: Vec<tokio::task::AbortHandle>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        // A caller cancelling a query must not leave Git or a pipe reader behind.
        #[cfg(unix)]
        if self.kill_group {
            if let Some(pid) = self.pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
        for reader in &self.readers {
            reader.abort();
        }
    }
}

/// Private: renderer input can select a query, never a command or executable.
pub(crate) struct Runner;
impl Runner {
    pub async fn run(&self, cwd: &Path, args: &[&str]) -> Outcome {
        // Node's analysisOnly profile: never execute repository-configured filters,
        // fsmonitor, textconv, diff helpers or hooks while servicing a read.
        let filters = execute(
            "git",
            cwd,
            &[
                "config",
                "--null",
                "--name-only",
                "--get-regexp",
                "^filter\\..*\\.(clean|smudge|process|required)$",
            ],
            &[],
            READ_TIMEOUT,
            MAX_BUFFER,
        )
        .await;
        if !filters.ok && filters.code != Some(1) {
            return filters;
        }
        let mut drivers = Vec::new();
        for name in filters.stdout.split('\0').filter(|s| !s.is_empty()) {
            if let Some((driver, _)) = name.rsplit_once('.') {
                if !drivers.contains(&driver) {
                    drivers.push(driver);
                }
            }
        }
        let config: Vec<_> = drivers
            .iter()
            .flat_map(|driver| {
                [
                    format!("{driver}.clean="),
                    format!("{driver}.smudge="),
                    format!("{driver}.process="),
                    format!("{driver}.required=false"),
                ]
            })
            .collect();
        execute("git", cwd, args, &config, READ_TIMEOUT, MAX_BUFFER).await
    }
    pub async fn checked(&self, cwd: &Path, args: &[&str]) -> Result<String, GitError> {
        let result = self.run(cwd, args).await;
        if result.ok {
            Ok(result.stdout)
        } else {
            Err(result)
        }
    }
    pub async fn out(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        let result = self.run(cwd, args).await;
        result.ok.then(|| crate::trim(&result.stdout).to_owned())
    }
}

async fn drain<R: AsyncRead + Unpin>(
    mut pipe: R,
    saved: Arc<Mutex<Vec<u8>>>,
    limit: usize,
    event: mpsc::UnboundedSender<()>,
) {
    let mut chunk = [0; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut bytes = saved.lock().unwrap();
                let room = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&chunk[..n.min(room)]);
                if n > room {
                    let _ = event.send(());
                    return;
                }
            }
        }
    }
}

async fn execute(
    program: &str,
    cwd: &Path,
    args: &[&str],
    config: &[String],
    timeout: Duration,
    max_buffer: usize,
) -> Outcome {
    execute_profile(program, cwd, args, config, timeout, max_buffer, None, None).await
}

/// Only the new private temporary-repository capability can supply this context.
pub(crate) struct IsolatedEnvironment {
    pub root: std::path::PathBuf,
    pub hooks: std::path::PathBuf,
}
pub(crate) async fn isolated_process(
    cwd: &Path,
    args: &[&str],
    input: Option<Vec<u8>>,
    environment: &IsolatedEnvironment,
    timeout: Duration,
) -> Outcome {
    execute_profile(
        "git",
        cwd,
        args,
        &[],
        timeout,
        MAX_BUFFER,
        input,
        Some(environment),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn execute_profile(
    program: &str,
    cwd: &Path,
    args: &[&str],
    config: &[String],
    timeout: Duration,
    max_buffer: usize,
    input: Option<Vec<u8>>,
    isolated: Option<&IsolatedEnvironment>,
) -> Outcome {
    static LANES: OnceLock<Semaphore> = OnceLock::new();
    let _slot = LANES
        .get_or_init(|| Semaphore::new(8))
        .acquire()
        .await
        .unwrap();
    let mut command = Command::new(program);
    if isolated.is_some() {
        // Fixture hooks must not inherit provider tokens, shell startup files,
        // dynamic-loader overrides or credential agents from the live host.
        command
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .env("LC_ALL", "C");
    }
    let hooks = isolated
        .map(|context| format!("core.hooksPath={}", context.hooks.display()))
        .unwrap_or_else(|| "core.hooksPath=/dev/null".into());
    command.current_dir(cwd).arg("-C").arg(cwd).args([
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        &hooks,
        "-c",
        "submodule.recurse=false",
    ]);
    for value in config {
        command.args(["-c", value]);
    }
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* must not redirect admitted cwd reads.
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    if let Some(context) = isolated {
        command
            .env("HOME", context.root.join("home"))
            .env("TMPDIR", &context.root)
            .env("XDG_CONFIG_HOME", context.root.join("home/.config"))
            .env("XDG_CACHE_HOME", context.root.join("home/.cache"))
            .env("GNUPGHOME", context.root.join("home/gnupg"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("SSH_AUTH_SOCK")
            .env_remove("GPG_TTY");
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let mut result = GitError::validation("GIT_PROCESS", error.to_string());
            result.missing = error.kind() == std::io::ErrorKind::NotFound;
            return result;
        }
    };
    let process_id = child.id();
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let (event, mut events) = mpsc::unbounded_channel();
    let mut out_task = tokio::spawn(drain(
        child.stdout.take().unwrap(),
        stdout.clone(),
        max_buffer,
        event.clone(),
    ));
    let mut err_task = tokio::spawn(drain(
        child.stderr.take().unwrap(),
        stderr.clone(),
        max_buffer,
        event,
    ));
    let mut cleanup = Cleanup {
        pid: process_id,
        kill_group: true,
        readers: vec![out_task.abort_handle(), err_task.abort_handle()],
    };
    let mut input_task = input.map(|bytes| {
        let mut stdin = child.stdin.take().unwrap();
        tokio::spawn(async move {
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
        })
    });
    if let Some(task) = &input_task {
        cleanup.readers.push(task.abort_handle());
    }
    // Includes pipe draining: descendants cannot hold an inherited pipe open forever.
    let mut timed_out = false;
    let mut overflow = false;
    let status = {
        let complete = async {
            let status = child.wait().await;
            let _ = (&mut out_task).await;
            let _ = (&mut err_task).await;
            if let Some(task) = &mut input_task {
                let _ = task.await;
            }
            status
        };
        tokio::pin!(complete);
        tokio::select! {
            result = &mut complete => result.ok(),
            Some(()) = events.recv() => { overflow = true; None },
            _ = tokio::time::sleep(timeout) => { timed_out = true; None },
        }
    };
    // Readers may hit the cap in the same scheduler tick as process completion.
    overflow |= events.try_recv().is_ok();
    if timed_out || overflow {
        #[cfg(unix)]
        if let Some(pid) = process_id {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        out_task.abort();
        err_task.abort();
    }
    cleanup.kill_group = false;
    let stdout = String::from_utf8_lossy(&stdout.lock().unwrap()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr.lock().unwrap()).into_owned();
    let ok = status.is_some_and(|s| s.success()) && !timed_out && !overflow;
    let message = if ok {
        String::new()
    } else if !crate::trim(&stderr).is_empty() {
        crate::trim(&stderr).into()
    } else if overflow {
        "stdout or stderr exceeded maxBuffer".into()
    } else if timed_out {
        if isolated.is_some() {
            "Git operation timed out"
        } else {
            "Git read timed out"
        }
        .into()
    } else {
        format!("Git exited with code {:?}", status.and_then(|s| s.code()))
    };
    Outcome {
        ok,
        code: if timed_out || overflow {
            None
        } else {
            status.and_then(|s| s.code())
        },
        missing: false,
        timed_out,
        overflow,
        stdout,
        stderr,
        message,
        kind: "GIT_PROCESS",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn script(body: &str) -> (tempfile::TempDir, String) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fake-git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (temp, path.to_str().unwrap().into())
    }
    fn assert_node_outcome(actual: &Outcome, failure: serde_json::Value) {
        use std::io::Write;
        let mut node = std::process::Command::new("node")
            .arg(format!(
                "{}/tests/process-outcome.cjs",
                env!("CARGO_MANIFEST_DIR")
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        node.stdin.take().unwrap().write_all(serde_json::to_string(&serde_json::json!({"failure":failure,"stdout":actual.stdout,"stderr":actual.stderr})).unwrap().as_bytes()).unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let actual = serde_json::to_value(actual).unwrap();
        for field in [
            "ok", "code", "missing", "timedOut", "overflow", "stdout", "stderr",
        ] {
            assert_eq!(actual[field], expected[field], "Node outcome {field}");
        }
    }
    #[tokio::test]
    async fn timeout_preserves_partial_output_and_kills_descendants() {
        let (dir, path) =
            script("printf partial; printf warning >&2; sleep 30 &\necho $! > descendant\nwait");
        let result = execute(&path, dir.path(), &[], &[], Duration::from_secs(2), 1024).await;
        assert!(result.timed_out && !result.ok && !result.overflow);
        assert_eq!(result.stdout, "partial");
        assert_eq!(result.stderr, "warning");
        assert_node_outcome(&result, serde_json::json!({"killed":true}));
        let pid: i32 = std::fs::read_to_string(dir.path().join("descendant"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // A killed child can briefly remain a zombie until launchd reaps it.
        let state = std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        assert!(
            state.stdout.is_empty()
                || String::from_utf8_lossy(&state.stdout)
                    .trim()
                    .starts_with('Z')
        );
    }
    #[tokio::test]
    async fn overflow_is_bounded_and_preserves_prefix() {
        let (dir, path) = script("printf prefix; while :; do printf 0123456789; done");
        let result = execute(&path, dir.path(), &[], &[], Duration::from_secs(2), 127).await;
        assert!(result.overflow && !result.timed_out && !result.ok);
        assert_eq!(result.stdout.len(), 127);
        assert!(result.stdout.starts_with("prefix"));
        assert_node_outcome(
            &result,
            serde_json::json!({"code":"ERR_CHILD_PROCESS_STDIO_MAXBUFFER"}),
        );
    }
    #[tokio::test]
    async fn missing_and_exit_code_are_structured() {
        let dir = tempfile::tempdir().unwrap();
        let missing = execute(
            "/nonexistent/milagre-git",
            dir.path(),
            &[],
            &[],
            READ_TIMEOUT,
            MAX_BUFFER,
        )
        .await;
        assert!(missing.missing && missing.code.is_none());
        assert_node_outcome(&missing, serde_json::json!({"code":"ENOENT"}));
        let (dir, path) = script("printf partial; printf failure >&2; exit 128");
        let failed = execute(&path, dir.path(), &[], &[], READ_TIMEOUT, MAX_BUFFER).await;
        assert_eq!(failed.code, Some(128));
        assert_eq!(failed.message, "failure");
        assert_eq!(failed.stdout, "partial");
        assert_node_outcome(&failed, serde_json::json!({"code":128}));
    }
    #[tokio::test]
    async fn cancelled_query_kills_its_process_group() {
        let (dir, path) = script("echo $$ > parent; sleep 30 &\necho $! > descendant\nwait");
        let cwd = dir.path().to_owned();
        let task =
            tokio::spawn(
                async move { execute(&path, &cwd, &[], &[], READ_TIMEOUT, MAX_BUFFER).await },
            );
        tokio::time::timeout(Duration::from_secs(2), async {
            while !dir.path().join("descendant").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let pid = std::fs::read_to_string(dir.path().join("descendant")).unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let state = std::process::Command::new("ps")
            .args(["-p", pid.trim(), "-o", "stat="])
            .output()
            .unwrap();
        assert!(
            state.stdout.is_empty()
                || String::from_utf8_lossy(&state.stdout)
                    .trim()
                    .starts_with('Z')
        );
    }
}
