//! Small pieces the Devices and Project pages share: the route pill, notes under a row, a group footer, an icon chip.

use gpui::{App, Div, Hsla, ParentElement, SharedString, Styled, div, prelude::*, px};

use super::logic::RouteState;
use crate::theme::{ActiveTheme, RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt};
use crate::ui::{Icon, IconName, IconSize};

/// `RoutePill`: "In use" on a green tint, "Ready" and "Not available" on `hover`.
pub fn route_pill(state: RouteState, cx: &App) -> Div {
    let theme = *cx.theme();
    let (fill, ink) = if state == RouteState::InUse { (theme.green_tint, theme.green_ink) } else { (theme.hover, theme.ink3) };
    div()
        .debug_selector(|| "connection-state".into())
        .rounded_full()
        .px(px(8.0))
        .py(px(2.0))
        .bg(fill)
        .text_color(ink)
        .text_step(TEXT_11)
        .child(state.label())
}

/// A failure under a row, `red-ink` 12px (`px-4 pb-3` in the TypeScript).
pub fn row_error(message: impl Into<SharedString>, cx: &App) -> Div {
    let theme = *cx.theme();
    div().px(px(16.0)).pb(px(12.0)).text_step(TEXT_12).text_color(theme.red_ink).child(message.into())
}

/// A note filling a card row, `ink-3` 12px (`px-4 py-3`).
pub fn card_note(message: impl Into<SharedString>, cx: &App) -> Div {
    let theme = *cx.theme();
    div().px(px(16.0)).py(px(12.0)).text_step(TEXT_12).text_color(theme.ink3).child(message.into())
}

/// A `Group`'s footer: 12px `ink-3`, pulled up under the card the group just drew (its 24px bottom margin).
pub fn group_footer(message: impl Into<SharedString>, cx: &App) -> Div {
    let theme = *cx.theme();
    div().mt(px(-16.0)).mb(px(24.0)).px(px(4.0)).text_step(TEXT_12).text_color(theme.ink3).child(message.into())
}

/// A 28px rounded chip holding a 14px icon (`size-7 rounded-control bg-hover text-ink-2`).
pub fn icon_chip(icon: IconName, cx: &App) -> Div {
    let theme = *cx.theme();
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(28.0))
        .rounded(RADIUS_CONTROL)
        .bg(theme.hover)
        .child(Icon::new(icon).size(IconSize::S14).color(theme.ink2))
}

/// `theme.hover` at half strength (`hover:bg-hover/50`).
pub fn hover_half_color(theme: &crate::theme::Theme) -> Hsla {
    Hsla::from(theme.hover).opacity(0.5)
}

/// The same, reading the theme from the app.
pub fn hover_half(cx: &App) -> Hsla {
    hover_half_color(cx.theme())
}
