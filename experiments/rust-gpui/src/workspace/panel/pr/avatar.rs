//! A person's avatar (`Avatar` in `pr/Properties.tsx`). The desktop loads their GitHub picture and falls back to
//! initials on a `hover-2` disc when it cannot. Here a data layer fetches the pictures and hands them over with
//! [`set_avatars`] ([`Avatars`], one per window's app); a login without one (none fetched yet, offline, no picture)
//! keeps its initials. A team has no picture: a group glyph on a `field` disc.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{App, Global, Image, IntoElement, ObjectFit, RenderOnce, Window, div, img, prelude::*, px};

use super::model::initials;
use crate::theme::{TEXT_10, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize};

/// The GitHub pictures a data layer fetched, by login.
#[derive(Default)]
pub struct Avatars(HashMap<String, Arc<Image>>);

impl Global for Avatars {}

/// Adds fetched pictures (by login); the PR views draw them from their next frame.
pub fn set_avatars(pictures: impl IntoIterator<Item = (String, Arc<Image>)>, cx: &mut App) {
    let avatars = cx.default_global::<Avatars>();
    avatars.0.extend(pictures);
}

/// The picture fetched for `login`, if any.
pub fn avatar_image(login: &str, cx: &App) -> Option<Arc<Image>> {
    cx.try_global::<Avatars>().and_then(|avatars| avatars.0.get(login).cloned())
}

/// The picture's URL Electron's `<img>` ends up loading (`https://github.com/<login>.png?size=40` redirects there):
/// GitHub's avatar host by login, 40px. `None` for a team or a login GitHub would not have (`app/…`, spaces).
pub fn avatar_url(login: &str) -> Option<String> {
    let ok = !login.is_empty() && login.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '[' | ']'));
    ok.then(|| format!("https://avatars.githubusercontent.com/{}?s=40", login.replace('[', "%5B").replace(']', "%5D")))
}

/// A login's avatar at `size`: its picture when one was fetched, else its initials.
pub fn avatar(theme: &Theme, login: &str, size: f32, team: bool) -> Avatar {
    Avatar { theme: *theme, login: login.to_string(), size, team }
}

#[derive(IntoElement)]
pub struct Avatar {
    theme: Theme,
    login: String,
    size: f32,
    team: bool,
}

impl RenderOnce for Avatar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let Avatar { theme, login, size, team } = self;
        let disc = div().flex().flex_none().items_center().justify_center().size(px(size)).rounded_full();
        if team {
            return disc
                .bg(theme.field)
                .child(Icon::new(IconName::UserGroup).size(if size >= 20.0 { IconSize::S14 } else { IconSize::S12 }).color(theme.ink2))
                .into_any_element();
        }
        let selector = format!("avatar-{login}");
        if let Some(picture) = avatar_image(&login, cx) {
            let selector = format!("avatar-picture-{login}");
            // `bg-field` under the picture, rounded as the picture is (GPUI clips an image to its own corners).
            return disc
                .bg(theme.field)
                .overflow_hidden()
                .debug_selector(move || selector.clone())
                .child(img(gpui::ImageSource::Image(picture)).size(px(size)).rounded_full().object_fit(ObjectFit::Cover))
                .into_any_element();
        }
        disc.bg(theme.hover2)
            .text_color(theme.ink2)
            .text_step(TEXT_10)
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .debug_selector(move || selector.clone())
            .child(initials(&login))
            .into_any_element()
    }
}
