//! [`Tab`] (the desktop's `primitives/Tabs.tsx`): a 28px tab with an optional 14px icon and count. The active
//! tab is `hover-2` with an ink label (DESIGN.md: a selection is ink, never accent); the others are `ink-3`
//! with the `hover` fill on hover.
//!
//! A tab strip is the caller's `div().flex()` (or a horizontally scrolling one, as the panel's); tabs must
//! be its direct children for `ScrollHandle::scroll_to_item` to bring a tab into view. Tabs are no-drag,
//! so a strip can live in a window header.

use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, CONTROL_SM, RADIUS_CONTROL, TEXT_12, TextStepExt};
use crate::workspace::chrome::NoDrag;

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Tab {
    id: ElementId,
    selector: Option<SharedString>,
    label: SharedString,
    icon: Option<IconName>,
    count: Option<SharedString>,
    active: bool,
    on_click: Option<ClickHandler>,
}

impl Tab {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self { id: id.into(), selector: None, label: label.into(), icon: None, count: None, active: false, on_click: None }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A number after the label, in `ink-3` (Changes 4).
    pub fn count(mut self, count: impl Into<SharedString>) -> Self {
        self.count = Some(count.into());
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// The name tests find it by; its icon is `<selector>-icon`. The element id's text by default.
    pub fn selector(mut self, selector: impl Into<SharedString>) -> Self {
        self.selector = Some(selector.into());
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Tab {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let selector = self.selector.unwrap_or_else(|| self.id.to_string().into());
        let icon_selector = format!("{selector}-icon");
        let color = if self.active { theme.ink } else { theme.ink3 };
        let hover = theme.hover;
        div()
            .id(self.id)
            .debug_selector(move || selector.to_string())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.0))
            .h(CONTROL_SM)
            .px(px(6.0))
            .rounded(RADIUS_CONTROL)
            .text_step(TEXT_12)
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .cursor_pointer()
            .text_color(color)
            .when(self.active, |el| el.bg(theme.hover2))
            .when(!self.active, |el| el.hover(move |style| style.bg(hover)))
            .no_drag()
            .when_some(self.on_click, |el, handler| {
                el.on_click(move |event, window, cx| {
                    // Keep a double-click on a tab from reaching a header's zoom.
                    cx.stop_propagation();
                    handler(event, window, cx);
                })
            })
            .when_some(self.icon, |el, icon| {
                el.child(div().debug_selector(move || icon_selector.clone()).child(Icon::new(icon).size(IconSize::S14).color(color)))
            })
            .child(
                div()
                    .flex()
                    .gap(px(4.0))
                    .child(self.label)
                    .when_some(self.count, |el, count| el.child(div().text_color(theme.ink3).child(count))),
            )
    }
}
