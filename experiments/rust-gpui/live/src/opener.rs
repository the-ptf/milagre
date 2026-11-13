//! Opening a Chat's folder from Details, Electron's `editor:list`, `editor:open` and `project:reveal` (served by its
//! main process, not the daemon: `call()` refuses them), done natively. Ported from the parked Tauri shell's
//! `native.rs` (`EDITORS`, `detect_editors`, `open_editor`): the editors installed in `/Applications` or
//! `~/Applications` or on the PATH (plus Homebrew's and `~/.local/bin`, since a Finder launch has a small PATH).
//!
//! - Show in Finder: `open <folder>` (as `shell.openPath` does).
//! - Open in editor: Settings › General's editor (Cursor, VS Code, Zed) when installed, else the first installed one;
//!   the folder opens with `open -a <app>` or its command-line tool.
//!
//! Only an existing absolute folder is opened; nothing else is run.

use std::path::{Path, PathBuf};

/// One editor this computer has (`editor:list`'s entry).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Editor {
    pub id: &'static str,
    pub name: &'static str,
    pub app: Option<PathBuf>,
    pub cli: Option<PathBuf>,
}

/// id, name, app bundle, command, the command inside the bundle (the Tauri shell's list).
const EDITORS: &[(&str, &str, &str, &str, &str)] = &[
    ("cursor", "Cursor", "Cursor.app", "cursor", "Contents/Resources/app/bin/cursor"),
    ("vscode", "Visual Studio Code", "Visual Studio Code.app", "code", "Contents/Resources/app/bin/code"),
    ("zed", "Zed", "Zed.app", "zed", "Contents/MacOS/cli"),
    ("windsurf", "Windsurf", "Windsurf.app", "windsurf", "Contents/Resources/app/bin/windsurf"),
    ("vscodium", "VSCodium", "VSCodium.app", "codium", "Contents/Resources/app/bin/codium"),
    ("sublime", "Sublime Text", "Sublime Text.app", "subl", "Contents/SharedSupport/bin/subl"),
];

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The editors under `home` and on `path` (`editor:list`), in the list's order.
pub fn detect_in(home: &Path, path: Option<&std::ffi::OsStr>) -> Vec<Editor> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path.unwrap_or_default()).filter(|p| p.is_absolute()).collect();
    for extra in [PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), home.join(".local/bin")] {
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    EDITORS
        .iter()
        .filter_map(|&(id, name, bundle, command, bundle_cli)| {
            let app = [PathBuf::from("/Applications"), home.join("Applications")].iter().map(|dir| dir.join(bundle)).find(|p| p.is_dir());
            let cli = dirs
                .iter()
                .map(|dir| dir.join(command))
                .find(|p| executable(p))
                .or_else(|| app.as_ref().map(|app| app.join(bundle_cli)).filter(|p| executable(p)));
            (app.is_some() || cli.is_some()).then_some(Editor { id, name, app, cli })
        })
        .collect()
}

/// This computer's editors.
pub fn detect() -> Vec<Editor> {
    detect_in(&crate::setup::home(), std::env::var_os("PATH").as_deref())
}

/// The editor for Settings › General's choice (`cursor`, `vscode`, `zed`, or anything else for the first installed).
pub fn pick<'a>(editors: &'a [Editor], choice: &str) -> Option<&'a Editor> {
    editors.iter().find(|e| e.id == choice).or_else(|| editors.first())
}

fn folder(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("That folder isn't a project".into());
    }
    let real = std::fs::canonicalize(path).map_err(|_| "That folder no longer exists".to_owned())?;
    if !real.is_dir() {
        return Err("That folder no longer exists".into());
    }
    Ok(real)
}

