//! Shell and environment selection, ported from `terminalShell`, `terminalShells` and `terminalEnvironment` in
//! packages/core/src/terminals.cjs. Every input the Node code reads from the system is injectable through
//! [`ShellProbe`], so the same cases run on any host and against the Node fixtures.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::paths::{posix, win32};

pub const TERMINAL_TYPE: &str = "xterm-256color";

/// Insertion order matters: shell discovery lists `<folder>/<name>` in this order.
pub const UNIX_SHELLS: [&str; 11] = ["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish"];

/// Variables that describe the host process, not a shell the user opens.
pub const HOST_ONLY: [&str; 7] =
    ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "MILAGRE_BUNDLED_BIN_DIR", "PWD", "OLDPWD", "SHLVL", "_"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    #[serde(rename = "darwin")]
    Darwin,
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "win32")]
    Windows,
    /// Any other Unix (`process.platform` values such as `freebsd`).
    #[serde(rename = "other")]
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Other
        }
    }
}

/// The program a new Terminal runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCommand {
    pub file: String,
    pub args: Vec<String>,
}

/// One installed shell, as `terminal:profiles` lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellOption {
    pub file: String,
    pub label: String,
}

type Exists = Arc<dyn Fn(&str) -> bool + Send + Sync>;
type UserShell = Arc<dyn Fn() -> Option<String> + Send + Sync>;
type ReadShells = Arc<dyn Fn() -> Option<String> + Send + Sync>;
type Realpath = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// What shell discovery reads from the system. `user_shell` is `os.userInfo().shell` (None for null or a throw);
/// `read_shells` is /etc/shells (None when unreadable); `realpath` is None when it fails.
#[derive(Clone)]
pub struct ShellProbe {
    pub platform: Platform,
    pub env: HashMap<String, String>,
    pub exists: Exists,
    pub user_shell: UserShell,
    pub read_shells: ReadShells,
    pub realpath: Realpath,
}

impl ShellProbe {
    /// The real system: this process's environment, the account database, /etc/shells and the file system.
    pub fn system() -> Self {
        ShellProbe {
            platform: Platform::current(),
            env: std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))).collect(),
            exists: Arc::new(executable_file),
            user_shell: Arc::new(account_shell),
            read_shells: Arc::new(|| std::fs::read_to_string("/etc/shells").ok()),
            realpath: Arc::new(|file| std::fs::canonicalize(file).ok().and_then(|p| p.into_os_string().into_string().ok())),
        }
    }

    fn var(&self, key: &str) -> Option<&str> {
        // JavaScript `env.X || ...`: an empty value counts as missing.
        self.env.get(key).map(String::as_str).filter(|value| !value.is_empty())
    }
}

/// `fs.accessSync(file, X_OK)` and a regular file after following links.
pub fn executable_file(file: &str) -> bool {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let Ok(c) = CString::new(file) else { return false };
        if unsafe { libc::access(c.as_ptr(), libc::X_OK) } != 0 {
            return false;
        }
    }
    std::fs::metadata(file).map(|meta| meta.is_file()).unwrap_or(false)
}

