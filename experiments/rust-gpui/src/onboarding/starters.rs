//! The first Chat's starter tasks (`FirstChatStarters`, design onboarding-first-chat): "What should we make first?"
//! over three one-line cards. The new Chat's column mounts it above the composer; a pick fills the composer with the
//! starter's prompt.

use std::rc::Rc;

use gpui::{App, FontWeight, IntoElement, RenderOnce, Window, div, prelude::*, px};

use super::model::Starter;
use crate::theme::{ActiveTheme, RADIUS_CARD, TEXT_13, TEXT_17, TextStepExt};
use crate::ui::{Icon, IconName, IconSize};

type Pick = Rc<dyn Fn(&Starter, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct FirstChatStarters {
    starters: Vec<Starter>,
    on_pick: Pick,
}

impl FirstChatStarters {
    pub fn new(starters: Vec<Starter>, on_pick: impl Fn(&Starter, &mut Window, &mut App) + 'static) -> Self {
        Self { starters, on_pick: Rc::new(on_pick) }
    }
}

/// `STARTER_ICONS`.
pub fn starter_icon(id: &str) -> IconName {
    match id {
        "bug" => IconName::Bug01,
        "tests" => IconName::TestTube01,
        _ => IconName::Maps,
    }
}

impl RenderOnce for FirstChatStarters {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        div()
            .debug_selector(|| "first-chat-starters".into())
            .flex()
            .flex_col()
            .gap(px(12.0))
            .px(px(4.0))
            .child(div().text_step(TEXT_17).font_weight(FontWeight::SEMIBOLD).text_color(theme.ink).child("What should we make first?"))
            .child(div().flex().flex_col().gap(px(8.0)).children(self.starters.into_iter().map(|starter| {
                let id = format!("starter-{}", starter.id);
                let group: gpui::SharedString = id.clone().into();
                let (pick, picked) = (self.on_pick.clone(), starter.clone());
                let selector = id.clone();
                div()
                    .id(gpui::ElementId::Name(id.into()))
                    .debug_selector(move || selector)
                    .group(group.clone())
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .h(px(48.0))
                    .px(px(12.0))
                    .rounded(RADIUS_CARD)
                    .border_1()
                    .border_color(theme.line)
                    .bg(theme.surface)
                    .text_step(TEXT_13)
                    .text_color(theme.ink)
                    .cursor_pointer()
                    .hover(move |el| el.border_color(theme.line_strong).bg(theme.hover))
                    .on_click(move |_, window, cx| pick(&picked, window, cx))
                    .child(Icon::new(starter_icon(starter.id)).size(IconSize::S16).color(theme.ink2))
                    .child(div().flex_1().min_w_0().truncate().child(starter.label))
                    .child(
                        div()
                            .invisible()
                            .group_hover(group, |el| el.visible())
                            .child(Icon::new(IconName::ArrowUpRight01).size(IconSize::S16).color(theme.ink3)),
                    )
            })))
    }
}
