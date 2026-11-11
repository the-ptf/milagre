//! The permission chip and its picker (`PERMISSION_MODES`, `permissionPresentation`): Ask for approval, Auto mode and
//! Full permissions, each with its description, a shield glyph (a shield, a shield with a check, a shield with an
//! alert) and a tick on the current one. Full is the only orange mode: its glyph and title take `orange-ink`, and so
//! does the chip's glyph.

use gpui::{AnyElement, IntoElement, ParentElement, prelude::*};

use super::Composer;
use super::pick_list::{PickList, Row, panel, popup};
use crate::data::PermissionMode;
use crate::logic::copy::model_copy::{PermissionIcon, PermissionMode as Mode};
use crate::theme::{ActiveTheme, Theme};
use crate::ui::{Chip, Icon, IconName, IconSize};

pub fn to_mode(mode: PermissionMode) -> Mode {
    match mode {
        PermissionMode::Ask => Mode::Ask,
        PermissionMode::Auto => Mode::Auto,
        PermissionMode::Full => Mode::Full,
    }
}

pub fn from_mode(mode: Mode) -> PermissionMode {
    match mode {
        Mode::Ask => PermissionMode::Ask,
        Mode::Auto => PermissionMode::Auto,
        Mode::Full => PermissionMode::Full,
    }
}

fn glyph(icon: PermissionIcon) -> IconName {
    match icon {
        PermissionIcon::Shield => IconName::Shield01,
        PermissionIcon::SecurityCheck => IconName::SecurityCheck,
        PermissionIcon::ShieldAlert => IconName::ShieldAlert,
    }
}

impl Composer {
    pub(super) fn permission_chip(&self, theme: &Theme, cx: &mut gpui::Context<Self>) -> AnyElement {
        let mode = to_mode(self.bar.permission);
        let warn = theme.orange_ink;
        let composer = cx.entity();
        popup(&composer, "composer-permission", self.bar.open == Some("composer-permission"))
            .trigger(move |open| {
                Chip::new("composer-permission-chip")
                    .on(open)
                    .when(mode == Mode::Full, |chip| chip.child(Icon::new(IconName::ShieldAlert).size(IconSize::S14).color(warn)))
                    .child(mode.label())
                    .into_any_element()
            })
            .content(move |dismiss, _, cx| {
                let theme = *cx.theme();
                let current = to_mode(composer.read(cx).bar.permission);
                let rows = Mode::ALL
                    .into_iter()
                    .map(|mode| {
                        let (composer, dismiss) = (composer.clone(), dismiss.clone());
                        let full = mode == Mode::Full;
                        let mut row = Row::new(format!("permission-{}", mode.id()), mode.name(), move |window, cx| {
                            composer.update(cx, |c, cx| c.set_permission_mode(from_mode(mode), cx));
                            dismiss.call(window, cx);
                        })
                        .icon(glyph(mode.presentation().icon), full.then_some(theme.orange_ink))
                        .subtitle(mode.description())
                        .checked(mode == current);
                        if full {
                            row = row.title_color(theme.orange_ink);
                        }
                        row
                    })
                    .collect();
                panel(320.0, None, &theme)
                    .debug_selector(|| "permission-picker".into())
                    .child(PickList::new("permission-list", rows))
                    .into_any_element()
            })
            .into_any_element()
    }
}
