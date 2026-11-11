//! The generative UI block drawn natively (`apps/desktop/app/src/components/genui/{components,charts,GenerativeUI}.tsx`).
//!
//! Sizes follow the desktop's classes: text at the Chat size (`--chat-size`, 14px, 1.6 line height), a `Stack`'s
//! gap `s`/`m`/`l` is 4/8/16px, a table, callout and chart sit in `rounded-card` boxes, a chart is at most
//! `max-w-md` (448px) wide at the 320 by 140 aspect of its viewBox with its text scaled with it, as an SVG scales.
//! A button is `disabled` while the reply streams or when nothing can take its message.

use std::sync::Arc;

use gpui::{
    AnyElement, App, Bounds, ElementId, FontWeight, IntoElement, ParentElement as _, PathBuilder, Pixels, SharedString, Styled as _,
    TextAlign, TextRun, Window, canvas, div, font, point, prelude::*, px, quad, size,
};

use super::contract::{
    Action, Block, ButtonVariant, CHART_HEIGHT, CHART_PAD_BOTTOM, CHART_PAD_LEFT, CHART_PAD_RIGHT, CHART_PAD_TOP, CHART_WIDTH, CalloutTone,
    Direction, Gap, Geometry, Node, TextTone,
};
use crate::theme::{ActiveTheme, CHAT_TEXT, RADIUS_CARD, SANS, TEXT_12, TextStepExt, Theme};
use crate::ui::{Button, ButtonVariant as ButtonLook, ProgressBar};

/// What a pressed button does with its message: the transcript posts it as the user's next message.
pub type SendHandler = Arc<dyn Fn(&str, &mut Window, &mut App) + Send + Sync>;

/// The widest a chart draws (`max-w-md`).
pub const CHART_MAX_WIDTH: f32 = 448.0;
/// The space around a block in the reply (`my-2`).
pub const BLOCK_MARGIN: f32 = 8.0;

/// Where a block is drawn: its place in the reply and who takes its buttons' messages.
#[derive(Clone)]
pub struct Surface {
    /// The block of a reply still being written: buttons are off.
    pub streaming: bool,
    pub send: Option<SendHandler>,
    /// Tells this block's buttons from another block's.
    pub key: u64,
}

pub fn render(block: &Block, surface: &Surface, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(root) = &block.root else { return div().into_any_element() };
    let mut counter = 0usize;
    node(root, surface, &mut counter, window, cx)
}

fn gap_px(gap: Gap) -> f32 {
    match gap {
        Gap::S => 4.0,
        Gap::M => 8.0,
        Gap::L => 16.0,
    }
}

fn node(item: &Node, surface: &Surface, counter: &mut usize, window: &mut Window, cx: &mut App) -> AnyElement {
    let theme = *cx.theme();
    match item {
        Node::Stack { children, direction, gap } => {
            let children: Vec<AnyElement> = children.iter().map(|child| node(child, surface, counter, window, cx)).collect();
            let base = div().debug_selector(|| "genui-stack".into()).flex().min_w_0().gap(px(gap_px(*gap)));
            match direction {
                Direction::Column => base.flex_col().children(children).into_any_element(),
                Direction::Row => base.flex_row().flex_wrap().items_start().children(children).into_any_element(),
            }
        }
        Node::Heading { text, level } => {
            let (size, weight, color) = match level {
                1 => (CHAT_TEXT.size + 2.0, FontWeight::SEMIBOLD, theme.ink),
                3 => (CHAT_TEXT.size, FontWeight::MEDIUM, theme.ink2),
                _ => (CHAT_TEXT.size + 1.0, FontWeight::SEMIBOLD, theme.ink),
            };
            div()
                .debug_selector(|| "genui-heading".into())
                .text_size(px(size))
                .line_height(px(size * 1.35))
                .font_weight(weight)
                .text_color(color)
                .child(text.clone())
                .into_any_element()
        }
        Node::Text { text, tone } => {
            let base = div().debug_selector(|| "genui-text".into()).text_size(px(CHAT_TEXT.size)).line_height(px(CHAT_TEXT.size * 1.6));
            match tone {
                TextTone::Default => base.text_color(theme.ink),
                TextTone::Muted => base.text_color(theme.ink2),
                TextTone::Strong => base.font_weight(FontWeight::MEDIUM).text_color(theme.ink),
            }
            .child(text.clone())
            .into_any_element()
        }
        Node::KeyValue { pairs } => {
            // `grid-cols-[auto_1fr]`: the key column is as wide as its widest key.
            let widest = pairs.iter().map(|(key, _)| text_width(window, key, CHAT_TEXT.size)).fold(0.0_f32, f32::max).ceil() + 1.0;
            div()
                .debug_selector(|| "genui-keyvalue".into())
                .flex()
                .flex_col()
                .gap(px(4.0))
                .text_size(px(CHAT_TEXT.size))
                .line_height(px(CHAT_TEXT.size * 1.6))
                .children(pairs.iter().map(|(key, value)| {
                    div()
                        .flex()
                        .gap(px(16.0))
                        .child(div().flex_none().w(px(widest.min(260.0))).text_color(theme.ink2).child(key.clone()))
                        .child(div().flex_1().min_w_0().text_color(theme.ink).child(value.clone()))
                }))
                .into_any_element()
        }
        Node::Table { columns, rows } => table(columns, rows, surface.key, &theme),
        Node::Callout { body, tone, title } => {
            let (border, fill) = match tone {
                CalloutTone::Info => (theme.line_strong, theme.field),
                CalloutTone::Success => (gpui::transparent_black().into(), theme.green_tint),
                CalloutTone::Warning => (gpui::transparent_black().into(), theme.orange_tint),
                CalloutTone::Danger => (gpui::transparent_black().into(), theme.red_tint),
            };
            div()
                .debug_selector(|| "genui-callout".into())
                .rounded(RADIUS_CARD)
                .border_1()
                .border_color(border)
                .bg(fill)
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(CHAT_TEXT.size))
                .line_height(px(CHAT_TEXT.size * 1.6))
                .text_color(theme.ink)
                .when_some(title.clone(), |el, title| el.child(div().mb(px(2.0)).font_weight(FontWeight::MEDIUM).child(title)))
                .child(div().child(body.clone()))
                .into_any_element()
        }
        Node::Progress { label, value } => {
            let value = value.clamp(0.0, 1.0);
            div()
                .debug_selector(|| "genui-progress".into())
                .text_size(px(CHAT_TEXT.size))
                .line_height(px(CHAT_TEXT.size * 1.6))
                .child(
                    div()
                        .mb(px(4.0))
                        .flex()
                        .justify_between()
                        .text_color(theme.ink2)
                        .child(label.clone())
                        .child(format!("{}%", (value * 100.0).round() as i64)),
                )
                .child(ProgressBar::new(value as f32).thick())
                .into_any_element()
        }
        Node::BarChart { labels, values, title } => chart(Kind::Bars, labels, values, title.as_deref(), &theme),
        Node::LineChart { labels, values, title } => chart(Kind::Line, labels, values, title.as_deref(), &theme),
        Node::Button { label, action, variant } => {
            let ix = *counter;
            *counter += 1;
            button(label, action, *variant, ix, surface)
        }
    }
}

