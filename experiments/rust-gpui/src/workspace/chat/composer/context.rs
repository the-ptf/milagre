//! The context ring and its card (`ContextRing.tsx`, `ContextBar.tsx`): in the bottom row a 16x4 bar (`line-strong`,
//! filled with the current colour) and the used percentage, 28 high, `ink-2`, or `orange-ink` once a Claude Chat
//! passes the Compact threshold; `hover-2` while its card is open. The card (264 wide, `rounded-window`, `shadow-raised`)
//! opens upward on click and says "120k of 200k tokens", draws the gradient bar with both threshold markers (Compact
//! at 70%, automatic at 85%, `CONTEXT_DEFAULTS`) and, on Claude, a Compact now button that sends `/compact`.
//!
//! Not built: opening on hover or focus (a click opens it) and the thresholds from Settings (the defaults are used).

use gpui::{
    AnyElement, FontWeight, IntoElement, ParentElement, Rgba, Styled, div, linear_color_stop, linear_gradient, prelude::*, px, rgb,
};

use super::Composer;
use super::pick_list::popup;
use crate::data::Provider;
use crate::logic::usage::report::context_summary;
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, RADIUS_WINDOW, TEXT_11, TEXT_12, TextStepExt, Theme};

/// `CONTEXT_DEFAULTS`: the percentages where Compact appears and where Milagre compacts by itself.
const BUTTON_THRESHOLD: f32 = 70.0;
const AUTO_THRESHOLD: f32 = 85.0;
/// `CONTEXT_GRADIENT_COLORS` and `CONTEXT_GRADIENT_STOPS` (`context-settings.mjs`): the bar's fixed gradient.
const GRADIENT: [(u32, f32); 4] = [(0x78b1b1, 0.0), (0xe0c271, 0.55), (0xf1933e, 0.78), (0xcf4e3e, 1.0)];
const CARD_WIDTH: f32 = 264.0;
const CARD_PAD_X: f32 = 16.0;
const BAR_WIDTH: f32 = CARD_WIDTH - 2.0 * CARD_PAD_X;
const MARKER: f32 = 16.0;
/// The ring's own bar in the bottom row.
const RING_BAR: (f32, f32) = (16.0, 4.0);

impl Composer {
    /// The used and total tokens of the Chat's context window.
    pub fn set_context(&mut self, used: f64, size: f64, cx: &mut gpui::Context<Self>) {
        self.bar.context = Some((used, size));
        cx.notify();
    }

    pub(super) fn context_slot(&self, theme: &Theme, cx: &mut gpui::Context<Self>) -> AnyElement {
        let slot = div().debug_selector(|| "composer-context-slot".into()).flex().flex_none().items_center();
        let Some((used, size)) = self.bar.context else { return slot.into_any_element() };
        let summary = context_summary(used, size);
        let percent = summary.percent;
        let claude = self.bar.provider == Provider::Claude;
        let attention = claude && percent as f32 >= BUTTON_THRESHOLD;
        let tone = if attention { theme.orange_ink } else { theme.ink2 };
        let (hover2, line_strong) = (theme.hover2, theme.line_strong);
        let composer = cx.entity();
        let compact_blocked = self.bar.compacting || self.bar.blocked;
        let card_composer = composer.clone();
        slot.child(
            popup(&composer, "composer-context", self.bar.open == Some("composer-context"))
                .trigger(move |open| {
                    div()
                        .id("composer-context-ring")
                        .debug_selector(|| "composer-context-ring".into())
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .gap_1()
                        .h(CONTROL_SM)
                        .px(px(8.0))
                        .rounded(RADIUS_CONTROL)
                        .text_step(TEXT_12)
                        .text_color(tone)
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover2))
                        .when(open, |el| el.bg(hover2))
                        .child(
                            div()
                                .w(px(RING_BAR.0))
                                .h(px(RING_BAR.1))
                                .rounded_full()
                                .overflow_hidden()
                                .bg(line_strong)
                                .child(div().h_full().w(px(RING_BAR.0 * percent as f32 / 100.0)).bg(tone)),
                        )
                        .child(format!("{percent}%"))
                        .into_any_element()
                })
                .content(move |dismiss, _, cx| {
                    let theme = *cx.theme();
                    let composer = card_composer.clone();
                    let dismiss = dismiss.clone();
                    card(&theme, &summary.tokens, percent, claude, compact_blocked, move |window, cx| {
                        composer.update(cx, |c, cx| c.compact(cx));
                        dismiss.call(window, cx);
                    })
                }),
        )
        .into_any_element()
    }

    /// Compact now: asks the host to send `/compact`.
    pub fn compact(&mut self, cx: &mut gpui::Context<Self>) {
        cx.emit(super::ComposerEvent::Compact);
    }
}

