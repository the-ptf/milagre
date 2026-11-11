//! [`Button`] and [`IconButton`] (DESIGN.md "Buttons", the desktop's `primitives/Button.tsx`).
//!
//! ```ignore
//! Button::new("approval-deny", "Deny").variant(ButtonVariant::DangerGhost).size(ButtonSize::S28).on_click(|_, _, cx| ...)
//! IconButton::new("search", IconName::Search01).size(IconButtonSize::S24)
//! ```
//!
//! One primary style: an ink fill with an `on-ink` label; accent and green never fill a button. Labels are
//! 500 weight. Disabled is 40% and inert. Focusable, with the accent focus ring on keyboard focus (`focus.rs`;
//! Enter and Space press it). Not built: the 0.97 press scale (GPUI has no transform on
//! divs) and the colour transitions.

use std::rc::Rc;

use gpui::{App, ClickEvent, ElementId, FontWeight, Hsla, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px, svg};

use super::focus::{focus_ring, item_focus};
use super::{Icon, IconName, IconSize};
use crate::theme::{ActiveTheme, CONTROL_MD, CONTROL_SM, CONTROL_XS, RADIUS_CONTROL, TEXT_12, TEXT_13, TextStep, TextStepExt, Theme};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    /// Ink fill, on-ink label; hover 90% opacity.
    #[default]
    Primary,
    /// Surface with `shadow-btn`; hover fill.
    Secondary,
    /// Ink label; hover fill.
    Ghost,
    /// `ink-2` label, ink on hover.
    Quiet,
    /// `accent-ink` label: an inline action that reads as a link.
    Link,
    /// `red-ink` fill, `on-red` label: the confirm of a destructive action.
    Danger,
    /// `red-ink` label, `red-tint` hover: the first step (Remove, Delete, Deny, Revoke, Stop).
    DangerGhost,
}

/// 32 by default, 28 in compact rows and composer chips, 24 inline.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonSize {
    S24,
    S28,
    #[default]
    S32,
}

impl ButtonSize {
    fn metrics(self) -> (gpui::Pixels, f32, TextStep) {
        match self {
            ButtonSize::S24 => (CONTROL_XS, 8.0, TEXT_12),
            ButtonSize::S28 => (CONTROL_SM, 10.0, TEXT_12),
            ButtonSize::S32 => (CONTROL_MD, 12.0, TEXT_13),
        }
    }
}

/// The colours of a variant: (fill, label, hover fill, hover label, hover by fading instead).
fn look(variant: ButtonVariant, theme: &Theme) -> (Option<Hsla>, Hsla, Option<Hsla>, Option<Hsla>, bool) {
    match variant {
        ButtonVariant::Primary => (Some(theme.ink.into()), theme.on_ink.into(), None, None, true),
        ButtonVariant::Secondary => (Some(theme.surface.into()), theme.ink.into(), Some(theme.hover.into()), None, false),
        ButtonVariant::Ghost => (None, theme.ink.into(), Some(theme.hover.into()), None, false),
        ButtonVariant::Quiet => (None, theme.ink2.into(), Some(theme.hover.into()), Some(theme.ink.into()), false),
        ButtonVariant::Link => (None, theme.accent_ink.into(), Some(theme.hover.into()), None, false),
        ButtonVariant::Danger => (Some(theme.red_ink.into()), theme.on_red.into(), None, None, true),
        ButtonVariant::DangerGhost => (None, theme.red_ink.into(), Some(theme.red_tint.into()), None, false),
    }
}

/// A text button, optionally with a leading 14px icon.
#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    selector: Option<&'static str>,
    label: SharedString,
    icon: Option<IconName>,
    variant: ButtonVariant,
    size: ButtonSize,
    pill: bool,
    disabled: bool,
    on_click: Option<ClickHandler>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            selector: None,
            label: label.into(),
            icon: None,
            variant: ButtonVariant::default(),
            size: ButtonSize::default(),
            pill: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }

    /// Fully round instead of `rounded-control`.
    pub fn pill(mut self) -> Self {
        self.pill = true;
        self
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The name tests find it by (`cx.debug_bounds`); the element id's text by default.
    pub fn selector(mut self, selector: &'static str) -> Self {
        self.selector = Some(selector);
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let (height, padding, text) = self.size.metrics();
        let (fill, label, hover_fill, hover_label, fade) = look(self.variant, &theme);
        let selector: SharedString = self.selector.map(SharedString::from).unwrap_or_else(|| self.id.to_string().into());
        let enabled = !self.disabled;
        let handle = item_focus(&self.id, window, cx);
        let ring_radius = if self.pill { height / 2.0 } else { RADIUS_CONTROL };
        div()
            .id(self.id)
            .debug_selector(move || selector.to_string())
            .when(enabled, |el| el.track_focus(&handle))
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(px(6.0))
            .h(height)
            .px(px(padding))
            .when(self.pill, |el| el.rounded_full())
            .when(!self.pill, |el| el.rounded(RADIUS_CONTROL))
            .text_step(text)
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .text_color(label)
            .when_some(fill, |el, fill| el.bg(fill))
            .when(self.variant == ButtonVariant::Secondary, |el| el.shadow(theme.shadow_btn()))
            .when(enabled, |el| {
                el.cursor_pointer().hover(move |style| {
                    let style = if fade { style.opacity(0.9) } else { style };
                    let style = match hover_fill {
                        Some(fill) => style.bg(fill),
                        None => style,
                    };
                    match hover_label {
                        Some(label) => style.text_color(label),
                        None => style,
                    }
                })
            })
            .when(self.disabled, |el| el.opacity(0.4))
            .when_some(self.on_click.filter(|_| enabled), |el, handler| el.on_click(move |event, window, cx| handler(event, window, cx)))
            .when_some(self.icon, |el, icon| el.child(Icon::new(icon).size(IconSize::S14).color(label)))
            .child(self.label)
            .child(focus_ring(&handle, ring_radius))
    }
}

