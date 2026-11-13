//! The window's frame and the sidebar's collapsed state, kept across launches (the desktop keeps both: Electron's
//! window state and `SidebarNav`'s saved collapse). One small JSON file:
//!
//! ```json
//! { "x": 120, "y": 80, "width": 1440, "height": 900, "mode": "windowed", "sidebarCollapsed": false }
//! ```
//!
//! It lives at `MILAGRE_GPUI_WINDOW_STATE`, else `~/Library/Application Support/Milagre GPUI/window-state.json`.
//! Snapshot mode and the tests neither read nor write it ([`StateFile`] is absent), so pictures stay 1440 x 900.
//! A saved frame that no longer touches a display, or is smaller than the window's minimum, is not restored.

use std::path::PathBuf;

use gpui::{Bounds, Pixels, Size, WindowBounds, point, px, size};

/// What is saved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowState {
    /// The window's frame while windowed (its restore frame while zoomed or full screen), in screen points.
    pub bounds: Bounds<Pixels>,
    pub mode: Mode,
    pub sidebar_collapsed: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Windowed,
    Maximized,
    Fullscreen,
}

impl WindowState {
    pub fn from_window(bounds: WindowBounds, sidebar_collapsed: bool) -> Self {
        let (bounds, mode) = match bounds {
            WindowBounds::Windowed(b) => (b, Mode::Windowed),
            WindowBounds::Maximized(b) => (b, Mode::Maximized),
            WindowBounds::Fullscreen(b) => (b, Mode::Fullscreen),
        };
        Self { bounds, mode, sidebar_collapsed }
    }

    pub fn window_bounds(&self) -> WindowBounds {
        match self.mode {
            Mode::Windowed => WindowBounds::Windowed(self.bounds),
            Mode::Maximized => WindowBounds::Maximized(self.bounds),
            Mode::Fullscreen => WindowBounds::Fullscreen(self.bounds),
        }
    }

    pub fn to_json(&self) -> String {
        let mode = match self.mode {
            Mode::Windowed => "windowed",
            Mode::Maximized => "maximized",
            Mode::Fullscreen => "fullscreen",
        };
        serde_json::json!({
            "x": f32::from(self.bounds.origin.x).round(),
            "y": f32::from(self.bounds.origin.y).round(),
            "width": f32::from(self.bounds.size.width).round(),
            "height": f32::from(self.bounds.size.height).round(),
            "mode": mode,
            "sidebarCollapsed": self.sidebar_collapsed,
        })
        .to_string()
    }

    /// Reads a saved state; `None` for anything malformed (the window then opens at its default).
    pub fn parse(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let number = |key: &str| value.get(key)?.as_f64().filter(|n| n.is_finite()).map(|n| n as f32);
        let bounds = Bounds { origin: point(px(number("x")?), px(number("y")?)), size: size(px(number("width")?), px(number("height")?)) };
        let mode = match value.get("mode").and_then(|m| m.as_str()) {
            Some("maximized") => Mode::Maximized,
            Some("fullscreen") => Mode::Fullscreen,
            _ => Mode::Windowed,
        };
        let sidebar_collapsed = value.get("sidebarCollapsed").and_then(|v| v.as_bool()).unwrap_or(false);
        Some(Self { bounds, mode, sidebar_collapsed })
    }

    /// The frame to open at, given the displays' frames: the saved one when it is at least `min` big and at least
    /// 100 x 60 of it is on a display (so its title bar can be reached), else `None`.
    pub fn restorable(&self, displays: &[Bounds<Pixels>], min: Size<Pixels>) -> Option<WindowBounds> {
        let b = self.bounds;
        if b.size.width < min.width || b.size.height < min.height {
            return None;
        }
        let reachable = displays.iter().any(|display| {
            let overlap = display.intersect(&b);
            overlap.size.width >= px(100.0) && overlap.size.height >= px(60.0)
        });
        reachable.then(|| self.window_bounds())
    }
}

/// Where the state is kept, as an app global. Absent in snapshot mode and in tests: nothing is read or written.
pub struct StateFile(pub PathBuf);

impl gpui::Global for StateFile {}

impl StateFile {
    /// `MILAGRE_GPUI_WINDOW_STATE`, else under Application Support. `None` without a home directory.
    pub fn default_path() -> Option<PathBuf> {
        if let Some(path) = std::env::var_os("MILAGRE_GPUI_WINDOW_STATE") {
            return Some(PathBuf::from(path));
        }
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join("Library/Application Support/Milagre GPUI/window-state.json"))
    }

    pub fn load(&self) -> Option<WindowState> {
        WindowState::parse(&std::fs::read_to_string(&self.0).ok()?)
    }

    pub fn save(&self, state: &WindowState) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write then rename, so a crash mid-write never leaves half a file.
        let tmp = self.0.with_extension("json.tmp");
        if std::fs::write(&tmp, state.to_json()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.0);
        }
    }
}
