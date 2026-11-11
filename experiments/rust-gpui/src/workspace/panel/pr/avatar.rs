//! A person's avatar (`Avatar` in `pr/Properties.tsx`). The desktop loads their GitHub picture and falls back to
//! initials on a `hover-2` disc when it cannot; there is no network here, so the initials are always what shows. A
//! team has no picture: a group glyph on a `field` disc.

use gpui::{IntoElement, div, prelude::*, px};

use super::model::initials;
use crate::theme::{TEXT_10, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize};

pub fn avatar(theme: &Theme, login: &str, size: f32, team: bool) -> impl IntoElement {
    let disc = div().flex().flex_none().items_center().justify_center().size(px(size)).rounded_full();
    if team {
        return disc
            .bg(theme.field)
            .child(Icon::new(IconName::UserGroup).size(if size >= 20.0 { IconSize::S14 } else { IconSize::S12 }).color(theme.ink2));
    }
    disc.bg(theme.hover2)
        .text_color(theme.ink2)
        .text_step(TEXT_10)
        .font_weight(gpui::FontWeight::SEMIBOLD)
        .debug_selector({
            let name = format!("avatar-{login}");
            move || name.clone()
        })
        .child(initials(login))
}
