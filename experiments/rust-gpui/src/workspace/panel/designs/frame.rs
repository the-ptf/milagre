//! The pieces of the canvas: a design's frame (title row with its controls, and the design's screen), a group's
//! block and name, the dot grid and the zoom bar. Positions are on screen, from the board's canvas units and the
//! view.

use std::rc::Rc;

use gpui::{AnyElement, ClickEvent, Context, FontWeight, Pixels, Rgba, SharedString, Window, div, point, prelude::*, px, size};

use super::DesignsView;
use super::board::{self, FrameBox, GroupBox, HeaderFit, View};
use super::scene::Scene;
use super::{render, zoom_label};
use crate::theme::{RADIUS_CARD, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, ButtonSize, ButtonVariant, Icon, IconName, IconSize};

fn p(value: f64) -> Pixels {
    px(value as f32)
}

/// The dot grid (`radial-gradient(var(--color-line) 1px, transparent 1px)`): a 2px dot centred in each tile, the tiles
/// following the view.
pub fn paint_dots(bounds: gpui::Bounds<Pixels>, view: View, color: Rgba, window: &mut Window) {
    let step = board::dot_step(view.scale);
    let (width, height) = (f64::from(f32::from(bounds.size.width)), f64::from(f32::from(bounds.size.height)));
    let start = |offset: f64| offset.rem_euclid(step) - step + step / 2.0;
    let mut y = start(view.y);
    while y < height + step {
        let mut x = start(view.x);
        while x < width + step {
            let origin = point(bounds.origin.x + p(x - 1.0), bounds.origin.y + p(y - 1.0));
            window.paint_quad(gpui::fill(gpui::Bounds::new(origin, size(px(2.0), px(2.0))), color).corner_radii(px(1.0)));
            x += step;
        }
        y += step;
    }
}

/// A group's block (`rounded-card bg-hover`, scaled with the canvas) and its name and count above it (screen size).
pub fn group(group: &GroupBox, view: View, theme: &Theme) -> AnyElement {
    let (bx, by) = view.to_screen(group.block.x, group.block.y);
    let name: SharedString = group.name.clone().unwrap_or_else(|| "Ungrouped".into()).into();
    let selector = format!("design-group-{name}");
    div()
        .child(
            div()
                .absolute()
                .left(p(bx))
                .top(p(by))
                .w(p(group.block.width * view.scale))
                .h(p(group.block.height * view.scale))
                .rounded(p(f64::from(f32::from(RADIUS_CARD)) * view.scale))
                .bg(theme.hover),
        )
        .child(
            div()
                .debug_selector(move || selector.clone())
                .absolute()
                .left(p(bx))
                .top(p(by - board::GROUP_LABEL))
                .h(p(board::GROUP_LABEL))
                .pb_2()
                .flex()
                .items_end()
                .gap_2()
                .whitespace_nowrap()
                .text_step(TEXT_13)
                .child(
                    div().font_weight(FontWeight::MEDIUM).text_color(if group.name.is_some() { theme.ink } else { theme.ink3 }).child(name),
                )
                .child(div().text_color(theme.ink3).child(group.count.to_string())),
        )
        .into_any_element()
}

/// A 24px (or 28px pill) button around any glyph: the version arrows, Delete and the zoom bar.
fn glyph_button(id: impl Into<SharedString>, glyph: AnyElement, pill: bool, disabled: bool, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    let id: SharedString = id.into();
    let selector = id.to_string();
    let hover = theme.hover;
    div()
        .id(id)
        .debug_selector(move || selector.clone())
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(if pill { 28.0 } else { 24.0 }))
        .when(pill, |el| el.rounded_full())
        .when(!pill, |el| el.rounded(RADIUS_CONTROL))
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| el.cursor_pointer().hover(move |style| style.bg(hover)))
        .child(glyph)
}

/// A 14px Hugeicons chevron: `ArrowLeft01` for the previous version, `ArrowRight01` for the next.
fn chevron(left: bool, color: Rgba) -> AnyElement {
    Icon::new(if left { IconName::ArrowLeft01 } else { IconName::ArrowRight01 }).size(IconSize::S14).color(color).into_any_element()
}