fn text_width(window: &Window, text: &str, size: f32) -> f32 {
    let text: SharedString = text.replace('\n', " ").into();
    let run =
        TextRun { len: text.len(), font: font(SANS), color: gpui::black(), background_color: None, underline: None, strikethrough: None };
    window.text_system().shape_line(text, px(size), &[run], None).width.into()
}

fn table(columns: &[String], rows: &[Vec<String>], key: u64, theme: &Theme) -> AnyElement {
    // `<table>` sizes a column by its content: the weight of a column is its longest cell, within bounds.
    let weights: Vec<f32> = (0..columns.len())
        .map(|at| {
            let longest = rows.iter().map(|row| row[at].chars().count()).chain([columns[at].chars().count()]).max().unwrap_or(1);
            (longest as f32 + 2.0).clamp(4.0, 40.0)
        })
        .collect();
    let cell = |text: &str, at: usize, header: bool| {
        let mut cell = div().min_w(px(56.0)).flex_basis(px(0.0)).px(px(12.0)).py(px(6.0)).child(text.to_string()).text_color(if header {
            theme.ink2
        } else {
            theme.ink
        });
        if header {
            cell = cell.font_weight(FontWeight::MEDIUM);
        }
        cell.style().flex_grow = Some(weights[at]);
        cell.style().flex_shrink = Some(1.0);
        cell
    };
    let header =
        div().flex().border_b_1().border_color(theme.line).children(columns.iter().enumerate().map(|(at, text)| cell(text, at, true)));
    let last = rows.len().saturating_sub(1);
    let body = rows.iter().enumerate().map(|(ix, row)| {
        div()
            .flex()
            .when(ix != last, |el| el.border_b_1().border_color(theme.line))
            .children(row.iter().enumerate().map(|(at, text)| cell(text, at, false)))
    });
    div()
        .debug_selector(|| "genui-table".into())
        .my(px(4.0))
        .max_w_full()
        .rounded(RADIUS_CARD)
        .border_1()
        .border_color(theme.line)
        .bg(theme.surface)
        .overflow_hidden()
        .child(
            div()
                .id(ElementId::Name(format!("genui-table-scroll-{key:x}").into()))
                .w_full()
                .overflow_x_scroll()
                .text_size(px(CHAT_TEXT.size))
                .line_height(px(CHAT_TEXT.size * 1.5))
                .child(div().min_w(px(56.0 * columns.len() as f32)).w_full().flex().flex_col().child(header).children(body)),
        )
        .into_any_element()
}

fn button(label: &str, action: &Action, variant: ButtonVariant, ix: usize, surface: &Surface) -> AnyElement {
    let enabled = !surface.streaming && surface.send.is_some();
    let messages = action.messages.clone();
    let send = surface.send.clone();
    div()
        .flex()
        .justify_start()
        .child(
            Button::new(ElementId::Name(format!("genui-button-{:x}-{ix}", surface.key).into()), label.to_string())
                .variant(match variant {
                    ButtonVariant::Primary => ButtonLook::Primary,
                    ButtonVariant::Secondary => ButtonLook::Secondary,
                })
                .selector("genui-button")
                .disabled(!enabled)
                .on_click(move |_, window, cx| {
                    let Some(send) = &send else { return };
                    for message in &messages {
                        send(message, window, cx);
                    }
                }),
        )
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Bars,
    Line,
}

