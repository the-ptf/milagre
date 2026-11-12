//! A row of the Done list (Victor's reference video): greyed at rest, alive under the pointer.
//!
//! - line 1: the Project mark in grey (a Chat without a Project: the grey bubble), the title in `ink-3`, and at the
//!   right an hourglass with how long the Chat ran ("20:20", "1:02:10") in `ink-4`;
//! - line 2, under the title: the computer, with its laptop, in `ink-4`.
//!
//! Under the pointer the row takes the hover fill, the mark its Project's colour, the title `ink`, and the run's length
//! gives way to Reopen (the undo arrow). Clicking the row opens its Chat; Reopen takes it back to the list (⌘Z undoes
//! it). The swap is a group hover, so it changes no layout and the sidebar does not re-render for it.

use std::ops::Range;

use gpui::{AnyElement, ClickEvent, Context, MouseButton, SharedString, Window, div, prelude::*, px};

use super::Sidebar;
use super::bottom::DONE_ROW;
use super::row::{ChatRow, MarkLook, project_mark_as};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_11, TEXT_13, TextStepExt, Theme, sidebar_step};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize};

/// The row's side inset in the sidebar, its padding, and the gap after the mark (line 2 starts under the title).
const DONE_INSET: f32 = 8.0;
const DONE_PAD_X: f32 = 8.0;
const DONE_MARK_GAP: f32 = 10.0;
const DONE_MARK: f32 = 14.0;
/// Between the hourglass (or the laptop) and its text.
const DONE_META_GAP: f32 = 4.0;

/// The look of one Done row: its pointer state, whether it is the Chat on screen.
struct DoneLook {
    hovered: bool,
    selected: bool,
}

impl Sidebar {
    /// The Done list's rows `range`.
    pub(super) fn render_done_rows(&mut self, range: Range<usize>, _window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let theme = *cx.theme();
        range
            .filter_map(|ix| {
                let row = self.done_rows.get(ix)?.clone();
                let look = DoneLook {
                    hovered: self.done_hover == Some(ix),
                    selected: self.picked.as_ref().is_some_and(|picked| picked.key == row.key),
                };
                Some(self.done_row(ix, &row, look, &theme, cx))
            })
            .collect()
    }

    /// Reopens the Done row at `ix`: back in the list, undoable.
    pub fn reopen_done(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(key) = self.done_rows.get(ix).map(|row| row.key.to_string()) else { return };
        self.reopen(&key, true, cx);
    }

    fn done_row(&self, ix: usize, row: &ChatRow, look: DoneLook, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let group: SharedString = format!("done-row-{ix}").into();
        let lit = look.hovered;
        let hover = theme.hover2;
        let (title_ink, rest_ink) = (theme.ink, theme.ink3);
        let mark = project_mark_as(row, theme, if lit { MarkLook::Colour } else { MarkLook::GreyUntilHover(group.clone()) });

        let title = div()
            .min_w_0()
            .flex_1()
            .truncate()
            .text_step(sidebar_step(TEXT_13))
            .text_color(if lit { title_ink } else { rest_ink })
            .group_hover(group.clone(), move |style| style.text_color(title_ink))
            .child(row.title.clone());

        // The run's length, and Reopen in its place under the pointer.
        let ran = row.ran.clone().map(|ran| {
            div()
                .debug_selector(move || format!("done-ran-{ix}"))
                .flex()
                .flex_none()
                .items_center()
                .gap(px(DONE_META_GAP))
                .text_step(sidebar_step(TEXT_11))
                .text_color(theme.ink4)
                .when(lit, |el| el.invisible())
                .group_hover(group.clone(), |style| style.invisible())
                .child(Icon::new(IconName::Hourglass).size(IconSize::S12).color(theme.ink4))
                .child(ran)
        });
        let reopen = div()
            .debug_selector(move || format!("done-reopen-{ix}"))
            .absolute()
            .right(px(0.0))
            .top(px(-2.0))
            .when(!lit, |el| el.invisible().group_hover(group.clone(), |style| style.visible()))
            .child(IconButton::new(("done-reopen", ix), IconName::Undo02).size(IconButtonSize::S20).on_click(cx.listener(
                move |this, _: &ClickEvent, _, cx| {
                    cx.stop_propagation();
                    this.reopen_done(ix, cx);
                },
            )));
        let line1 = div()
            .flex()
            .w_full()
            .items_center()
            .gap(px(DONE_MARK_GAP))
            .h(px(TEXT_13.line_height))
            .child(mark)
            .child(title)
            .child(div().relative().flex().flex_none().items_center().children(ran).child(reopen));
        let line2 = row.computer.clone().map(|name| {
            let ink = if row.offline.is_some() { theme.orange_ink } else { theme.ink4 };
            div()
                .flex()
                .w_full()
                .items_center()
                .gap(px(DONE_META_GAP))
                .pl(px(DONE_MARK + DONE_MARK_GAP))
                .h(px(TEXT_11.line_height))
                .text_step(sidebar_step(TEXT_11))
                .text_color(ink)
                .child(Icon::new(IconName::Laptop).size(IconSize::S12).color(ink))
                .child(div().debug_selector(move || format!("done-computer-{ix}")).min_w_0().truncate().child(name))
        });

        div()
            .id(("done-row", ix))
            .debug_selector(move || format!("done-row-{ix}"))
            .group(group.clone())
            .flex()
            .flex_col()
            .justify_center()
            .h(px(DONE_ROW))
            // A definite width: the list measures its items, and the lines' right edges hang from this one.
            .w(px(super::SIDEBAR_WIDTH - 2.0 * DONE_INSET))
            .mx(px(DONE_INSET))
            .px(px(DONE_PAD_X))
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .when(look.selected || lit, |el| el.bg(hover))
            .when(!look.selected, |el| el.hover(move |style| style.bg(hover)))
            .on_click(cx.listener(move |this, _, window, cx| {
                window.focus(&this.focus, cx);
                this.select_done(ix, cx);
            }))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, event: &gpui::MouseDownEvent, window, cx| {
                    cx.stop_propagation();
                    this.select_done(ix, cx);
                    let key = this.done_rows[ix].key.to_string();
                    this.open_menu_key(&key, event.position, window, cx);
                }),
            )
            .child(line1)
            .children(line2)
            .into_any_element()
    }
}
