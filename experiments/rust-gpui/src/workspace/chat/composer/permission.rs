//! The permission choice inside the model picker (`ModelPicker.tsx`'s `data-permission-footer`): a footer under the
//! picker (`border-t line`, trigger on the right) whose text trigger shows the mode's shield glyph, its name and a
//! chevron, and opens a 220px menu above it with the three modes (`PERMISSION_MODES`: Ask for approval, Auto mode,
//! Full permissions; a shield, a shield with a check, a shield with an alert; a tick on the current one). Full is the
//! only orange mode: its glyph in the menu and the trigger's glyph and name take `orange-ink`. There is no chip on
//! the bar: the model chip carries an orange shield while Full is on.

use gpui::{AnyElement, ClickEvent, Entity, FontWeight, IntoElement, ParentElement, Window, div, prelude::*, px};

use super::Composer;
use super::pick_list::{PickList, Row, panel};
use crate::data::PermissionMode;
use crate::logic::copy::model_copy::{PermissionIcon, PermissionMode as Mode};
use crate::theme::{RADIUS_CHIP, TEXT_12, TextStepExt, Theme};
use crate::ui::{Icon, IconName, IconSize, item_focus};

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

/// Height of the footer: a 28px trigger with 4px above and below.
pub const FOOTER_HEIGHT: f32 = 36.0;

/// Redraws every view: the popover's content is a layer of its own that a composer `notify` does not reach.
fn apply(composer: &Entity<Composer>, window: &mut Window, cx: &mut gpui::App, change: impl FnOnce(&mut Composer)) {
    composer.update(cx, |c, cx| {
        change(c);
        cx.notify();
    });
    window.refresh();
}

/// The trigger's focus handle; only callable while drawing.
pub fn trigger_focus(window: &mut Window, cx: &mut gpui::App) -> gpui::FocusHandle {
    item_focus(&"permission-trigger".into(), window, cx)
}

/// The footer row: the trigger, right-aligned.
pub fn footer(
    composer: &Entity<Composer>,
    mode: Mode,
    menu_open: bool,
    window: &mut Window,
    cx: &mut gpui::App,
    theme: &Theme,
) -> AnyElement {
    let handle = trigger_focus(window, cx);
    let color = if mode == Mode::Full { theme.orange_ink } else { theme.ink2 };
    let (hover, hover2, accent) = (theme.hover, theme.hover2, theme.accent);
    let toggle = {
        let composer = composer.clone();
        move |window: &mut Window, cx: &mut gpui::App| apply(&composer, window, cx, |c| c.bar.permission_menu = !c.bar.permission_menu)
    };
    let key_toggle = toggle.clone();
    div()
        .debug_selector(|| "permission-footer".into())
        .flex()
        .flex_none()
        .items_center()
        .justify_end()
        .h(px(FOOTER_HEIGHT))
        .py(px(4.0))
        .pr(px(10.0))
        .pl(px(8.0))
        .border_t_1()
        .border_color(theme.line)
        .child(
            div()
                .id("permission-trigger")
                .debug_selector(|| "permission-trigger".into())
                .track_focus(&handle)
                .flex()
                .items_center()
                .gap(px(4.0))
                .h(px(28.0))
                .px(px(6.0))
                .rounded(RADIUS_CHIP)
                .cursor_pointer()
                .text_step(TEXT_12)
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .when(menu_open, move |el| el.bg(hover2))
                .when(!menu_open, move |el| el.hover(move |style| style.bg(hover)))
                .focus_visible(move |style| style.shadow(crate::ui::inset_ring(accent)))
                .on_click(move |_: &ClickEvent, window, cx| toggle(window, cx))
                .on_key_down(move |event, window, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space" | "up" | "down") {
                        key_toggle(window, cx);
                        cx.stop_propagation();
                    }
                })
                .child(Icon::new(glyph(mode.presentation().icon)).size(IconSize::S14).color(color))
                .child(mode.name())
                .child(Icon::new(IconName::ArrowDown01).size(IconSize::S14).color(theme.ink3)),
        )
        .into_any_element()
}

/// The menu above the trigger, placed by the picker (absolute, bottom right): the three modes, a tick on the current.
pub fn menu(composer: &Entity<Composer>, current: Mode, trigger: gpui::FocusHandle, theme: &Theme) -> AnyElement {
    let rows = Mode::ALL
        .into_iter()
        .map(|mode| {
            let (composer, trigger) = (composer.clone(), trigger.clone());
            let full = mode == Mode::Full;
            Row::new(format!("permission-{}", mode.id()), mode.name(), move |window, cx| {
                apply(&composer, window, cx, |c| {
                    c.bar.permission_menu = false;
                    c.bar.permission = from_mode(mode);
                });
                // Back to the trigger, as a closed select returns focus to it.
                trigger.focus(window, cx);
            })
            .icon(glyph(mode.presentation().icon), full.then_some(theme.orange_ink))
            .checked(mode == current)
        })
        .collect();
    panel(220.0, None, theme).debug_selector(|| "permission-menu".into()).child(PickList::new("permission-list", rows)).into_any_element()
}
