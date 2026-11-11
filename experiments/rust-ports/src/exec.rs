//! Running the listings: `run` from ports.cjs. On macOS and Linux it runs `ps` and `lsof` as asked. On Windows the
//! same two requests become PowerShell scripts that print the same text formats (`Get-CimInstance Win32_Process`
//! and `Get-NetTCPConnection -State Listen`); anything else answers "". Every failure answers what was printed,
//! or "", as `execFile`'s callback does. Output stops at 8 MiB and a run at 10 s.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// `exec(command, args)` resolves with the command's stdout ("" when it could not run).
pub type Exec = Arc<dyn Fn(String, Vec<String>) -> BoxFuture<String> + Send + Sync>;

pub const MAX_OUTPUT: usize = 8 * 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(10);

pub const WINDOWS_PS: &str = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {0} @{2} {3}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks,$_.Name }";

/// The PowerShell script that answers `command args` on Windows, or None when it answers "" without running.
pub fn windows_script(command: &str, args: &[String]) -> Option<String> {
    if command == "ps" {
        return Some(WINDOWS_PS.to_owned());
    }
    if command == "lsof" && args.iter().any(|arg| arg == "-iTCP") {
        let index = args.iter().position(|arg| arg == "-p")?;
        let key = args.get(index + 1)?;
        let valid = !key.is_empty() && key.split(',').all(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()));
        if !valid {
            return None;
        }
        return Some(format!(
            "$wanted = @({key}); Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {{ $wanted -contains $_.OwningProcess }} | ForEach-Object {{ 'p' + $_.OwningProcess; 'c' + (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName; 'n' + $_.LocalAddress + ':' + $_.LocalPort }}"
        ));
    }
    None
}

/// private-files.cjs `powershell()`: Windows PowerShell 5.1 under `SystemRoot` (default `C:\Windows`).
pub fn powershell_path(system_root: Option<&str>) -> String {
    let root = system_root.filter(|root| !root.is_empty()).unwrap_or("C:\\Windows").trim_end_matches(['\\', '/']);
    format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

/// The program and arguments `run` starts for a Windows script: `-EncodedCommand` with UTF-16LE base64.
pub fn windows_invocation(script: &str, system_root: Option<&str>) -> (String, Vec<String>) {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    (
        powershell_path(system_root),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"].iter().map(|s| s.to_string()).chain([base64(&utf16)]).collect(),
    )
}

/// private-files.cjs `powershellEnvironment()`: the environment without any PSModulePath (any case), with
/// PSModulePath pointing at Windows PowerShell's own modules.
pub fn powershell_environment(env: impl IntoIterator<Item = (String, String)>, system_root: Option<&str>) -> Vec<(String, String)> {
    let mut safe: Vec<(String, String)> = env.into_iter().filter(|(key, _)| !key.eq_ignore_ascii_case("psmodulepath")).collect();
    let shell = powershell_path(system_root);
    let folder = &shell[..shell.rfind('\\').unwrap_or(0)];
    safe.push(("PSModulePath".into(), format!("{folder}\\Modules")));
    safe
}

pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= chunk.len() { ALPHABET[(n >> shift) as usize & 63] as char } else { '=' });
        }
    }
    out
}

/// Runs a program and resolves with its stdout, whatever its exit status, bounded in size and time.
pub async fn run_program(program: String, args: Vec<String>, env: Option<Vec<(String, String)>>) -> String {
    let mut command = tokio::process::Command::new(&program);
    command
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(env) = env {
        command.env_clear().envs(env);
    }
    let Ok(mut child) = command.spawn() else { return String::new() };
    let Some(stdout) = child.stdout.take() else { return String::new() };
    let mut buffer = Vec::new();
    let read = async {
        let _ = stdout.take(MAX_OUTPUT as u64).read_to_end(&mut buffer).await;
    };
    let _ = tokio::time::timeout(TIMEOUT, read).await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    String::from_utf8_lossy(&buffer).into_owned()
}

/// The `exec` the watcher uses unless told otherwise. `windows` switches to the PowerShell scripts.
pub fn system_exec(windows: bool) -> Exec {
    Arc::new(move |command: String, args: Vec<String>| {
        Box::pin(async move {
            if !windows {
                return run_program(command, args, None).await;
            }
            let Some(script) = windows_script(&command, &args) else { return String::new() };
            let root = std::env::var("SystemRoot").ok();
            let (program, args) = windows_invocation(&script, root.as_deref());
            let env = powershell_environment(std::env::vars(), root.as_deref());
            run_program(program, args, Some(env)).await
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_node_buffers() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn invalid_pid_lists_never_reach_powershell() {
        let args = |key: &str| ["-nP", "-a", "-p", key, "-iTCP", "-sTCP:LISTEN", "-F", "pcn"].map(String::from).to_vec();
        assert!(windows_script("lsof", &args("1,2")).is_some());
        for key in ["", "1,", "1;rm", "$(x)", "1, 2"] {
            assert!(windows_script("lsof", &args(key)).is_none(), "{key}");
        }
        assert!(windows_script("lsof", &["-d".into(), "1".into()]).is_none());
        assert!(windows_script("whoami", &[]).is_none());
    }
}
