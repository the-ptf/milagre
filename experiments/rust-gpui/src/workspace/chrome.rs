//! Window chrome: the 44px column headers are the window's title bar.
//!
//! macOS (gpui-pre): the window opens with `app_owns_titlebar_drag` (`app.rs`), so AppKit neither drags
//! the window from its own title-bar strip nor delays clicks there to tell a drag from a double-click
//! (the macOS 27 delay). Every [`header`] moves the window itself, the way Zed's title bar does: a left
//! press arms a move, and the first mouse move after it calls `Window::start_window_move`
//! (`performWindowDragWithEvent`). A double-click zooms or minimises per the system setting
//! (`Window::titlebar_double_click`). So all 44px of all three headers drag, not only the top 28.
//!
//! A control inside a header calls [`NoDrag::no_drag`] (DESIGN.md: "a control inside one takes
//! `.no-drag`"), so pressing it and moving does not move the window and double-clicking it does not zoom.
//!
//! Windows: `WindowControlArea::Drag` feeds the native hit test. Linux: the same mouse handlers apply.

use std::cell::Cell;

use gpui::{ClickEvent, Div, ElementId, InteractiveElement, MouseButton, Stateful, Window, WindowControlArea, div, prelude::*};

use crate::theme::HEADER_HEIGHT;

thread_local! {
    /// A left press on a header that the next mouse move turns into a window move. One per UI thread is
    /// enough: only one press can be down at a time.
    static MOVE_ARMED: Cell<bool> = const { Cell::new(false) };
}

/// A 44px column header that acts as the window's title bar.
pub fn header(id: impl Into<ElementId>) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .h(HEADER_HEIGHT)
        .window_control_area(WindowControlArea::Drag)
        .on_mouse_down(MouseButton::Left, |_, _, _| MOVE_ARMED.set(true))
        .on_mouse_up(MouseButton::Left, |_, _, _| MOVE_ARMED.set(false))
        .on_mouse_down_out(|_, _, _| MOVE_ARMED.set(false))
        .on_mouse_move(|_, window, _| {
            if MOVE_ARMED.replace(false) {
                start_window_move(window);
            }
        })
        .on_click(|event: &ClickEvent, window, _| {
            if event.click_count() == 2 {
                titlebar_double_click(window);
            }
        })
}

/// For controls inside a header: a press on them never moves the window or reaches the header's
/// double-click.
pub trait NoDrag: InteractiveElement + Sized {
    fn no_drag(self) -> Self {
        self.on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
    }
}

impl<E: InteractiveElement> NoDrag for E {}

#[cfg(not(test))]
fn start_window_move(window: &mut Window) {
    window.start_window_move();
}

#[cfg(not(test))]
fn titlebar_double_click(window: &mut Window) {
    window.titlebar_double_click();
}

// GPUI's test window panics in `start_window_move` (`unimplemented!`), so the tests record the calls instead.
#[cfg(test)]
thread_local! {
    pub(crate) static CHROME_CALLS: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn start_window_move(_window: &mut Window) {
    CHROME_CALLS.with_borrow_mut(|calls| calls.push("move"));
}

#[cfg(test)]
fn titlebar_double_click(_window: &mut Window) {
    CHROME_CALLS.with_borrow_mut(|calls| calls.push("double-click"));
}
