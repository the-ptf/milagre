//! [`Toast`] (DESIGN.md "Toasts and notices": "A toast is an ink capsule on both platforms: `bg-ink`, `on-ink` text
//! at 13/18, `rounded-card`, `shadow-raised`, an optional on-ink Undo"; the desktop's `SidebarToast.tsx`).
//!
//! The capsule itself, at least 44px high, 13 semibold `on-ink`; an optional 16px glyph before the text and an
//! optional action at the end (Undo) that is `on-ink` too, with the shortcut after it at 60%. Our own: gpui-component's
//! `Notification` is a surface card with its own variants and stack, and a toast here is one line of ink.
//! DESIGN.md says `rounded-card` (10); the desktop code today draws it fully round, which the rule overrules
//! (`SidebarToast.tsx`: `rounded-full`, to be moved onto the rule). Showing and timing it (6s) is the host's job:
//! mount it where it sits and unmount it.

use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px};

use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_13, TextStepExt};

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Toast {
    text: SharedString,
    icon: Option<IconName>,
    action: Option<(ElementId, SharedString, Option<SharedString>, Handler)>,
}

impl Toast {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into(), icon: None, action: None }
    }

    /// A 16px glyph in the text colour before the text.
    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// The action at the end (`"Undo"`), with an optional shortcut hint after it (`"⌘Z"`).
    pub fn action(
        mut self,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        shortcut: Option<&str>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.action = Some((id.into(), label.into(), shortcut.map(|s| SharedString::from(s.to_string())), Rc::new(handler)));
        self
    }
}

impl RenderOnce for Toast {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .debug_selector(|| "toast".into())
            .flex()
            .items_center()
            .gap(px(10.0))
            .w_full()
            .min_h(px(44.0))
            .py(px(8.0))
            .pl(px(14.0))
            .pr(px(16.0))
            .rounded(RADIUS_CARD)
            .bg(theme.ink)
            .shadow(theme.shadow_raised())
            .text_step(TEXT_13)
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.on_ink)
            .when_some(self.icon, |el, icon| el.child(Icon::new(icon).size(IconSize::S16).color(theme.on_ink)))
            .child(div().flex_1().min_w_0().child(self.text))
            .when_some(self.action, |el, (id, label, shortcut, handler)| {
                let selector = id.to_string();
                el.child(
                    div()
                        .id(id)
                        .debug_selector(move || selector.clone())
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(8.0))
                        .cursor_pointer()
                        .hover(|style| style.opacity(0.8))
                        .on_click(move |event, window, cx| handler(event, window, cx))
                        .child(label)
                        .when_some(shortcut, |el, shortcut| el.child(div().font_weight(FontWeight::MEDIUM).opacity(0.6).child(shortcut))),
                )
            })
    }
}
