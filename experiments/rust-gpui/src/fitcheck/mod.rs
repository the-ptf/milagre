//! WP-01: the `gpui-component` fit check. Probe views and headless tests that decide which of its
//! widgets Milagre adopts, wraps or owns; the verdicts and their evidence are in `COMPONENT-FIT.md`.
//!
//! Nothing here ships in the app: the module is compiled for `cargo test` and, for the snapshot
//! gallery, with `--features fitcheck` (`MILAGRE_GPUI_FITCHECK=<page> MILAGRE_GPUI_SNAPSHOT=<png>`).
//! `--features webview` adds the `gpui-webview` probe (D1).
//!
//! | File          | Checks                                                                                  |
//! | ------------- | --------------------------------------------------------------------------------------- |
//! | `fixture.rs`  | Long transcript answers and a small patch, shared by the probes                         |
//! | `probes.rs`   | Probe views: messages as `TextView`s, Milagre's markdown extensions, the text style     |
//! | `markdown.rs` | Selection across blocks and messages, copy, chips, fence routing, streaming, links      |
//! | `input.rs`    | `Textarea` and `Input`: auto-grow, undo, words, IME, paste, atomic tokens, focus mark   |
//! | `widgets.rs`  | Tabs, resizable, scrollbar, popover, menu, dialog, tooltip, checkbox, radio, slider ... |
//! | `lists.rs`    | `v_virtual_list` against GPUI's `list` and `uniform_list`                               |
//! | `diff.rs`     | The `diff` module and the highlighter against Milagre's diff and Shiki buckets          |
//! | `gallery.rs`  | Snapshot pages (feature `fitcheck`)                                                     |
//! | `webview.rs`  | A local HTML string in a wry child view (feature `webview`)                             |

pub mod fixture;
pub mod probes;

#[cfg(feature = "fitcheck")]
pub mod gallery;
#[cfg(feature = "webview")]
pub mod webview;

#[cfg(test)]
mod diff;
#[cfg(test)]
mod input;
#[cfg(test)]
mod lists;
#[cfg(test)]
mod markdown;
#[cfg(test)]
mod widgets;

#[cfg(test)]
pub(crate) mod harness {
    //! Mounting a probe the way the app would host gpui-component: our theme, the bridge, and
    //! `Root` as the window root (its dialogs, tooltips and window-wide text selection need it).

    use gpui::{AnyView, AppContext as _, Entity, Render, TestAppContext, VisualTestContext, Window};
    use gpui_component::Root;

    use crate::theme::Theme;

    pub fn init(cx: &mut TestAppContext, theme: Theme) {
        cx.update(|cx| {
            cx.set_global(theme);
            gpui_component::init(cx);
            crate::theme::component_bridge::init(cx);
        });
    }

    /// Opens a window whose root is gpui-component's `Root` around `build`'s view, draws it, and
    /// returns the view.
    pub fn mount<V: Render + 'static>(
        cx: &mut TestAppContext,
        build: impl FnOnce(&mut Window, &mut gpui::Context<V>) -> V + 'static,
    ) -> (Entity<V>, &mut VisualTestContext) {
        init(cx, Theme::dark());
        let (root, cx) = cx.add_window_view(move |window, cx| {
            let view = cx.new(|cx| build(window, cx));
            Root::new(AnyView::from(view), window, cx)
        });
        let view = root.read_with(cx, |root, _| root.view().clone().downcast::<V>().expect("probe view"));
        cx.run_until_parked();
        draw(cx);
        (view, cx)
    }

    /// Lays out and paints the window now (the test platform draws only when asked).
    pub fn draw(cx: &mut VisualTestContext) {
        cx.update(|window, cx| {
            let _ = window.draw(cx);
        });
    }
}
