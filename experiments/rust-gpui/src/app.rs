//! App startup: globals, actions, key bindings, menus and the main window.
//!
//! `MILAGRE_GPUI_THEME=light` switches to the light theme. `MILAGRE_GPUI_SNAPSHOT=<path.png>` saves the
//! window to a PNG once it has drawn, then quits (macOS; see `snapshot.rs`).
//!
//! App-wide actions and their key bindings are declared here. A view's own editing keys are bound by the
//! view under its key context (the composer's in `workspace/chat/composer.rs`).

use std::path::PathBuf;
use std::time::Duration;

use gpui::{
    App, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowHandle, WindowOptions, actions, point, prelude::*, px,
    size,
};

use crate::theme::Theme;
use crate::workspace::Workspace;

actions!(milagre_gpui_spike, [Quit]);

pub const WINDOW_WIDTH: f32 = 1440.0;
pub const WINDOW_HEIGHT: f32 = 900.0;
pub const MIN_WIDTH: f32 = 960.0;
pub const MIN_HEIGHT: f32 = 600.0;

/// Starts the app and opens the main window. Returns when the app quits.
pub fn run() {
    let snapshot = std::env::var_os("MILAGRE_GPUI_SNAPSHOT").map(PathBuf::from);
    gpui_platform::application().with_assets(crate::assets::Assets).run(move |cx: &mut App| {
        init(cx);
        match snapshot {
            None => {
                open_main_window(cx);
                cx.activate(true);
            }
            Some(path) => {
                // The snapshot window is never activated, so AppKit may report it occluded (or the display is
                // asleep) and gpui-pre then draws no frame after the first ones: images must be decoded before.
                cx.spawn(async move |cx| {
                    for _ in 0..100 {
                        if cx.update(crate::ui::preload_logos) {
                            break;
                        }
                        cx.background_executor().timer(Duration::from_millis(20)).await;
                    }
                    cx.update(|cx| {
                        let window = open_main_window(cx);
                        snapshot_then_quit(window, path, cx);
                    });
                })
                .detach();
            }
        }
    });
}

/// Everything the views expect to find in `App`: the theme, gpui-component, actions, key bindings and
/// menus. Tests call the parts they need (`testing::init`).
pub fn init(cx: &mut App) {
    cx.set_global(Theme::from_env());
    // Where views get their data. Only the fixture exists; a daemon client implements the same trait.
    cx.set_global(crate::data::Data(std::sync::Arc::new(crate::data::FixtureSource::new())));
    crate::theme::init_fonts(cx);
    crate::ui::preload_logos(cx);
    // gpui-component's globals, theme and key bindings, so its widgets can be used in any view.
    gpui_component::init(cx);
    // Its theme follows ours: DESIGN.md colours, radii and type for every gpui-component widget.
    crate::theme::component_bridge::init(cx);

    cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
    cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
    cx.set_menus(vec![Menu::new("Milagre GPUI spike").items([MenuItem::action("Quit", Quit)])]);
    // Closing the last window quits the spike (the real app keeps running when its window hides).
    cx.on_window_closed(|cx, _| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
}

/// The one Milagre window: 1440 x 900 centred, a transparent title bar under our own 44px headers.
pub fn open_main_window(cx: &mut App) -> WindowHandle<Workspace> {
    let bounds = Bounds::centered(None, size(px(WINDOW_WIDTH), px(WINDOW_HEIGHT)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
            is_resizable: true,
            // Our 44px headers move the window themselves (`workspace/chrome.rs`); AppKit does not drag
            // from its title-bar strip or delay clicks there.
            app_owns_titlebar_drag: true,
            titlebar: Some(TitlebarOptions {
                title: Some("Milagre GPUI spike".into()),
                appears_transparent: true,
                // From the window's top-left corner to the close button frame's top-left. Measured
                // on macOS 27: the 14pt buttons at y 16 centre at 22.75; y 15 centres them at
                // 21.75, the closest to the 44px header's middle (Electron uses 16 with its own origin).
                traffic_light_position: Some(point(px(16.0), px(15.0))),
            }),
            ..Default::default()
        },
        |window, cx| cx.new(|cx| Workspace::new(window, cx)),
    )
    .expect("open the main window")
}

/// Waits for the first frames to reach the screen, saves the window and quits.
fn snapshot_then_quit(window: WindowHandle<Workspace>, path: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(Duration::from_millis(1500)).await;
        let result = window.update(cx, |_, window, _| save(window, &path));
        match result {
            Ok(Ok((w, h))) => eprintln!("snapshot: wrote {} ({w}x{h} px)", path.display()),
            Ok(Err(error)) => eprintln!("snapshot failed: {error}"),
            Err(error) => eprintln!("snapshot failed: window gone: {error}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

#[cfg(target_os = "macos")]
fn save(window: &gpui::Window, path: &std::path::Path) -> Result<(usize, usize), String> {
    crate::snapshot::save_window_png(window, path)
}

#[cfg(not(target_os = "macos"))]
fn save(_window: &gpui::Window, _path: &std::path::Path) -> Result<(usize, usize), String> {
    Err("snapshots are macOS only".into())
}
