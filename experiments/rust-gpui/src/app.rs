//! App startup: globals, actions, key bindings, menus and the main window.
//!
//! `MILAGRE_GPUI_THEME=light` switches to the light theme. `MILAGRE_GPUI_SNAPSHOT=<path.png>` saves the
//! window to a PNG once it has drawn, then quits (macOS; see `snapshot.rs`).
//!
//! The shell's app-wide actions, their keys and the menu bar live in `workspace/shell/keys.rs`; a view's own editing
//! keys are bound by the view under its key context (the composer's in `workspace/chat/composer.rs`).
//!
//! The window reopens where it was left, with the sidebar as it was (`workspace/shell/window_state.rs`), except in
//! snapshot mode, which always opens 1440 x 900 and saves nothing. `MILAGRE_GPUI_SIDEBAR_COLLAPSED=1` opens the
//! sidebar as a rail (for snapshots).

use std::path::PathBuf;
use std::time::Duration;

use gpui::{App, Bounds, Entity, TitlebarOptions, WindowBounds, WindowHandle, WindowOptions, point, prelude::*, px, size};
use gpui_component::Root;

use crate::theme::Theme;
use crate::workspace::Workspace;
use crate::workspace::shell::window_state::{StateFile, WindowState};

pub const WINDOW_WIDTH: f32 = 1440.0;
pub const WINDOW_HEIGHT: f32 = 900.0;
/// The desktop's minimum (`electron/main.cjs`: 980 x 680).
pub const MIN_WIDTH: f32 = 980.0;
pub const MIN_HEIGHT: f32 = 680.0;
/// How long the window must rest before its frame is written.
const SAVE_DELAY: Duration = Duration::from_millis(500);

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
                if let Some(path) = StateFile::default_path() {
                    cx.set_global(StateFile(path));
                }
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

    // ⌘Q, ⌘B, ⌘N, ⇧⌘T, the window keys and the menu bar.
    crate::workspace::shell::keys::init(cx);
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
    // `MILAGRE_GPUI_NO_PROJECT=1`: the fixture of a first launch, so the window opens on onboarding.
    let source = if std::env::var_os("MILAGRE_GPUI_NO_PROJECT").is_some() {
        crate::data::FixtureSource::without_project()
    } else {
        crate::data::FixtureSource::new()
    };
    let data = source.data();
    cx.set_global(crate::workspace::sidebar::SidebarSeed {
        open_families: data.open_families.iter().cloned().collect(),
        open_chat: Some(data.open_chat.clone()),
    });
    cx.set_global(crate::data::Data(std::sync::Arc::new(source)));
}

/// The one Milagre window: where it was left (else 1440 x 900 centred), at least 980 x 680, a transparent title bar
/// under our own 44px headers.
///
/// The window's root view is gpui-component's [`Root`] around the [`Workspace`]: its dialogs, popovers,
/// tooltips, notifications and window-wide text selection live in `Root`'s layers (COMPONENT-FIT.md). `Root`
/// sets the window's rem size from gpui-component's theme every frame; the theme bridge keeps it at 16, the
/// size our `p_*`/`gap_*` spacing assumes. [`workspace_of`] gets the Workspace back from the handle.
pub fn open_main_window(cx: &mut App) -> WindowHandle<Root> {
    let min = size(px(MIN_WIDTH), px(MIN_HEIGHT));
    let saved = cx.try_global::<StateFile>().and_then(StateFile::load);
    let displays: Vec<_> = cx.displays().iter().map(|display| display.bounds()).collect();
    let window_bounds = saved
        .and_then(|state| state.restorable(&displays, min))
        .unwrap_or_else(|| WindowBounds::Windowed(Bounds::centered(None, size(px(WINDOW_WIDTH), px(WINDOW_HEIGHT)), cx)));
    let collapsed = saved.is_some_and(|state| state.sidebar_collapsed) || std::env::var_os("MILAGRE_GPUI_SIDEBAR_COLLAPSED").is_some();
    cx.open_window(
        WindowOptions {
            window_bounds: Some(window_bounds),
            window_min_size: Some(min),
            is_resizable: true,
            // Our 44px headers move the window themselves (`workspace/chrome.rs`); AppKit does not drag
            // from its title-bar strip or delay clicks there.
            app_owns_titlebar_drag: true,
            titlebar: Some(TitlebarOptions {
                title: Some("Milagre".into()),
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
            if collapsed {
                let sidebar = workspace.read(cx).sidebar.clone();
                sidebar.update(cx, |sidebar, cx| sidebar.set_collapsed(true, cx));
            }
            keep_window_state(&workspace, window, cx);
            cx.new(|cx| Root::new(workspace, window, cx))
        },
    )
    .expect("open the main window")
}

/// Writes the window's frame and the sidebar's collapse to the state file whenever either changes and then rests,
/// while the app has one ([`StateFile`]).
fn keep_window_state(workspace: &Entity<Workspace>, window: &mut gpui::Window, cx: &mut App) {
    if !cx.has_global::<StateFile>() {
        return;
    }
    struct Keeper {
        last: Option<WindowState>,
        _save: Option<gpui::Task<()>>,
    }
    let sidebar = workspace.read(cx).sidebar.clone();
    let keeper = cx.new(|_| Keeper { last: None, _save: None });
    let note = {
        let sidebar = sidebar.clone();
        move |keeper: &mut Keeper, window: &mut gpui::Window, cx: &mut gpui::Context<Keeper>| {
            let state = WindowState::from_window(window.window_bounds(), sidebar.read(cx).is_collapsed());
            if keeper.last == Some(state) {
                return;
            }
            keeper.last = Some(state);
            keeper._save = Some(cx.spawn(async move |_, cx| {
                cx.background_executor().timer(SAVE_DELAY).await;
                cx.update(|cx| {
                    if let Some(file) = cx.try_global::<StateFile>() {
                        file.save(&state);
                    }
                });
            }));
        }
    };
    keeper.update(cx, |_, cx| {
        let on_bounds = note.clone();
        cx.observe_window_bounds(window, move |keeper, window, cx| on_bounds(keeper, window, cx)).detach();
        let on_sidebar = note.clone();
        cx.observe_in(&sidebar, window, move |keeper, _, window, cx| on_sidebar(keeper, window, cx)).detach();
    });
    // The keeper lives as long as the workspace.
    workspace.update(cx, |_, cx| cx.on_release(move |_, _| drop(keeper)).detach());
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