/// The command that opens `path` in `editor`.
pub fn editor_command(editor: &Editor, path: &Path) -> std::process::Command {
    let mut command = match (&editor.app, &editor.cli) {
        (Some(app), _) => {
            let mut command = std::process::Command::new("/usr/bin/open");
            command.arg("-a").arg(app);
            command
        }
        (None, Some(cli)) => std::process::Command::new(cli),
        (None, None) => unreachable!("an editor has an app or a command"),
    };
    command
        .arg(path)
        .current_dir(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

/// Opens `path` (a folder) in Settings' editor, or the first installed one. What happened, in words.
pub fn open_in_editor(path: &str, choice: &str) -> Result<String, String> {
    let real = folder(path)?;
    let editors = detect();
    let editor = pick(&editors, choice).ok_or_else(|| "No editor found: install Cursor, VS Code or Zed".to_owned())?;
    let status = editor_command(editor, &real).status().map_err(|e| format!("Couldn't open {}: {e}", editor.name))?;
    if status.success() { Ok(format!("Opened in {}", editor.name)) } else { Err(format!("Couldn't open {}", editor.name)) }
}

/// Shows `path` (a folder) in Finder.
pub fn reveal(path: &str) -> Result<String, String> {
    let real = folder(path)?;
    let status = std::process::Command::new("/usr/bin/open").arg(&real).status().map_err(|e| format!("Couldn't open Finder: {e}"))?;
    if status.success() { Ok("Shown in Finder".into()) } else { Err("Couldn't open Finder".into()) }
}

/// Tests: the requests are recorded here instead of opening anything.
#[derive(Clone, Default)]
pub struct DryRun(pub std::rc::Rc<std::cell::RefCell<Vec<String>>>);

impl gpui::Global for DryRun {}

/// Opens what Details asked for (off the UI thread), or records it under [`DryRun`]; a failure is said in the
/// sidebar.
pub fn handle(
    request: &milagre_gpui_spike::workspace::panel::details::Request,
    sidebar: gpui::Entity<milagre_gpui_spike::workspace::sidebar::Sidebar>,
    cx: &mut gpui::App,
) {
    use milagre_gpui_spike::workspace::panel::details::Request;
    let choice = cx.try_global::<milagre_gpui_spike::settings::SettingsStore>().map_or("system", |s| s.default_editor.as_str());
    let (what, path, choice) = match request {
        Request::Finder(path) => ("finder", path.clone(), String::new()),
        Request::Editor { path, .. } => ("editor", path.clone(), choice.to_owned()),
        _ => return,
    };
    if let Some(dry) = cx.try_global::<DryRun>() {
        dry.0.borrow_mut().push(format!("{what} {path} {choice}").trim_end().to_owned());
        return;
    }
    let task = cx.background_executor().spawn(async move { if what == "finder" { reveal(&path) } else { open_in_editor(&path, &choice) } });
    cx.spawn(async move |cx| {
        if let Err(error) = task.await {
            sidebar.update(cx, |s, cx| s.set_notice(Some(error.into()), cx));
        }
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editors_are_found_by_app_or_command_and_picked_by_choice() {
        let home = std::env::temp_dir().join(format!("gpui-editors-{}", std::process::id()));
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let zed = bin.join("zed");
        std::fs::write(&zed, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&zed, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A path with only that folder; /Applications may hold others on this computer, so look for Zed's entry.
        let found = detect_in(&home, Some(bin.as_os_str()));
        let entry = found.iter().find(|e| e.id == "zed").expect("zed from the PATH");
        assert!(entry.cli.as_deref() == Some(zed.as_path()) || entry.app.is_some());
        assert_eq!(pick(&found, "zed").map(|e| e.id), Some("zed"));
        assert_eq!(pick(&found, "system").map(|e| e.id), found.first().map(|e| e.id), "the first installed one");
        let only_cli = Editor { id: "zed", name: "Zed", app: None, cli: Some(zed.clone()) };
        let command = editor_command(&only_cli, &home);
        assert_eq!(command.get_program(), zed.as_os_str());
        assert!(folder("relative/path").is_err() && folder("/definitely/not/here").is_err() && folder(home.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&home);
    }
}