/// The hover group an icon button's glyph follows; the nearest ancestor with the name wins.
const GROUP: &str = "icon-button";

/// Square icon-only button sizes; the glyph follows the desktop (`GLYPH` in Button.tsx).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IconButtonSize {
    /// 20px, 12px glyph: inline in a dense row (DESIGN.md: reaches the 24px hit area through its `::before`,
    /// which GPUI cannot extend, so keep 2px clear of neighbours and treat 24 as the target floor).
    S20,
    /// 24px, 14px glyph: window chrome and inline.
    S24,
    /// 28px, 16px glyph: the default.
    #[default]
    S28,
    /// 32px, 16px glyph.
    S32,
}

/// A square icon-only button: `ink-3` at rest, ink and the `hover` fill on hover, `hover-2` with an ink glyph
/// while pressed (`.pressed(true)`: an open or toggled control). Give it a tooltip with
/// `.tooltip(Tooltip::text(..))` on a wrapper until it takes one itself.
#[derive(IntoElement)]
pub struct IconButton {
    id: ElementId,
    icon: IconName,
    size: IconButtonSize,
    glyph: Option<IconSize>,
    pill: bool,
    pressed: bool,
    disabled: bool,
    on_click: Option<ClickHandler>,
}

impl IconButton {
    pub fn new(id: impl Into<ElementId>, icon: IconName) -> Self {
        Self {
            id: id.into(),
            icon,
            size: IconButtonSize::default(),
            glyph: None,
            pill: false,
            pressed: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn size(mut self, size: IconButtonSize) -> Self {
        self.size = size;
        self
    }

    /// A glyph size other than the size's default (the panel's 24px buttons draw 16px glyphs).
    pub fn glyph(mut self, glyph: IconSize) -> Self {
        self.glyph = Some(glyph);
        self
    }

    pub fn pill(mut self) -> Self {
        self.pill = true;
        self
    }

    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for IconButton {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *cx.theme();
        let handle = item_focus(&self.id, window, cx);
        let (box_size, default_glyph) = match self.size {
            IconButtonSize::S20 => (px(20.0), IconSize::S12),
            IconButtonSize::S24 => (CONTROL_XS, IconSize::S14),
            IconButtonSize::S28 => (CONTROL_SM, IconSize::S16),
            IconButtonSize::S32 => (CONTROL_MD, IconSize::S16),
        };
        let selector = self.id.to_string();
        let glyph = if self.pressed { theme.ink } else { theme.ink3 };
        let glyph_size = self.glyph.unwrap_or(default_glyph);
        let ink = theme.ink;
        let enabled = !self.disabled;
        let hover = theme.hover;
        let ring_radius = if self.pill { box_size / 2.0 } else { RADIUS_CONTROL };
        div()
            .id(self.id)
            .debug_selector(move || selector.clone())
            .when(enabled, |el| el.track_focus(&handle))
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(box_size)
            .when(self.pill, |el| el.rounded_full())
            .when(!self.pill, |el| el.rounded(RADIUS_CONTROL))
            .when(self.pressed, |el| el.bg(theme.hover2))
            .when(enabled && !self.pressed, |el| el.cursor_pointer().hover(move |style| style.bg(hover)))
            .when(enabled && self.pressed, |el| el.cursor_pointer())
            .when(self.disabled, |el| el.opacity(0.4))
            .when_some(self.on_click.filter(|_| enabled), |el, handler| el.on_click(move |event, window, cx| handler(event, window, cx)))
            .group(GROUP)
            // The glyph turns ink while the button is hovered (an `Icon` cannot follow its parent's hover).
            .child(
                svg()
                    .path(self.icon.path(glyph_size))
                    .flex_none()
                    .size(px(glyph_size.px()))
                    .text_color(glyph)
                    .when(enabled, |el| el.group_hover(GROUP, move |style| style.text_color(ink))),
            )
            .child(focus_ring(&handle, ring_radius))
    }
}