/// The account's login shell from the user database (`os.userInfo().shell`).
pub fn account_shell() -> Option<String> {
    #[cfg(unix)]
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        let status = libc::getpwuid_r(libc::getuid(), &mut pwd, buffer.as_mut_ptr(), buffer.len(), &mut result);
        if status != 0 || result.is_null() || pwd.pw_shell.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr(pwd.pw_shell).to_str().ok().map(str::to_owned)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn windows_folders(probe: &ShellProbe) -> Vec<String> {
    probe.var("Path").or_else(|| probe.var("PATH")).unwrap_or("").split(';').filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// On Linux, prefer installed zsh; otherwise the account's login shell, then $SHELL. On Windows, PowerShell 7, then
/// Windows PowerShell, then cmd.
pub fn terminal_shell(probe: &ShellProbe) -> ShellCommand {
    if probe.platform == Platform::Windows {
        let folders = windows_folders(probe);
        let on_path = |name: &str| folders.iter().map(|folder| win32::join(&[folder, name])).find(|file| (probe.exists)(file));
        let root = probe.var("SystemRoot").unwrap_or("C:\\Windows").to_owned();
        let candidates = [
            on_path("pwsh.exe"),
            probe.var("ProgramFiles").map(|pf| win32::join(&[pf, "PowerShell", "7", "pwsh.exe"])),
            Some(win32::join(&[&root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"])),
        ];
        let found = candidates.into_iter().flatten().find(|file| (probe.exists)(file));
        let file =
            found.or_else(|| probe.var("ComSpec").map(str::to_owned)).unwrap_or_else(|| win32::join(&[&root, "System32", "cmd.exe"]));
        return ShellCommand { file, args: vec![] };
    }
    let account = (probe.user_shell)();
    let inherited = probe.env.get("SHELL").cloned();
    let usable = |file: &Option<String>| {
        file.as_deref().is_some_and(|f| posix::is_absolute(f) && UNIX_SHELLS.contains(&posix::basename(f)) && (probe.exists)(f))
    };
    let mut zsh = None;
    if probe.platform == Platform::Linux {
        let mut list = vec![account.clone(), inherited.clone()];
        list.extend(
            probe
                .env
                .get("PATH")
                .map(String::as_str)
                .unwrap_or("")
                .split(':')
                .filter(|f| posix::is_absolute(f))
                .map(|f| Some(posix::join(&[f, "zsh"]))),
        );
        list.extend(["/usr/local/bin/zsh", "/usr/bin/zsh", "/bin/zsh"].map(|f| Some(f.to_owned())));
        zsh = list.into_iter().find(|file| usable(file) && posix::basename(file.as_deref().unwrap()) == "zsh").flatten();
    }
    let file = zsh.or_else(|| [account, inherited].into_iter().find(usable).flatten()).unwrap_or_else(|| {
        if probe.platform == Platform::Darwin {
            "/bin/zsh".into()
        } else {
            "/bin/sh".into()
        }
    });
    // A login shell reads the same profile files as a new window of the user's terminal app.
    ShellCommand { file, args: vec!["-l".into()] }
}

/// Discover installed shells without running them. Symlink aliases are listed once.
pub fn terminal_shells(probe: &ShellProbe) -> Vec<ShellOption> {
    let windows = probe.platform == Platform::Windows;
    let mut candidates: Vec<Option<String>> = vec![Some(terminal_shell(probe).file)];
    if windows {
        let folders = windows_folders(probe);
        let root = probe.var("SystemRoot").unwrap_or("C:\\Windows").to_owned();
        for folder in &folders {
            for name in ["pwsh.exe", "powershell.exe", "cmd.exe"] {
                candidates.push(Some(win32::join(&[folder, name])));
            }
        }
        candidates.push(probe.var("ProgramFiles").map(|pf| win32::join(&[pf, "PowerShell", "7", "pwsh.exe"])));
        candidates.push(Some(win32::join(&[&root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"])));
        candidates.push(Some(probe.var("ComSpec").map(str::to_owned).unwrap_or_else(|| win32::join(&[&root, "System32", "cmd.exe"]))));
    } else {
        // Some installations have no /etc/shells. Known shells on PATH still work.
        if let Some(text) = (probe.read_shells)() {
            for line in text.split('\n') {
                let line = line.strip_suffix('\r').unwrap_or(line);
                candidates.push(Some(line.split('#').next().unwrap_or("").trim().to_owned()));
            }
        }
        candidates.push(probe.env.get("SHELL").cloned());
        let path = probe.env.get("PATH").map(String::as_str).filter(|p| !p.is_empty()).unwrap_or("");
        let mut folders: Vec<&str> = path.split(':').collect();
        folders.extend(["/usr/local/bin", "/usr/bin", "/bin"]);
        for folder in folders.into_iter().filter(|f| posix::is_absolute(f)) {
            for name in UNIX_SHELLS {
                candidates.push(Some(posix::join(&[folder, name])));
            }
        }
    }
    let absolute = |f: &str| if windows { win32::is_absolute(f) } else { posix::is_absolute(f) };
    let basename = |f: &str| if windows { win32::basename(f).to_owned() } else { posix::basename(f).to_owned() };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for file in candidates.into_iter().flatten() {
        if !absolute(&file) || !(probe.exists)(&file) {
            continue;
        }
        let mut canonical = (probe.realpath)(&file).unwrap_or_else(|| file.clone());
        if windows {
            canonical = canonical.to_lowercase();
        }
        if !seen.insert(canonical) {
            continue;
        }
        let label = strip_exe(&basename(&file)).to_owned();
        result.push(ShellOption { file, label });
    }
    result
}

/// `name.replace(/\.exe$/i, "")`.
pub fn strip_exe(name: &str) -> &str {
    if name.len() >= 4 && name.is_char_boundary(name.len() - 4) && name[name.len() - 4..].eq_ignore_ascii_case(".exe") {
        &name[..name.len() - 4]
    } else {
        name
    }
}

/// The environment a Terminal's shell gets: the host's, without host-only variables, plus the terminal type.
/// `host_windows` stands for `process.platform === "win32"` (the LANG default is skipped there).
pub fn terminal_environment<I: IntoIterator<Item = (String, String)>>(env: I, host_windows: bool) -> BTreeMap<String, String> {
    let mut result: BTreeMap<String, String> = env.into_iter().filter(|(key, _)| !HOST_ONLY.contains(&key.as_str())).collect();
    result.insert("TERM".into(), TERMINAL_TYPE.into());
    result.insert("COLORTERM".into(), "truecolor".into());
    result.insert("TERM_PROGRAM".into(), "Milagre".into());
    if !host_windows && result.get("LANG").is_none_or(|lang| lang.is_empty()) {
        result.insert("LANG".into(), "en_US.UTF-8".into());
    }
    result
}

/// [`terminal_environment`] over this process's environment.
pub fn system_terminal_environment() -> BTreeMap<String, String> {
    terminal_environment(std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))), cfg!(windows))
}
