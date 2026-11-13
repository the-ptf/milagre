//! The Settings pages' host ([`milagre_gpui_spike::settings::host::SettingsHost`]) on Milagre's daemon: Skills,
//! Integrations, Phone & sharing, This Mac and the Projects' pages send Electron's commands through it.
//!
//! A read (one of [`crate::daemon::READS`]) goes on a short request-only connection of the live Project; a write on
//! a request-only connection of the live Project ([`Daemon::writer`]). A request waits at most the client's 30 s, so
//! Linear's sign-in (which waits for the browser) answers `TimedOut` while the host still waits; the page then follows
//! `linear:status` until the new workspace shows. In read-only mode a write is refused before any request and recorded. What only
//! Electron's window does is done here: the editor's name, opening a SKILL.md in it, showing it in Finder, opening a
//! link ([`host::EDITOR`], [`host::OPEN_FILE`], [`host::REVEAL`], [`host::OPEN_URL`]), recorded under
//! [`crate::opener::DryRun`] in tests.

use std::sync::Arc;

use gpui::{App, Task, WeakEntity};
use milagre_gpui_spike::settings::host::{self, SettingsHost};
use serde_json::{Value, json};

use super::LiveSettings;
use crate::daemon::{Daemon, READS};
use crate::usage::off_thread;

/// The message a write gets in read-only mode.
pub const READ_ONLY: &str = "Read-only: nothing is written to Milagre's daemon in this window.";

/// The host Settings' pages call, on `daemon`; every request is recorded on `live`.
pub fn make(daemon: Arc<Daemon>, live: WeakEntity<LiveSettings>) -> SettingsHost {
    let project = {
        let daemon = daemon.clone();
        std::rc::Rc::new(move |_: &App| {
            let path = super::project_of(&daemon)?;
            let name = daemon.known().into_iter().find(|known| known.path == path).map(|known| known.name).unwrap_or_else(|| {
                std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())
            });
            Some((path, name))
        })
    };
    let read_only = daemon.read_only();
    let call = std::rc::Rc::new(move |method: &'static str, args: Value, cx: &mut App| -> Task<Result<Value, String>> {
        match method {
            host::EDITOR => Task::ready(Ok(editor_name(cx))),
            host::OPEN_FILE | host::REVEAL | host::OPEN_URL => window_call(method, &args, cx),
            _ if READS.contains(&method) => read(&daemon, method, args, cx),
            _ => write(&daemon, &live, method, args, cx),
        }
    });
    SettingsHost { call, read_only, project, visit: 0 }
}

fn read(daemon: &Arc<Daemon>, method: &'static str, args: Value, cx: &mut App) -> Task<Result<Value, String>> {
    let Some(project) = super::project_of(daemon) else {
        return Task::ready(Err("Milagre's daemon has no Project open yet.".into()));
    };
    let daemon = daemon.clone();
    let work = off_thread(move || futures::executor::block_on(daemon.read(&project, method, args)).map_err(|e| format!("{e:#}")));
    cx.background_executor().spawn(async move { work.await.unwrap_or_else(|_| Err("The read thread ended.".into())) })
}

fn write(
    daemon: &Arc<Daemon>,
    live: &WeakEntity<LiveSettings>,
    method: &'static str,
    args: Value,
    cx: &mut App,
) -> Task<Result<Value, String>> {
    let project = super::project_of(daemon).filter(|_| !daemon.read_only());
    let Some(project) = project else {
        eprintln!("live: read-only, not sent: {method}");
        let _ = live.update(cx, |live, _| live.refused.push(method.to_owned()));
        return Task::ready(Err(READ_ONLY.into()));
    };
    let _ = live.update(cx, |live, _| live.sent.push((method.to_owned(), args.clone())));
    let daemon = daemon.clone();
    let work = off_thread(move || {
        futures::executor::block_on(async {
            let writer = daemon.writer(&project).await.map_err(|e| format!("{e:#}"))?;
            let answer = writer.call(method, args).await.map_err(|e| format!("{e:#}"));
            drop(writer);
            answer
        })
    });
    let live = live.clone();
    cx.spawn(async move |cx| {
        let answer = work.await.unwrap_or_else(|_| Err("The write thread ended.".into()));
        // Show in sidebar: the sidebar follows at once, as when Filters hides a Project.
        if let (Ok(list), "project:set-hidden") = (&answer, method) {
            let list = list.clone();
            cx.update(|cx| {
                if let Some(writes) = cx.try_global::<crate::sidebar_writes::Writes>().map(|w| w.0.clone()) {
                    writes.update(cx, |w, cx| w.hidden_changed(&list, cx));
                }
            });
        }
        if let Err(error) = &answer {
            let error = format!("{method}: {error}");
            let _ = live.update(cx, |live, _| live.errors.push(error));
        }
        answer
    })
}

/// The editor Open in editor uses (Settings › General's choice, else the first installed), or `null`.
fn editor_name(cx: &App) -> Value {
    let choice = cx.try_global::<milagre_gpui_spike::settings::SettingsStore>().map_or("system", |s| s.default_editor.as_str());
    if cx.has_global::<crate::opener::DryRun>() {
        return json!("Editor");
    }
    let editors = crate::opener::detect();
    crate::opener::pick(&editors, choice).map_or(Value::Null, |editor| json!(editor.name))
}

/// What Electron's main process does for its window: a file in the editor, a file in Finder, a link in the browser.
fn window_call(method: &'static str, args: &Value, cx: &mut App) -> Task<Result<Value, String>> {
    let target = args[0].as_str().unwrap_or_default().to_owned();
    let choice = cx.try_global::<milagre_gpui_spike::settings::SettingsStore>().map_or("system", |s| s.default_editor.as_str()).to_owned();
    if let Some(dry) = cx.try_global::<crate::opener::DryRun>() {
        let what = match method {
            host::OPEN_FILE => "skill-editor",
            host::REVEAL => "skill-finder",
            _ => "url",
        };
        dry.0.borrow_mut().push(format!("{what} {target}"));
        return Task::ready(Ok(Value::Null));
    }
    if method == host::OPEN_URL {
        cx.open_url(&target);
        return Task::ready(Ok(Value::Null));
    }
    cx.background_executor().spawn(async move {
        let file = std::path::Path::new(&target);
        if !file.is_absolute() || !file.is_file() {
            return Err("That skill is no longer there. Reload the list.".to_owned());
        }
        let mut command = if method == host::REVEAL {
            let mut command = std::process::Command::new("/usr/bin/open");
            command.arg("-R");
            command
        } else {
            let editors = crate::opener::detect();
            let editor = crate::opener::pick(&editors, &choice).ok_or("No editor found: install Cursor, VS Code or Zed")?;
            match (&editor.app, &editor.cli) {
                (Some(app), _) => {
                    let mut command = std::process::Command::new("/usr/bin/open");
                    command.arg("-a").arg(app);
                    command
                }
                (None, Some(cli)) => std::process::Command::new(cli),
                (None, None) => return Err("No editor found: install Cursor, VS Code or Zed".to_owned()),
            }
        };
        let status = command
            .arg(file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("Couldn't open it: {e}"))?;
        if status.success() { Ok(Value::Null) } else { Err("Couldn't open it.".to_owned()) }
    })
}
