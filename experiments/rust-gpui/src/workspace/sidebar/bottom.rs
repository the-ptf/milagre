//! The sidebar's pinned bottom group: the Done row (with how many Chats are Done), the usage block and the footer.
//!
//! The usage block follows `SidebarUsage.tsx` through `logic::usage::report`: the providers with numbers
//! (`visible_providers`), each window's "46% wk" (`format_percent`), the meter filled in the usage tone (`usage_tone`:
//! orange from 80 %, red from 95 %), and the `Alert02` mark after a provider whose last read failed.

use gpui::{FontWeight, Rgba, div, prelude::*, px};

use crate::data::{AccountUsage, UsageSnapshot, UsageStatus};
use crate::logic::usage::report::{UsageTone, format_percent, usage_tone, visible_providers};
use crate::theme::{TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, ProviderLogo};

const DONE_HEIGHT: f32 = 40.0;
const FOOTER_HEIGHT: f32 = 44.0;

/// Done row, usage block and footer, each under a 1px `line` rule.
pub fn bottom_group(done_count: usize, usage: &UsageSnapshot, theme: &Theme) -> impl IntoElement + use<> {
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
        .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child("Done"))
        .child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink3).child(done_count.to_string()));
    let report = usage.report();
    let usage = div()
        .id("sidebar-usage")
        .debug_selector(|| "sidebar-usage".to_string())
        .flex()
        .flex_col()
        .flex_none()
        .py(px(8.0))
        .children(visible_providers(&report).into_iter().map(|row| usage_row(row, theme)));
    let footer = div()
        .id("sidebar-footer")
        .debug_selector(|| "sidebar-footer".to_string())
        .flex()
        .flex_none()
        .items_center()
        .justify_between()
        .h(px(FOOTER_HEIGHT))
        .px(px(20.0))
        .child(Icon::new(IconName::FolderAdd).color(theme.ink3))
        .child(
            div()
                .id("sidebar-settings")
                .debug_selector(|| "sidebar-settings".to_string())
                .cursor_pointer()
                .on_click(|_, window, cx| window.dispatch_action(Box::new(crate::settings::ToggleSettings), cx))
                .child(Icon::new(IconName::Settings01).color(theme.ink3)),
        );
    div().flex().flex_col().flex_none().child(rule()).child(done).child(rule()).child(usage).child(rule()).child(footer)
}

const USAGE_ROW_HEIGHT: f32 = 32.0;
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
