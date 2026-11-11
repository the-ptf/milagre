//! The plain code block both fenced kinds fall back to (`CodeBlock.tsx` as the transcript draws it): a header with
//! the fence's name in mono, then the source in the code size. Used while a block is still being written, over a
//! block that did not parse, and for a diagram's Source view.

use gpui::{AnyElement, App, IntoElement, ParentElement as _, SharedString, Styled as _, div, prelude::*, px};

use crate::theme::{ActiveTheme, CODE_TEXT, RADIUS_CONTROL, TEXT_11, TextStepExt, Theme, mono};

/// The source, in mono at the code size with its lines kept; wide lines scroll sideways instead of wrapping.
pub fn source(code: &SharedString, theme: &Theme) -> AnyElement {
    div()
        .px(px(12.0))
        .py(px(12.0))
        .font_family(mono())
        .text_size(px(CODE_TEXT.size))
        .line_height(px(CODE_TEXT.size * 1.6))
        .text_color(theme.ink)
        .whitespace_nowrap()
        .children(code.split('\n').map(|line| div().min_h(px(CODE_TEXT.size * 1.6)).child(line.to_string())))
        .into_any_element()
}

/// A bordered code block named `label`, `selector` for tests.
pub fn code_block(label: &str, code: &SharedString, selector: &'static str, cx: &App) -> AnyElement {
    let theme = *cx.theme();
    div()
        .debug_selector(move || selector.into())
        .my(px(8.0))
        .w_full()
        .min_w_0()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .overflow_hidden()
        .child(
            div()
                .flex()
                .items_center()
                .h(px(28.0))
                .pl(px(10.0))
                .border_b_1()
                .border_color(theme.line)
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child(div().font_family(mono()).child(label.to_string())),
        )
        .child(source(code, &theme))
        .into_any_element()
}
