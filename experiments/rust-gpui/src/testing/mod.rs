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
//!
//! The app's window root is gpui-component's `Root` around the workspace (`app::open_main_window`), and
//! [`mount_workspace`] mounts it the same way. A gpui-component widget (a `Popover`, a `Dialog`, a tooltip,
//! a `TextView` with window-wide selection) needs `Root` above it: mount it with [`mount_in_root`] (a view)
//! or [`mount_element_in_root`] (an element). [`mount_element`] mounts a plain element without `Root`, for
//! our own primitives.

use gpui::{AnyElement, AnyView, App, Bounds, Context, Entity, Pixels, Render, TestAppContext, VisualTestContext, Window, div, prelude::*};
use gpui_component::Root;

use crate::theme::Theme;
use crate::workspace::Workspace;

/// What the app's `init` sets up that views need: the dark theme, the fixture data source (`data::Data`) and the
/// sidebar's seed (`app::install_fixture`), gpui-component and the theme bridge that feeds gpui-component's theme
/// from ours.
pub fn init(cx: &mut TestAppContext) {
    init_with(cx, Theme::dark());
}

pub fn init_with(cx: &mut TestAppContext, theme: Theme) {
    cx.update(|cx| {
        cx.set_global(theme);
        crate::app::install_fixture(cx);
        gpui_component::init(cx);
        crate::theme::component_bridge::init(cx);
    });
}

/// The whole window (sidebar, Chat, panel) in a test window under `Root`, as the app opens it, after its
/// first frames settle.
pub fn mount_workspace(cx: &mut TestAppContext) -> (Entity<Workspace>, &mut VisualTestContext) {
    mount_in_root(cx, Workspace::new)
}

/// The whole window with the side panel open on `tab` (a Chat opens on Details; most panel tests want a body).
pub fn mount_workspace_on(cx: &mut TestAppContext, tab: crate::workspace::panel::PanelTab) -> (Entity<Workspace>, &mut VisualTestContext) {
    let (workspace, cx) = mount_workspace(cx);
    let panel = workspace.read_with(cx, |w, _| w.panel.clone());
    panel.update(cx, |panel, cx| panel.activate(tab, cx));
    cx.run_until_parked();
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    (workspace, cx)
}

/// Mounts the view `build` makes in a test window whose root is gpui-component's `Root`, the way the app's
/// window is built, and draws it. Returns the view (not the `Root`). `testing::init` runs first.
///
/// ```ignore
/// let (view, cx) = testing::mount_in_root(cx, |window, cx| MyField::new(window, cx));
/// ```
pub fn mount_in_root<V: Render + 'static>(
    cx: &mut TestAppContext,
    build: impl FnOnce(&mut Window, &mut Context<V>) -> V + 'static,
) -> (Entity<V>, &mut VisualTestContext) {
    init(cx);
    let (root, cx) = cx.add_window_view(move |window, cx| {
        let view = cx.new(|cx| build(window, cx));
        Root::new(AnyView::from(view), window, cx)
    });
    let view = root.read_with(cx, |root, _| root.view().clone().downcast::<V>().expect("the view mounted in Root"));
    cx.run_until_parked();
    (view, cx)
}

type Build = Box<dyn Fn(&mut Window, &mut App) -> AnyElement>;

/// A view that draws whatever its closure builds: for testing a primitive on its own.
pub struct Harness {
    build: Build,
}

impl Harness {
    fn new<E: IntoElement>(build: impl Fn(&mut Window, &mut App) -> E + 'static) -> Self {
        Self { build: Box::new(move |window, cx| build(window, cx).into_any_element()) }
    }
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
    let (harness, cx) = cx.add_window_view(move |_, _| Harness::new(build));
    cx.run_until_parked();
    (harness, cx)
}

/// [`mount_element`] under gpui-component's `Root`: for a wrapped gpui-component widget built as an element.
pub fn mount_element_in_root<E: IntoElement>(
    cx: &mut TestAppContext,
    build: impl Fn(&mut Window, &mut App) -> E + 'static,
) -> (Entity<Harness>, &mut VisualTestContext) {
    mount_in_root(cx, move |_, _| Harness::new(build))
}

/// The bounds `selector` was drawn at in the last frame; panics with the selector when it was not drawn.
pub fn bounds(cx: &mut VisualTestContext, selector: &'static str) -> Bounds<Pixels> {
    cx.debug_bounds(selector).unwrap_or_else(|| panic!("`{selector}` is not drawn"))
}

/// A `&'static str` for a selector built at run time (`debug_bounds` takes `&'static str`).
pub fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}
