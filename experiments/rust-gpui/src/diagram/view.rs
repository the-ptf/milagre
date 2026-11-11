//! The Mermaid block: `MermaidBlock`'s header (kind, Diagram / Source, Copy, Expand), the picture, the source view
//! and the "didn't draw" note.

use std::sync::Arc;
use std::time::Duration;

use gpui::{
    AnyElement, App, ClipboardItem, ElementId, FontWeight, ImageSource, IntoElement, ObjectFit, ParentElement as _, SharedString,
    Styled as _, Window, div, img, prelude::*, px,
};

use super::render::{self, Drawing};
use super::{detect_type, diagram_label};
use crate::genui::code;
use crate::theme::{ActiveTheme, Appearance, RADIUS_CHIP, RADIUS_CONTROL, TEXT_11, TEXT_12, TextStepExt, Theme};
use crate::ui::{Dialog, DialogAction, IconButton, IconButtonSize, IconName};

/// How long the tick stays after a copy (`useCopied`).
const COPIED_MS: u64 = 1500;
/// The lightbox: the width of its dialog, and the box the picture is fitted into (up to twice its size).
const LIGHTBOX_WIDTH: f32 = 960.0;
const LIGHTBOX_FIT: (f32, f32) = (920.0, 520.0);

#[derive(Default)]
struct BlockState {
    source: bool,
    copied: bool,
}

fn fingerprint(code: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    code.hash(&mut hasher);
    hasher.finish()
}

/// A ```mermaid fence. `streaming`: the block of a reply still being written, which stays code.
pub fn render_block(code: SharedString, streaming: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    if streaming {
        return code::code_block("mermaid", &code, "mermaid-block", cx);
    }
    let theme = *cx.theme();
    let id = fingerprint(&code);
    let state = window.use_keyed_state(ElementId::Name(format!("mermaid-block-{id:x}").into()), cx, |_, _| BlockState::default());
    let (source, copied) = {
        let state = state.read(cx);
        (state.source, state.copied)
    };
    let drawn = if source { None } else { Some(render::draw(&code, &theme, cx)) };
    let error = drawn.as_ref().and_then(|drawn| drawn.as_ref().err().cloned());
    let drawing = drawn.as_ref().and_then(|drawn| drawn.as_ref().ok().cloned());
    let label = diagram_label(detect_type(&code).as_deref());

    let tab = |name: &'static str, on: bool, to_source: bool| {
        let state = state.clone();
        div()
            .id(ElementId::Name(format!("mermaid-{name}-{id:x}").into()))
            .debug_selector(move || format!("mermaid-{name}"))
            .rounded(RADIUS_CHIP)
            .px(px(8.0))
            .py(px(2.0))
            .text_step(TEXT_11)
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .when(on, |el| {
                let fill = if theme.appearance == Appearance::Dark { theme.hover2 } else { theme.surface };
                el.bg(fill).text_color(theme.ink).shadow(theme.shadow_btn())
            })
            .when(!on, |el| el.text_color(theme.ink2).hover(move |style| style.text_color(theme.ink)))
            .child(name)
            .on_click(move |_, _, cx| {
                state.update(cx, |state, cx| {
                    state.source = to_source;
                    cx.notify();
                })
            })
    };
    let header = div()
        .flex()
        .items_center()
        .gap(px(4.0))
        .h(px(28.0))
        .pl(px(10.0))
        .pr(px(4.0))
        .border_b_1()
        .border_color(theme.line)
        .text_step(TEXT_11)
        .text_color(theme.ink3)
        .child(div().flex_1().min_w_0().truncate().child(label))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(2.0))
                .rounded(RADIUS_CONTROL)
                .bg(theme.field)
                .p(px(2.0))
                .child(tab("Diagram", !source, false))
                .child(tab("Source", source, true)),
        )
        .child({
            let state = state.clone();
            let code = code.clone();
            let button = IconButton::new(
                ElementId::Name(format!("mermaid-copy-{id:x}").into()),
                if copied { IconName::Tick02 } else { IconName::Copy01 },
            )
            .size(IconButtonSize::S24)
            .on_click(move |_, _, cx| {
                cx.write_to_clipboard(ClipboardItem::new_string(code.to_string()));
                state.update(cx, |state, cx| {
                    state.copied = true;
                    cx.notify();
                });
                let state = state.downgrade();
                cx.spawn(async move |cx| {
                    cx.background_executor().timer(Duration::from_millis(COPIED_MS)).await;
                    let _ = state.update(cx, |state, cx| {
                        state.copied = false;
                        cx.notify();
                    });
                })
                .detach();
            });
            div().debug_selector(|| "mermaid-copy".into()).child(button)
        })
        .child({
            let drawing = drawing.clone();
            let can_expand = drawing.is_some();
            let button = IconButton::new(ElementId::Name(format!("mermaid-expand-{id:x}").into()), IconName::ArrowExpand01)
                .size(IconButtonSize::S24)
                .disabled(!can_expand)
                .on_click(move |_, window, cx| {
                    if let Some(drawing) = &drawing {
                        expand(label, drawing.clone(), window, cx);
                    }
                });
            div().debug_selector(|| "mermaid-expand".into()).child(button)
        });

    let body: AnyElement = match (&drawing, &error) {
        (Some(drawing), _) => picture(drawing, "mermaid-diagram"),
        (None, Some(error)) => div()
            .child(
                div()
                    .debug_selector(|| "mermaid-error".into())
                    .px(px(12.0))
                    .pt(px(8.0))
                    .text_step(TEXT_12)
                    .text_color(theme.red_ink)
                    .child(format!("The diagram didn't draw: {error}")),
            )
            .child(code::source(&code, &theme))
            .into_any_element(),
        (None, None) => div().debug_selector(|| "mermaid-source".into()).child(code::source(&code, &theme)).into_any_element(),
    };
    frame(&theme).child(header).child(body).into_any_element()
}

