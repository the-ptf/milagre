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
    App, Bounds, Entity, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowHandle, WindowOptions, actions, point,
    prelude::*, px, size,
};
use gpui_component::Root;

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
        // WP-01 fit-check gallery (`--features fitcheck`, `MILAGRE_GPUI_FITCHECK=<page>`) instead of the app.
        #[cfg(feature = "fitcheck")]
        if crate::fitcheck::gallery::run(snapshot.clone(), cx) {
            return;
        }
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
    install_fixture(cx);
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

/// The fixture data source as the app's `data::Data`, and the sidebar's device state (opened Subchat families, the
/// Chat on screen) seeded from it until a preference store exists.
pub fn install_fixture(cx: &mut App) {
    let source = crate::data::FixtureSource::new();
    let data = source.data();
    cx.set_global(crate::workspace::sidebar::SidebarSeed {
        open_families: data.open_families.iter().cloned().collect(),
        open_chat: Some(data.open_chat.clone()),
    });
    cx.set_global(crate::data::Data(std::sync::Arc::new(source)));
}

/// The one Milagre window: 1440 x 900 centred, a transparent title bar under our own 44px headers.
///
/// The window's root view is gpui-component's [`Root`] around the [`Workspace`]: its dialogs, popovers,
/// tooltips, notifications and window-wide text selection live in `Root`'s layers (COMPONENT-FIT.md). `Root`
/// sets the window's rem size from gpui-component's theme every frame; the theme bridge keeps it at 16, the
/// size our `p_*`/`gap_*` spacing assumes. [`workspace_of`] gets the Workspace back from the handle.
pub fn open_main_window(cx: &mut App) -> WindowHandle<Root> {
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
        |window, cx| {
            let workspace = cx.new(|cx| Workspace::new(window, cx));
            cx.new(|cx| Root::new(workspace, window, cx))
        },
    )
    .expect("open the main window")
}

/// The [`Workspace`] inside a window [`open_main_window`] opened (`Root`'s content view).
pub fn workspace_of(root: &Root) -> Option<Entity<Workspace>> {
    root.view().clone().downcast::<Workspace>().ok()
}

/// Waits for the first frames to reach the screen, saves the window and quits.
fn snapshot_then_quit(window: WindowHandle<Root>, path: PathBuf, cx: &mut App) {
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
