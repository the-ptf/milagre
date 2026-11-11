//! The window's side of the sidebar's drags and of the top bar's Link Projects button: what `workspace/mod.rs` and
//! the shell call, kept here so the shared root files only gain a line each.
//!
//! A row's drag is GPUI's own (`on_drag` on the row): the window hears every move of it (`on_drag_move`, which runs
//! wherever the pointer is), asks the sidebar first and the grid second where it would land, and ends it on the
//! release anywhere in the window (a window-level mouse-up listener, so a release over an element that takes the
//! pointer still drops) or on Escape.

use gpui::{
    App, Context, DragMoveEvent, InteractiveElement, KeyDownEvent, MouseUpEvent, ParentElement, Pixels, Point, Styled, Window, canvas,
};

use super::drag::ChatDrag;
use crate::workspace::Workspace;

impl Workspace {
    /// The root's drag listeners: moves, the release and Escape.
    pub(crate) fn sidebar_drag<E: InteractiveElement + ParentElement>(&self, element: E, cx: &mut Context<Self>) -> E {
        let this = cx.entity().downgrade();
        let release = canvas(
            |_, _, _| (),
            move |_, _, window, _| {
                let this = this.clone();
                window.on_mouse_event(move |_: &MouseUpEvent, phase, window, cx| {
                    if phase != gpui::DispatchPhase::Capture || !cx.has_active_drag() {
                        return;
                    }
                    // After this release is dispatched (GPUI drops its drag then), so the drop sees the last move.
                    let this = this.clone();
                    window.defer(cx, move |window, cx| {
                        let _ = this.update(cx, |this, cx| this.chat_dropped(window, cx));
                    });
                });
            },
        )
        .absolute()
        .size_0();
        let mut element = element
            .on_drag_move::<ChatDrag>(cx.listener(|this, event: &DragMoveEvent<ChatDrag>, _, cx| {
                let drag = event.drag(cx).clone();
                this.chat_drag_moved(&drag, event.event.position, cx);
            }))
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" && this.sidebar.read(cx).pointer_dragging() {
                    cx.stop_active_drag(window);
                    this.cancel_chat_drag(cx);
                    cx.stop_propagation();
                }
            }));
        element.extend([gpui::IntoElement::into_any_element(release)]);
        element
    }

    /// A row is dragged to `at`: the sidebar's Pinned rows take it first, then the Chat view (unless the Link
    /// workspace or Routines has the window).
    pub(crate) fn chat_drag_moved(&mut self, drag: &ChatDrag, at: Point<Pixels>, cx: &mut Context<Self>) {
        let took = self.sidebar.update(cx, |sidebar, cx| sidebar.drag_over(drag, at, cx));
        let grid = if took || self.link.is_some() || self.routines_open { None } else { self.grid.read(cx).hit(at, &drag.key) };
        self.sidebar.update(cx, |sidebar, _| sidebar.set_drag_grid(grid.clone()));
        self.grid.update(cx, |g, cx| g.show_drop(grid, cx));
    }

    /// The release: on the Chat view the grid takes the Chat; in the sidebar it pins, reorders or asks for a Link.
    pub(crate) fn chat_dropped(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let landed = self.sidebar.update(cx, |sidebar, cx| sidebar.end_drag(window, cx));
        self.grid.update(cx, |g, cx| g.show_drop(None, cx));
        if let Some((key, target)) = landed {
            self.grid.update(cx, |g, cx| g.drop_chat(&key, &target, cx));
        }
        cx.notify();
    }

    pub(crate) fn cancel_chat_drag(&mut self, cx: &mut Context<Self>) {
        self.sidebar.update(cx, |sidebar, cx| sidebar.cancel_drag(cx));
        self.grid.update(cx, |g, cx| g.show_drop(None, cx));
    }

    /// The top bar's Link Projects: the Link Projects dialog, and the new Link's workspace once it is made.
    pub fn open_link_projects_from_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let this = cx.entity().downgrade();
        let handle = window.window_handle();
        crate::overlays::dialogs::link_projects::open(
            None,
            self.dialog_host.clone(),
            move |_, cx: &mut App| {
                let this = this.clone();
                cx.defer(move |cx| {
                    let _ = handle.update(cx, |_, window, cx| {
                        let _ = this.update(cx, |this, cx| this.open_link(window, cx));
                    });
                });
            },
            None,
            window,
            cx,
        );
    }
}