fn frame(theme: &Theme) -> gpui::Div {
    div()
        .debug_selector(|| "mermaid-block".into())
        .my(px(8.0))
        .w_full()
        .min_w_0()
        .rounded(RADIUS_CONTROL)
        .border_1()
        .border_color(theme.line)
        .bg(theme.inset)
        .overflow_hidden()
}

/// The picture as wide as the reply, never wider than itself, at its own proportions.
fn picture(drawing: &Arc<Drawing>, selector: &'static str) -> AnyElement {
    div()
        .px(px(12.0))
        .py(px(12.0))
        .flex()
        .justify_center()
        .child(
            div()
                .debug_selector(move || selector.into())
                .w_full()
                .max_w(px(drawing.width))
                .aspect_ratio(drawing.width / drawing.height)
                .child(img(ImageSource::Render(drawing.image.clone())).object_fit(ObjectFit::Contain).size_full()),
        )
        .into_any_element()
}

/// Expand: the picture in a dialog, on its block's ground, fitted to the room (up to twice its size).
fn expand(label: &'static str, drawing: Arc<Drawing>, window: &mut Window, cx: &mut App) {
    Dialog::new(label)
        .width(LIGHTBOX_WIDTH)
        .body(move |_, cx| {
            let theme = *cx.theme();
            let scale = (LIGHTBOX_FIT.0 / drawing.width).min(LIGHTBOX_FIT.1 / drawing.height).min(2.0);
            div()
                .debug_selector(|| "mermaid-lightbox".into())
                .flex()
                .justify_center()
                .rounded(RADIUS_CONTROL)
                .bg(theme.inset)
                .p(px(24.0))
                .child(
                    div()
                        .debug_selector(|| "mermaid-lightbox-picture".into())
                        .w(px(drawing.width * scale))
                        .h(px(drawing.height * scale))
                        .child(img(ImageSource::Render(drawing.image.clone())).object_fit(ObjectFit::Contain).size_full()),
                )
                .into_any_element()
        })
        .action(DialogAction::new("mermaid-lightbox-close", "Close").variant(crate::ui::ButtonVariant::Ghost))
        .open(window, cx);
}
