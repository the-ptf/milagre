//! Draws a [`Scene`] natively at a zoom: each layer a box at its laid-out place times the scale, nested as the
//! desktop's markup nests them so a frame clips what it holds, with its fill and border, its opacity over everything
//! inside it, its text one line per row, its icon or image.
//!
//! What differs from the desktop's HTML: GPUI clips to rectangles, so a rounded frame's corners do not cut its
//! children (images round their own corners); an ellipse is a path, its border stroked half a width inside.

use gpui::{
    AnyElement, Bounds as GpuiBounds, FontWeight, ObjectFit, PathBuilder, Pixels, Rgba, StyledImage, canvas, div, img, point, prelude::*,
    px,
};

use super::scene::{Content, Layer, Scene, TextPaint};
use crate::logic::design_layout::{Bounds, TextAlign};

/// Text smaller than this on screen is not drawn: it would only be noise at a far zoom.
const MIN_TEXT_PX: f64 = 0.75;

fn p(value: f64) -> Pixels {
    px(value as f32)
}

/// The scene's screen at `scale`, filling a box of `width * scale` by `height * scale`.
pub fn scene(scene: &Scene, scale: f64) -> AnyElement {
    let origin = Bounds { x: 0.0, y: 0.0, width: scene.width, height: scene.height };
    div()
        .relative()
        .size_full()
        .overflow_hidden()
        .when_some(scene.background, |el, color| el.bg(color))
        .children(scene.roots.iter().map(|&index| layer(scene, index, &origin, scale)))
        .into_any_element()
}

fn layer(scene: &Scene, index: usize, parent: &Bounds, scale: f64) -> AnyElement {
    let layer = &scene.layers[index];
    let b = layer.bounds;
    let (width, height) = (b.width * scale, b.height * scale);
    div()
        .absolute()
        .left(p((b.x - parent.x) * scale))
        .top(p((b.y - parent.y) * scale))
        .w(p(width))
        .h(p(height))
        .overflow_hidden()
        .when(layer.opacity < 1.0, |el| el.opacity(layer.opacity))
        .child(backdrop(layer, scale))
        .when_some(content(layer, scale), |el, content| el.child(content))
        .children(layer.children.iter().map(|&child| self::layer(scene, child, &b, scale)))
        .into_any_element()
}

/// The fill and the border, under the content and the children.
fn backdrop(layer: &Layer, scale: f64) -> AnyElement {
    if layer.fill.is_none() && layer.stroke.is_none() {
        return div().into_any_element();
    }
    if layer.ellipse {
        let (fill, stroke) = (layer.fill, layer.stroke);
        return canvas(|_, _, _| {}, move |bounds, _, window, _| paint_ellipse(bounds, fill, stroke.map(|(w, c)| (w * scale, c)), window))
            .absolute()
            .size_full()
            .into_any_element();
    }
    div()
        .absolute()
        .size_full()
        .rounded(p(layer.radius * scale))
        .when_some(layer.fill, |el, color| el.bg(color))
        .when_some(layer.stroke, |el, (width, color)| el.border(p(width * scale)).border_color(color))
        .into_any_element()
}

/// Four cubic arcs: the ellipse inscribed in `bounds`.
fn ellipse_path(bounds: GpuiBounds<Pixels>, inset: f32, mut builder: PathBuilder) -> Option<gpui::Path<Pixels>> {
    const K: f32 = 0.552_284_8;
    let (cx, cy) = (f32::from(bounds.center().x), f32::from(bounds.center().y));
    let rx = f32::from(bounds.size.width) / 2.0 - inset;
    let ry = f32::from(bounds.size.height) / 2.0 - inset;
    if rx <= 0.0 || ry <= 0.0 {
        return None;
    }
    let pt = |x: f32, y: f32| point(px(x), px(y));
    builder.move_to(pt(cx + rx, cy));
    builder.cubic_bezier_to(pt(cx, cy + ry), pt(cx + rx, cy + ry * K), pt(cx + rx * K, cy + ry));
    builder.cubic_bezier_to(pt(cx - rx, cy), pt(cx - rx * K, cy + ry), pt(cx - rx, cy + ry * K));
    builder.cubic_bezier_to(pt(cx, cy - ry), pt(cx - rx, cy - ry * K), pt(cx - rx * K, cy - ry));
    builder.cubic_bezier_to(pt(cx + rx, cy), pt(cx + rx * K, cy - ry), pt(cx + rx, cy - ry * K));
    builder.close();
    builder.build().ok()
}

fn paint_ellipse(bounds: GpuiBounds<Pixels>, fill: Option<Rgba>, stroke: Option<(f64, Rgba)>, window: &mut gpui::Window) {
    if let Some(color) = fill
        && let Some(path) = ellipse_path(bounds, 0.0, PathBuilder::fill())
    {
        window.paint_path(path, color);
    }
    if let Some((width, color)) = stroke
        && let Some(path) = ellipse_path(bounds, width as f32 / 2.0, PathBuilder::stroke(px(width as f32)))
    {
        window.paint_path(path, color);
    }
}

fn content(layer: &Layer, scale: f64) -> Option<AnyElement> {
    match &layer.content {
        Content::None => None,
        Content::Text(text) => text_lines(text, layer.bounds.width, scale),
        Content::Icon(image) => {
            image.clone().map(|image| img(image).absolute().size_full().object_fit(ObjectFit::Contain).into_any_element())
        }
        Content::Image(image) => image.clone().map(|image| {
            img(image).absolute().size_full().rounded(p(layer.radius * scale)).object_fit(ObjectFit::Cover).into_any_element()
        }),
    }
}

fn text_lines(text: &TextPaint, width: f64, scale: f64) -> Option<AnyElement> {
    let size = text.font_size * scale;
    if size < MIN_TEXT_PX || text.lines.is_empty() {
        return None;
    }
    let color = text.color?;
    let line_height = text.line_height * scale;
    let inner = ((width - 2.0 * text.inset) * scale).max(0.0);
    Some(
        div()
            .absolute()
            .left(p(text.inset * scale))
            .top(p(text.inset * scale))
            .w(p(inner))
            .font_family(text.family.clone())
            .font_weight(FontWeight(text.weight))
            .text_size(p(size))
            .line_height(p(line_height))
            .text_color(color)
            .children(text.lines.iter().map(|line| {
                div()
                    .w_full()
                    .h(p(line_height))
                    .whitespace_nowrap()
                    .map(|el| match text.align {
                        TextAlign::Left => el,
                        TextAlign::Center => el.text_center(),
                        TextAlign::Right => el.text_right(),
                    })
                    .child(line.clone())
            }))
            .into_any_element(),
    )
}