/// Stops a press on a control from starting a pan of the canvas behind it.
fn controls_row() -> gpui::Div {
    div().flex().flex_none().items_center().gap_1().on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

fn controls(this: &DesignsView, id: &str, version: u32, last: u32, kit: String, theme: &Theme, cx: &mut Context<DesignsView>) -> gpui::Div {
    let shown = (id.to_string(), version);
    let pending_here = this.pending.as_ref() == Some(&shown);
    let sent_here = this.pending.is_none() && this.sent.as_ref() == Some(&shown);
    let previous = {
        let id = id.to_string();
        glyph_button(format!("design-prev-{id}"), chevron(true, theme.ink3), false, version <= 1, theme)
            .when(version > 1, |el| el.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.go(&id, version - 1, cx))))
    };
    let next = {
        let id = id.to_string();
        glyph_button(format!("design-next-{id}"), chevron(false, theme.ink3), false, version >= last, theme)
            .when(version < last, |el| el.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.go(&id, version + 1, cx))))
    };
    let version_selector = format!("design-version-{id}");
    let version_text = div()
        .debug_selector(move || version_selector.clone())
        .flex()
        .flex_none()
        .whitespace_nowrap()
        .text_color(theme.ink3)
        .child(format!("v{version} of {last}"))
        .when(!kit.is_empty(), |el| el.child(div().ml_2().child(kit)));
    let delete: AnyElement = if this.deleting.as_deref() == Some(id) {
        let confirm = id.to_string();
        div()
            .flex()
            .items_center()
            .gap_1()
            .child(
                Button::new(SharedString::from(format!("design-delete-confirm-{id}")), "Delete")
                    .variant(ButtonVariant::Danger)
                    .size(ButtonSize::S24)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.delete(&confirm, cx))),
            )
            .child(
                Button::new(SharedString::from(format!("design-delete-cancel-{id}")), "Cancel")
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::S24)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.arm_delete(None, cx))),
            )
            .into_any_element()
    } else {
        let arm = id.to_string();
        glyph_button(
            format!("design-delete-{id}"),
            Icon::new(IconName::Delete02).size(IconSize::S14).color(theme.red_ink).into_any_element(),
            false,
            false,
            theme,
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.arm_delete(Some(&arm), cx)))
        .into_any_element()
    };
    let choice: AnyElement = if sent_here {
        chosen_pill(format!("design-chosen-{id}"), theme).into_any_element()
    } else {
        let target = id.to_string();
        let selector = format!("design-choose-{id}");
        let label = if pending_here { "Chosen" } else { "Choose" };
        let (hover, hover2, surface) = (theme.hover, theme.hover2, theme.surface);
        div()
            .id(SharedString::from(selector.clone()))
            .debug_selector(move || selector.clone())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.0))
            .h(px(24.0))
            .px_2()
            .rounded(RADIUS_CONTROL)
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.ink)
            .cursor_pointer()
            .when(pending_here, |el| el.bg(hover2).child(Icon::new(IconName::CheckmarkCircle02).size(IconSize::S14).color(theme.ink)))
            .when(!pending_here, |el| el.bg(surface).shadow(theme.shadow_btn()).hover(move |style| style.bg(hover)))
            .child(label)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.choose(&target, cx)))
            .into_any_element()
    };
    controls_row()
        .child(previous)
        .child(version_text)
        .child(next)
        // Edit opens the design page editor (`editor/`) on this design.
        .child({
            let target = id.to_string();
            Button::new(SharedString::from(format!("design-edit-{id}")), "Edit")
                .variant(ButtonVariant::Secondary)
                .size(ButtonSize::S24)
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.open_editor(&target, cx)))
        })
        .child(delete)
        .child(choice)
}

fn chosen_pill(selector: String, theme: &Theme) -> gpui::Div {
    div()
        .debug_selector(move || selector.clone())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.0))
        .h(px(24.0))
        .px_2()
        .rounded(RADIUS_CONTROL)
        .bg(theme.hover2)
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.ink)
        .child(Icon::new(IconName::CheckmarkCircle02).size(IconSize::S14).color(theme.ink))
        .child("Chosen")
}