/// `Labels`: only as many labels as fit at about 40px each; the rest are left out.
fn label_stride(slot: f32) -> usize {
    ((40.0 / slot).ceil() as usize).max(1)
}

/// A label cut to eight characters with an ellipsis, as the chart's `<text>` is.
fn short_label(label: &str) -> String {
    if label.chars().count() > 8 { format!("{}…", label.chars().take(7).collect::<String>()) } else { label.to_string() }
}

fn chart(kind: Kind, labels: &[String], values: &[f64], title: Option<&str>, theme: &Theme) -> AnyElement {
    let geometry = Geometry::of(values);
    let labels: Vec<String> = labels.iter().take(values.len()).cloned().collect();
    let values = values.to_vec();
    let (accent, ink3) = (theme.accent, theme.ink3);
    let paint = canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, _, window, cx| {
            // The viewBox scaled to the box: one unit is `scale` pixels.
            let scale = f32::from(bounds.size.width) / CHART_WIDTH;
            let at = |x: f32, y: f32| point(bounds.origin.x + px(x * scale), bounds.origin.y + px(y * scale));
            let slot = geometry.slot;
            let zero = geometry.zero();
            match kind {
                Kind::Bars => {
                    for (index, value) in values.iter().enumerate() {
                        let y = geometry.y(*value);
                        let top = y.min(zero);
                        let height = (zero - y).abs().max(1.0);
                        let x = CHART_PAD_LEFT + slot * index as f32 + slot * 0.15;
                        let rect = Bounds::new(at(x, top), size(px(slot * 0.7 * scale), px(height * scale)));
                        window.paint_quad(quad(
                            rect,
                            px(2.0 * scale),
                            accent,
                            px(0.0),
                            gpui::transparent_black(),
                            gpui::BorderStyle::default(),
                        ));
                    }
                }
                Kind::Line => {
                    let x_of = |index: usize| CHART_PAD_LEFT + slot * index as f32 + slot / 2.0;
                    if !values.is_empty() {
                        let mut path = PathBuilder::stroke(px(2.0 * scale));
                        for (index, value) in values.iter().enumerate() {
                            let to = at(x_of(index), geometry.y(*value));
                            if index == 0 {
                                path.move_to(to);
                            } else {
                                path.line_to(to);
                            }
                        }
                        if values.len() == 1 {
                            // A single point has no line: a zero-length segment draws its round cap, as SVG does not; skip.
                        } else if let Ok(path) = path.build() {
                            window.paint_path(path, accent);
                        }
                    }
                    for (index, value) in values.iter().enumerate() {
                        let radius = 2.5 * scale;
                        let centre = at(x_of(index), geometry.y(*value));
                        let rect =
                            Bounds::new(point(centre.x - px(radius), centre.y - px(radius)), size(px(radius * 2.0), px(radius * 2.0)));
                        window.paint_quad(quad(rect, px(radius), accent, px(0.0), gpui::transparent_black(), gpui::BorderStyle::default()));
                    }
                }
            }
            // The labels, centred under their slot at 10 units.
            let stride = label_stride(slot);
            let font_size = px(10.0 * scale);
            for (index, label) in labels.iter().enumerate().filter(|(index, _)| index % stride == 0) {
                let text: SharedString = short_label(label).replace('\n', " ").into();
                let run = TextRun {
                    len: text.len(),
                    font: font(SANS),
                    color: ink3.into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let line = window.text_system().shape_line(text, font_size, &[run], None);
                let centre = CHART_PAD_LEFT + slot * index as f32 + slot / 2.0;
                let origin = point(
                    bounds.origin.x + px(centre * scale) - line.width / 2.0,
                    bounds.origin.y + px((CHART_HEIGHT - 6.0) * scale) - font_size * 0.85,
                );
                let _ = line.paint(origin, font_size * 1.2, TextAlign::Left, None, window, cx);
            }
        },
    )
    .w_full()
    .h_full();
    let _ = (CHART_PAD_TOP, CHART_PAD_BOTTOM, CHART_PAD_RIGHT);
    div()
        .debug_selector(|| "genui-chart".into())
        .my(px(4.0))
        .rounded(RADIUS_CARD)
        .border_1()
        .border_color(theme.line)
        .bg(theme.surface)
        .p(px(12.0))
        .when_some(title.map(str::to_string), |el, title| {
            el.child(div().mb(px(4.0)).text_step(TEXT_12).font_weight(FontWeight::MEDIUM).text_color(theme.ink2).child(title))
        })
        .child(
            div()
                .debug_selector(|| "genui-chart-canvas".into())
                .w_full()
                .max_w(px(CHART_MAX_WIDTH))
                .aspect_ratio(CHART_WIDTH / CHART_HEIGHT)
                .child(paint),
        )
        .into_any_element()
}
