//! The editor's own chrome (`DesignPageEditor.tsx`): the page title and save status at the top-left, the page
//! actions (Undo, Redo, Export, Save, Close) in a raised pill at the top-right, the zoom bar centred under the
//! artboards, the notices over the canvas, and the "Your changes have not been saved" confirmation.
//!
//! The confirmation is drawn inside the editor rather than through `ui::Dialog`: the editor is a deferred layer
//! over the window, above the app root's dialog layer, so a root dialog would open under it.

use gpui::{AnyElement, ClickEvent, Context, FontWeight, div, prelude::*, px};

use super::DesignEditor;
use super::page::{self, MAX_SCALE, MIN_SCALE, ZOOM_STEP};
use crate::theme::{HEADER_HEIGHT, RADIUS_WINDOW, TEXT_11, TEXT_12, TEXT_13, TEXT_17, TextStepExt, Theme};
use crate::ui::{
    Button, ButtonSize, ButtonVariant, ErrorVariant, Icon, IconButton, IconButtonSize, IconName, IconSize, InlineError, Tooltip,
};

/// The title's inset from the left and the actions' from the right, and their offset under the window chrome.
const LEFT: f32 = 24.0;
const RIGHT: f32 = 16.0;
const TITLE_TOP: f32 = 12.0;
const ACTIONS_TOP: f32 = 8.0;
/// The zoom bar's distance from the bottom (`bottom-5`) and the confirmation's width.
const ZOOM_BOTTOM: f32 = 20.0;
const CONFIRM_WIDTH: f32 = 420.0;
/// Wider than the zoom bar, to centre it in.
const ZOOM_BOX: f32 = 320.0;

fn top() -> f32 {
    f32::from(HEADER_HEIGHT)
}

pub fn heading(editor: &DesignEditor, theme: &Theme) -> AnyElement {
    let count = editor.sessions.len();
    div()
        .absolute()
        .left(px(LEFT))
        .right(px(440.0))
        .top(px(top() + TITLE_TOP))
        .min_w_0()
        .child(
            div().flex().items_baseline().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).child("Designs").child(
                div()
                    .ml(px(6.0))
                    .text_step(TEXT_11)
                    .font_weight(FontWeight::NORMAL)
                    .text_color(theme.ink3)
                    .child(format!("{count} {}", if count == 1 { "design" } else { "designs" })),
            ),
        )
        .child(
            div()
                .debug_selector(|| "design-save-status".to_string())
                .mt(px(2.0))
                .truncate()
                .text_step(TEXT_11)
                .text_color(theme.ink3)
                .child(editor.status()),
        )
        .into_any_element()
}

/// A 32px pill button around a glyph (Undo and Redo).
fn pill(id: &'static str, glyph: AnyElement, tooltip: Tooltip, disabled: bool, theme: &Theme) -> gpui::Stateful<gpui::Div> {
    let hover = theme.hover;
    div()
        .id(id)
        .debug_selector(move || id.to_string())
        .size(px(32.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .tooltip(tooltip.build())
        .when(disabled, |el| el.opacity(0.4))
        .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(hover)))
        .child(glyph)
}

fn divider(theme: &Theme) -> AnyElement {
    div().mx(px(2.0)).h(px(16.0)).w(px(1.0)).bg(theme.line).into_any_element()
}

pub fn actions(editor: &mut DesignEditor, theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    let (can_undo, can_redo) = editor.active().map(|s| (s.history.can_undo(), s.history.can_redo())).unwrap_or_default();
    let can_save = editor.changed() > 0;
    let ink2 = theme.ink2;
    let undo = Icon::new(IconName::Undo).size(IconSize::S16).color(ink2).into_any_element();
    let redo = Icon::new(IconName::Redo).size(IconSize::S16).color(ink2).into_any_element();
    div()
        .debug_selector(|| "design-page-actions".to_string())
        .absolute()
        .right(px(RIGHT))
        .top(px(top() + ACTIONS_TOP))
        .flex()
        .items_center()
        .gap(px(2.0))
        .p_1()
        .rounded_full()
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .child(
            pill("design-undo", undo, Tooltip::new("Undo").shortcut("⌘Z"), !can_undo, theme)
                .when(can_undo, |el| el.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.undo(cx)))),
        )
        .child(
            pill("design-redo", redo, Tooltip::new("Redo").shortcut("⇧⌘Z"), !can_redo, theme)
                .when(can_redo, |el| el.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.redo(cx)))),
        )
        .child(divider(theme))
        // Export (JSON, SVG and PNG through the host) is not ported yet.
        .child(Button::new("design-export", "Export").variant(ButtonVariant::Quiet).size(ButtonSize::S28).pill().disabled(true))
        .child(div().ml(px(2.0)).child(Button::new("design-save", "Save").size(ButtonSize::S28).pill().disabled(!can_save).on_click(
            cx.listener(|this, _: &ClickEvent, _, cx| {
                this.save(cx);
            }),
        )))
        .child(divider(theme))
        .child(
            div().id("design-close-tip").tooltip(Tooltip::new("Back to Milagre").build()).child(
                IconButton::new("design-close", IconName::Cancel01)
                    .size(IconButtonSize::S32)
                    .pill()
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.close(window, cx))),
            ),
        )
        .into_any_element()
}

