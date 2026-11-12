//! The side panel's loading placeholders, in the desktop's `Skeleton` bars (`primitives/Skeleton.tsx`, `ui::Skeleton`:
//! `hover-2` for a main line, `hover` for the one under it, 4px corners, a pulse unless motion is off), laid out as
//! the tab they stand in for, so nothing jumps when the read answers:
//!
//! - [`pr`]: the PR panel's header (repository and number, the title, the state pill with author and age, the
//!   branches), the checks bar and Summary / Files switch, then check rows and file rows.
//! - [`designs`]: the Designs board's frames side by side, each with its title row.
//! - [`page`]: the Artifact page, white paper with a heading and lines of text.
//!
//! Only the first bars pulse (CONVENTIONS.md: an animation stays out of big views); the rest are static.

use gpui::{AnyElement, IntoElement, ParentElement, Styled, div, prelude::*, px};

use crate::theme::Theme;
use crate::ui::Skeleton;

fn bar(width: f32, height: f32) -> Skeleton {
    Skeleton::new().h(px(height)).w(px(width))
}

/// The PR panel while its PR is being read.
pub fn pr(theme: &Theme) -> AnyElement {
    let row = |i: usize, glyph: f32| {
        div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .h(px(28.0))
            .px(px(4.0))
            .child(bar(glyph, glyph))
            .child(Skeleton::new().h(px(12.0)).w(px(110.0 + (i * 37 % 120) as f32)))
            .child(div().flex_1())
            .child(Skeleton::new().secondary().h(px(12.0)).w(px(36.0)))
    };
    let section = |title: f32| div().pt(px(12.0)).pb(px(4.0)).child(bar(title, 12.0));
    div()
        .debug_selector(|| "pr-skeleton".to_string())
        .flex()
        .flex_col()
        .w_full()
        .text_color(theme.ink)
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .p(px(12.0))
                .child(Skeleton::new().pulse("pr-sk-repo").h(px(12.0)).w(px(140.0)))
                .child(Skeleton::new().pulse("pr-sk-title").h(px(18.0)).w_full())
                .child(Skeleton::new().h(px(18.0)).w(px(220.0)))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .child(Skeleton::new().h(px(20.0)).w(px(56.0)).rounded_full())
                        .child(Skeleton::new().secondary().h(px(12.0)).w(px(150.0))),
                )
                .child(Skeleton::new().secondary().h(px(12.0)).w(px(200.0))),
        )
        .child(div().flex_none().h(px(1.0)).bg(theme.line))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(10.0))
                .px(px(12.0))
                .pt(px(10.0))
                .child(Skeleton::new().h(px(4.0)).w_full())
                .child(Skeleton::new().h(px(28.0)).w_full()),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .px(px(12.0))
                .child(section(72.0))
                .children((0..4).map(|i| row(i, 14.0)))
                .child(section(56.0))
                .children((4..10).map(|i| row(i, 14.0))),
        )
        .into_any_element()
}

/// The Designs board while the Chat's designs are being read: three screens side by side under their title rows.
pub fn designs(theme: &Theme) -> AnyElement {
    let frame = |ix: usize, width: f32, height: f32| {
        let title = Skeleton::new().h(px(12.0)).w(px(width * 0.5));
        div()
            .flex()
            .flex_col()
            .gap(px(8.0))
            .child(div().flex().items_center().gap(px(6.0)).child(bar(18.0, 12.0)).child(if ix == 0 {
                title.pulse("designs-sk-title")
            } else {
                title
            }))
            .child(Skeleton::new().secondary().h(px(height)).w(px(width)))
    };
    div()
        .debug_selector(|| "designs-skeleton".to_string())
        .size_full()
        .flex()
        .items_start()
        .gap(px(24.0))
        .p(px(24.0))
        .overflow_hidden()
        .text_color(theme.ink)
        .child(frame(0, 130.0, 280.0))
        .child(frame(1, 130.0, 280.0))
        .child(frame(2, 210.0, 140.0))
        .into_any_element()
}

/// The Artifact page while it is being read: its paper, a heading and paragraphs of lines.
pub fn page(theme: &Theme) -> AnyElement {
    let line = |width: gpui::DefiniteLength| Skeleton::new().secondary().h(px(12.0)).w(width);
    div()
        .debug_selector(|| "artifact-skeleton".to_string())
        .size_full()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .p(px(28.0))
        .bg(theme.surface)
        .child(Skeleton::new().pulse("artifact-sk-title").h(px(22.0)).w(px(260.0)))
        .child(Skeleton::new().h(px(14.0)).w(px(340.0)))
        .child(div().h(px(10.0)))
        .children((0..3).map(|i| line(gpui::relative([1.0, 0.92, 0.6][i]))))
        .child(div().h(px(6.0)))
        .child(Skeleton::new().h(px(140.0)).w_full())
        .child(div().h(px(6.0)))
        .children((0..4).map(|i| line(gpui::relative([0.96, 1.0, 0.88, 0.4][i]))))
        .into_any_element()
}
