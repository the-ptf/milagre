//! The collapsed sidebar's scope rail (`ScopeRail` in `components/sidebar/ScopeRail.tsx`, the one-list variant of
//! `SidebarNav`): 44px wide, one 32px icon per Chat in the list's order (pinned first), the Project's tile with a
//! corner badge — an orange dot while the Chat waits on the user, a small accent ring while it runs. Resting 300ms
//! on an icon opens a card beside the rail with the Chat and its mark; leaving gives 250ms to cross to it. Clicking
//! an icon opens that Chat.
//!
//! The model ([`items`], [`rail_status`]) is pure; [`popover`] draws the card. The icons themselves are drawn by the
//! sidebar's `uniform_list` so 500 Chats stay cheap; the running badge is a still ring there (a turning one would
//! re-render the whole list every frame, see CONVENTIONS "Adding a view that does not repaint its siblings").

use std::time::Duration;

use gpui::{Anchor, AnyElement, Pixels, SharedString, Window, anchored, deferred, div, point, prelude::*, px};

use super::row::{ChatRow, project_tile, status_mark};
use crate::logic::marks::ChatMark;
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_12, TextStepExt};
use crate::ui::SectionLabel;

/// The collapsed sidebar's width (`SIDEBAR_MOTION.collapsedWidth`).
pub const RAIL_WIDTH: f32 = 44.0;
pub const ITEM_SIZE: f32 = 32.0;
pub const OPEN_DELAY: Duration = Duration::from_millis(300);
pub const CLOSE_GRACE: Duration = Duration::from_millis(250);
const POPOVER_WIDTH: f32 = 240.0;
/// Icons this close to the window's bottom open the card upwards.
const FLIP_ZONE: f32 = 240.0;

/// What an icon's corner shows: a Chat asking or waiting wins over one running.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RailStatus {
    Attention,
    Running,
    Idle,
}

pub fn rail_status(mark: ChatMark) -> RailStatus {
    match mark {
        ChatMark::Question | ChatMark::Waiting => RailStatus::Attention,
        ChatMark::Delegated | ChatMark::Running | ChatMark::Background => RailStatus::Running,
        _ => RailStatus::Idle,
    }
}

/// One icon on the rail.
#[derive(Clone, Debug, PartialEq)]
pub struct RailItem {
    pub key: SharedString,
    /// The Project's name (the card's heading).
    pub name: SharedString,
    pub title: SharedString,
    pub current: bool,
    pub status: RailStatus,
}

/// The icon for one row.
pub fn item(row: &ChatRow, name: SharedString, current: bool) -> RailItem {
    RailItem { key: row.key.clone(), name, title: row.title.clone(), current, status: rail_status(row.mark) }
}

/// The rail's icons, one per row, in the list's order.
pub fn items(rows: &[ChatRow], names: impl Fn(&ChatRow) -> SharedString, selected: Option<usize>) -> Vec<RailItem> {
    rows.iter().enumerate().map(|(ix, row)| item(row, names(row), selected == Some(ix))).collect()
}

/// An icon's 32px button.
pub fn icon(ix: usize, row: &ChatRow, item: &RailItem, window: &mut gpui::Window, cx: &mut gpui::App) -> gpui::Stateful<gpui::Div> {
    let theme = *cx.theme();
    let (hover, current) = (theme.hover, theme.hover2);
    // `active:scale-press` (ScopeRail.tsx): the fill shrinks, the tile stays.
    let press = crate::ui::press::Press::new(("rail-item", ix), window, cx);
    let engaged = press.engaged();
    let face = engaged.then(|| press.face(Some(if item.current { current } else { hover }.into()), crate::theme::RADIUS_CONTROL));
    press
        .wire(div().id(("rail-item", ix)))
        .debug_selector(move || format!("rail-item-{ix}"))
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(ITEM_SIZE))
        .rounded(crate::theme::RADIUS_CONTROL)
        .cursor_pointer()
        .when(item.current && !engaged, |el| el.bg(current))
        .when(!item.current && !engaged, |el| el.hover(move |style| style.bg(hover)))
        .children(face)
        .child(project_tile(row, &theme).size(24.0))
        .when(item.status == RailStatus::Attention, |el| {
            el.child(
                div()
                    .debug_selector(move || format!("rail-attention-{ix}"))
                    .absolute()
                    .top(px(2.0))
                    .right(px(2.0))
                    .size(px(8.0))
                    .rounded_full()
                    .bg(theme.orange)
                    .border_2()
                    .border_color(theme.surface),
            )
        })
        .when(item.status == RailStatus::Running, |el| {
            el.child(
                div()
                    .debug_selector(move || format!("rail-running-{ix}"))
                    .absolute()
                    .top(px(0.0))
                    .right(px(0.0))
                    .rounded_full()
                    .bg(theme.surface)
                    .p(px(1.0))
                    .child(crate::ui::Spinner::new(("rail-spinner", ix)).size(10.0).color(theme.accent)),
            )
        })
}

/// The card beside the rail: the Project's name, then the Chat with its mark.
pub fn popover(
    item: &RailItem,
    row: &ChatRow,
    y: Pixels,
    window: &Window,
    cx: &gpui::App,
    on_hover: impl Fn(bool, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let theme = *cx.theme();
    let flip = y > window.viewport_size().height - px(FLIP_ZONE);
    let (anchor, position) = if flip {
        (Anchor::BottomLeft, point(px(RAIL_WIDTH + 8.0), y + px(16.0)))
    } else {
        (Anchor::TopLeft, point(px(RAIL_WIDTH + 8.0), y - px(16.0)))
    };
    deferred(
        anchored().position(position).anchor(anchor).child(
            div()
                .id("rail-popover")
                .debug_selector(|| "rail-popover".into())
                .occlude()
                .w(px(POPOVER_WIDTH))
                .p(px(8.0))
                .rounded(RADIUS_CARD)
                .bg(theme.surface)
                .shadow(theme.shadow_raised())
                .on_hover(move |hovered, window, cx| on_hover(*hovered, window, cx))
                .child(div().px(px(8.0)).pt(px(4.0)).pb(px(6.0)).truncate().child(SectionLabel::new(item.name.clone()).menu()))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(8.0))
                        .h(px(32.0))
                        .text_step(TEXT_12)
                        .text_color(theme.ink)
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .size(px(16.0))
                                .items_center()
                                .justify_center()
                                .child(status_mark(100_001, row, &theme)),
                        )
                        .child(div().flex_1().min_w_0().truncate().child(item.title.clone())),
                ),
        ),
    )
    .with_priority(1)
    .into_any_element()
}