fn card(
    theme: &Theme,
    tokens: &str,
    percent: i64,
    claude: bool,
    blocked: bool,
    compact: impl Fn(&mut gpui::Window, &mut gpui::App) + 'static,
) -> AnyElement {
    div()
        .debug_selector(|| "context-card".into())
        .flex()
        .flex_col()
        .gap_2()
        .w(px(CARD_WIDTH))
        .px(px(CARD_PAD_X))
        .py(px(12.0))
        .rounded(RADIUS_WINDOW)
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .text_color(theme.ink)
        .child(div().text_step(TEXT_12).text_color(theme.ink2).child(tokens.to_string()))
        .child(bar(theme, percent))
        .when(claude, |el| {
            el.child(
                div()
                    .id("context-compact")
                    .debug_selector(|| "context-compact".into())
                    .flex()
                    .items_center()
                    .justify_center()
                    .w_full()
                    .h(px(32.0))
                    .px(px(10.0))
                    .rounded(RADIUS_CONTROL)
                    .bg(Rgba { a: 0.15, ..theme.orange })
                    .text_step(TEXT_12)
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.orange_ink)
                    .when(blocked, |el| el.opacity(0.4).cursor_not_allowed())
                    .when(!blocked, |el| el.cursor_pointer().on_click(move |_, window, cx| compact(window, cx)))
                    .child("Compact now"),
            )
        })
        .into_any_element()
}

/// `ContextBar`: the gradient track filled to `percent`, with the Compact and automatic thresholds above it.
fn bar(theme: &Theme, percent: i64) -> impl IntoElement {
    let fill = BAR_WIDTH * (percent as f32).clamp(0.0, 100.0) / 100.0;
    let segments = GRADIENT.windows(2).map(|pair| {
        let ((from, at), (to, until)) = (pair[0], pair[1]);
        div().absolute().top_0().bottom_0().left(px(BAR_WIDTH * at)).w(px(BAR_WIDTH * (until - at))).bg(linear_gradient(
            90.0,
            linear_color_stop(rgb(from), 0.0),
            linear_color_stop(rgb(to), 1.0),
        ))
    });
    let marker = |at: f32, color: Rgba, label_color: Rgba| {
        div()
            .absolute()
            .top_0()
            .left(px(BAR_WIDTH * at / 100.0 - 16.0))
            .w(px(32.0))
            .flex()
            .flex_col()
            .items_center()
            .child(div().text_step(TEXT_11).font_weight(FontWeight::MEDIUM).text_color(label_color).child(format!("{at:.0}%")))
            .child(div().mt(px(6.0)).size(px(MARKER)).rounded_full().border(px(2.5)).border_color(color).bg(theme.surface))
    };
    div()
        .debug_selector(|| "context-bar".into())
        .relative()
        .w_full()
        .h(px(48.0))
        .child(
            div().absolute().left_0().right_0().top(px(28.0)).h(px(6.0)).rounded_full().overflow_hidden().bg(theme.line_strong).child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .w(px(fill))
                    .overflow_hidden()
                    .child(div().absolute().top_0().bottom_0().left_0().w(px(BAR_WIDTH)).children(segments)),
            ),
        )
        .child(marker(BUTTON_THRESHOLD, theme.orange, theme.orange_ink))
        .child(marker(AUTO_THRESHOLD, theme.ink, theme.ink))
}
