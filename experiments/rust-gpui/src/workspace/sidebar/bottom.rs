//! The sidebar's pinned bottom group: the Done row (with how many Chats are Done), the usage block and the footer.
//!
//! The usage block follows `SidebarUsage.tsx` through `logic::usage::report`: the providers with numbers
//! (`visible_providers`), each window's "46% wk" (`format_percent`), the meter filled in the usage tone (`usage_tone`:
//! orange from 80 %, red from 95 %), and the `Alert02` mark after a provider whose last read failed.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{AnyElement, App, Bounds, FontWeight, Pixels, Rgba, Window, canvas, div, prelude::*, px};

use crate::data::{AccountUsage, UsageSnapshot, UsageStatus};
use crate::logic::usage::report::{UsageTone, format_percent, usage_tone, visible_providers};
use crate::theme::{TEXT_12, TEXT_13, TextStepExt, Theme, sidebar_step};
use crate::ui::{Icon, IconButton, IconButtonSize, IconName, IconSize, ProviderLogo};

const DONE_HEIGHT: f32 = 40.0;
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

/// The Done row, then the toast's slot, the usage block and the footer, each under a 1px `line` rule. The toast hangs
/// from a zero-height slot between Done and the usage block, so it floats over the usage meters.
pub fn bottom_group(
    done_count: usize,
    usage: &UsageSnapshot,
    toast: AnyElement,
    footer: Footer,
    theme: &Theme,
) -> impl IntoElement + use<> {
    let rule = || div().flex_none().h(px(1.0)).w_full().bg(theme.line);
    let hover = theme.hover;
    let done = div()
        .id("sidebar-done")
        .debug_selector(|| "sidebar-done".to_string())
        .flex()
        .flex_none()
        .items_center()
        .h(px(DONE_HEIGHT))
        .px(px(20.0))
        .gap(px(8.0))
        .cursor_pointer()
        .hover(move |style| style.bg(hover))
        .child(Icon::new(IconName::ArrowRight01).color(theme.ink3))
        .child(div().text_step(sidebar_step(TEXT_13)).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Done"))
        .child(div().text_step(sidebar_step(TEXT_13)).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child(done_count.to_string()));
    let report = usage.report();
    // Settings › Appearance › Sidebar usage "Compact": a mark and its fullest window per provider, in a row.
    let compact = crate::theme::live::compact_usage();
    let usage = div()
        .id("sidebar-usage")
        .debug_selector(|| "sidebar-usage".to_string())
        .flex()
        .flex_col()
        .flex_none()
        .py(px(8.0))
        .when(compact, |el| el.flex_row().items_center().justify_center().gap(px(2.0)))
        .children(
            visible_providers(&report)
                .into_iter()
                .map(|row| if compact { usage_mark(row, theme).into_any_element() } else { usage_row(row, theme).into_any_element() }),
        );
    div()
        .flex()
        .flex_col()
        .flex_none()
        .child(rule())
        .child(done)
        .child(toast)
        .child(rule())
        .child(usage)
        .child(rule())
        .child(footer_bar(footer, theme))
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

const USAGE_ROW_HEIGHT: f32 = 32.0;

/// The compact layout's cell (`sidebar-usage-row` in `data-usage-compact`): 32 wide, the provider mark at 14 and its
/// fullest window as a 16 by 2 bar `bottom-1`, centred.
fn usage_mark(row: &AccountUsage, theme: &Theme) -> impl IntoElement + use<> {
    let name = row.provider.name();
    let peak = row.windows.iter().map(|w| w.used_percent).fold(0.0_f64, f64::max);
    let fill = if peak <= 0.0 { 0.0 } else { (16.0 * peak as f32 / 100.0).max(2.0) };
    let fill_color = meter_fill(peak, theme);
    div()
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(USAGE_ROW_HEIGHT))
        .debug_selector(move || format!("usage-mark-{name}"))
        .child(ProviderLogo::new(row.provider).size(14.0))
        .when(!row.windows.is_empty(), |el| {
            el.child(
                div()
                    .absolute()
                    .bottom(px(4.0))
                    .left(px(8.0))
                    .w(px(16.0))
                    .h(px(2.0))
                    .rounded(px(1.0))
                    .bg(theme.line)
                    .child(div().w(px(fill)).h_full().rounded(px(1.0)).bg(fill_color)),
            )
        })
}
const METER_WIDTH: f32 = 68.0;

/// One provider row: logo at x 12, name at x 40, then one or two meters ending at x 276.
fn usage_row(row: &AccountUsage, theme: &Theme) -> impl IntoElement + use<> {
    let single = row.windows.len() == 1;
    let mut el = div()
        .relative()
        .flex_none()
        .w(px(288.0))
        .h(px(USAGE_ROW_HEIGHT))
        .debug_selector({
            let name = row.provider.name();
            move || format!("usage-row-{name}")
        })
        .child(div().absolute().left(px(12.0)).top(px(8.0)).child(ProviderLogo::new(row.provider)))
        .child(
            div()
                .absolute()
                .left(px(40.0))
                .top(px(8.0))
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink2)
                .child(row.provider.name()),
        );
    if row.status == UsageStatus::Error {
        // The desktop's "Couldn't read usage" mark: Alert02 at 12 in `red-ink` (SidebarUsage.tsx).
        el = el.child(
            div().absolute().left(px(86.0)).top(px(10.0)).child(Icon::new(IconName::Alert02).size(IconSize::S12).color(theme.red_ink)),
        );
    }
    for (i, w) in row.windows.iter().enumerate() {
        let (x, width) = if single { (132.0, 144.0) } else { (132.0 + 76.0 * i as f32, METER_WIDTH) };
        let fill = if w.used_percent <= 0.0 { 0.0 } else { (width * w.used_percent as f32 / 100.0).max(2.0) };
        let label = format!("{} {}", format_percent(w.used_percent), w.short_label);
        let fill_color = meter_fill(w.used_percent, theme);
        let id = format!("usage-meter-{}-{i}", row.provider.name());
        let track_id = format!("usage-track-{}-{i}", row.provider.name());
        let fill_id = format!("usage-fill-{}-{i}", row.provider.name());
        el = el
            .child(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(3.0))
                    .w(px(width))
                    .debug_selector(move || id.clone())
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.ink3)
                    .text_right()
                    .child(label),
            )
            .child(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(23.0))
                    .w(px(width))
                    .h(px(2.0))
                    .rounded(px(1.0))
                    .bg(theme.line)
                    .debug_selector(move || track_id.clone()),
            );
        if fill > 0.0 {
            el = el.child(
                div()
                    .absolute()
                    .left(px(x))
                    .top(px(23.0))
                    .w(px(fill))
                    .h(px(2.0))
                    .rounded(px(1.0))
                    .bg(fill_color)
                    .debug_selector(move || fill_id.clone()),
            );
        }
    }
    el
}

/// A meter's fill in its usage tone: `ink-3` (the spike's normal fill), orange from 80 %, red from 95 %.
fn meter_fill(used_percent: f64, theme: &Theme) -> Rgba {
    match usage_tone(used_percent) {
        UsageTone::Normal => theme.ink3,
        UsageTone::Warning => theme.orange,
        UsageTone::Critical => theme.red,
    }
}
