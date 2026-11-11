//! GPUI spike for Milagre's desktop shell: app startup, the window and the root view.
//!
//! `MILAGRE_GPUI_THEME=light` switches to the light theme. `MILAGRE_GPUI_SNAPSHOT=<path.png>` saves the
//! window to a PNG once it has drawn, then quits (macOS; see `snapshot.rs`).

use std::path::PathBuf;
use std::time::Duration;

use gpui::{
    App, Bounds, KeyBinding, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowHandle, WindowOptions, actions, point, prelude::*, px,
    size,
};
use milagre_gpui_spike::theme::Theme;
use milagre_gpui_spike::workspace::Workspace;

actions!(milagre_gpui_spike, [Quit]);

const WINDOW_WIDTH: f32 = 1440.0;
const WINDOW_HEIGHT: f32 = 900.0;
const MIN_WIDTH: f32 = 960.0;
const MIN_HEIGHT: f32 = 600.0;

fn main() {
    let snapshot = std::env::var_os("MILAGRE_GPUI_SNAPSHOT").map(PathBuf::from);
    gpui_platform::application().run(move |cx: &mut App| {
        cx.set_global(Theme::from_env());
        // gpui-component's globals, theme and key bindings, so its widgets can be used in any view.
        gpui_component::init(cx);

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

        let bounds = Bounds::centered(None, size(px(WINDOW_WIDTH), px(WINDOW_HEIGHT)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(MIN_WIDTH), px(MIN_HEIGHT))),
                    is_resizable: true,
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
            .expect("open the main window");

        match snapshot {
            Some(path) => snapshot_then_quit(window, path, cx),
            None => cx.activate(true),
        }
    });
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
    milagre_gpui_spike::snapshot::save_window_png(window, path)
}

#[cfg(not(target_os = "macos"))]
fn save(_window: &gpui::Window, _path: &std::path::Path) -> Result<(usize, usize), String> {
    Err("snapshots are macOS only".into())
}
