//! The diff bar (C-07, `DiffBar` and `DiffToolbar` in `ChangesChrome.tsx`/`DiffPrefs.tsx`): Back to the Chat and
//! "Send N comments" on the left; Unified and Split, a divider, Wrap and Refresh on the right.
//!

use gpui::{AnyElement, ClickEvent, Context, FontWeight, SharedString, div, prelude::*, px};

use super::rows::DiffLayout;
use super::view::{DiffEvent, DiffView};
use crate::theme::{CONTROL_SM, RADIUS_CONTROL, TEXT_13, TextStepExt, Theme};
use crate::ui::{Button, Icon, IconName, IconSize, Tooltip};

/// The bar's height (`h-8`) and the space under it before the first file.
pub const BAR_H: f32 = 32.0;
pub const BAR_GAP: f32 = 8.0;

#[derive(Clone, Copy)]
enum Glyph {
    Unified,
    Split,
    Wrap,
}

/// The toolbar's 16px Hugeicons (`DiffPrefs.tsx`): `LayoutTop`, `Layout2Column` and `TextWrap`.
fn glyph(kind: Glyph, color: gpui::Rgba) -> AnyElement {
    let name = match kind {
        Glyph::Unified => IconName::LayoutTop,
        Glyph::Split => IconName::Layout2Column,
        Glyph::Wrap => IconName::TextWrap,
    };
    Icon::new(name).size(IconSize::S16).color(color).into_any_element()
}

impl DiffView {
    #[allow(clippy::too_many_arguments)]
    fn tool(
        &self,
        id: &'static str,
        label: &'static str,
        content: AnyElement,
        active: bool,
        disabled: bool,
        theme: &Theme,
        on_click: impl Fn(&mut Self, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let hover = theme.hover;
        div()
            .id(id)
            .debug_selector(move || id.to_string())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(CONTROL_SM)
            .rounded(RADIUS_CONTROL)
            .when(active, |el| el.bg(theme.hover2))
            .when(disabled, |el| el.opacity(0.4))
            .when(!active && !disabled, |el| el.cursor_pointer().hover(move |s| s.bg(hover)))
            .tooltip(Tooltip::text(label))
            .when(!disabled, |el| el.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| on_click(this, cx))))
            .child(content)
            .into_any_element()
    }

    pub(super) fn bar(&self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let label = match &self.over_chat {
            Some(over) => over.label.clone(),
            None => self.source.as_ref().map(|s| s.back_label.clone()).unwrap_or_default(),
        };
        let (leading, trailing) = self.over_chat.as_ref().map_or((px(12.0), px(12.0)), |over| (over.leading, over.trailing));
        let back_label: SharedString = if label.is_empty() { "Back".into() } else { label.clone() };
        let count = self.sendable().len();
        let hover = theme.hover;
        let layout = self.applied.layout;
        let split = layout == DiffLayout::Split;
        let color = |on: bool| if on { theme.ink } else { theme.ink3 };
        let back = div()
            .id("diff-back")
            .debug_selector(|| "diff-back".to_string())
            .flex()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .h(CONTROL_SM)
            .px(px(8.0))
            .rounded(RADIUS_CONTROL)
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .tooltip(Tooltip::text(if label.is_empty() { "Back".to_string() } else { format!("Back to {label}") }))
            .on_click(cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(DiffEvent::Close)))
            .text_step(TEXT_13)
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.ink)
            .child(Icon::new(IconName::ArrowLeft02).size(IconSize::S14).color(theme.ink3))
            .child(div().min_w_0().truncate().child(back_label));
        let send = (count > 0).then(|| {
            Button::new("diff-send", if count == 1 { "Send 1 comment".to_string() } else { format!("Send {count} comments") })
                .selector("diff-send")
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.send_comments(cx)))
        });
        let toolbar = div()
            .debug_selector(|| "diff-toolbar".to_string())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(2.0))
            .child(self.tool(
                "diff-layout-unified",
                "Unified",
                glyph(Glyph::Unified, color(!split)),
                !split,
                false,
                theme,
                |this, cx| this.set_layout(DiffLayout::Unified, cx),
                cx,
            ))
            .child(self.tool(
                "diff-layout-split",
                "Split",
                glyph(Glyph::Split, color(split)),
                split,
                false,
                theme,
                |this, cx| this.set_layout(DiffLayout::Split, cx),
                cx,
            ))
            // Unified and Split are one choice; a divider sets them off from Wrap and Refresh.
            .child(div().mx(px(4.0)).h(px(16.0)).w(px(1.0)).flex_none().bg(theme.line))
            .child(self.tool(
                "diff-wrap",
                if split { "Split view always wraps" } else { "Wrap lines" },
                glyph(Glyph::Wrap, color(split || self.applied.wrap)),
                split || self.applied.wrap,
                split,
                theme,
                |this, cx| {
                    let wrap = !this.applied.wrap;
                    this.set_wrap(wrap, cx)
                },
                cx,
            ))
            .child(self.tool(
                "diff-refresh",
                "Refresh",
                Icon::new(IconName::Refresh).size(IconSize::S16).color(theme.ink3).into_any_element(),
                false,
                false,
                theme,
                |_, cx| cx.emit(DiffEvent::Refresh),
                cx,
            ));
        div()
            .debug_selector(|| "diff-bar".to_string())
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .h(px(BAR_H))
            .pl(leading)
            .pr(trailing)
            .mb(px(BAR_GAP))
            .child(div().flex().min_w_0().items_center().gap(px(8.0)).child(back).children(send).when(count == 0, |el| el.child(div())))
            .child(toolbar)
            .into_any_element()
    }
}
