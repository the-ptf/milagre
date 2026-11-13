//! The Chat card (design `gpui-chat-card-a`): the only detached part of the window. The sidebar, the top row and the
//! side panel share one surface (`canvas` under one film grain); the transcript and the composer, the Terminals
//! drawer, the diff over the Chat and the Routines page sit in a card right under the top row, `page`-filled with a 1px
//! `line` border on its top and sides and 12px top corners, 8px from the panel (or the window's right edge). Like
//! Linear's content panel it runs down to the window's bottom edge, with no bottom border or rounded bottom corners.
//! A grain of its own (`GrainView::card`, a bit stronger than the surface's) lies over its fill and under its content.
//! Its left edge is the sidebar's (the sidebar's rows already end 8px short of it, as in the design).
//!
//! GPUI clips to rectangles, so the card's content is laid out 1px inside its border and the corners are cut over
//! it: each top corner outside the curve is painted in the surface's colour ([`corners`]), the surface's own film
//! grain is laid over that wedge again, one device-pixel row at a time and aligned with the window's grain tiles
//! ([`corner_grain`]), so the wedge cannot be told from the grained surface around it, and the border's curve is drawn
//! again on top ([`corner_arcs`]). What the content paints into a corner (a diff's bar, the Routines page's fill)
//! never shows past the curve.

use gpui::{AnyElement, Bounds, Entity, PathBuilder, Pixels, Rgba, Window, canvas, div, point, prelude::*, px};

use crate::theme::Theme;
use crate::ui::grain::GrainView;
use crate::workspace::chrome::TOP_ROW;

/// The card's top corner radius.
pub const CARD_RADIUS: f32 = 12.0;
/// Between the card and the panel or the window's right edge (it starts right under the top row).
pub const CARD_GAP: f32 = 8.0;
/// The card's border.
pub const CARD_BORDER: f32 = 1.0;
/// Where the card starts: right under the top row.
pub fn top() -> Pixels {
    px(TOP_ROW)
}

/// Where the card's content starts, below its top border: the column's own header (the top row), then the border.
pub fn body_top() -> Pixels {
    top() + header_gap()
}

/// What sits under the card's top edge, between the column's header and its body: the border.
pub fn header_gap() -> Pixels {
    px(CARD_BORDER)
}

/// How far the card's right edge sits from its column's: the whole gap with the panel closed (to the window's edge);
/// half with it open, the panel's side holding the other half ([`panel_lead`]), so the resize handle straddles
/// the middle of the gap.
pub fn right_gap(panel_open: bool) -> f32 {
    if panel_open { CARD_GAP / 2.0 } else { CARD_GAP }
}

/// The open panel's half of the gap, before its tabs.
pub fn panel_lead() -> Pixels {
    px(CARD_GAP / 2.0)
}

/// `content` (a column whose first [`TOP_ROW`] px are its header in the top row) on the card. The column fills the card's
/// width, 1px inside its side borders, from the window's top to its bottom; what follows its header must leave
/// [`header_gap`] first.
pub fn column(content: AnyElement, panel_open: bool, theme: &Theme, grain: &Entity<GrainView>) -> AnyElement {
    let right = px(right_gap(panel_open));
    let inset = px(CARD_BORDER);
    let (surface, line, appearance) = (theme.canvas, theme.line, theme.appearance);
    div()
        .relative()
        .size_full()
        .min_w_0()
        .child(
            div()
                .id("chat-card")
                .debug_selector(|| "chat-card".into())
                .absolute()
                .top(top())
                .left_0()
                .right(right)
                .bottom_0()
                .rounded_t(px(CARD_RADIUS))
                .border_t(inset)
                .border_l(inset)
                .border_r(inset)
                .border_color(theme.line)
                .bg(theme.page),
        )
        // The card's own, stronger grain: over the fill, under the content, a cached view of its own (rendered once,
        // again only on a theme change). Its rectangle ends at the card's top corners; `corners` below cuts them.
        .child(
            gpui::AnyView::from(grain.clone())
                .cached(gpui::StyleRefinement::default().absolute().top(top()).left_0().right(right).bottom_0())
                .into_any_element(),
        )
        .child(
            div()
                .debug_selector(|| "chat-card-content".into())
                .absolute()
                .top_0()
                .left(inset)
                .right(right + inset)
                .bottom_0()
                .flex()
                .flex_col()
                .child(content),
        )
        .child(
            canvas(|_, _, _| (), move |bounds, _, window, _| corners(bounds, surface, window))
                .absolute()
                .top(top())
                .left_0()
                .right(right)
                .h(px(CARD_RADIUS)),
        )
        // The surface's grain over the wedges, at the surface grain's strength.
        .child(
            div().absolute().top(top()).left_0().right(right).h(px(CARD_RADIUS)).opacity(crate::ui::grain::STRENGTH).child(
                canvas(
                    move |_, window, cx| window.use_asset::<gpui::ImgResourceLoader>(&crate::ui::grain::surface_texture(appearance), cx),
                    move |bounds, image, window, _| {
                        if let Some(Ok(image)) = image {
                            corner_grain(bounds, &image, window);
                        }
                    },
                )
                .size_full(),
            ),
        )
        .child(
            canvas(|_, _, _| (), move |bounds, _, window, _| corner_arcs(bounds, line, window))
                .absolute()
                .top(top())
                .left_0()
                .right(right)
                .h(px(CARD_RADIUS)),
        )
        .into_any_element()
}

