//! Window chrome shared by the three column headers.

use gpui::{ClickEvent, Div, ElementId, Stateful, WindowControlArea, div, prelude::*};

use crate::theme::HEADER_HEIGHT;

/// A 44px column header that acts as the window's title bar.
///
/// What each platform does with it (GPUI 0.2.2):
/// - macOS: AppKit drags the window from the native title bar strip (the top ~28px of the
///   transparent title bar) on its own. GPUI 0.2.2 has no macOS `start_window_move`, so the lower
///   16px of a 44px header do not drag. Double-click zooms or minimises per the system setting,
///   through `Window::titlebar_double_click`, the same call Zed's own title bar makes.
/// - Windows: `WindowControlArea::Drag` feeds the native hit test, so the whole header drags.
/// - Linux: not wired; it would need `Window::start_window_move` on mouse down.
pub fn header(id: impl Into<ElementId>) -> Stateful<Div> {
    div().id(id).flex().flex_none().items_center().h(HEADER_HEIGHT).window_control_area(WindowControlArea::Drag).on_click(
        |event: &ClickEvent, window, _cx| {
            if event.click_count() == 2 {
                window.titlebar_double_click();
            }
        },
    )
}
