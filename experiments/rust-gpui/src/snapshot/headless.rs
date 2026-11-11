//! Headless snapshots (macOS): draw the app, or any view, to a PNG with no window on screen.
//!
//! The window snapshot (`snapshot::save_window_png`) photographs a real AppKit window, which gpui-pre stops drawing
//! once AppKit reports it occluded or the display sleeps, so only its first frames ever show. This path never opens
//! an AppKit window: gpui-pre's [`HeadlessAppContext`] runs the app on its test platform (a deterministic executor and
//! a simulated clock) with the real CoreText text system, and its `MetalHeadlessRenderer` draws the last frame's
//! scene into an offscreen Metal texture that is read back. Frames are pumped by hand ([`pump`]): each one delivers
//! the next-frame callbacks (`request_animation_frame`, `on_next_frame`), redraws what changed and moves the clock
//! one frame on, so selections made after the first frame, open popovers and dialogs, and settled animations show.
//!
//! Needs gpui-pre's `test-support` (feature `headless-snapshot`; `cargo test` has it already). No gpui-pre patch:
//! 0.3.12 ships `HeadlessAppContext::capture_screenshot` and `gpui_platform::current_headless_renderer`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use gpui::{AnyWindowHandle, App, AssetSource, HeadlessAppContext};

/// One frame at 60 Hz, the step the simulated clock moves per pumped frame.
pub const FRAME: Duration = Duration::from_micros(16_667);
/// Frames pumped before the capture when `MILAGRE_GPUI_SNAPSHOT_FRAMES` is not set: two seconds, longer than any
/// opening motion in the app (the slowest is 400 ms at Normal speed).
pub const DEFAULT_FRAMES: usize = 120;

/// A headless app: the test platform with the real text system, the app's assets and the Metal headless renderer.
pub fn context(assets: Arc<dyn AssetSource>) -> HeadlessAppContext {
    let text_system = Arc::new(gpui_apple::AppleTextSystem::new());
    HeadlessAppContext::with_platform(text_system, assets, gpui_platform::current_headless_renderer)
}

/// Pumps `frames` frames on every window: deliver the next-frame callbacks, let the app settle (which draws every
/// window something made dirty), then move the clock one frame on.
pub fn pump(cx: &mut HeadlessAppContext, frames: usize) {
    for _ in 0..frames {
        let windows = cx.update(|cx| cx.windows());
        for window in windows {
            cx.update_window(window, |_, window, cx| {
                window.simulate_next_frame(cx);
            })
            .ok();
        }
        cx.run_until_parked();
        cx.advance_clock(FRAME);
        cx.run_until_parked();
    }
    // A last draw for whatever the final callbacks dirtied, so the capture shows the newest frame.
    let windows = cx.update(|cx| cx.windows());
    for window in windows {
        cx.update_window(window, |_, window, cx| {
            window.simulate_next_frame(cx);
        })
        .ok();
    }
    cx.run_until_parked();
}

/// Draws `window`'s last frame and writes it to `path` as a PNG. Returns its size in device pixels (2x).
pub fn save_png(cx: &mut HeadlessAppContext, window: AnyWindowHandle, path: &Path) -> Result<(u32, u32), String> {
    let image = cx.capture_screenshot(window).map_err(|error| format!("could not render the window: {error:#}"))?;
    let size = image.dimensions();
    image.save(path).map_err(|error| format!("could not write {}: {error}", path.display()))?;
    Ok(size)
}

/// How many frames to pump before the capture: `MILAGRE_GPUI_SNAPSHOT_FRAMES`, else [`DEFAULT_FRAMES`].
pub fn frames_from_env() -> usize {
    std::env::var("MILAGRE_GPUI_SNAPSHOT_FRAMES").ok().and_then(|value| value.parse().ok()).unwrap_or(DEFAULT_FRAMES)
}

/// The app's snapshot mode without a window: everything `app::run` sets up, the main window as it opens (with every
/// `MILAGRE_GPUI_*` seed), [`frames_from_env`] frames, then the PNG at `path`. Returns the process exit code.
pub fn run_app(path: &Path) -> i32 {
    let mut cx = context(Arc::new(crate::assets::Assets));
    cx.update(crate::app::init);
    // The provider logos decode on the background executor; give them the frames they need before the window opens,
    // as the window snapshot does.
    for _ in 0..100 {
        if cx.update(crate::ui::preload_logos) {
            break;
        }
        cx.advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
    }
    let window = cx.update(crate::app::open_main_window);
    pump(&mut cx, frames_from_env());
    let code = match save_png(&mut cx, window.into(), path) {
        Ok((w, h)) => {
            eprintln!("snapshot (headless): wrote {} ({w}x{h} px)", path.display());
            0
        }
        Err(error) => {
            eprintln!("snapshot (headless) failed: {error}");
            1
        }
    };
    cx.update(|cx: &mut App| cx.quit());
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole window through the real Metal renderer, no window on screen. Needs a Metal device, so it runs on
    /// request: `cargo test headless_renders_the_window -- --ignored`.
    #[test]
    #[ignore = "needs a Metal device; run explicitly on macOS"]
    fn headless_renders_the_window() {
        let mut cx = context(Arc::new(crate::assets::Assets));
        cx.update(crate::app::init);
        let window = cx.update(crate::app::open_main_window);
        pump(&mut cx, 4);
        let image = cx.capture_screenshot(window.into()).expect("a frame");
        assert_eq!(image.dimensions(), (2880, 1800));
        let first = *image.get_pixel(0, 0);
        assert!(image.pixels().any(|pixel| *pixel != first), "the frame is not one flat colour");
    }
}
