//! The Chat card (design `gpui-chat-card-a`): the only detached part of the window. The sidebar, the top row and the
//! side panel share one surface (`canvas` under one film grain); the transcript and the composer, the Terminals
//! drawer, the diff over the Chat and the Routines page sit in a card right under the top row, `page`-filled with a 1px
//! `line` border on its top and sides and 12px top corners, 8px from the panel (or the window's right edge). Like
//! Linear's content panel it runs down to the window's bottom edge, with no bottom border or rounded bottom corners.
//! A grain of its own (`GrainView::card`, a bit stronger than the surface's) lies over its fill and under its content.
//! Its left edge is the sidebar's (the sidebar's rows already end 8px short of it, as in the design).
//!
//! GPUI clips to rectangles, so the card's content is laid out 1px inside its border and the corners are cut over
//! it: each top corner outside the curve is painted in the surface's colour and the border's curve is drawn again on
//! top ([`corners`]). What the content paints into a corner (a diff's bar, the Routines page's fill) never shows
//! past the curve.

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
    let (surface, line) = (theme.canvas, theme.line);
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
            canvas(|_, _, _| (), move |bounds, _, window, _| corners(bounds, surface, line, window))
                .absolute()
                .top(top())
                .left_0()
                .right(right)
                .h(px(CARD_RADIUS)),
        )
        .into_any_element()
}

/// Cuts the card's two top corners over its content: the surface outside each curve, then the border's curve again.
fn corners(bounds: Bounds<Pixels>, surface: Rgba, line: Rgba, window: &mut Window) {
    // A quarter circle's cubic Bézier control distance.
    const K: f32 = 0.552_284_8;
    let r = CARD_RADIUS;
    let (left, top) = (f32::from(bounds.left()), f32::from(bounds.top()));
    let right = f32::from(bounds.right());
    if right - left < 2.0 * r {
        return;
    }
    // Each corner: its point, and which way the card runs from it along x and y.
    let corners = [(left, top, 1.0, 1.0), (right, top, -1.0, 1.0)];
    let pt = |x: f32, y: f32| point(px(x), px(y));
    for (x, y, dx, dy) in corners {
        let mut wedge = PathBuilder::fill();
        wedge.move_to(pt(x, y));
        wedge.line_to(pt(x + dx * r, y));
        wedge.cubic_bezier_to(pt(x, y + dy * r), pt(x + dx * r * (1.0 - K), y), pt(x, y + dy * r * (1.0 - K)));
        wedge.close();
        if let Ok(path) = wedge.build() {
            window.paint_path(path, surface);
        }
        // The border's curve, through the middle of its width.
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
