//! One two-line Chat row (48px), as a view of its own.
//!
//! The sidebar's list mounts each visible row as a cached view (`AnyView::cached` at the row's fixed
//! size). So when the sidebar re-renders (a logo finished loading, a row's spinner turned, the selection
//! moved), GPUI reuses every row whose view did not change instead of building it again; only a row that
//! called `cx.notify()` renders. Rows tell the sidebar about clicks with [`RowEvent`], not by updating it
//! from inside their own listener (that would borrow the row view twice when the sidebar updates it back).

use std::cell::Cell;
use std::rc::Rc;

use gpui::{ClickEvent, Context, EventEmitter, FontWeight, Rgba, Window, div, prelude::*, px};

use crate::data::fixture::{ChatRow, ChatStatus};
use crate::theme::{ActiveTheme, RADIUS_CONTROL, ROW_TWO_LINE, TEXT_12, TEXT_13, TextStepExt, Theme, hex};
use crate::ui::{Icon, IconName, IconSize, ProjectAvatar, SpinnerRing};

/// Horizontal inset of each row inside the sidebar.
pub const ROW_INSET: f32 = 8.0;
const TILE_SIZE: f32 = 24.0;
/// The trailing status slot of a row.
const MARK_SLOT: f32 = 16.0;

pub enum RowEvent {
    Clicked,
}

pub struct ChatRowView {
    ix: usize,
    row: ChatRow,
    selected: bool,
    /// Shared with the sidebar: every `render` of any row, to check what a frame rebuilt.
    renders: Rc<Cell<usize>>,
}

impl EventEmitter<RowEvent> for ChatRowView {}

impl ChatRowView {
    pub fn new(ix: usize, row: ChatRow, selected: bool, renders: Rc<Cell<usize>>) -> Self {
        Self { ix, row, selected, renders }
    }

    pub fn set_selected(&mut self, selected: bool, cx: &mut Context<Self>) {
        if self.selected != selected {
            self.selected = selected;
            cx.notify();
        }
    }
}

impl Render for ChatRowView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders.set(self.renders.get() + 1);
        let theme = *cx.theme();
        let (ix, row, selected) = (self.ix, &self.row, self.selected);
        let hover = theme.hover;
        // Outer box carries the 8px side inset so the rounded fill stops short of the edges.
        div().w_full().h(ROW_TWO_LINE).px(px(ROW_INSET)).child(
            div()
                .id(("chat-row", ix))
                .debug_selector(move || format!("chat-row-{ix}"))
                .h(ROW_TWO_LINE)
                .px_2()
                .flex()
                .items_center()
                .gap_2()
                .rounded(RADIUS_CONTROL)
                .cursor_pointer()
                .when(selected, |el| el.bg(theme.hover2))
                .when(!selected, |el| el.hover(move |style| style.bg(hover)))
                .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(RowEvent::Clicked)))
                .child(project_tile(row, &theme))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_step(TEXT_13)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink)
                                .truncate()
                                .child(row.title.clone()),
                        )
                        .child(
                            div()
                                .text_step(TEXT_12)
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.ink3)
                                .truncate()
                                .child(row.detail.clone()),
                        ),
                )
                .child(
                    div().flex().flex_none().items_center().justify_center().w(px(MARK_SLOT)).child(status_mark(ix, row.status, &theme)),
                ),
        )
    }
}

/// A project tile: the project's identity colour, or `field`, with its initial at 600. (The spike's look;
/// DESIGN.md's default tile is an ink fill, which `ProjectAvatar` draws without `.colors`.)
fn project_tile(row: &ChatRow, theme: &Theme) -> ProjectAvatar {
    let (fill, ink) = match row.tile {
        Some(color) => (color, hex("#ffffff")),
        None => (theme.field, theme.ink2),
    };
    ProjectAvatar::new(&row.initial.to_string()).size(TILE_SIZE).colors(fill, ink)
}

pub fn dot_mark(color: Rgba) -> gpui::Div {
    div().flex_none().size(px(8.0)).rounded_full().bg(color)
}

/// The trailing status of a row, as the desktop's `ChatMarkDot` draws it: a spinner ring while running,
/// orange glyphs when the Chat needs you (a shield for an approval, a bubble for a question), a red dot
/// when the last turn failed, the accent dot when unread.
fn status_mark(ix: usize, status: ChatStatus, theme: &Theme) -> gpui::AnyElement {
    match status {
        ChatStatus::None => div().into_any_element(),
        ChatStatus::Running => {
            let ring = SpinnerRing::new();
            // The spin re-renders this row's view (cheap) and its ancestors, never the other rows.
            if crate::ui::motion() { ring.animated(("chat-row-spinner", ix)).into_any_element() } else { ring.into_any_element() }
        }
        ChatStatus::NeedsApproval => Icon::new(IconName::ShieldAlert).size(IconSize::S14).color(theme.orange).into_any_element(),
        ChatStatus::Question => Icon::new(IconName::BubbleChatQuestion).size(IconSize::S14).color(theme.orange).into_any_element(),
        ChatStatus::Failed => dot_mark(theme.red).into_any_element(),
        ChatStatus::Unread => dot_mark(theme.accent).into_any_element(),
    }
}
