//! Helpers shared by the headless tests (GPUI's test platform, `#[gpui::test]`).
//!
//! ```ignore
//! #[gpui::test]
//! fn clicking_it_works(cx: &mut TestAppContext) {
//!     let (workspace, cx) = testing::mount_workspace(cx);
//!     let row = cx.debug_bounds("chat-row-3").expect("drawn");
//!     cx.simulate_click(row.center(), Modifiers::none());
//! }
//! ```
//!
//! What the test platform does and does not do: it lays out and "paints" real views, hit-tests clicks,
//! dispatches keys and actions, and records each element's bounds under its `debug_selector` for the
//! current frame. Its text system is a no-op with fixed advances, so assert on structure, state and
//! geometry, never on text metrics; it cannot move a window (`start_window_move` panics). Animations are
//! off under `cfg(test)` (`ui::motion`).

use gpui::{AnyElement, App, Bounds, Context, Entity, Pixels, Render, TestAppContext, VisualTestContext, Window, div, prelude::*};

use crate::theme::Theme;
use crate::workspace::Workspace;

/// What the app's `init` sets up that views need: the dark theme and gpui-component.
pub fn init(cx: &mut TestAppContext) {
    init_with(cx, Theme::dark());
}

pub fn init_with(cx: &mut TestAppContext, theme: Theme) {
    cx.update(|cx| {
        cx.set_global(theme);
        gpui_component::init(cx);
    });
}

/// The whole window (sidebar, Chat, panel) in a test window, after its first frames settle.
pub fn mount_workspace(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut VisualTestContext) {
    init(cx);
    let (workspace, cx) = cx.add_window_view(Workspace::new);
    cx.run_until_parked();
    (workspace, cx)
}

type Build = Box<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// A view that draws whatever its closure builds: for testing a primitive on its own.
pub struct Harness {
    build: Build,
}

impl Render for Harness {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().flex().flex_col().items_start().gap_2().p_4().child((self.build)(window, cx))
    }
}

/// Mounts `build` in a test window and draws it.
pub fn mount_element<E: IntoElement>(
    cx: &mut TestAppContext,
    build: impl Fn(&mut Window, &mut App) -> E + 'static,
) -> (Entity<Harness>, &mut VisualTestContext) {
    init(cx);
    let (harness, cx) = cx.add_window_view(move |_, _| Harness { build: Box::new(move |window, cx| build(window, cx).into_any_element()) });
    cx.run_until_parked();
    (harness, cx)
}

/// The bounds `selector` was drawn at in the last frame; panics with the selector when it was not drawn.
pub fn bounds(cx: &mut VisualTestContext, selector: &'static str) -> Bounds<Pixels> {
    cx.debug_bounds(selector).unwrap_or_else(|| panic!("`{selector}` is not drawn"))
}

/// A `&'static str` for a selector built at run time (`debug_bounds` takes `&'static str`).
pub fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}
