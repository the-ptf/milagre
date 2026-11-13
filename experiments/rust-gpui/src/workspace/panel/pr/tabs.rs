//! The Summary / Files switch and the checks bar under the header (`Tabs` in `PullRequestPanel.tsx`).

use gpui::{AnyElement, Context, FontWeight, div, prelude::*, px, relative};

use super::model::{ChecksTone, PullRequestDetail, checks_progress};
use super::{PrTab, PrView};
use crate::theme::{ActiveTheme, TEXT_12, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, Segmented, SegmentedOption, SpinnerRing, motion};

/// The checks bar's segments in order, with their colours (`SEGMENTS`).
fn segment_color(theme: &Theme, key: &str) -> gpui::Hsla {
    use gpui::Hsla;
    match key {
        "passed" => theme.green.into(),
        "skipped" => Hsla::from(theme.ink3).opacity(0.4),
        "failed" => theme.red.into(),
        _ => Hsla::from(theme.orange).opacity(0.4),
    }
}

impl PrView {
    pub(super) fn tabs(&self, pr: &PullRequestDetail, tab: PrTab, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let progress = checks_progress(&pr.checks);
        let view = cx.entity();
        let switch = Segmented::new(
            "pr-tab",
            Some(if tab == PrTab::Summary { "summary" } else { "files" }),
            [SegmentedOption::new("summary", "Summary"), SegmentedOption::new("files", "Files").count(pr.changed_files)],
        )
        .on_change(move |value, _window, cx| {
            let next = if value.as_ref() == "files" { PrTab::Files } else { PrTab::Summary };
            view.update(cx, |this, cx| this.set_tab(next, cx));
        });
        let tone_ink = match progress.tone {
            ChecksTone::Fail => theme.red_ink,
            ChecksTone::Pass => theme.green_ink,
            _ => theme.ink2,
        };
        let status = (!progress.label.is_empty()).then(|| {
            let glyph: AnyElement = match progress.tone {
                ChecksTone::Running => {
                    let ring = SpinnerRing::new().size(13.0).color(theme.orange);
                    if motion() { ring.animated("pr-checks-ring").into_any_element() } else { ring.into_any_element() }
                }
                tone => Icon::new(if tone == ChecksTone::Fail { IconName::CancelCircle } else { IconName::CheckmarkCircle02 })
                    .size(IconSize::S14)
                    .color(tone_ink)
                    .into_any_element(),
            };
            div()
                .debug_selector(|| "pr-checks-status".to_string())
                .flex()
                .items_center()
                .gap(px(6.0))
                .pt(px(4.0))
                .text_step(TEXT_12)
                .whitespace_nowrap()
                .text_color(tone_ink)
                .child(glyph)
                .child(progress.label.clone())
        });
        let bar = (progress.total > 0).then(|| {
            let segments =
                [("passed", progress.passed), ("skipped", progress.skipped), ("failed", progress.failed), ("running", progress.running)];
            div().debug_selector(|| "pr-checks-bar".to_string()).flex().h(px(4.0)).gap(px(2.0)).children(
                segments.into_iter().filter(|(_, n)| *n > 0).map(|(key, n)| {
                    div()
                        .debug_selector(move || format!("pr-checks-segment-{key}"))
                        .h_full()
                        .min_w_0()
                        .rounded_full()
                        .flex_basis(relative(n as f32 / progress.total as f32))
                        .bg(segment_color(&theme, key))
                }),
            )
        });
        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .px(px(12.0))
            .pt(px(12.0))
            .pb(px(4.0))
            .font_weight(FontWeight::NORMAL)
            .child(switch)
            .children(status)
            .children(bar)
            .into_any_element()
    }
}