/// The zoom bar (`ZoomBar`): out, the zoom (back to 100%), in, Fit; centred in the room between the panels.
pub fn zoom_bar(editor: &mut DesignEditor, theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    let scale = editor.view.scale;
    let ink3 = theme.ink3;
    let minus = Icon::new(IconName::MinusSign).size(IconSize::S16).color(ink3).into_any_element();
    let fit = Icon::new(IconName::FitToScreen).size(IconSize::S16).color(ink3).into_any_element();
    let (centre, _) = page::zoom_centre(editor.room, editor.layers_open);
    let hover = theme.hover;
    let button = |id: &'static str, glyph: AnyElement, disabled: bool| {
        div()
            .id(id)
            .debug_selector(move || id.to_string())
            .size(px(28.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .when(disabled, |el| el.opacity(0.4))
            .when(!disabled, |el| el.cursor_pointer().hover(move |s| s.bg(hover)))
            .child(glyph)
    };
    let bar = div()
        .debug_selector(|| "design-zoom-bar".to_string())
        .flex()
        .items_center()
        .gap(px(2.0))
        .p_1()
        .rounded_full()
        .bg(theme.surface)
        .shadow(theme.shadow_raised())
        .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(
            button("design-zoom-out", minus, scale <= MIN_SCALE + 1e-9)
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.zoom_by(1.0 / ZOOM_STEP, cx))),
        )
        .child(
            div()
                .id("design-zoom")
                .debug_selector(|| "design-zoom".to_string())
                .h(px(28.0))
                .w(px(48.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .child(super::super::zoom_label(scale))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.zoom_by(1.0 / this.view.scale, cx))),
        )
        .child(
            button(
                "design-zoom-in",
                Icon::new(IconName::PlusSign).size(IconSize::S16).color(ink3).into_any_element(),
                scale >= MAX_SCALE - 1e-9,
            )
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.zoom_by(ZOOM_STEP, cx))),
        )
        .child(divider(theme))
        .child(button("design-fit", fit, false).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.fit_page(cx))));
    // Centred on `centre`: a box twice as wide as the bar could be, its middle there.
    div()
        .absolute()
        .bottom(px(ZOOM_BOTTOM))
        .left(px(centre as f32 - ZOOM_BOX / 2.0))
        .w(px(ZOOM_BOX))
        .flex()
        .justify_center()
        .child(bar)
        .into_any_element()
}

/// Errors and notices over the canvas, between the rail (or Layers) and the inspector.
pub fn notices(editor: &DesignEditor, theme: &Theme) -> AnyElement {
    let left = if editor.layers_open { page::FIT_LEFT_LAYERS } else { page::FIT_LEFT } as f32;
    div()
        .debug_selector(|| "design-editor-notices".to_string())
        .absolute()
        .top(px(16.0))
        .left(px(left))
        .right(px(page::FIT_RIGHT as f32))
        .flex()
        .flex_col()
        .gap_2()
        .when_some(editor.error.clone(), |el, error| el.child(InlineError::new(error).variant(ErrorVariant::Floating)))
        .when_some(editor.notice.clone(), |el, notice| {
            el.child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .rounded(crate::theme::RADIUS_CARD)
                    .bg(theme.surface)
                    .shadow(theme.shadow_raised())
                    .px_3()
                    .py_2()
                    .text_step(TEXT_12)
                    .child(notice),
            )
        })
        .into_any_element()
}

/// The confirmation, over a scrim covering the editor.
pub fn confirmation(theme: &Theme, cx: &mut Context<DesignEditor>) -> AnyElement {
    div()
        .absolute()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(theme.scrim)
        .occlude()
        .on_mouse_down(
            gpui::MouseButton::Left,
            cx.listener(|this, _, _, cx| {
                this.confirming = false;
                cx.stop_propagation();
                cx.notify();
            }),
        )
        .child(
            div()
                .debug_selector(|| "design-close-confirmation".to_string())
                .w(px(CONFIRM_WIDTH))
                .p(px(20.0))
                .flex()
                .flex_col()
                .gap_4()
                .rounded(RADIUS_WINDOW)
                .bg(theme.surface)
                .border_1()
                .border_color(theme.line)
                .shadow(theme.shadow_raised())
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_step(TEXT_17).font_weight(FontWeight::SEMIBOLD).child("Your changes have not been saved"))
                        .child(
                            div()
                                .text_step(TEXT_13)
                                .text_color(theme.ink2)
                                .child("Keep editing this page, or discard its unsaved changes and return to Milagre."),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .child(Button::new("design-keep-editing", "Keep editing").variant(ButtonVariant::Ghost).on_click(cx.listener(
                            |this, _: &ClickEvent, _, cx| {
                                this.confirming = false;
                                cx.notify();
                            },
                        )))
                        .child(Button::new("design-discard", "Discard changes").variant(ButtonVariant::Danger).on_click(cx.listener(
                            |this, _: &ClickEvent, _, cx| {
                                this.confirming = false;
                                this.discard(cx);
                            },
                        ))),
                ),
        )
        .into_any_element()
}
