//! Small JSON files kept across launches, beside `window-state.json` (the desktop keeps these in `localStorage`):
//! the diff's line comments and the PR merge method.
//!
//! They live in `MILAGRE_GPUI_STATE_DIR`, else `~/Library/Application Support/Milagre GPUI/`. Snapshot mode and the
//! tests never call [`enable`], so [`file`] answers `None` and nothing is read or written (a test that wants a file
//! builds a [`JsonFile`] on a path of its own).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// The directory of the app's state files: `MILAGRE_GPUI_STATE_DIR`, else under Application Support.
pub fn default_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MILAGRE_GPUI_STATE_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/Milagre GPUI"))
}

/// Turns persistence on for this process (the app's normal start; never snapshot mode).
pub fn enable() {
    if let Some(dir) = default_dir() {
        let _ = DIR.set(dir);
    }
}

/// The file called `name` in the state directory, or `None` while persistence is off.
pub fn file(name: &str) -> Option<JsonFile> {
    DIR.get().map(|dir| JsonFile::new(dir.join(name)))
}

/// One JSON document on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonFile(PathBuf);

impl JsonFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// The saved document; `None` when there is none or it is malformed (the caller then starts empty).
    pub fn read(&self) -> Option<serde_json::Value> {
        serde_json::from_str(&std::fs::read_to_string(&self.0).ok()?).ok()
    }

    /// Writes then renames, so a crash mid-write never leaves half a file.
    pub fn write(&self, value: &serde_json::Value) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.0.with_extension("json.tmp");
        if std::fs::write(&tmp, value.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.0);
        }
    }
}

/// A path for a test's file, unique to the test.
#[cfg(test)]
pub fn test_file(name: &str) -> JsonFile {
    let dir = std::env::temp_dir().join(format!("milagre-gpui-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    JsonFile::new(dir.join("state.json"))
}
