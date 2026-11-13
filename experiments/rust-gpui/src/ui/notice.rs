//! [`Notice`] (DESIGN.md "Toasts and notices": "A message that stays is a `Notice` card"; the desktop's
//! `components/Notice.tsx`): a dismissable card above the composer or over a view, a line of text or a list.
//!
//! `surface`, `rounded-card`, `shadow-overlay` on the desktop (here `shadow-raised`: the theme has no
//! `shadow-overlay` token yet), 13 `ink`, 16px by 8px padding, an optional action and a quiet 24px Dismiss button
//! at the end. Our own: a card with two slots.

use std::rc::Rc;

use gpui::{AnyElement, App, ClickEvent, IntoElement, ParentElement, RenderOnce, Window, div, prelude::*, px};

use super::{Button, ButtonSize, ButtonVariant};
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_13, TextStepExt};

type DismissHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Notice {
    children: Vec<AnyElement>,
    action: Option<AnyElement>,
    on_dismiss: Option<DismissHandler>,
}

impl Default for Notice {
    fn default() -> Self {
        Self::new()
    }
}

impl Notice {
    pub fn new() -> Self {
        Self { children: Vec::new(), action: None, on_dismiss: None }
    }

    /// A button or link before Dismiss.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    /// Shows the Dismiss button.
    pub fn on_dismiss(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for Notice {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for Notice {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .debug_selector(|| "notice".into())
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .w_full()
            .px(px(16.0))
            .py(px(8.0))
            .rounded(RADIUS_CARD)
            .bg(theme.surface)
            .shadow(theme.shadow_raised())
            .text_step(TEXT_13)
            .text_color(theme.ink)
            .child(div().flex_1().min_w_0().children(self.children))
            .children(self.action)
            .when_some(self.on_dismiss, |el, handler| {
                el.child(
                    div().flex_none().mr(px(-8.0)).child(
                        Button::new("notice-dismiss", "Dismiss")
                            .variant(ButtonVariant::Quiet)
                            .size(ButtonSize::S24)
                            .on_click(move |event, window, cx| handler(event, window, cx)),
                    ),
                )
            })
    }
}
