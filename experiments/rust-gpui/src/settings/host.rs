//! The seam a data layer gives the Settings pages that keep their state on a host (Skills, Integrations, Phone &
//! sharing, This Mac, a Project's page): one call with Electron's command name and its arguments as a JSON array, as
//! `window.milagre` sends them (`apps/desktop/electron/preload.cjs`), answered with the host's JSON or why it failed.
//!
//! Without a [`SettingsHost`] each page keeps its fixture. With one, a page reads through it when it shows, writes
//! through it at once, and shows what the host answered. Besides the host's commands a data layer answers what only
//! this window does, which Electron's main process does for its window:
//!
//! | Call | Arguments | Answer |
//! | --- | --- | --- |
//! | [`EDITOR`] | `[]` | the name of the editor Open in editor uses, or `null` when none is installed |
//! | [`OPEN_FILE`] | `[path]` | opens the file in that editor (`skills:open`) |
//! | [`REVEAL`] | `[path]` | shows the file in Finder (`skills:reveal`) |
//! | [`OPEN_URL`] | `[url]` | opens a link in the system browser |

use std::rc::Rc;

use gpui::{App, Global, Task};
use serde_json::Value;

pub const EDITOR: &str = "window:editor";
pub const OPEN_FILE: &str = "window:open-file";
pub const REVEAL: &str = "window:reveal";
pub const OPEN_URL: &str = "window:open-url";

/// A command and its arguments, answered later on the UI thread.
pub type Call = Rc<dyn Fn(&'static str, Value, &mut App) -> Task<Result<Value, String>>>;

/// The open Project's path and name, as the data layer knows it now.
pub type OpenProject = Rc<dyn Fn(&App) -> Option<(String, String)>>;

/// Set by a data layer that backs the pages listed in the module doc.
#[derive(Clone)]
pub struct SettingsHost {
    pub call: Call,
    /// Nothing is written (a read-only snapshot): writes answer an error saying so.
    pub read_only: bool,
    /// The open Project (path and name), whose skills Settings › Skills lists.
    pub project: OpenProject,
    /// Counts the times Settings opened or went to another page: a page reads the host again when it changed since
    /// its last read ([`visit`]), as Electron's pages read when they mount.
    pub visit: u64,
}

impl Global for SettingsHost {}

/// The data layer's host, when there is one.
pub fn host(cx: &App) -> Option<SettingsHost> {
    cx.try_global::<SettingsHost>().cloned()
}

/// `method` with `args` on the host, or `None` without one (the page keeps its fixture).
pub fn call(method: &'static str, args: Value, cx: &mut App) -> Option<Task<Result<Value, String>>> {
    let host = host(cx)?;
    Some((host.call)(method, args, cx))
}

/// The open Project, when a data layer backs the pages.
pub fn project(cx: &App) -> Option<(String, String)> {
    let host = cx.try_global::<SettingsHost>()?;
    (host.project)(cx)
}

/// The host's visit when a data layer backs the pages (see [`SettingsHost::visit`]).
pub fn visit(cx: &App) -> Option<u64> {
    cx.try_global::<SettingsHost>().map(|host| host.visit)
}

/// A string field of an answer, or empty.
pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