/// A quarter circle's cubic Bézier control distance.
const K: f32 = 0.552_284_8;

/// Each top corner of a card whose top edge is `bounds`' top: its point, and which way the card runs from it along x
/// and y. None when the card is narrower than its two corners.
fn corner_points(bounds: Bounds<Pixels>) -> Option<[(f32, f32, f32, f32); 2]> {
    let (left, top, right) = (f32::from(bounds.left()), f32::from(bounds.top()), f32::from(bounds.right()));
    (right - left >= 2.0 * CARD_RADIUS).then_some([(left, top, 1.0, 1.0), (right, top, -1.0, 1.0)])
}

/// Cuts the card's two top corners over its content: the surface's colour outside each curve.
fn corners(bounds: Bounds<Pixels>, surface: Rgba, window: &mut Window) {
    let r = CARD_RADIUS;
    let pt = |x: f32, y: f32| point(px(x), px(y));
    for (x, y, dx, dy) in corner_points(bounds).into_iter().flatten() {
        let mut wedge = PathBuilder::fill();
        wedge.move_to(pt(x, y));
        wedge.line_to(pt(x + dx * r, y));
        wedge.cubic_bezier_to(pt(x, y + dy * r), pt(x + dx * r * (1.0 - K), y), pt(x, y + dy * r * (1.0 - K)));
        wedge.close();
        if let Ok(path) = wedge.build() {
            window.paint_path(path, surface);
        }
    }
}

/// How wide the wedge outside a corner's curve is, `depth` points below the card's top edge (0 past the radius).
pub fn wedge_width(depth: f32) -> f32 {
    let r = CARD_RADIUS;
    if !(0.0..r).contains(&depth) {
        return 0.0;
    }
    let rise = r - depth;
    r - (r * r - rise * rise).max(0.0).sqrt()
}

/// The surface's grain texture over each wedge, one device-pixel row at a time (GPUI clips images to rectangles):
/// each row's span outside the curve shows the tiles the window's grain draws there (anchored at the window's
/// origin, [`crate::ui::grain::GRAIN_TILE`] points each), so its specks continue the surface's. The caller sets the
/// grain's opacity.
fn corner_grain(bounds: Bounds<Pixels>, image: &std::sync::Arc<gpui::RenderImage>, window: &mut Window) {
    let tile = crate::ui::grain::GRAIN_TILE;
    let step = 1.0 / window.scale_factor().max(1.0);
    for (x, y, dx, _) in corner_points(bounds).into_iter().flatten() {
        let mut depth = 0.0;
        while depth < CARD_RADIUS {
            // The row's middle decides its width; a whole device pixel more, under the border's curve drawn later.
            let width = (wedge_width(depth + step / 2.0) / step).ceil() * step;
            if width > 0.0 {
                let x0 = if dx > 0.0 { x } else { x - width };
                let row = Bounds { origin: point(px(x0), px(y + depth)), size: gpui::size(px(width), px(step)) };
                let ty = ((y + depth) / tile).floor() * tile;
                let (first, last) = ((x0 / tile).floor() as i64, ((x0 + width) / tile).floor() as i64);
                for column in first..=last {
                    let image_bounds = Bounds { origin: point(px(column as f32 * tile), px(ty)), size: gpui::size(px(tile), px(tile)) };
                    let _ = window.paint_image(row, image_bounds, gpui::Corners::default(), image.clone(), 0, false);
                }
            }
            depth += step;
        }
    }
}

/// The border's curve at each top corner, through the middle of its width, over the cut.
fn corner_arcs(bounds: Bounds<Pixels>, line: Rgba, window: &mut Window) {
    let r = CARD_RADIUS;
    let pt = |x: f32, y: f32| point(px(x), px(y));
    for (x, y, dx, dy) in corner_points(bounds).into_iter().flatten() {
        let (h, c) = (CARD_BORDER / 2.0, r - CARD_BORDER / 2.0);
        let (ox, oy) = (x + dx * h, y + dy * h);
        let mut arc = PathBuilder::stroke(px(CARD_BORDER));
        arc.move_to(pt(ox + dx * c, oy));
        arc.cubic_bezier_to(pt(ox, oy + dy * c), pt(ox + dx * c * (1.0 - K), oy), pt(ox, oy + dy * c * (1.0 - K)));
        if let Ok(path) = arc.build() {
            window.paint_path(path, line);
        }
    }
}
