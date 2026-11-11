//! [`Checkbox`] (DESIGN.md "States": no switches; a checkbox for an independent on/off setting). The
//! desktop's `CheckboxBox`: 16px, `rounded-inline`, an `ink-3` border on `surface`; checked is an ink fill
//! with a 14px on-ink tick. A label, when given, sits 8px after it at 13 medium and toggles it too.

use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, RADIUS_INLINE, TEXT_13, TextStepExt};

type ToggleHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    checked: bool,
    label: Option<SharedString>,
    disabled: bool,
    on_toggle: Option<ToggleHandler>,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>, checked: bool) -> Self {
        Self { id: id.into(), checked, label: None, disabled: false, on_toggle: None }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the new value on a click.
    pub fn on_toggle(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let selector = self.id.to_string();
        let box_selector = format!("{selector}-box");
        let checked = self.checked;
        let check_box = div()
            .debug_selector(move || box_selector.clone())
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .rounded(RADIUS_INLINE)
            .border_1()
            .when(checked, |el| el.bg(theme.ink).border_color(theme.ink))
            .when(!checked, |el| el.bg(theme.surface).border_color(theme.ink3))
            .when(checked, |el| el.child(Icon::new(IconName::Tick02).size(IconSize::S14).color(theme.on_ink)));
        let enabled = !self.disabled;
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .flex()
            .flex_none()
            .items_center()
            .gap_2()
            .when(enabled, |el| el.cursor_pointer())
            .when(self.disabled, |el| el.opacity(0.4))
            .when_some(self.on_toggle.filter(|_| enabled), |el, handler| {
                el.on_click(move |_: &ClickEvent, window, cx| handler(!checked, window, cx))
            })
            .child(check_box)
            .when_some(self.label, |el, label| {
                el.child(div().text_step(TEXT_13).font_weight(FontWeight::MEDIUM).text_color(theme.ink).child(label))
            })
    }
}
