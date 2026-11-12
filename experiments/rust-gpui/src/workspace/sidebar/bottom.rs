//! The sidebar's pinned bottom group: the Done row (with how many Chats are Done), the usage block and the footer.
//!
//! The usage block's rows and card are `usage.rs`.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{AnyElement, App, Bounds, FontWeight, Pixels, Window, canvas, div, prelude::*, px};

use crate::theme::{TEXT_13, TextStepExt, Theme, sidebar_step};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize};

/// The Done footer (design `gpui-sidebar-v-a`: 36px, 16px in, no rule above it).
const DONE_HEIGHT: f32 = 36.0;
const DONE_PAD: f32 = 16.0;
/// A Done row (`h-[30px]`), and the list's most height (`max-h-[186px]`).
pub const DONE_ROW: f32 = 30.0;
pub const DONE_LIST_HEIGHT: f32 = 186.0;

/// The Done section: the footer row with its count, and the list under it while it is open.
pub struct DoneSection {
    pub count: usize,
    pub open: bool,
    pub on_toggle: FooterHandler,
    pub list: Option<AnyElement>,
}
const FOOTER_HEIGHT: f32 = 44.0;

/// A footer button's handler.
pub type FooterHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the footer needs from the sidebar: the Filters button's state and the handlers of its three buttons.
pub struct Footer {
    /// The Filters menu is open: its button stays pressed.
    pub filters_open: bool,
    /// A dot on the Filters button: orange while a computer is away, accent while a filter is on.
    pub filters_dot: Option<FiltersDot>,
    pub on_add_project: FooterHandler,
    pub on_filters: FooterHandler,
    /// Where the Filters button is painted, for the menu's backdrop.
    pub button_bounds: Rc<Cell<Bounds<Pixels>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FiltersDot {
    Away,
    Filtering,
}

/// The footer's left edge for the first button, and the gap between buttons (`mx-2`, `gap-1`).
pub const FOOTER_PAD: f32 = 12.0;
pub const FOOTER_BUTTON: f32 = 32.0;
pub const FOOTER_GAP: f32 = 4.0;
/// Where the Filters button's left edge sits.
pub const FILTERS_LEFT: f32 = FOOTER_PAD + FOOTER_BUTTON + FOOTER_GAP;
/// The footer's height: the menu opens just above it.
pub const FOOTER_BAR: f32 = FOOTER_HEIGHT;

/// The Done row, then the toast's slot, the usage block and the footer, with no rule between them. The toast hangs
/// from a zero-height slot between Done and the usage block, so it floats over the usage meters.
pub fn bottom_group(
    done: DoneSection,
    usage_rows: Vec<AnyElement>,
    toast: AnyElement,
    footer: Footer,
    theme: &Theme,
) -> impl IntoElement + use<> {
    let hover = theme.hover;
    let DoneSection { count: done_count, open: done_open, on_toggle, list: done_list } = done;
    let done = div()
        .id("sidebar-done")
        .debug_selector(|| "sidebar-done".to_string())
        .flex()
        .flex_none()
        .items_center()
        .h(px(DONE_HEIGHT))
        .px(px(DONE_PAD))
        .gap(px(8.0))
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .on_click(move |_, window, cx| on_toggle(window, cx))
        .child(Icon::new(if done_open { IconName::ArrowDown01 } else { IconName::ArrowRight01 }).size(IconSize::S14).color(theme.ink3))
        .child(div().text_step(sidebar_step(TEXT_13)).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Done"))
        .child(div().text_step(sidebar_step(TEXT_13)).text_color(theme.ink4).child(done_count.to_string()));
    // Settings › Appearance › Sidebar usage "Compact": a mark and its fullest window per provider, in a row.
    let compact = crate::theme::live::compact_usage();
    let usage = div()
        .id("sidebar-usage")
        .debug_selector(|| "sidebar-usage".to_string())
        .flex()
        .flex_col()
        .flex_none()
        .gap(px(2.0))
        .px(px(4.0))
        .py(px(8.0))
        .when(compact, |el| el.flex_row().items_center().justify_center().gap(px(2.0)))
        .children(usage_rows);
    div().flex().flex_col().flex_none().child(done).children(done_list).child(toast).child(usage).child(footer_bar(footer, theme))
}

/// Add Project and Filters at the left, Settings at the right.
fn footer_bar(footer: Footer, theme: &Theme) -> impl IntoElement + use<> {
    let Footer { filters_open, filters_dot, on_add_project, on_filters, button_bounds } = footer;
    let button = |id: &'static str, icon: IconName| IconButton::new(id, icon).size(IconButtonSize::S32).glyph(IconSize::S16);
    let dot = filters_dot.map(|dot| {
        let color = if dot == FiltersDot::Away { theme.orange } else { theme.accent };
        div().debug_selector(|| "filters-dot".into()).absolute().top(px(4.0)).right(px(4.0)).size(px(6.0)).rounded_full().bg(color)
    });
    div()
        .id("sidebar-footer")
        .debug_selector(|| "sidebar-footer".to_string())
        .flex()
        .flex_none()
        .items_center()
        .justify_between()
        .h(px(FOOTER_HEIGHT))
        .px(px(FOOTER_PAD))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(FOOTER_GAP))
                .child(button("add-project", IconName::FolderAdd).on_click(move |_, window, cx| on_add_project(window, cx)))
                .child(
                    div()
                        .relative()
                        .child(canvas(move |bounds, _, _| button_bounds.set(bounds), |_, _, _, _| ()).absolute().size_full())
                        .child(
                            button("filters", IconName::Filter).pressed(filters_open).on_click(move |_, window, cx| on_filters(window, cx)),
                        )
                        .children(dot),
                ),
        )
        .child(
            div().id("sidebar-settings").debug_selector(|| "sidebar-settings".to_string()).child(
                button("settings", IconName::Settings01)
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(crate::settings::ToggleSettings), cx)),
            ),
        )
}