/// One design: the title row above its screen, and the screen drawn at the zoom with its border and shadow.
pub fn frame(
    this: &DesignsView,
    item: &FrameBox,
    version: u32,
    scene: Option<Rc<Scene>>,
    theme: &Theme,
    cx: &mut Context<DesignsView>,
) -> AnyElement {
    let view = this.view;
    let design = this.design(&item.id);
    let title: SharedString = design.map(|d| d.title.clone()).unwrap_or_default().into();
    let last = design.map(|d| d.latest()).unwrap_or(1);
    let kit = scene.as_ref().map(|s| s.document.kit_label()).unwrap_or_default();
    let fit = board::header_fit(item.body.width, view.scale);
    let header = board::header_height(item.body.width, view.scale);
    let (x, y) = view.to_screen(item.body.x, item.body.y);
    let (width, height) = (item.body.width * view.scale, item.body.height * view.scale);
    let id = item.id.clone();
    let shown = (id.clone(), version);
    let pending_here = this.pending.as_ref() == Some(&shown);
    let sent_here = this.pending.is_none() && this.sent.as_ref() == Some(&shown);
    let chosen = pending_here || sent_here;
    let active = this.active.as_deref() == Some(id.as_str());
    let hovered = this.hovered.as_deref() == Some(id.as_str()) || this.deleting.as_deref() == Some(id.as_str());
    let row_controls = controls(this, &id, version, last, kit, theme, cx);
    let number = div().flex_none().text_color(theme.ink3).child(item.number.to_string());
    let title_el = div().min_w_0().flex_1().truncate().child(title.clone());
    let row = div().flex().items_center().gap_1().w_full().min_w_0();
    let heading: AnyElement = match fit {
        HeaderFit::Row => row.child(number).child(title_el).child(row_controls).into_any_element(),
        HeaderFit::Narrow => div()
            .flex()
            .flex_col()
            .justify_end()
            .gap_1()
            .w_full()
            .child(row.child(number).child(title_el))
            .child(row_controls.flex_wrap())
            .into_any_element(),
        HeaderFit::Compact => row
            .child(number)
            .child(title_el)
            .when(chosen, |el| el.child(Icon::new(IconName::CheckmarkCircle02).size(IconSize::S14).color(theme.ink)))
            .into_any_element(),
    };
    let border = if active {
        Some(theme.accent)
    } else if chosen {
        Some(theme.ink)
    } else {
        None
    };
    let radius = p(f64::from(f32::from(RADIUS_CARD)) * view.scale);
    let body_selector = format!("design-body-{id}");
    let frame_selector = format!("design-frame-{id}");
    let hover_id = id.clone();
    div()
        .id(SharedString::from(frame_selector.clone()))
        .debug_selector(move || frame_selector.clone())
        .absolute()
        .left(p(x))
        .top(p(y - header))
        .w(p(width))
        .h(p(header + height))
        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| this.set_hovered(&hover_id, *hovered, cx)))
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .w_full()
                .h(p(header))
                .pb(px(6.0))
                .flex()
                .items_end()
                .text_step(TEXT_12)
                .text_color(theme.ink)
                .child(heading),
        )
        .child(
            div()
                .debug_selector(move || body_selector.clone())
                .absolute()
                .left_0()
                .top(p(header))
                .w(p(width))
                .h(p(height))
                .rounded(radius)
                .shadow(theme.shadow_raised())
                .bg(gpui::white())
                .overflow_hidden()
                .when_some(scene, |el, scene| el.child(render::scene(&scene, view.scale)))
                .when_some(border, |el, color| {
                    el.child(div().absolute().size_full().rounded(radius).border(p((2.0 * view.scale).max(1.0))).border_color(color))
                }),
        )
        .when(fit == HeaderFit::Compact && hovered, |el| {
            el.child(
                div()
                    .absolute()
                    .left(px(6.0))
                    .top(p(header + 6.0))
                    .p_1()
                    .rounded(RADIUS_CONTROL)
                    .bg(theme.surface)
                    .shadow(theme.shadow_raised())
                    .whitespace_nowrap()
                    .text_step(TEXT_12)
                    .text_color(theme.ink)
                    .child(controls(this, &id, version, last, String::new(), theme, cx)),
            )
        })
        .into_any_element()
}

/// The floating zoom bar (`ZoomBar`): zoom out, the zoom (back to 100%), zoom in, Fit.
pub fn zoom_bar(scale: f64, theme: &Theme, cx: &mut Context<DesignsView>) -> AnyElement {
    let ink3 = theme.ink3;
    let hover = theme.hover;
    let can_out = scale > board::MIN_SCALE + 1e-9;
    let can_in = scale < board::MAX_SCALE - 1e-9;
    div()
        .absolute()
        .left(px(16.0))
        .bottom(px(16.0))
        .flex()
        .items_center()
        .gap(px(2.0))
        .p_1()
        .rounded_full()
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            glyph_button(
                "designs-zoom-out",
                Icon::new(IconName::MinusSign).size(IconSize::S16).color(ink3).into_any_element(),
                true,
                !can_out,
                theme,
            )
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.zoom_by(1.0 / board::ZOOM_STEP, cx))),
        )
        .child(
            div()
                .id("designs-zoom")
                .debug_selector(|| "designs-zoom".to_string())
                .h(px(28.0))
                .w(px(48.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.ink)
                .cursor_pointer()
                .hover(move |style| style.bg(hover))
                .child(zoom_label(scale))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.zoom_to(1.0, cx))),
        )
        .child(
            glyph_button(
                "designs-zoom-in",
                Icon::new(IconName::PlusSign).size(IconSize::S16).color(ink3).into_any_element(),
                true,
                !can_in,
                theme,
            )
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.zoom_by(board::ZOOM_STEP, cx))),
        )
        .child(div().mx(px(2.0)).h(px(16.0)).w(px(1.0)).bg(theme.line))
        .child(
            glyph_button(
                "designs-fit",
                Icon::new(IconName::FitToScreen).size(IconSize::S16).color(ink3).into_any_element(),
                true,
                false,
                theme,
            )
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.fit_all(cx))),
        )
        .into_any_element()
}
